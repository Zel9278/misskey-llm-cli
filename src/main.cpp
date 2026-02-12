#include "misskey_websocket.hpp"
#include "misskey.hpp"
#include "event_handler.hpp"
#include <toml++/toml.hpp>
#include <filesystem>

#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <climits>
#endif

using namespace Misskey;

std::string get_executable_dir() {
#ifdef _WIN32
    std::string path(MAX_PATH, '\0');
    GetModuleFileNameA(NULL, path.data(), MAX_PATH);
    path.resize(strlen(path.data()));
#else
    std::string path(PATH_MAX, '\0');
    ssize_t len = readlink("/proc/self/exe", path.data(), PATH_MAX);
    if (len == -1) {
        // Fallback: current working directory
        return std::filesystem::current_path().string();
    }
    path.resize(static_cast<size_t>(len));
#endif
    path.shrink_to_fit();
    return std::filesystem::path(std::move(path)).parent_path().string();
}

int main() {
#ifdef _WIN32
    std::setlocale(LC_ALL, ".UTF8");
#else
    std::setlocale(LC_ALL, "");
#endif

    std::string executable_path = get_executable_dir();

    std::filesystem::path config_file_path =
        std::filesystem::path(executable_path) / "config.toml";
    std::string config_file_str = config_file_path.string();

    if (!std::filesystem::exists(config_file_path)) {
        std::cerr << "Please set config to " << config_file_str << ", bye" << std::endl;
        return 1;
    }

    toml::table config = toml::parse_file(config_file_str);

    std::string& uri = config.at_path("Secrets.uri").ref<std::string>();
    std::string& token = config.at_path("Secrets.token").ref<std::string>();

    // Read output format from config (default: jsonl)
    std::string format_str = config.at_path("Output.format").value_or<std::string>("jsonl");

    EventHandler handler;
    if (format_str == "human") {
        handler.format = OutputFormat::Human;
    } else {
        handler.format = OutputFormat::JSONL;
    }

    // External command integration (e.g. openclaw)
    handler.command.config.enabled = config.at_path("Command.enabled").value_or(false);
    handler.command.config.program = config.at_path("Command.program").value_or<std::string>("");

    if (auto* arr = config.at_path("Command.args").as_array()) {
        for (const auto& v : *arr) {
            if (auto s = v.value<std::string>()) {
                handler.command.config.args.push_back(*s);
            }
        }
    }

    if (auto* arr = config.at_path("Command.events").as_array()) {
        for (const auto& v : *arr) {
            if (auto s = v.value<std::string>()) {
                handler.command.config.events.push_back(*s);
            }
        }
    }

    handler.command.config.max_queue_size =
        config.at_path("Command.max_queue_size").value_or(100);

    handler.start();

    websocket client(handler);
    client.connect(uri, token);
}
