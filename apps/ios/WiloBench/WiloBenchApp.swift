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

struct ContentView: View {
    /// What llama.cpp supports on this phone. Showing it proves the library links and runs.
    private let systemInfo = String(cString: llama_print_system_info())

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Wilo Bench").font(.title)
            Text(systemInfo).font(.footnote.monospaced())
        }
        .padding()
    }
}
