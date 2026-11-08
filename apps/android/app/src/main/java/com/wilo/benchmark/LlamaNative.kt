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
}
