package com.wilo.benchmark

import java.io.File

data class Reply(
    val text: String,
    val promptTokens: Int,
    val replyTokens: Int,
    val finishReason: String,
    val timing: Timing,
)

/** How long one reply took, measured the same way as the laptop and iOS benchmarks. */
data class Timing(
    /** From starting the request until the first token of the reply exists. */
    val timeToFirstTokenMs: Double,
    /** Processing the prompt only. */
    val promptMs: Double,
    /** Writing the reply only, after the prompt was processed. */
    val replyMs: Double,
    /** The whole request. */
    val totalMs: Double,
    val promptTokens: Int,
    val replyTokens: Int,
) {
    val promptTokensPerSecond get() = if (promptMs > 0) promptTokens / promptMs * 1000 else 0.0
    val replyTokensPerSecond get() = if (replyMs > 0) replyTokens / replyMs * 1000 else 0.0
}

/** A model in memory, ready to generate. Closing it frees its memory. */
class LoadedModel(val file: File) : AutoCloseable {
    private val handle = LlamaNative.loadModel(file.path, CONTEXT_SIZE, THREADS)
    private var closed = false

    /** Generate a reply to already-rendered prompt text. */
    fun generate(prompt: String, maxTokens: Int): Reply {
        check(!closed) { "The model has been unloaded." }
        val reply = LlamaNative.generate(handle, prompt, maxTokens)
        val timing = Timing(
            reply.timeToFirstTokenMs, reply.promptMs, reply.replyMs, reply.totalMs,
            reply.promptTokens, reply.replyTokens,
        )
        return Reply(
            reply.text.toString(Charsets.UTF_8), reply.promptTokens, reply.replyTokens, reply.finishReason, timing,
        )
    }

    override fun close() {
        if (!closed) {
            LlamaNative.freeModel(handle)
            closed = true
        }
    }

    companion object {
        /** The same context size as the laptop and iOS benchmarks. */
        const val CONTEXT_SIZE = 4096

        /** 2 to 4 threads, leaving 2 cores free, as in llama.cpp's Android example. */
        val THREADS = (Runtime.getRuntime().availableProcessors() - 2).coerceIn(2, 4)
    }
}
