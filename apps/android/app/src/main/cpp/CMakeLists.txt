# Builds llama.cpp from the pinned source in third_party/llama.cpp, plus our
# small JNI bridge, into the app's native libraries. Based on llama.cpp's own
# Android example (examples/llama.android).

cmake_minimum_required(VERSION 3.22.1)
project(wilo_bench LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(LLAMA_SRC ${CMAKE_CURRENT_LIST_DIR}/../../../../../../third_party/llama.cpp)
if(NOT EXISTS ${LLAMA_SRC}/CMakeLists.txt)
    message(FATAL_ERROR "llama.cpp source not found. Run eval/fetch_llama_cpp.sh from the repository root first.")
endif()

if(ANDROID_ABI STREQUAL "arm64-v8a")
    # Real phones. KleidiAI adds Arm's optimised matrix routines.
    set(GGML_CPU_KLEIDIAI ON CACHE BOOL "" FORCE)
    set(GGML_OPENMP ON CACHE BOOL "" FORCE)
elseif(ANDROID_ABI STREQUAL "x86_64")
    # The emulator on a laptop: only for checking that the app works.
    set(GGML_CPU_KLEIDIAI OFF CACHE BOOL "" FORCE)
    set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
else()
    message(FATAL_ERROR "Unsupported ABI: ${ANDROID_ABI}")
endif()

add_subdirectory(${LLAMA_SRC} build-llama)

add_library(wilo_bench SHARED wilo_bench.cpp)
target_link_libraries(wilo_bench llama android log)
