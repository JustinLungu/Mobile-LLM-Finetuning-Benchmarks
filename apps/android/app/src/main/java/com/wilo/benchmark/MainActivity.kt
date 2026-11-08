package com.wilo.benchmark

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LlamaNative.init(applicationInfo.nativeLibraryDir)

        // Showing llama.cpp's system info proves the native library builds, loads and runs.
        setContentView(TextView(this).apply {
            text = "Wilo Bench\n\nllama.cpp on this phone:\n${LlamaNative.systemInfo()}"
            textSize = 16f
            setPadding(48, 96, 48, 48)
        })
    }
}
