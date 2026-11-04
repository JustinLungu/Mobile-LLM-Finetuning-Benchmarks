import Foundation
import llama

enum LlamaError: LocalizedError {
    case modelLoadFailed(String)
    case contextFailed(String)

    var errorDescription: String? {
        switch self {
        case .modelLoadFailed(let file): return "Could not load \(file). It may be incomplete, or too new for this llama.cpp."
        case .contextFailed(let file): return "Loaded \(file), but could not create its context. The phone may be out of memory."
        }
    }
}

/// A model in memory, ready to generate. Freeing this object frees its memory.
final class LoadedModel: @unchecked Sendable {
    /// The same context size as the laptop benchmarks (see eval/llama_server.py).
    static let contextSize: UInt32 = 4096

    private static let backend: Void = llama_backend_init()

    let model: OpaquePointer
    let context: OpaquePointer

    init(path: String) throws {
        _ = Self.backend
        let file = URL(fileURLWithPath: path).lastPathComponent

        var modelParams = llama_model_default_params()
        modelParams.n_gpu_layers = 999  // everything on the phone's GPU (Metal)
        guard let model = llama_model_load_from_file(path, modelParams) else {
            throw LlamaError.modelLoadFailed(file)
        }

        var contextParams = llama_context_default_params()
        contextParams.n_ctx = Self.contextSize
        // Mostly unused, since the GPU does the work. Stays clear of the slow cores.
        let threads = Int32(max(1, min(4, ProcessInfo.processInfo.processorCount - 2)))
        contextParams.n_threads = threads
        contextParams.n_threads_batch = threads
        guard let context = llama_init_from_model(model, contextParams) else {
            llama_model_free(model)
            throw LlamaError.contextFailed(file)
        }

        self.model = model
        self.context = context
    }

    deinit {
        llama_free(context)
        llama_model_free(model)
    }
}
