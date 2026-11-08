package com.wilo.benchmark

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Runs the benchmark for one model: the 5 prompts, 4 times, reloading the model
 * before each repeat, like Wilo loads it each time it wakes up. Mirrors the iOS
 * app's BenchmarkRun.swift.
 *
 * The results file (spec/results.schema.json format) is written after every
 * run. Until the last run finishes, it says the benchmark didn't finish, so a
 * run that Android kills is still recorded correctly.
 */
class BenchmarkRun(
    private val context: Context,
    private val modelFile: File,
    private val modelKey: String,
    private val prompts: RenderedPrompts,
) {
    private val probe = DeviceProbe(context)
    private val timestamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }
        .format(Date())

    /** Same naming as the laptop: <model>-<backend>-<UTC time>.json */
    val resultsFile = File(resultsDir(context), "$modelKey-cpu-${timestamp.replace("-", "").replace(":", "")}.json")

    private val runsRequested = REPEATS * prompts.promptIds.size
    private val runs = JSONArray()
    private val loadTimes = JSONArray()
    private var error: String? = INTERRUPTED_MESSAGE
    private var memory: MemoryPeak? = null
    private var highestPrivateBytes = 0L
    private val thermalAtStart = probe.thermalState()

    val runsCompleted get() = runs.length()

    /** Run everything. Reports progress as (runs done, runs requested). Records failures instead of throwing. */
    fun run(progress: (Int, Int) -> Unit) {
        resultsDir(context).mkdirs()
        markerFile(context).writeText(resultsFile.name)
        // One peak for the whole benchmark, across all 4 loads.
        memory = MemoryPeak(probe)
        try {
            for (repeat in 0 until REPEATS) {
                val started = System.nanoTime()
                LoadedModel(modelFile).use { model ->
                    loadTimes.put((System.nanoTime() - started) / 1e9)
                    sampleMemory()
                    for (promptId in prompts.promptIds) {
                        val prompt = prompts.prompt(modelKey, promptId)
                        val reply = model.generate(prompt.text, prompts.maxTokens)
                        val t = reply.timing
                        runs.put(JSONObject().apply {
                            put("prompt_id", promptId)
                            put("repeat", repeat)
                            put("prompt_tokens", reply.promptTokens)
                            put("reply_tokens", reply.replyTokens)
                            put("finish_reason", reply.finishReason)
                            put("time_to_first_token_ms", t.timeToFirstTokenMs)
                            put("prompt_tokens_per_s", t.promptTokensPerSecond)
                            put("reply_tokens_per_s", t.replyTokensPerSecond)
                            put("total_ms", t.totalMs)
                        })
                        sampleMemory()
                        save()
                        progress(runsCompleted, runsRequested)
                    }
                }  // `use` frees the model here, before the next load.
            }
            error = null
        } catch (e: Exception) {
            // Any failure, not only llama.cpp's (e.g. a full storage), is recorded.
            error = e.message ?: e.javaClass.simpleName
        }
        try {
            save()
        } catch (e: Exception) {
            // Nothing more can be done; the last successful save remains.
        }
        markerFile(context).delete()
    }

    private fun sampleMemory() {
        memory?.sample()
        probe.privateBytes()?.let { highestPrivateBytes = maxOf(highestPrivateBytes, it) }
    }

    /** A one-paragraph summary, using medians like the laptop's results table. */
    val summary: String
        get() {
            fun median(values: List<Double>): Double {
                val sorted = values.sorted()
                if (sorted.isEmpty()) return 0.0
                val middle = sorted.size / 2
                return if (sorted.size % 2 == 0) (sorted[middle - 1] + sorted[middle]) / 2 else sorted[middle]
            }
            val text = "$runsCompleted/$runsRequested runs"
            error?.let { return "$text. Stopped: $it" }
            val all = (0 until runs.length()).map { runs.getJSONObject(it) }
            return String.format(
                Locale.US, "%s. Load %.1f s, first token %.0f ms, reply %.1f tokens/s, peak memory %.2f GB.",
                text,
                median((0 until loadTimes.length()).map { loadTimes.getDouble(it) }),
                median(all.map { it.getDouble("time_to_first_token_ms") }),
                median(all.map { it.getDouble("reply_tokens_per_s") }),
                (memory?.peakBytes ?: 0) / 1e9,
            )
        }

    private fun save() {
        val details = prompts.modelDetails(modelKey)
        val memory = memory
        val results = JSONObject().apply {
            put("schema_version", 1)
            put("timestamp", timestamp)
            memory?.let {
                put("notes", String.format(Locale.US, "Lowest available phone memory: %.2f GB.", it.lowestAvailableBytes / 1e9))
            }
            put("device", deviceInfo())
            put("engine", JSONObject().apply {
                put("llama_cpp_tag", prompts.llamaCppTag)
                put("llama_cpp_commit", prompts.llamaCppCommit)
                put("backend", "cpu")
                put("gpu_layers", "0")
                put("threads", LoadedModel.THREADS)
            })
            put("model", JSONObject().apply {
                put("key", modelKey)
                put("file", details?.file ?: modelFile.name)
                put("quant", details?.quant ?: "unknown")
                put("size_bytes", details?.sizeBytes ?: modelFile.length())
                put("sha256", details?.sha256 ?: "")
                put("finetuned", false)
            })
            put("settings", JSONObject().apply {
                put("ctx_size", LoadedModel.CONTEXT_SIZE)
                put("max_tokens", prompts.maxTokens)
                put("temperature", 0)
                put("seed", 0)
                put("thinking", false)
                put("prompts_version", prompts.promptsVersion)
                put("repeats", REPEATS)
            })
            put("reliability", JSONObject().apply {
                put("runs_requested", runsRequested)
                put("runs_completed", runsCompleted)
                put("error", error ?: JSONObject.NULL)
            })
            put("load_times_s", loadTimes)
            put("peak_memory", JSONObject().apply {
                if (memory != null && memory.peakBytes > 0) {
                    put("bytes", memory.peakBytes)
                    put("method", memory.method)
                    if (highestPrivateBytes > 0) put("private_bytes", highestPrivateBytes)
                } else {
                    put("bytes", JSONObject.NULL)
                    put("method", JSONObject.NULL)
                }
            })
            put("thermal", JSONObject().apply {
                put("start", thermalAtStart)
                put("end", probe.thermalState())
            })
            put("runs", runs)
        }
        // Write a temporary file, then rename it over the old one in one step,
        // so a crash mid-write can't leave a half-written file.
        val temporary = File(resultsFile.path + ".tmp")
        temporary.writeText(results.toString(2))
        temporary.renameTo(resultsFile)
    }

    private fun deviceInfo() = JSONObject().apply {
        put("name", "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}")
        put("platform", "android")
        put("os", "Android ${Build.VERSION.RELEASE}")
        // The exact chip name is only available from Android 12.
        put("chip", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "${Build.SOC_MANUFACTURER} ${Build.SOC_MODEL}" else Build.HARDWARE)
        val info = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(info)
        // Slightly less than the advertised size, because some is reserved.
        put("ram_gb", Math.round(info.totalMem / 1e9 * 10) / 10.0)
    }

    companion object {
        /** 4 repeats of the 5 prompts: the 20 back-to-back runs of the reliability check. */
        const val REPEATS = 4

        const val INTERRUPTED_MESSAGE =
            "The benchmark didn't finish: the app closed during it. Android may have stopped it for using too much " +
                "memory, or it was closed by hand."

        /** Android/data/com.wilo.benchmark/files/results/ on the phone; copy with `adb pull`. */
        fun resultsDir(context: Context) = File(context.getExternalFilesDir(null), "results")

        /** Exists only while a benchmark runs, and holds the results file's name. */
        private fun markerFile(context: Context) = File(resultsDir(context), ".running")

        /**
         * Call at launch. If a benchmark was running when the app last closed,
         * Android most likely stopped it. Its file already records that; this
         * removes the marker and returns a message to show, or null.
         */
        fun recoverInterruptedRun(context: Context): String? {
            val marker = markerFile(context)
            if (!marker.exists()) return null
            val name = marker.readText()
            marker.delete()
            val completed = try {
                JSONObject(File(resultsDir(context), name).readText()).getJSONObject("reliability").getInt("runs_completed")
            } catch (e: Exception) {
                return null
            }
            return "The last benchmark ($name) stopped after $completed runs, probably because Android closed the " +
                "app. This is recorded in its results file."
        }
    }
}
