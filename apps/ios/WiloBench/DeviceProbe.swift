import Foundation
import os

/// Memory and temperature readings from iOS, for the benchmark results.
enum DeviceProbe {
    /// The memory iOS counts against this app right now ("physical footprint"):
    /// the number it compares with its limit before killing the app. Nil if
    /// unavailable.
    static func footprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : nil
    }

    /// How much more memory iOS would let this app use before killing it.
    static func remainingBytes() -> UInt64 {
        UInt64(os_proc_available_memory())
    }

    /// The phone's temperature state, as iOS reports it: nominal, fair, serious or critical.
    static func thermalState() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}

/// The highest memory footprint seen while one model was loaded.
///
/// iOS's own peak counter covers the app's whole lifetime, so it would mix in
/// models loaded earlier. Instead, the footprint is read at the moments it is
/// highest (after loading, and after each reply, when everything the model
/// needs has been allocated) and the maximum is kept. Short spikes in between
/// could be missed.
struct MemoryPeak {
    private(set) var peakBytes: UInt64 = 0
    private(set) var lowestRemainingBytes: UInt64 = .max

    mutating func sample() {
        if let footprint = DeviceProbe.footprintBytes() {
            peakBytes = max(peakBytes, footprint)
        }
        lowestRemainingBytes = min(lowestRemainingBytes, DeviceProbe.remainingBytes())
    }

    var summary: String {
        let gigabytes = { (bytes: UInt64) in String(format: "%.2f GB", Double(bytes) / 1e9) }
        guard peakBytes > 0 else { return "Memory: unavailable." }
        return "Memory: peak \(gigabytes(peakBytes)); iOS would allow \(gigabytes(lowestRemainingBytes)) more."
    }
}
