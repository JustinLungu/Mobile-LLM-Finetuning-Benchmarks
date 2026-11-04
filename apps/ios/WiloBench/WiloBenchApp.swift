import SwiftUI
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

    private var loaded: LoadedModel?

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
        status = "Loading \(file.lastPathComponent)..."

        let started = Date()
        do {
            loaded = try await Task.detached { try LoadedModel(path: file.path) }.value
            let seconds = Date().timeIntervalSince(started)
            status = "Loaded \(file.lastPathComponent) in \(String(format: "%.1f", seconds)) s."
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
                Section("Status") {
                    Text(state.status)
                }
                Section("llama.cpp on this phone") {
                    Text(systemInfo).font(.footnote.monospaced())
                }
            }
            .navigationTitle("Wilo Bench")
            .refreshable { state.refreshModelFiles() }
            .onAppear { state.refreshModelFiles() }
        }
    }
}
