import Foundation
import llama

enum LlamaError: LocalizedError {
    case modelLoadFailed(String)
    case contextFailed(String)
    case tokenizeFailed
    case generationFailed(Int32)

    var errorDescription: String? {
        switch self {
        case .modelLoadFailed(let file): return "Could not load \(file). It may be incomplete, or too new for this llama.cpp."
        case .contextFailed(let file): return "Loaded \(file), but could not create its context. The phone may be out of memory."
        case .tokenizeFailed: return "Could not tokenize the prompt."
        case .generationFailed(let status): return "Generating failed (llama_decode returned \(status))."
        }
    }
}

struct Reply: Sendable {
    let text: String
    let promptTokens: Int
    let replyTokens: Int
    let finishReason: String
    let timing: Timing
}

/// How long one reply took, measured the same way as the laptop benchmarks.
struct Timing: Sendable {
    /// From starting the request until the first token of the reply exists.
    let timeToFirstTokenMs: Double
    /// Processing the prompt only.
    let promptMs: Double
    /// Writing the reply only, after the prompt was processed.
    let replyMs: Double
    /// The whole request.
    let totalMs: Double

    let promptTokens: Int
    let replyTokens: Int

    var promptTokensPerSecond: Double { promptMs > 0 ? Double(promptTokens) / promptMs * 1000 : 0 }
    var replyTokensPerSecond: Double { replyMs > 0 ? Double(replyTokens) / replyMs * 1000 : 0 }
}

/// Milliseconds on a clock that only moves forward, for measuring durations.
private func nowMs() -> Double {
    Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
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

    /// Generate a reply to already-rendered prompt text, one token at a time.
    /// Always picks the most likely token, like temperature 0 on the laptop.
    func generate(prompt: String, maxTokens: Int) throws -> Reply {
        let started = nowMs()
        let vocab = llama_model_get_vocab(model)
        var promptTokens = try tokenize(prompt, vocab: vocab)
        let promptTokenCount = promptTokens.count

        // Forget the previous prompt, so nothing is reused between runs.
        llama_memory_clear(llama_get_memory(context), true)

        let sampler = llama_sampler_chain_init(llama_sampler_chain_default_params())
        defer { llama_sampler_free(sampler) }
        llama_sampler_chain_add(sampler, llama_sampler_init_greedy())

        let status = promptTokens.withUnsafeMutableBufferPointer { buffer in
            llama_decode(context, llama_batch_get_one(buffer.baseAddress, Int32(buffer.count)))
        }
        guard status == 0 else { throw LlamaError.generationFailed(status) }
        // On the GPU, llama_decode can return before the work is done. Wait for
        // it, so the prompt time is real.
        llama_synchronize(context)
        let promptDone = nowMs()

        var firstTokenAt: Double?
        var replyBytes: [UInt8] = []
        var replyTokenCount = 0
        var finishReason = "length"
        while replyTokenCount < maxTokens {
            var token = llama_sampler_sample(sampler, context, -1)
            if firstTokenAt == nil {
                firstTokenAt = nowMs()
            }
            if llama_vocab_is_eog(vocab, token) {
                finishReason = "stop"
                break
            }
            replyBytes += piece(of: token, vocab: vocab)
            replyTokenCount += 1

            let status = withUnsafeMutablePointer(to: &token) { pointer in
                llama_decode(context, llama_batch_get_one(pointer, 1))
            }
            guard status == 0 else { throw LlamaError.generationFailed(status) }
        }

        llama_synchronize(context)
        let finished = nowMs()

        return Reply(
            text: String(decoding: replyBytes, as: UTF8.self),
            promptTokens: promptTokenCount,
            replyTokens: replyTokenCount,
            finishReason: finishReason,
            timing: Timing(
                timeToFirstTokenMs: (firstTokenAt ?? finished) - started,
                promptMs: promptDone - started,
                replyMs: finished - promptDone,
                totalMs: finished - started,
                promptTokens: promptTokenCount,
                replyTokens: replyTokenCount
            )
        )
    }

    private func tokenize(_ text: String, vocab: OpaquePointer?) throws -> [llama_token] {
        let length = Int32(text.utf8.count)
        // At most one token per byte, plus the start-of-text token.
        var tokens = [llama_token](repeating: 0, count: Int(length) + 1)
        // Same options as eval/render_prompts.py, so the token counts can be compared.
        let count = llama_tokenize(vocab, text, length, &tokens, Int32(tokens.count), true, true)
        guard count >= 0 else { throw LlamaError.tokenizeFailed }
        return Array(tokens.prefix(Int(count)))
    }

    private func piece(of token: llama_token, vocab: OpaquePointer?) -> [UInt8] {
        var buffer = [CChar](repeating: 0, count: 64)
        var length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        if length < 0 {
            // A negative length means the buffer was too small, and how much is needed.
            buffer = [CChar](repeating: 0, count: Int(-length))
            length = llama_token_to_piece(vocab, token, &buffer, Int32(buffer.count), 0, false)
        }
        return buffer.prefix(Int(max(0, length))).map { UInt8(bitPattern: $0) }
    }

    deinit {
        llama_free(context)
        llama_model_free(model)
    }
}
