package com.wilo.benchmark

import java.io.File

/** A model in memory, ready to generate. Closing it frees its memory. */
class LoadedModel(val file: File) : AutoCloseable {
    private val handle = LlamaNative.loadModel(file.path, CONTEXT_SIZE, THREADS)
    private var closed = false

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
