package com.wilo.benchmark

import android.content.Context
import org.json.JSONObject

/**
 * The benchmark prompts in each model's exact final text.
 * Generated on a computer by eval/render_prompts.py, and bundled in the app.
 */
class RenderedPrompts(json: JSONObject) {
    class Prompt(val text: String, val tokens: Int)

    val maxTokens = json.getInt("max_tokens")
    val promptIds: List<String> = json.getJSONArray("prompt_ids").let { ids -> List(ids.length()) { ids.getString(it) } }
    private val files = json.getJSONObject("files")
    private val models = json.getJSONObject("models")

    /** The registry key of a model file, e.g. qwen3.5-2b for Qwen3.5-2B-Q4_K_M.gguf. */
    fun modelKey(fileName: String): String? = files.keys().asSequence().firstOrNull { files.getString(it) == fileName }

    fun prompt(modelKey: String, promptId: String): Prompt {
        val prompt = models.getJSONObject(modelKey).getJSONObject(promptId)
        return Prompt(prompt.getString("text"), prompt.getInt("tokens"))
    }

    companion object {
        fun load(context: Context): RenderedPrompts =
            RenderedPrompts(JSONObject(context.assets.open("rendered_prompts.json").bufferedReader().readText()))
    }
}
