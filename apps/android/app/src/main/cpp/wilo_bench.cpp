// The bridge between the Kotlin app and llama.cpp (JNI). Each function here
// matches an `external fun` in LlamaNative.kt.

#include <jni.h>

#include <string>

#include "ggml-backend.h"
#include "llama.h"

namespace {

// A loaded model and its context. Kotlin holds a pointer to it as a Long.
struct Session {
    llama_model *model;
    llama_context *context;
};

void throw_error(JNIEnv *env, const std::string &message) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), message.c_str());
}

}  // namespace

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

extern "C" JNIEXPORT jlong JNICALL
Java_com_wilo_benchmark_LlamaNative_loadModel(JNIEnv *env, jobject, jstring model_path, jint context_size, jint threads) {
    const char *path = env->GetStringUTFChars(model_path, nullptr);
    const std::string file = path;
    llama_model *model = llama_model_load_from_file(path, llama_model_default_params());
    env->ReleaseStringUTFChars(model_path, path);
    if (model == nullptr) {
        throw_error(env, "Could not load " + file + ". It may be incomplete, or too new for this llama.cpp.");
        return 0;
    }

    llama_context_params params = llama_context_default_params();
    params.n_ctx = context_size;
    params.n_threads = threads;
    params.n_threads_batch = threads;
    llama_context *context = llama_init_from_model(model, params);
    if (context == nullptr) {
        llama_model_free(model);
        throw_error(env, "Loaded the model, but could not create its context. The phone may be out of memory.");
        return 0;
    }
    return reinterpret_cast<jlong>(new Session{model, context});
}

extern "C" JNIEXPORT void JNICALL
Java_com_wilo_benchmark_LlamaNative_freeModel(JNIEnv *, jobject, jlong handle) {
    auto *session = reinterpret_cast<Session *>(handle);
    llama_free(session->context);
    llama_model_free(session->model);
    delete session;
}
