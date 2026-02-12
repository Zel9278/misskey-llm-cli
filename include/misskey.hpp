#ifndef MISSKEY 
#define MISSKEY

#include <iostream>
#include <string>
#include <curl/curl.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace Misskey {

    // cURL write callback
    inline size_t curl_write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
        auto* buf = static_cast<std::string*>(userdata);
        buf->append(ptr, size * nmemb);
        return size * nmemb;
    }

    class api {
    public:
        std::string uri;
        std::string token;

        api(const std::string& uri, const std::string& token)
            : uri(uri), token(token) {}

        // Generic POST to /api/<endpoint>
        json post(const std::string& endpoint, json body = {}) const {
            std::string url = "https://" + uri + "/api/" + endpoint;
            body["i"] = token;
            std::string body_str = body.dump();

            CURL* curl = curl_easy_init();
            std::string response_buf;

            if (!curl) {
                std::cerr << "curl_easy_init failed" << std::endl;
                return json{{"error", "curl_init_failed"}};
            }

            struct curl_slist* headers = nullptr;
            headers = curl_slist_append(headers, "Content-Type: application/json");

            curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl, CURLOPT_POST, 1L);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body_str.c_str());
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, body_str.size());
            curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
            curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_cb);
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response_buf);

            CURLcode res = curl_easy_perform(curl);
            curl_slist_free_all(headers);
            curl_easy_cleanup(curl);

            if (res != CURLE_OK) {
                return json{{"error", curl_easy_strerror(res)}};
            }

            try {
                return json::parse(response_buf);
            } catch (...) {
                return json{{"error", "invalid_json"}, {"raw", response_buf}};
            }
        }

        // ---- Notes ----

        json note_create(const std::string& text,
                         const std::string& visibility = "public",
                         const std::string& cw = "",
                         const std::string& reply_id = "",
                         const std::string& renote_id = "") const {
            json body;
            body["text"] = text;
            body["visibility"] = visibility;
            if (!cw.empty()) body["cw"] = cw;
            if (!reply_id.empty()) body["replyId"] = reply_id;
            if (!renote_id.empty()) body["renoteId"] = renote_id;
            return post("notes/create", body);
        }

        json renote(const std::string& note_id) const {
            json body;
            body["renoteId"] = note_id;
            return post("notes/create", body);
        }

        json note_delete(const std::string& note_id) const {
            return post("notes/delete", {{"noteId", note_id}});
        }

        json note_show(const std::string& note_id) const {
            return post("notes/show", {{"noteId", note_id}});
        }

        json timeline(const std::string& type = "hybrid", int limit = 10) const {
            std::string endpoint = "notes/hybrid-timeline";
            if (type == "local") endpoint = "notes/local-timeline";
            else if (type == "global") endpoint = "notes/global-timeline";
            else if (type == "home") endpoint = "notes/timeline";
            return post(endpoint, {{"limit", limit}});
        }

        // ---- Reactions ----

        json reaction_create(const std::string& note_id,
                             const std::string& reaction) const {
            return post("notes/reactions/create",
                        {{"noteId", note_id}, {"reaction", reaction}});
        }

        json reaction_delete(const std::string& note_id) const {
            return post("notes/reactions/delete", {{"noteId", note_id}});
        }

        // ---- Notifications ----

        json notifications(int limit = 10) const {
            return post("i/notifications", {{"limit", limit}});
        }

        // ---- Users ----

        json user_show(const std::string& username,
                       const std::string& host = "") const {
            json body;
            body["username"] = username;
            if (!host.empty()) body["host"] = host;
            return post("users/show", body);
        }

        json me() const {
            return post("i");
        }

        // ---- Follow ----

        json follow(const std::string& user_id) const {
            return post("following/create", {{"userId", user_id}});
        }

        json unfollow(const std::string& user_id) const {
            return post("following/delete", {{"userId", user_id}});
        }

        // ---- Search ----

        json search_notes(const std::string& query, int limit = 10) const {
            return post("notes/search", {{"query", query}, {"limit", limit}});
        }
    };
}

#endif // MISSKEY