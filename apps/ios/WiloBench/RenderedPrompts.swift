import Foundation

/// The benchmark prompts in each model's exact final text.
/// Generated on a computer by eval/render_prompts.py, and bundled in the app.
struct RenderedPrompts: Decodable, Sendable {
    struct Prompt: Decodable, Sendable {
        let text: String
        let tokens: Int
    }

    /// What a results file records about a model.
    struct ModelDetails: Decodable, Sendable {
        let file: String
        let quant: String
        let sizeBytes: Int64
        let sha256: String

        enum CodingKeys: String, CodingKey {
            case file, quant, sha256
            case sizeBytes = "size_bytes"
        }
    }

    let promptsVersion: Int
    let llamaCppTag: String
    let llamaCppCommit: String
    let maxTokens: Int
    let promptIds: [String]
    let files: [String: String]
    let modelDetails: [String: ModelDetails]
    let models: [String: [String: Prompt]]

    enum CodingKeys: String, CodingKey {
        case promptsVersion = "prompts_version"
        case llamaCppTag = "llama_cpp_tag"
        case llamaCppCommit = "llama_cpp_commit"
        case maxTokens = "max_tokens"
        case promptIds = "prompt_ids"
        case files
        case modelDetails = "model_details"
        case models
    }

    static func loadFromBundle() throws -> RenderedPrompts {
        guard let url = Bundle.main.url(forResource: "rendered_prompts", withExtension: "json") else {
            throw CocoaError(.fileNoSuchFile)
        }
        return try JSONDecoder().decode(RenderedPrompts.self, from: Data(contentsOf: url))
    }

    /// The registry key of a model file, e.g. qwen3.5-2b for Qwen3.5-2B-Q4_K_M.gguf.
    func modelKey(forFile name: String) -> String? {
        files.first { $0.value == name }?.key
    }
}
