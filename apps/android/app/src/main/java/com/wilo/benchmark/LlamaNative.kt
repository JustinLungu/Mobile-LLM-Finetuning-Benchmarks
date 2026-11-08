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
}
