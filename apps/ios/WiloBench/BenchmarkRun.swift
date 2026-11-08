import Foundation

/// Runs the benchmark for one model: the 5 prompts, 4 times, reloading the
/// model before each repeat, like Wilo loads it each time it wakes up.
///
/// The results file is written after every run. If iOS kills the app partway,
/// the runs so far are already saved, and the next launch adds the reason
/// (see `recoverInterruptedRun`).
final class BenchmarkRun: @unchecked Sendable {
    /// 4 repeats of the 5 prompts: the 20 back-to-back runs of the reliability check.
    static let repeats = 4

    /// Where results files are saved, visible in Finder and the Files app.
    static let resultsDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("results", isDirectory: true)

    static let interruptedMessage =
        "The benchmark didn't finish: the app closed during it. iOS may have stopped it for using too much memory, "
        + "or it was closed by hand."

    /// Exists only while a benchmark runs, and holds the results file's name.
    private static let markerFile = resultsDir.appendingPathComponent(".running")

    private let modelFile: URL
    private let modelKey: String
    private let prompts: RenderedPrompts
    private var results: ResultsFile
    private let resultsURL: URL
    private var memory = MemoryPeak()

    init(modelFile: URL, modelKey: String, prompts: RenderedPrompts) {
        self.modelFile = modelFile
        self.modelKey = modelKey
        self.prompts = prompts
        let details = prompts.modelDetails[modelKey]
        let timestamp = ResultsFile.timestampNow()
        results = ResultsFile(
            timestamp: timestamp,
            device: .current(),
            engine: .init(
                llamaCppTag: prompts.llamaCppTag,
                llamaCppCommit: prompts.llamaCppCommit,
                threads: LoadedModel.threads
            ),
            model: .init(
                key: modelKey,
                file: details?.file ?? modelFile.lastPathComponent,
                quant: details?.quant ?? "unknown",
                sizeBytes: details?.sizeBytes ?? 0,
                sha256: details?.sha256 ?? ""
            ),
            settings: .init(
                ctxSize: Int(LoadedModel.contextSize),
                maxTokens: prompts.maxTokens,
                promptsVersion: prompts.promptsVersion,
                repeats: Self.repeats
            ),
            reliability: .init(runsRequested: Self.repeats * prompts.promptIds.count)
        )
        // Same naming as the laptop: <model>-<backend>-<UTC time>.json
        let stamp = timestamp.replacingOccurrences(of: "-", with: "").replacingOccurrences(of: ":", with: "")
        resultsURL = Self.resultsDir.appendingPathComponent("\(modelKey)-metal-\(stamp).json")
    }

    /// Run everything. Reports progress as (runs done, runs requested). Returns
    /// the results file, which records any failure instead of throwing.
    func run(progress: @escaping @Sendable (Int, Int) -> Void) -> URL {
        try? FileManager.default.createDirectory(at: Self.resultsDir, withIntermediateDirectories: true)
        try? Data(resultsURL.lastPathComponent.utf8).write(to: Self.markerFile)
        defer { try? FileManager.default.removeItem(at: Self.markerFile) }

        let thermalAtStart = DeviceProbe.thermalState()
        // Until the last run finishes, every saved copy says it didn't finish.
        // So a run that iOS kills is recorded correctly even if nobody opens
        // the app again to recover it.
        results.reliability.error = Self.interruptedMessage
        do {
            for repeatIndex in 0..<Self.repeats {
                let started = ProcessInfo.processInfo.systemUptime
                let model = try LoadedModel(path: modelFile.path)
                results.loadTimesS.append(ProcessInfo.processInfo.systemUptime - started)
                memory.sample()

                for promptId in prompts.promptIds {
                    guard let prompt = prompts.models[modelKey]?[promptId] else { continue }
                    let reply = try model.generate(prompt: prompt.text, maxTokens: prompts.maxTokens)
                    let timing = reply.timing
                    results.runs.append(.init(
                        promptId: promptId,
                        repeat: repeatIndex,
                        promptTokens: reply.promptTokens,
                        replyTokens: reply.replyTokens,
                        finishReason: reply.finishReason,
                        timeToFirstTokenMs: timing.timeToFirstTokenMs,
                        promptTokensPerS: timing.promptTokensPerSecond,
                        replyTokensPerS: timing.replyTokensPerSecond,
                        totalMs: timing.totalMs
                    ))
                    results.reliability.runsCompleted += 1
                    memory.sample()
                    save(thermalStart: thermalAtStart)
                    progress(results.reliability.runsCompleted, results.reliability.runsRequested)
                }
                // `model` is released here, freeing its memory before the next load.
            }
            results.reliability.error = nil
        } catch {
            results.reliability.error = error.localizedDescription
        }
        save(thermalStart: thermalAtStart)
        return resultsURL
    }

    /// A one-paragraph summary, using medians like the laptop's results table.
    var summary: String {
        func median(_ values: [Double]) -> Double {
            let sorted = values.sorted()
            guard !sorted.isEmpty else { return 0 }
            let middle = sorted.count / 2
            return sorted.count % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
        }
        let r = results.reliability
        var text = "\(r.runsCompleted)/\(r.runsRequested) runs"
        if let error = r.error {
            return text + ". Stopped: \(error)"
        }
        text += String(
            format: ". Load %.1f s, first token %.0f ms, reply %.1f tokens/s",
            median(results.loadTimesS),
            median(results.runs.map(\.timeToFirstTokenMs)),
            median(results.runs.map(\.replyTokensPerS))
        )
        if let bytes = results.peakMemory.bytes {
            text += String(format: ", peak memory %.2f GB", Double(bytes) / 1e9)
        }
        return text + "."
    }

    private func save(thermalStart: String) {
        if memory.peakBytes > 0 {
            results.peakMemory = .init(bytes: memory.peakBytes, method: "phys_footprint (sampled)")
            results.notes = String(
                format: "Lowest remaining memory allowed by iOS: %.2f GB.", Double(memory.lowestRemainingBytes) / 1e9
            )
        }
        results.thermal = .init(start: thermalStart, end: DeviceProbe.thermalState())
        try? results.write(to: resultsURL)
    }

    /// Call at launch. If a benchmark was running when the app last closed, iOS
    /// most likely stopped it; record that in its results file. Returns a
    /// message to show, or nil.
    static func recoverInterruptedRun() -> String? {
        guard let name = try? String(contentsOf: markerFile, encoding: .utf8) else { return nil }
        try? FileManager.default.removeItem(at: markerFile)
        let url = resultsDir.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url),
              var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var reliability = json["reliability"] as? [String: Any] else { return nil }
        reliability["error"] = interruptedMessage
        json["reliability"] = reliability
        if let updated = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]) {
            try? updated.write(to: url, options: .atomic)
        }
        let completed = reliability["runs_completed"] as? Int ?? 0
        return "The last benchmark (\(name)) stopped after \(completed) runs, probably because iOS closed the app. "
            + "This is recorded in its results file."
    }
}
