#include "misskey_websocket.hpp"
#include "misskey.hpp"
#include <toml++/toml.hpp>
#include <windows.h>

using namespace Misskey;

std::string get_executable_dir() {
    std::string path(MAX_PATH, '\0');
    char* path_data = path.data();
    GetModuleFileNameA(NULL, path_data, MAX_PATH);

    path.resize(strlen(path.data()));
    path.shrink_to_fit();

    std::filesystem::path exe_path(std::move(path));
    std::filesystem::path exe_dir = exe_path.parent_path();
    return exe_dir.string();
}

int main() {
    std::setlocale(LC_ALL, ".UTF8");

    std::string executable_path = get_executable_dir();

    std::string config_file_path = executable_path;
    config_file_path.append("\\config.toml");

    if (!std::filesystem::exists(config_file_path)) {
        std::cerr << "Please set config to " << config_file_path << ", bye" << std::endl;
        return 1;
    }

    toml::table config = toml::parse_file(config_file_path);

    std::string& uri = config.at_path("Secrets.uri").ref<std::string>();
    std::string& token = config.at_path("Secrets.token").ref<std::string>();

    // std::cout << "いまどうしてる？: ";
    // std::string line;
    // std::getline(std::cin, line);

    // misskey::postNote(uri, token, line);

    websocket client;
    client.connect(uri, token);
}
