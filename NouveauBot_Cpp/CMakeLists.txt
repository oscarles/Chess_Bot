cmake_minimum_required(VERSION 3.16)
project(ChessBot CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native")

# SFML installed via MSYS2 pacman
list(APPEND CMAKE_PREFIX_PATH "C:/msys64/mingw64")
find_package(SFML 3 COMPONENTS Graphics Window System REQUIRED)

add_executable(ChessBot
    src/main.cpp
    src/chess.cpp
    src/ai.cpp
)

target_include_directories(ChessBot PRIVATE src)
target_link_libraries(ChessBot SFML::Graphics SFML::Window SFML::System)

# Copier les DLLs MSYS2 nécessaires à côté de l'exe
add_custom_command(TARGET ChessBot POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        $<TARGET_RUNTIME_DLLS:ChessBot>
        $<TARGET_FILE_DIR:ChessBot>
    COMMAND_EXPAND_LISTS
)
