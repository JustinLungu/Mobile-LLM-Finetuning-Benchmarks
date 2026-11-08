package com.wilo.benchmark

/** Kotlin side of the JNI bridge in src/main/cpp/wilo_bench.cpp. */
object LlamaNative {
    init {
        System.loadLibrary("wilo_bench")
    }

    /** Load llama.cpp's backends from the app's native library folder. Call once, first. */
    external fun init(nativeLibDir: String)

    /** What llama.cpp detects on this phone, such as the CPU features it uses. */
    external fun systemInfo(): String

    /** Load a model and create its context. Returns a handle; throws IllegalStateException on failure. */
    external fun loadModel(path: String, contextSize: Int, threads: Int): Long

    /** Free a model loaded with loadModel. */
    external fun freeModel(handle: Long)

    /** Generate a reply to rendered prompt text. Throws IllegalStateException on failure. */
    external fun generate(handle: Long, prompt: String, maxTokens: Int): NativeReply
}

/** Built by the native code; LoadedModel turns it into a Reply. */
class NativeReply(
    val text: ByteArray,
    val promptTokens: Int,
    val replyTokens: Int,
    val finishReason: String,
    val timeToFirstTokenMs: Double,
    val promptMs: Double,
    val replyMs: Double,
    val totalMs: Double,
)
