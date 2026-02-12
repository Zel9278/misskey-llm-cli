#ifndef COMMAND_EXECUTOR
#define COMMAND_EXECUTOR

#include <string>
#include <vector>
#include <iostream>
#include <sstream>
#include <functional>
#include <thread>
#include <mutex>
#include <queue>
#include <condition_variable>
#include <atomic>
#include <nlohmann/json.hpp>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <sys/wait.h>
#include <signal.h>
#include <cstring>
#endif

using json = nlohmann::json;

namespace Misskey {

    struct CommandConfig {
        bool enabled = false;
        std::string program;           // e.g. "openclaw"
        std::vector<std::string> args;  // e.g. ["message", "send"]
        std::vector<std::string> events; // which events to forward (empty = all)
        int max_queue_size = 100;       // drop oldest if queue overflows
    };

    // Execute an external command with JSON piped to stdin
    // Runs in a worker thread to avoid blocking the WebSocket loop
    class CommandExecutor {
    public:
        CommandConfig config;

        explicit CommandExecutor() = default;

        ~CommandExecutor() {
            stop();
        }

        void start() {
            if (!config.enabled) return;
            running = true;
            worker = std::thread(&CommandExecutor::worker_loop, this);
        }

        void stop() {
            if (!running) return;
            running = false;
            cv.notify_all();
            if (worker.joinable()) worker.join();
        }

        // Enqueue an event JSON to be sent to the external command
        void send(const std::string& event, const json& data) {
            if (!config.enabled || !running) return;

            // Filter by event type if configured
            if (!config.events.empty()) {
                bool match = false;
                for (const auto& e : config.events) {
                    if (e == event) { match = true; break; }
                }
                if (!match) return;
            }

            json payload;
            payload["event"] = event;
            payload["data"] = data;
            std::string line = payload.dump(-1, ' ', false, json::error_handler_t::replace);

            {
                std::lock_guard<std::mutex> lock(mtx);
                if (static_cast<int>(queue_.size()) >= config.max_queue_size) {
                    queue_.pop(); // drop oldest
                }
                queue_.push(std::move(line));
            }
            cv.notify_one();
        }

    private:
        std::thread worker;
        std::mutex mtx;
        std::condition_variable cv;
        std::queue<std::string> queue_;
        std::atomic<bool> running{false};

        void worker_loop() {
            while (running) {
                std::string payload;
                {
                    std::unique_lock<std::mutex> lock(mtx);
                    cv.wait(lock, [this] { return !queue_.empty() || !running; });
                    if (!running && queue_.empty()) break;
                    payload = std::move(queue_.front());
                    queue_.pop();
                }
                exec_command(payload);
            }
        }

        void exec_command(const std::string& json_payload) {
#ifdef _WIN32
            exec_command_win32(json_payload);
#else
            exec_command_posix(json_payload);
#endif
        }

#ifdef _WIN32
        void exec_command_win32(const std::string& json_payload) {
            // Build command line: program arg1 arg2 ... (JSON via stdin)
            std::string cmdline = quote_arg(config.program);
            for (const auto& arg : config.args) {
                cmdline += " " + quote_arg(arg);
            }

            SECURITY_ATTRIBUTES sa;
            sa.nLength = sizeof(sa);
            sa.bInheritHandle = TRUE;
            sa.lpSecurityDescriptor = NULL;

            HANDLE stdin_read = NULL, stdin_write = NULL;
            if (!CreatePipe(&stdin_read, &stdin_write, &sa, 0)) {
                std::cerr << "[CMD] CreatePipe failed: " << GetLastError() << std::endl;
                return;
            }
            SetHandleInformation(stdin_write, HANDLE_FLAG_INHERIT, 0);

            STARTUPINFOA si;
            PROCESS_INFORMATION pi;
            ZeroMemory(&si, sizeof(si));
            si.cb = sizeof(si);
            si.hStdInput = stdin_read;
            si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            si.dwFlags |= STARTF_USESTDHANDLES;

            ZeroMemory(&pi, sizeof(pi));

            std::string cmdline_mut = cmdline;

            BOOL ok = CreateProcessA(
                NULL,
                cmdline_mut.data(),
                NULL, NULL, TRUE, 0, NULL, NULL,
                &si, &pi
            );

            if (!ok) {
                std::cerr << "[CMD] Failed to launch '" << config.program
                          << "': error " << GetLastError() << std::endl;
                CloseHandle(stdin_read);
                CloseHandle(stdin_write);
                return;
            }

            DWORD written;
            std::string input = json_payload + "\n";
            WriteFile(stdin_write, input.c_str(),
                      static_cast<DWORD>(input.size()), &written, NULL);
            CloseHandle(stdin_write);
            CloseHandle(stdin_read);

            WaitForSingleObject(pi.hProcess, 10000);

            DWORD exit_code = 0;
            GetExitCodeProcess(pi.hProcess, &exit_code);
            if (exit_code != 0 && exit_code != STILL_ACTIVE) {
                std::cerr << "[CMD] '" << config.program
                          << "' exited with code " << exit_code << std::endl;
            }

            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
        }
#else
        void exec_command_posix(const std::string& json_payload) {
            int pipefd[2];
            if (pipe(pipefd) == -1) {
                std::cerr << "[CMD] pipe() failed: " << strerror(errno) << std::endl;
                return;
            }

            pid_t pid = fork();
            if (pid == -1) {
                std::cerr << "[CMD] fork() failed: " << strerror(errno) << std::endl;
                close(pipefd[0]);
                close(pipefd[1]);
                return;
            }

            if (pid == 0) {
                // Child process
                close(pipefd[1]); // close write end
                dup2(pipefd[0], STDIN_FILENO);
                close(pipefd[0]);

                // Build argv
                std::vector<const char*> argv;
                argv.push_back(config.program.c_str());
                for (const auto& a : config.args) {
                    argv.push_back(a.c_str());
                }
                argv.push_back(nullptr);

                execvp(config.program.c_str(),
                       const_cast<char* const*>(argv.data()));

                // If exec fails
                std::cerr << "[CMD] execvp '" << config.program
                          << "' failed: " << strerror(errno) << std::endl;
                _exit(127);
            }

            // Parent process
            close(pipefd[0]); // close read end

            std::string input = json_payload + "\n";
            ssize_t w = write(pipefd[1], input.c_str(), input.size());
            (void)w; // ignore partial writes for simplicity
            close(pipefd[1]);

            // Wait up to 10 seconds
            int status = 0;
            int wait_ms = 0;
            while (wait_ms < 10000) {
                pid_t result = waitpid(pid, &status, WNOHANG);
                if (result == pid) break;
                if (result == -1) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                wait_ms += 50;
            }

            if (wait_ms >= 10000) {
                kill(pid, SIGKILL);
                waitpid(pid, &status, 0);
                std::cerr << "[CMD] '" << config.program
                          << "' timed out, killed" << std::endl;
            } else if (WIFEXITED(status) && WEXITSTATUS(status) != 0) {
                std::cerr << "[CMD] '" << config.program
                          << "' exited with code " << WEXITSTATUS(status) << std::endl;
            }
        }
#endif

        static std::string quote_arg(const std::string& arg) {
            if (arg.find(' ') == std::string::npos &&
                arg.find('"') == std::string::npos) {
                return arg;
            }
            std::string q = "\"";
            for (char c : arg) {
                if (c == '"') q += "\\\"";
                else q += c;
            }
            q += "\"";
            return q;
        }
    };

} // namespace Misskey

#endif // COMMAND_EXECUTOR
