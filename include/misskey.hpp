#ifndef MISSKEY 
#define MISSKEY

#include <curl/curl.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace Misskey {
    class misskey {
        public:            
            static void postToNote(std::string uri, std::string token, std::string text) {
                std::string notes_create_url = "https://" + uri + "/api/notes/create";

                json data;
                data["i"] = token;
                data["text"] = text;
                data["visibility"] = "public";

                std::string json_string = data.dump();

                CURL *curl = curl_easy_init();
                struct curl_slist *headers = NULL;

                if (curl) {
                    curl_easy_setopt(curl, CURLOPT_URL, notes_create_url.c_str());
                    curl_easy_setopt(curl, CURLOPT_POST, 1L);

                    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, json_string.c_str());
                    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, json_string.length());

                    headers = curl_slist_append(headers, "Content-Type: application/json");

                    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);

                    CURLcode response = curl_easy_perform(curl);

                    curl_slist_free_all(headers);
                    curl_easy_cleanup(curl);

                    if(response != CURLE_OK) {
                        std::cerr << "Post failed: " << curl_easy_strerror(response) << std::endl;
                        exit(1);
                    }
                }

                curl_global_cleanup();
            }
    };
}

#endif MISSKEY