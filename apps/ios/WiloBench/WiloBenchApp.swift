import SwiftUI
import UIKit
import llama

@main
struct WiloBenchApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

@MainActor
final class AppState: ObservableObject {
    @Published var modelFiles: [URL] = []
    @Published var status = "No model loaded."
    @Published var isBusy = false

    @Published var reply = ""
    @Published var loadedModelKey: String?

    @Published var deviceStatus = ""

    @Published var benchmarkProgress = ""

    let prompts = try? RenderedPrompts.loadFromBundle()
    private var loaded: LoadedModel?
    private var loadedFile: URL?
    private var memory = MemoryPeak()

    /// Read memory and temperature, and show them.
    private func updateDeviceStatus() {
        memory.sample()
        deviceStatus = memory.summary + " Temperature: \(DeviceProbe.thermalState())."
    }

    var promptIds: [String] { prompts?.promptIds ?? [] }

    /// Model files copied into the app's Documents folder (see apps/ios/README.md).
    func refreshModelFiles() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let files = (try? FileManager.default.contentsOfDirectory(at: documents, includingPropertiesForKeys: nil)) ?? []
        modelFiles = files
            .filter { $0.pathExtension == "gguf" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    func load(_ file: URL) async {
        isBusy = true
        defer { isBusy = false }

        // Free the previous model first, so two are never in memory at once.
        loaded = nil
        loadedFile = nil
        loadedModelKey = nil
        reply = ""
        // Each model gets its own peak.
        memory = MemoryPeak()
        deviceStatus = ""
        status = "Loading \(file.lastPathComponent)..."

        let started = ProcessInfo.processInfo.systemUptime  // only moves forward
        do {
            loaded = try await Task.detached { try LoadedModel(path: file.path) }.value
            let seconds = ProcessInfo.processInfo.systemUptime - started
            status = "Loaded \(file.lastPathComponent) in \(String(format: "%.1f", seconds)) s."
            updateDeviceStatus()
            loadedFile = file
            loadedModelKey = prompts?.modelKey(forFile: file.lastPathComponent)
            if loadedModelKey == nil {
                status += " It isn't one of the benchmark models, so it has no prompts."
            }
        } catch {
            status = error.localizedDescription
        }
    }

    /// At launch: report a benchmark that iOS interrupted last time, if any.
    func checkForInterruptedBenchmark() {
        // A benchmark in progress also has the marker file; that isn't a crash.
        guard !isBusy else { return }
        if let message = BenchmarkRun.recoverInterruptedRun() {
            status = message
        }
    }

    /// The full benchmark for the loaded model: 20 runs, saved to results/.
    func runBenchmark() async {
        guard let file = loadedFile, let key = loadedModelKey, let prompts else { return }
        isBusy = true
        // iOS pauses apps when the screen locks, which would stop the benchmark.
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            isBusy = false
            UIApplication.shared.isIdleTimerDisabled = false
        }

        // The benchmark loads the model itself, so free this copy first.
        loaded = nil
        reply = ""
        deviceStatus = ""
        status = "Running the benchmark. Keep the app open; this takes a few minutes."
        benchmarkProgress = "Starting..."

        let benchmark = BenchmarkRun(modelFile: file, modelKey: key, prompts: prompts)
        let resultsURL = await Task.detached {
            benchmark.run { done, total in
                Task { @MainActor in self.benchmarkProgress = "Run \(done) of \(total) done." }
            }
        }.value

        benchmarkProgress = ""
        status = "Benchmark finished: \(benchmark.summary)\nSaved as results/\(resultsURL.lastPathComponent)."
        // The model was unloaded for the benchmark; tap it again to try prompts.
        loadedFile = nil
        loadedModelKey = nil
    }

    func run(promptId: String) async {
        guard let model = loaded, let prompts, let key = loadedModelKey,
              let prompt = prompts.models[key]?[promptId] else { return }
        isBusy = true
        defer { isBusy = false }

        reply = ""
        status = "Generating a reply to \(promptId)..."

        let maxTokens = prompts.maxTokens
        do {
            let result = try await Task.detached {
                try model.generate(prompt: prompt.text, maxTokens: maxTokens)
            }.value
            let t = result.timing
            reply = result.text
            status = "\(result.promptTokens) prompt tokens, \(result.replyTokens) reply tokens "
                + "in \(String(format: "%.1f", t.totalMs / 1000)) s (\(result.finishReason)).\n"
                + String(
                    format: "First token after %.0f ms. Prompt %.1f tokens/s, reply %.1f tokens/s.",
                    t.timeToFirstTokenMs, t.promptTokensPerSecond, t.replyTokensPerSecond
                )
            updateDeviceStatus()
            // A different count means the phone isn't seeing what the laptop saw.
            if result.promptTokens != prompt.tokens {
                status += " Warning: expected \(prompt.tokens) prompt tokens."
            }
        } catch {
            status = error.localizedDescription
        }
    }
}

struct ContentView: View {
    @StateObject private var state = AppState()

    /// What llama.cpp supports on this phone.
    private let systemInfo = String(cString: llama_print_system_info())

    var body: some View {
        NavigationStack {
            List {
                Section("Models on this iPhone") {
                    if state.modelFiles.isEmpty {
                        Text("None yet. See 'Copy a model onto the iPhone' in apps/ios/README.md.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(state.modelFiles, id: \.self) { file in
                        Button(file.lastPathComponent) {
                            Task { await state.load(file) }
                        }
                        .disabled(state.isBusy)
                    }
                }
                if state.loadedModelKey != nil {
                    Section("Benchmark") {
                        Button("Run benchmark (20 runs)") {
                            Task { await state.runBenchmark() }
                        }
                        .disabled(state.isBusy)
                    }
                    Section("Try a prompt") {
                        ForEach(state.promptIds, id: \.self) { promptId in
                            Button(promptId) {
                                Task { await state.run(promptId: promptId) }
                            }
                            .disabled(state.isBusy)
                        }
                    }
                }
                Section("Status") {
                    Text(state.status)
                    if !state.benchmarkProgress.isEmpty {
                        Text(state.benchmarkProgress).bold()
                    }
                    if !state.deviceStatus.isEmpty {
                        Text(state.deviceStatus).foregroundStyle(.secondary)
                    }
                }
                if !state.reply.isEmpty {
                    Section("Reply") {
                        Text(state.reply).font(.footnote.monospaced())
                    }
                }
                Section("llama.cpp on this phone") {
                    Text(systemInfo).font(.footnote.monospaced())
                }
            }
            .navigationTitle("Wilo Bench")
            .refreshable { state.refreshModelFiles() }
            .onAppear {
                state.refreshModelFiles()
                state.checkForInterruptedBenchmark()
            }
        }
    }
}
