package com.wilo.benchmark

import android.content.Context
import org.json.JSONObject

/**
 * The benchmark prompts in each model's exact final text.
 * Generated on a computer by eval/render_prompts.py, and bundled in the app.
 */
class RenderedPrompts(private val json: JSONObject) {
    class Prompt(val text: String, val tokens: Int)

    /** What a results file records about a model. */
    class ModelDetails(val file: String, val quant: String, val sizeBytes: Long, val sha256: String)

    val promptsVersion = json.getInt("prompts_version")
    val llamaCppTag: String = json.getString("llama_cpp_tag")
    val llamaCppCommit: String = json.getString("llama_cpp_commit")
    val maxTokens = json.getInt("max_tokens")
    val promptIds: List<String> = json.getJSONArray("prompt_ids").let { ids -> List(ids.length()) { ids.getString(it) } }
    private val files = json.getJSONObject("files")
    private val models = json.getJSONObject("models")

    /** The registry key of a model file, e.g. qwen3.5-2b for Qwen3.5-2B-Q4_K_M.gguf. */
    fun modelKey(fileName: String): String? = files.keys().asSequence().firstOrNull { files.getString(it) == fileName }

    fun modelDetails(modelKey: String): ModelDetails? {
        val details = json.optJSONObject("model_details")?.optJSONObject(modelKey) ?: return null
        return ModelDetails(
            details.getString("file"), details.getString("quant"), details.getLong("size_bytes"), details.getString("sha256"),
        )
    }

    fun prompt(modelKey: String, promptId: String): Prompt {
        val prompt = models.getJSONObject(modelKey).getJSONObject(promptId)
        return Prompt(prompt.getString("text"), prompt.getInt("tokens"))
    }

    companion object {
        fun load(context: Context): RenderedPrompts =
            RenderedPrompts(JSONObject(context.assets.open("rendered_prompts.json").bufferedReader().readText()))
    }
}
