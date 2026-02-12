#ifndef EVENT_HANDLER
#define EVENT_HANDLER

#include <iostream>
#include <string>
#include <chrono>
#include <iomanip>
#include <sstream>
#include <functional>
#include <nlohmann/json.hpp>
#include "command_executor.hpp"

using json = nlohmann::json;

namespace Misskey {

    enum class OutputFormat {
        Human,  // Human-readable colored output
        JSONL,  // One JSON object per line (easy for LLM bots to parse)
    };

    // Get current ISO8601 timestamp
    inline std::string now_iso8601() {
        auto now = std::chrono::system_clock::now();
        auto time_t_now = std::chrono::system_clock::to_time_t(now);
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            now.time_since_epoch()) % 1000;

        std::tm tm_buf;
#ifdef _WIN32
        localtime_s(&tm_buf, &time_t_now);
#else
        localtime_r(&time_t_now, &tm_buf);
#endif

        std::ostringstream oss;
        oss << std::put_time(&tm_buf, "%Y-%m-%dT%H:%M:%S");
        oss << '.' << std::setfill('0') << std::setw(3) << ms.count();
        oss << std::put_time(&tm_buf, "%z");
        return oss.str();
    }

    // Truncate text for display
    inline std::string truncate(const std::string& s, size_t max_len = 200) {
        if (s.size() <= max_len) return s;
        return s.substr(0, max_len) + "...";
    }

    // Strip CW / newlines for single-line display
    inline std::string oneline(const std::string& s) {
        std::string out;
        out.reserve(s.size());
        for (char c : s) {
            if (c == '\n' || c == '\r') out += ' ';
            else out += c;
        }
        return out;
    }

    // Extract compact user info
    inline json extract_user(const json& user) {
        json u;
        u["username"] = user.value("username", "");
        u["name"] = user.value("name", json(nullptr));
        u["host"] = user.value("host", json(nullptr));
        return u;
    }

    // Build a full @user@host handle
    inline std::string user_handle(const json& user) {
        std::string handle = "@" + user.value("username", "???");
        if (user.contains("host") && !user["host"].is_null()) {
            handle += "@" + user["host"].get<std::string>();
        }
        return handle;
    }

    // Extract compact note info
    inline json extract_note(const json& note) {
        json n;
        n["id"] = note.value("id", "");
        n["text"] = note.value("text", json(nullptr));
        n["cw"] = note.value("cw", json(nullptr));
        n["visibility"] = note.value("visibility", "public");
        n["createdAt"] = note.value("createdAt", "");
        n["user"] = extract_user(note.at("user"));

        // Renote info
        if (note.contains("renote") && !note["renote"].is_null()) {
            n["renote"] = extract_note(note["renote"]);
        }

        // Reply info
        if (note.contains("reply") && !note["reply"].is_null()) {
            n["replyTo"] = note["reply"].value("id", "");
        }

        // File count
        if (note.contains("files") && note["files"].is_array()) {
            n["fileCount"] = note["files"].size();
        }

        // Reactions summary count
        if (note.contains("reactions") && note["reactions"].is_object()) {
            n["reactionCount"] = note["reactions"].size();
        }

        return n;
    }

    class EventHandler {
    public:
        OutputFormat format = OutputFormat::JSONL;
        CommandExecutor command;

        void start() {
            command.start();
        }

        // Process a raw streaming message from Misskey
        void handle(const std::string& raw) {
            json msg;
            try {
                msg = json::parse(raw);
            } catch (const json::parse_error& e) {
                emit_error("json_parse_error", e.what());
                return;
            }

            std::string type = msg.value("type", "");

            if (type == "channel") {
                handle_channel(msg);
            } else {
                // Unknown top-level event
                emit_event("unknown", {{"rawType", type}});
            }
        }

        // System events the caller can emit directly
        void emit_connected(const std::string& uri) {
            emit_event("connected", {{"uri", uri}});
        }

        void emit_disconnected(const std::string& reason) {
            emit_event("disconnected", {{"reason", reason}});
        }

        void emit_error(const std::string& code, const std::string& detail) {
            emit_event("error", {{"code", code}, {"detail", detail}});
        }

        void emit_reconnecting() {
            emit_event("reconnecting", {});
        }

    private:
        void handle_channel(const json& msg) {
            const auto& body = msg.at("body");
            std::string channel = body.value("id", "");
            std::string event_type = body.value("type", "");

            if (channel == "social" || channel == "hybridTimeline" ||
                channel == "local" || channel == "global" || channel == "home") {
                handle_timeline_event(channel, event_type, body);
            } else if (channel == "main") {
                handle_main_event(event_type, body);
            } else {
                emit_event("channel_event", {
                    {"channel", channel},
                    {"eventType", event_type}
                });
            }
        }

        void handle_timeline_event(const std::string& channel,
                                   const std::string& event_type,
                                   const json& body) {
            if (event_type == "note" && body.contains("body")) {
                const auto& note = body.at("body");
                json payload;
                payload["channel"] = channel;
                payload["note"] = extract_note(note);
                emit_event("note", payload);
            } else {
                emit_event("timeline_event", {
                    {"channel", channel},
                    {"eventType", event_type}
                });
            }
        }

        void handle_main_event(const std::string& event_type, const json& body) {
            if (event_type == "notification" && body.contains("body")) {
                const auto& notif = body.at("body");
                json payload;
                payload["notificationType"] = notif.value("type", "");
                payload["id"] = notif.value("id", "");

                if (notif.contains("user") && !notif["user"].is_null()) {
                    payload["user"] = extract_user(notif["user"]);
                }
                if (notif.contains("note") && !notif["note"].is_null()) {
                    payload["note"] = extract_note(notif["note"]);
                }
                if (notif.contains("reaction")) {
                    payload["reaction"] = notif["reaction"];
                }

                emit_event("notification", payload);

            } else if (event_type == "followed" && body.contains("body")) {
                json payload;
                payload["user"] = extract_user(body.at("body"));
                emit_event("followed", payload);

            } else if (event_type == "mention" && body.contains("body")) {
                json payload;
                payload["note"] = extract_note(body.at("body"));
                emit_event("mention", payload);

            } else if (event_type == "unreadNotification") {
                emit_event("unreadNotification", {});

            } else {
                emit_event("main_event", {{"eventType", event_type}});
            }
        }

        // Core emit function
        void emit_event(const std::string& event, const json& data) {
            if (format == OutputFormat::JSONL) {
                emit_jsonl(event, data);
            } else {
                emit_human(event, data);
            }

            // Forward to external command if configured
            command.send(event, data);
        }

        void emit_jsonl(const std::string& event, const json& data) {
            json line;
            line["ts"] = now_iso8601();
            line["event"] = event;
            line["data"] = data;
            std::cout << line.dump(-1, ' ', false, json::error_handler_t::replace) << std::endl;
        }

        void emit_human(const std::string& event, const json& data) {
            std::string ts = now_iso8601();
            std::ostringstream oss;
            oss << "[" << ts << "] ";

            if (event == "note") {
                std::string user = user_handle(data.at("note").at("user"));
                std::string channel = data.value("channel", "?");
                std::string text = data["note"].value("text", "");
                bool is_renote = data["note"].contains("renote");
                std::string cw = data["note"].value("cw", "");

                oss << "[" << channel << "] " << user;
                if (is_renote && text.empty()) {
                    std::string rt_user = user_handle(data["note"]["renote"]["user"]);
                    oss << " RN " << rt_user << ": "
                        << oneline(truncate(data["note"]["renote"].value("text", "")));
                } else {
                    if (!cw.empty()) oss << " [CW: " << oneline(cw) << "]";
                    oss << ": " << oneline(truncate(text));
                }

            } else if (event == "notification") {
                std::string ntype = data.value("notificationType", "");
                oss << "[NOTIF:" << ntype << "]";
                if (data.contains("user")) {
                    oss << " from " << user_handle(data["user"]);
                }
                if (data.contains("reaction")) {
                    oss << " " << data["reaction"].get<std::string>();
                }
                if (data.contains("note") && data["note"].contains("text")) {
                    oss << " on \"" << oneline(truncate(data["note"].value("text", ""), 80)) << "\"";
                }

            } else if (event == "followed") {
                oss << "[FOLLOWED] by " << user_handle(data["user"]);

            } else if (event == "mention") {
                std::string user = user_handle(data.at("note").at("user"));
                oss << "[MENTION] " << user << ": "
                    << oneline(truncate(data["note"].value("text", "")));

            } else if (event == "connected") {
                oss << "[SYSTEM] Connected to " << data.value("uri", "");

            } else if (event == "disconnected") {
                oss << "[SYSTEM] Disconnected: " << data.value("reason", "");

            } else if (event == "reconnecting") {
                oss << "[SYSTEM] Reconnecting...";

            } else if (event == "error") {
                oss << "[ERROR] " << data.value("code", "") << ": " << data.value("detail", "");

            } else {
                oss << "[" << event << "] " << data.dump();
            }

            std::cout << oss.str() << std::endl;
        }
    };

} // namespace Misskey

#endif // EVENT_HANDLER
