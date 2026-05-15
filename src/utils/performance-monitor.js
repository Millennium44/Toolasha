/**
 * Performance Monitor
 * Tracks execution time of features and DOM observer handlers
 * using a rolling window for CPU percentage calculations.
 */

const WINDOW_MS = 5000;

class PerformanceMonitor {
    constructor() {
        this.measurements = new Map();
        this.snapshots = new Map();
        this.windowMs = WINDOW_MS;
    }

    /**
     * Record a timing measurement
     * @param {string} name - Metric name (e.g. "dom:MarketFilter", "init:tooltipPrices")
     * @param {number} durationMs - Duration in milliseconds
     */
    record(name, durationMs) {
        if (!this.measurements.has(name)) {
            this.measurements.set(name, []);
        }
        this.measurements.get(name).push({ time: Date.now(), duration: durationMs });
    }

    /**
     * Store a one-time snapshot measurement that persists beyond the rolling window
     * @param {string} name - Metric name
     * @param {number} durationMs - Duration in milliseconds
     */
    snapshot(name, durationMs) {
        this.snapshots.set(name, { duration: durationMs, time: Date.now() });
    }

    /**
     * Wrap a function with automatic timing
     * @param {string} name - Metric name
     * @param {Function} fn - Function to wrap
     * @returns {Function} Wrapped function
     */
    wrap(name, fn) {
        const monitor = this;
        return function (...args) {
            const start = performance.now();
            const result = fn.apply(this, args);
            if (result && typeof result.then === 'function') {
                return result.finally(() => monitor.record(name, performance.now() - start));
            }
            monitor.record(name, performance.now() - start);
            return result;
        };
    }

    /**
     * Get stats for a single metric within the rolling window
     * @param {string} name - Metric name
     * @returns {{ calls: number, totalMs: number, avgMs: number, cpuPercent: number } | null}
     */
    getStats(name) {
        const entries = this.measurements.get(name);
        if (!entries || entries.length === 0) return null;

        const cutoff = Date.now() - this.windowMs;
        let calls = 0;
        let totalMs = 0;

        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].time < cutoff) break;
            calls++;
            totalMs += entries[i].duration;
        }

        if (calls === 0) return null;

        return {
            calls,
            totalMs,
            avgMs: totalMs / calls,
            cpuPercent: (totalMs / this.windowMs) * 100,
        };
    }

    /**
     * Get stats for all metrics, cleaning up stale data
     * @returns {Map<string, { calls: number, totalMs: number, avgMs: number, cpuPercent: number }>}
     */
    getAllStats() {
        this._cleanup();
        const result = new Map();

        for (const [name, entries] of this.measurements) {
            if (entries.length === 0) continue;
            const stats = this.getStats(name);
            if (stats) {
                result.set(name, stats);
            }
        }

        return result;
    }

    /**
     * Remove measurements older than the rolling window
     * @private
     */
    _cleanup() {
        const cutoff = Date.now() - this.windowMs;
        for (const [name, entries] of this.measurements) {
            let firstValid = 0;
            while (firstValid < entries.length && entries[firstValid].time < cutoff) {
                firstValid++;
            }
            if (firstValid > 0) {
                entries.splice(0, firstValid);
            }
            if (entries.length === 0) {
                this.measurements.delete(name);
            }
        }
    }

    /**
     * Get all snapshot measurements
     * @returns {Map<string, { duration: number, time: number }>}
     */
    getSnapshots() {
        return new Map(this.snapshots);
    }

    /**
     * Clear all measurements
     */
    reset() {
        this.measurements.clear();
        this.snapshots.clear();
    }
}

const performanceMonitor = new PerformanceMonitor();

export default performanceMonitor;
