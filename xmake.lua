add_rules("mode.debug", "mode.release")
add_rules("plugin.compile_commands.autoupdate", {outputdir = ".vscode"})

add_requires("libcurl", "nlohmann_json", "toml++")

set_languages("c++23")

target("what")
    set_kind("binary")

    set_encodings("source:utf-8", "target:utf-8")

    add_files("src/main.cpp")

    add_packages("libcurl", "nlohmann_json", "toml++")
