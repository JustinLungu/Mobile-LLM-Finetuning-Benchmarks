package com.wilo.benchmark

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import java.io.File
import java.util.Locale

/** Memory and temperature readings from Android, for the benchmark results. */
class DeviceProbe(private val context: Context) {

    /**
     * Fields of /proc/self/status, in bytes. Android is Linux underneath, so
     * this is the same source as the laptop benchmarks: VmHWM (peak memory),
     * VmRSS (memory now) and RssAnon (the part not mapped from the model file).
     */
    private fun status(): Map<String, Long> =
        File("/proc/self/status").readLines()
            .mapNotNull { line -> Regex("""^(\w+):\s+(\d+) kB""").find(line) }
            .associate { it.groupValues[1] to it.groupValues[2].toLong() * 1024 }

    /**
     * Restart Linux's peak-memory counter (VmHWM), so the next peak belongs to
     * the next model only. Returns false if Android doesn't allow it.
     */
    fun resetPeak(): Boolean = try {
        File("/proc/self/clear_refs").writeText("5")
        true
    } catch (e: Exception) {
        false
    }

    fun peakBytes(): Long? = status()["VmHWM"]
    fun currentBytes(): Long? = status()["VmRSS"]
    fun privateBytes(): Long? = status()["RssAnon"]

    /** Memory the whole phone still has available. Android has no fixed per-app limit like iOS. */
    fun availableBytes(): Long {
        val info = ActivityManager.MemoryInfo()
        context.getSystemService(ActivityManager::class.java).getMemoryInfo(info)
        return info.availMem
    }

    /** The phone's temperature state, as Android reports it (Android 10 and later). */
    fun thermalState(): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unknown"
        return when (context.getSystemService(PowerManager::class.java).currentThermalStatus) {
            PowerManager.THERMAL_STATUS_NONE -> "none"
            PowerManager.THERMAL_STATUS_LIGHT -> "light"
            PowerManager.THERMAL_STATUS_MODERATE -> "moderate"
            PowerManager.THERMAL_STATUS_SEVERE -> "severe"
            PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
            PowerManager.THERMAL_STATUS_EMERGENCY -> "emergency"
            PowerManager.THERMAL_STATUS_SHUTDOWN -> "shutdown"
            else -> "unknown"
        }
    }
}

/**
 * The highest memory use seen while one model was loaded.
 *
 * Linux keeps a true peak (VmHWM), but for the whole app session, so it is
 * restarted when a model loads. If Android refuses that, the peak falls back to
 * the highest VmRSS sampled after loading and after each reply, like on iOS.
 */
class MemoryPeak(private val probe: DeviceProbe) {
    private val peakIsReset = probe.resetPeak()
    private var sampledPeak = 0L
    var lowestAvailableBytes = Long.MAX_VALUE
        private set

    val method get() = if (peakIsReset) "VmHWM" else "VmRSS (sampled)"

    val peakBytes: Long
        get() = if (peakIsReset) probe.peakBytes() ?: sampledPeak else sampledPeak

    fun sample() {
        probe.currentBytes()?.let { sampledPeak = maxOf(sampledPeak, it) }
        lowestAvailableBytes = minOf(lowestAvailableBytes, probe.availableBytes())
    }

    val summary: String
        get() = String.format(
            Locale.US, "Memory: peak %.2f GB (%s); the phone had %.2f GB left.",
            peakBytes / 1e9, method, lowestAvailableBytes / 1e9,
        )
}
