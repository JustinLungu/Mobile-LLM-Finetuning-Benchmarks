// The bridge between the Kotlin app and llama.cpp (JNI). Each function here
// matches an `external fun` in LlamaNative.kt.

#include <jni.h>

#include <string>
#include <vector>

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

// Generate a reply to already-rendered prompt text, one token at a time. Always
// picks the most likely token, like temperature 0 on the laptop. Returns a
// NativeReply; the text goes back as UTF-8 bytes, because JNI strings use a
// modified UTF-8 that can't hold every character.
extern "C" JNIEXPORT jobject JNICALL
Java_com_wilo_benchmark_LlamaNative_generate(JNIEnv *env, jobject, jlong handle, jstring prompt_text, jint max_tokens) {
    auto *session = reinterpret_cast<Session *>(handle);
    const llama_vocab *vocab = llama_model_get_vocab(session->model);

    // Same options as eval/render_prompts.py, so the token counts can be compared.
    const char *text = env->GetStringUTFChars(prompt_text, nullptr);
    const std::string prompt = text;
    env->ReleaseStringUTFChars(prompt_text, text);
    std::vector<llama_token> tokens(prompt.size() + 1);
    const int count = llama_tokenize(vocab, prompt.c_str(), (int32_t) prompt.size(),
                                     tokens.data(), (int32_t) tokens.size(), true, true);
    if (count < 0) {
        throw_error(env, "Could not tokenize the prompt.");
        return nullptr;
    }
    tokens.resize(count);

    // Forget the previous prompt, so nothing is reused between runs.
    llama_memory_clear(llama_get_memory(session->context), true);

    llama_sampler *sampler = llama_sampler_chain_init(llama_sampler_chain_default_params());
    llama_sampler_chain_add(sampler, llama_sampler_init_greedy());

    int status = llama_decode(session->context, llama_batch_get_one(tokens.data(), (int32_t) tokens.size()));
    std::string reply;
    int reply_tokens = 0;
    const char *finish_reason = "length";
    while (status == 0 && reply_tokens < max_tokens) {
        llama_token token = llama_sampler_sample(sampler, session->context, -1);
        if (llama_vocab_is_eog(vocab, token)) {
            finish_reason = "stop";
            break;
        }
        char piece[256];
        const int length = llama_token_to_piece(vocab, token, piece, sizeof(piece), 0, false);
        if (length > 0) {
            reply.append(piece, length);
        }
        reply_tokens++;
        status = llama_decode(session->context, llama_batch_get_one(&token, 1));
    }
    llama_sampler_free(sampler);
    if (status != 0) {
        throw_error(env, "Generating failed (llama_decode returned " + std::to_string(status) + ").");
        return nullptr;
    }

    jbyteArray reply_bytes = env->NewByteArray((jsize) reply.size());
    env->SetByteArrayRegion(reply_bytes, 0, (jsize) reply.size(), reinterpret_cast<const jbyte *>(reply.data()));
    jclass reply_class = env->FindClass("com/wilo/benchmark/NativeReply");
    jmethodID constructor = env->GetMethodID(reply_class, "<init>", "([BIILjava/lang/String;)V");
    return env->NewObject(reply_class, constructor, reply_bytes, count, reply_tokens,
                          env->NewStringUTF(finish_reason));
}
