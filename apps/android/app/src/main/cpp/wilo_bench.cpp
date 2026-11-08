// The bridge between the Kotlin app and llama.cpp (JNI). Each function here
// matches an `external fun` in LlamaNative.kt.

#include <jni.h>

#include "ggml-backend.h"
#include "llama.h"

extern "C" JNIEXPORT void JNICALL
Java_com_wilo_benchmark_LlamaNative_init(JNIEnv *env, jobject, jstring native_lib_dir) {
    // llama.cpp is built in several CPU variants (one per set of processor
    // features). Loading them all lets it pick the fastest this phone supports.
    const char *path = env->GetStringUTFChars(native_lib_dir, nullptr);
    ggml_backend_load_all_from_path(path);
    env->ReleaseStringUTFChars(native_lib_dir, path);

    llama_backend_init();
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_wilo_benchmark_LlamaNative_systemInfo(JNIEnv *env, jobject) {
    return env->NewStringUTF(llama_print_system_info());
}
