package com.wilo.benchmark

import android.app.Activity
import android.os.Bundle
import android.widget.TextView

/** For now, only proves that the app builds and starts. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply {
            text = "Wilo Bench"
            textSize = 28f
            setPadding(48, 96, 48, 48)
        })
    }
}
