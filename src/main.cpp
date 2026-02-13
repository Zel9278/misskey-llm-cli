#include "misskey_websocket.hpp"
#include "misskey.hpp"
#include "event_handler.hpp"
#include <toml++/toml.hpp>
#include <filesystem>
#include <vector>

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
        return std::filesystem::current_path().string();
    }
    path.resize(static_cast<size_t>(len));
#endif
    path.shrink_to_fit();
    return std::filesystem::path(std::move(path)).parent_path().string();
}

struct AppConfig {
    std::string uri;
    std::string token;
    std::string output_format;
    toml::table raw;
};

AppConfig load_config() {
    std::string exe_dir = get_executable_dir();
    std::filesystem::path config_path = std::filesystem::path(exe_dir) / "config.toml";
    std::string config_str = config_path.string();

    if (!std::filesystem::exists(config_path)) {
        std::cerr << "Please set config to " << config_str << ", bye" << std::endl;
        std::exit(1);
    }

    toml::table tbl = toml::parse_file(config_str);

    AppConfig cfg;
    cfg.uri = tbl.at_path("Secrets.uri").ref<std::string>();
    cfg.token = tbl.at_path("Secrets.token").ref<std::string>();
    cfg.output_format = tbl.at_path("Output.format").value_or<std::string>("jsonl");
    cfg.raw = std::move(tbl);
    return cfg;
}

// Print JSON result to stdout
void print_result(const json& result) {
    std::cout << result.dump(2, ' ', false, json::error_handler_t::replace) << std::endl;
}

void print_usage() {
    std::cerr
        << "Usage:\n"
        << "  what stream                        -- Stream timeline & notifications\n"
        << "  what post <text> [--cw <cw>] [--visibility <vis>] [--reply <noteId>] [--quote <noteId>]\n"
        << "  what reply <noteId> <text> [--cw <cw>] [--visibility <vis>]\n"
        << "  what quote <noteId> <text> [--cw <cw>] [--visibility <vis>]\n"
        << "  what renote <noteId>\n"
        << "  what upload <file> [--name <name>] [--folder <folderId>] [--nsfw]\n"
        << "  what post-image <file> [<text>] [--cw <cw>] [--visibility <vis>] [--nsfw]\n"
        << "  what delete <noteId>\n"
        << "  what show <noteId>\n"
        << "  what timeline [hybrid|local|global|home] [--limit N]\n"
        << "  what search <query> [--limit N]\n"
        << "  what react <noteId> <reaction>\n"
        << "  what unreact <noteId>\n"
        << "  what notif [--limit N]\n"
        << "  what user <username> [--host <host>]\n"
        << "  what me\n"
        << "  what follow <userId>\n"
        << "  what unfollow <userId>\n";
}

// Simple arg parser helpers
std::string get_flag(const std::vector<std::string>& args,
                     const std::string& flag,
                     const std::string& default_val = "") {
    for (size_t i = 0; i < args.size(); i++) {
        if (args[i] == flag && i + 1 < args.size()) {
            return args[i + 1];
        }
    }
    return default_val;
}

int get_flag_int(const std::vector<std::string>& args,
                 const std::string& flag, int default_val = 10) {
    std::string val = get_flag(args, flag);
    if (val.empty()) return default_val;
    try { return std::stoi(val); } catch (...) { return default_val; }
}

// Collect all positional args (not starting with --)
std::vector<std::string> positional(const std::vector<std::string>& args) {
    std::vector<std::string> result;
    for (size_t i = 0; i < args.size(); i++) {
        if (args[i].starts_with("--")) {
            i++; // skip flag value
        } else {
            result.push_back(args[i]);
        }
    }
    return result;
}

int cmd_stream(const AppConfig& cfg) {
    EventHandler handler;
    if (cfg.output_format == "human") {
        handler.format = OutputFormat::Human;
    } else {
        handler.format = OutputFormat::JSONL;
    }

    handler.command.config.enabled =
        cfg.raw.at_path("Command.enabled").value_or(false);
    handler.command.config.program =
        cfg.raw.at_path("Command.program").value_or<std::string>("");

    if (auto* arr = cfg.raw.at_path("Command.args").as_array()) {
        for (const auto& v : *arr) {
            if (auto s = v.value<std::string>())
                handler.command.config.args.push_back(*s);
        }
    }
    if (auto* arr = cfg.raw.at_path("Command.events").as_array()) {
        for (const auto& v : *arr) {
            if (auto s = v.value<std::string>())
                handler.command.config.events.push_back(*s);
        }
    }
    handler.command.config.max_queue_size =
        cfg.raw.at_path("Command.max_queue_size").value_or(100);

    handler.start();

    websocket client(handler);
    client.connect(cfg.uri, cfg.token);
    return 0;
}

int main(int argc, char* argv[]) {
#ifdef _WIN32
    std::setlocale(LC_ALL, ".UTF8");
#else
    std::setlocale(LC_ALL, "");
#endif

    AppConfig cfg = load_config();
    api client(cfg.uri, cfg.token);

    // Collect args
    std::vector<std::string> args;
    for (int i = 1; i < argc; i++) {
        args.emplace_back(argv[i]);
    }

    // Default: stream if no args
    if (args.empty() || args[0] == "stream") {
        return cmd_stream(cfg);
    }

    std::string cmd = args[0];
    std::vector<std::string> rest(args.begin() + 1, args.end());
    auto pos = positional(rest);

    if (cmd == "post") {
        if (pos.empty()) {
            std::cerr << "Usage: what post <text> [--cw <cw>] [--visibility <vis>] [--reply <noteId>] [--quote <noteId>]" << std::endl;
            return 1;
        }
        std::string text = pos[0];
        std::string cw = get_flag(rest, "--cw");
        std::string vis = get_flag(rest, "--visibility", "public");
        std::string reply_id = get_flag(rest, "--reply");
        std::string quote_id = get_flag(rest, "--quote");
        print_result(client.note_create(text, vis, cw, reply_id, quote_id));

    } else if (cmd == "reply") {
        if (pos.size() < 2) { std::cerr << "Usage: what reply <noteId> <text> [--cw <cw>] [--visibility <vis>]" << std::endl; return 1; }
        std::string cw = get_flag(rest, "--cw");
        std::string vis = get_flag(rest, "--visibility", "public");
        print_result(client.note_create(pos[1], vis, cw, pos[0]));

    } else if (cmd == "quote") {
        if (pos.size() < 2) { std::cerr << "Usage: what quote <noteId> <text> [--cw <cw>] [--visibility <vis>]" << std::endl; return 1; }
        std::string cw = get_flag(rest, "--cw");
        std::string vis = get_flag(rest, "--visibility", "public");
        print_result(client.note_create(pos[1], vis, cw, "", pos[0]));

    } else if (cmd == "renote" || cmd == "rn") {
        if (pos.empty()) { std::cerr << "Usage: what renote <noteId>" << std::endl; return 1; }
        print_result(client.renote(pos[0]));

    } else if (cmd == "upload") {
        if (pos.empty()) { std::cerr << "Usage: what upload <file> [--name <name>] [--folder <folderId>] [--nsfw]" << std::endl; return 1; }
        std::string name = get_flag(rest, "--name");
        std::string folder = get_flag(rest, "--folder");
        bool nsfw = false;
        for (const auto& a : rest) { if (a == "--nsfw") { nsfw = true; break; } }
        print_result(client.drive_upload(pos[0], name, folder, nsfw));

    } else if (cmd == "post-image" || cmd == "pi") {
        if (pos.empty()) { std::cerr << "Usage: what post-image <file> [<text>] [--cw <cw>] [--visibility <vis>] [--nsfw]" << std::endl; return 1; }
        std::string file_path = pos[0];
        std::string text = pos.size() >= 2 ? pos[1] : "";
        std::string cw = get_flag(rest, "--cw");
        std::string vis = get_flag(rest, "--visibility", "public");
        bool nsfw = false;
        for (const auto& a : rest) { if (a == "--nsfw") { nsfw = true; break; } }

        // Upload file first
        json upload_result = client.drive_upload(file_path, "", "", nsfw);
        if (upload_result.contains("error")) {
            std::cerr << "Upload failed: " << upload_result.dump() << std::endl;
            return 1;
        }
        std::string file_id = upload_result.value("id", "");
        if (file_id.empty()) {
            std::cerr << "Upload succeeded but no file ID returned" << std::endl;
            return 1;
        }

        std::string reply_id = get_flag(rest, "--reply");
        std::string quote_id = get_flag(rest, "--quote");
        print_result(client.note_create_with_files(text, {file_id}, vis, cw, reply_id, quote_id));

    } else if (cmd == "delete") {
        if (pos.empty()) { std::cerr << "Usage: what delete <noteId>" << std::endl; return 1; }
        print_result(client.note_delete(pos[0]));

    } else if (cmd == "show") {
        if (pos.empty()) { std::cerr << "Usage: what show <noteId>" << std::endl; return 1; }
        print_result(client.note_show(pos[0]));

    } else if (cmd == "timeline" || cmd == "tl") {
        std::string type = pos.empty() ? "hybrid" : pos[0];
        int limit = get_flag_int(rest, "--limit", 10);
        print_result(client.timeline(type, limit));

    } else if (cmd == "search") {
        if (pos.empty()) { std::cerr << "Usage: what search <query>" << std::endl; return 1; }
        int limit = get_flag_int(rest, "--limit", 10);
        print_result(client.search_notes(pos[0], limit));

    } else if (cmd == "react") {
        if (pos.size() < 2) { std::cerr << "Usage: what react <noteId> <reaction>" << std::endl; return 1; }
        print_result(client.reaction_create(pos[0], pos[1]));

    } else if (cmd == "unreact") {
        if (pos.empty()) { std::cerr << "Usage: what unreact <noteId>" << std::endl; return 1; }
        print_result(client.reaction_delete(pos[0]));

    } else if (cmd == "notif" || cmd == "notifications") {
        int limit = get_flag_int(rest, "--limit", 10);
        print_result(client.notifications(limit));

    } else if (cmd == "user") {
        if (pos.empty()) { std::cerr << "Usage: what user <username> [--host <host>]" << std::endl; return 1; }
        std::string host = get_flag(rest, "--host");
        print_result(client.user_show(pos[0], host));

    } else if (cmd == "me") {
        print_result(client.me());

    } else if (cmd == "follow") {
        if (pos.empty()) { std::cerr << "Usage: what follow <userId>" << std::endl; return 1; }
        print_result(client.follow(pos[0]));

    } else if (cmd == "unfollow") {
        if (pos.empty()) { std::cerr << "Usage: what unfollow <userId>" << std::endl; return 1; }
        print_result(client.unfollow(pos[0]));

    } else {
        std::cerr << "Unknown command: " << cmd << std::endl;
        print_usage();
        return 1;
    }

    return 0;
}
