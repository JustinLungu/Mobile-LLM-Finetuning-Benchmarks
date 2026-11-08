package com.wilo.benchmark

import android.app.Activity
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    /** Models and generation run here, so the screen keeps responding. */
    private val worker = Executors.newSingleThreadExecutor()
    private var loaded: LoadedModel? = null

    private lateinit var modelList: LinearLayout
    private lateinit var status: TextView

    /** Where model files go: Android/data/com.wilo.benchmark/files/ on the phone. */
    private val modelDir: File get() = getExternalFilesDir(null)!!

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        LlamaNative.init(applicationInfo.nativeLibraryDir)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 96, 48, 48)
        }
        content.addView(TextView(this).apply { text = "Wilo Bench"; textSize = 28f })
        content.addView(heading("Models on this phone"))
        modelList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(modelList)
        content.addView(Button(this).apply {
            text = "Refresh list"
            setOnClickListener { refreshModelList() }
        })
        content.addView(heading("Status"))
        status = TextView(this).apply { text = "No model loaded." }
        content.addView(status)
        content.addView(heading("llama.cpp on this phone"))
        content.addView(TextView(this).apply { text = LlamaNative.systemInfo(); textSize = 12f })

        setContentView(ScrollView(this).apply { addView(content) })
        refreshModelList()
    }

    override fun onDestroy() {
        worker.execute { loaded?.close() }
        worker.shutdown()
        super.onDestroy()
    }

    private fun heading(label: String) = TextView(this).apply {
        text = label
        textSize = 18f
        setPadding(0, 48, 0, 8)
    }

    private fun refreshModelList() {
        modelList.removeAllViews()
        val files = modelDir.listFiles { file -> file.extension == "gguf" }.orEmpty().sortedBy { it.name }
        if (files.isEmpty()) {
            modelList.addView(TextView(this).apply {
                text = "None yet. Copy a .gguf file to:\n${modelDir.path}"
            })
        }
        for (file in files) {
            modelList.addView(Button(this).apply {
                text = file.name
                isAllCaps = false
                setOnClickListener { load(file) }
            })
        }
    }

    private fun load(file: File) {
        status.text = "Loading ${file.name}..."
        worker.execute {
            // Free the previous model first, so two are never in memory at once.
            loaded?.close()
            loaded = null
            val started = System.nanoTime()
            val message = try {
                loaded = LoadedModel(file)
                val seconds = (System.nanoTime() - started) / 1e9
                String.format(Locale.US, "Loaded %s in %.1f s.", file.name, seconds)
            } catch (e: IllegalStateException) {
                e.message ?: "Loading failed."
            }
            runOnUiThread { status.text = message }
        }
    }
}
