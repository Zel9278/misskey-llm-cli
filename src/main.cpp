#include <Shlwapi.h>
#pragma comment(lib, "Shlwapi.lib")
#include <iostream>
#include <vector>
#include <locale>
#include <curl/curl.h>
#include <nlohmann/json.hpp>
#include <toml++/toml.hpp>

using json = nlohmann::json;

static void postToMisskey(std::string uri, std::string token, std::string text) {
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

int main() {
    std::setlocale(LC_ALL, ".UTF8");

    TCHAR config_file_folder_path[_MAX_PATH];
    memset(config_file_folder_path, NULL, _countof(config_file_folder_path));
    GetModuleFileName(NULL, config_file_folder_path, _countof(config_file_folder_path));
    PathRemoveFileSpec(config_file_folder_path);

    std::string config_file_path = config_file_folder_path;
    config_file_path.append("\\config.toml");
    toml::table config = toml::parse_file(config_file_path);

    std::string& uri = config.at_path("Secrets.uri").ref<std::string>();
    std::string& token = config.at_path("Secrets.token").ref<std::string>();

    std::cout << "いまどうしてる？: ";
    std::string line;
    std::getline(std::cin, line);

    postToMisskey(uri, token, line);
}
