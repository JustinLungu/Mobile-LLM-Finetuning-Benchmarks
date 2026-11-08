import Foundation
import UIKit

/// One benchmark results file, in the format of spec/results.schema.json. The
/// laptop's eval/validate_results.py and eval/summarize_results.py read these.
struct ResultsFile: Codable {
    struct Device: Codable {
        var name: String
        var platform = "ios"
        var os: String
        var chip: String
        var ramGb: Double
    }

    struct Engine: Codable {
        var llamaCppTag: String
        var llamaCppCommit: String
        var backend = "metal"
        var gpuLayers = "all"
        var threads: Int
    }

    struct Model: Codable {
        var key: String
        var file: String
        var quant: String
        var sizeBytes: Int64
        var sha256: String
        var finetuned = false
    }

    struct Settings: Codable {
        var ctxSize: Int
        var maxTokens: Int
        var temperature = 0
        var seed = 0
        var thinking = false
        var promptsVersion: Int
        var repeats: Int
    }

    struct Reliability: Codable {
        var runsRequested: Int
        var runsCompleted = 0
        var error: String?

        // The format requires "error" even when there is none, as null.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(runsRequested, forKey: .runsRequested)
            try container.encode(runsCompleted, forKey: .runsCompleted)
            try container.encode(error, forKey: .error)
        }
    }

    struct PeakMemory: Codable {
        var bytes: UInt64?
        var method: String?

        // The format requires both fields, as null when not measured yet.
        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(bytes, forKey: .bytes)
            try container.encode(method, forKey: .method)
        }
    }

    struct Thermal: Codable {
        var start: String
        var end: String
    }

    struct Run: Codable {
        var promptId: String
        var repeat: Int
        var promptTokens: Int
        var replyTokens: Int
        var finishReason: String
        var timeToFirstTokenMs: Double
        var promptTokensPerS: Double
        var replyTokensPerS: Double
        var totalMs: Double
    }

    var schemaVersion = 1
    var timestamp: String
    var notes: String?
    var device: Device
    var engine: Engine
    var model: Model
    var settings: Settings
    var reliability: Reliability
    var loadTimesS: [Double] = []
    var peakMemory = PeakMemory()
    var thermal: Thermal?
    var runs: [Run] = []

    /// Write the file, replacing any previous version in one step, so a crash
    /// mid-write can't leave a half-written file.
    func write(to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: url, options: .atomic)
    }

    /// The current time in UTC, in the format's timestamp style.
    static func timestampNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: Date())
    }
}

extension ResultsFile.Device {
    /// This iPhone. The model name and chip come from the hardware identifier,
    /// e.g. iPhone14,3 is an iPhone 13 Pro Max with an A15.
    static func current() -> ResultsFile.Device {
        var system = utsname()
        uname(&system)
        let identifier = withUnsafeBytes(of: &system.machine) { bytes in
            String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let (name, chip) = iPhoneModels[identifier] ?? (identifier, "unknown (\(identifier))")
        return ResultsFile.Device(
            name: name,
            os: "iOS \(UIDevice.current.systemVersion)",
            chip: chip,
            // Slightly less than the advertised size, because some is reserved.
            ramGb: (Double(ProcessInfo.processInfo.physicalMemory) / 1e9 * 10).rounded() / 10
        )
    }

    /// The iPhones most relevant to this project. Others are recorded by identifier.
    private static let iPhoneModels: [String: (String, String)] = [
        "iPhone13,1": ("iPhone 12 mini", "Apple A14 Bionic"),
        "iPhone13,2": ("iPhone 12", "Apple A14 Bionic"),
        "iPhone13,3": ("iPhone 12 Pro", "Apple A14 Bionic"),
        "iPhone13,4": ("iPhone 12 Pro Max", "Apple A14 Bionic"),
        "iPhone14,4": ("iPhone 13 mini", "Apple A15 Bionic"),
        "iPhone14,5": ("iPhone 13", "Apple A15 Bionic"),
        "iPhone14,2": ("iPhone 13 Pro", "Apple A15 Bionic"),
        "iPhone14,3": ("iPhone 13 Pro Max", "Apple A15 Bionic"),
        "iPhone14,6": ("iPhone SE (3rd generation)", "Apple A15 Bionic"),
        "iPhone14,7": ("iPhone 14", "Apple A15 Bionic"),
        "iPhone14,8": ("iPhone 14 Plus", "Apple A15 Bionic"),
        "iPhone15,2": ("iPhone 14 Pro", "Apple A16 Bionic"),
        "iPhone15,3": ("iPhone 14 Pro Max", "Apple A16 Bionic"),
        "iPhone15,4": ("iPhone 15", "Apple A16 Bionic"),
        "iPhone15,5": ("iPhone 15 Plus", "Apple A16 Bionic"),
        "iPhone16,1": ("iPhone 15 Pro", "Apple A17 Pro"),
        "iPhone16,2": ("iPhone 15 Pro Max", "Apple A17 Pro"),
    ]
}
