/**
 * Performance Monitor
 * Tracks execution time of features and DOM observer handlers
 * using a rolling window for CPU percentage calculations.
 */

const WINDOW_MS = 5000;

/**
 * When the script started, as the clock the rest of the timings are quoted
 * against. `performance.now()` is already relative to page navigation, but the
 * userscript runs at document-start and the difference matters when the
 * question is "what happened before my feature got a turn".
 */
const BOOT_AT = typeof performance !== 'undefined' ? performance.now() : 0;

class PerformanceMonitor {
    constructor() {
        this.measurements = new Map();
        this.snapshots = new Map();
        // Named moments on the startup timeline, in the order they happened
        this.marks = [];
        // Work that a snapshot was made of, broken into its parts
        this.spans = new Map();
        this.bootAt = BOOT_AT;
        this.windowMs = WINDOW_MS;
        this.enabled = false;
        this._onVisibilityChange = () => {
            this._tabVisible = !document.hidden;
        };
        this._tabVisible = true;
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibilityChange);
        }
    }

    /**
     * Record a timing measurement
     * @param {string} name - Metric name (e.g. "dom:MarketFilter", "init:tooltipPrices")
     * @param {number} durationMs - Duration in milliseconds
     */
    record(name, durationMs) {
        if (!this.enabled || !this._tabVisible) return;
        if (!this.measurements.has(name)) {
            this.measurements.set(name, []);
        }
        this.measurements.get(name).push({ time: Date.now(), duration: durationMs });
    }

    /**
     * Store a one-time snapshot measurement that persists beyond the rolling window
     *
     * `startedAt` is what makes a startup trace readable: a feature that took six
     * seconds is one fact, and whether it took them at second two or second
     * fourteen is a different one — and only the second says what else was
     * waiting behind it.
     *
     * @param {string} name - Metric name
     * @param {number} durationMs - Duration in milliseconds
     * @param {number} [startedAt] - Milliseconds since boot when it began
     */
    snapshot(name, durationMs, startedAt) {
        this.snapshots.set(name, {
            duration: durationMs,
            time: Date.now(),
            startedAt: startedAt ?? this.sinceBoot() - durationMs,
        });
    }

    /** @returns {number} Milliseconds since the script started */
    sinceBoot() {
        return (typeof performance !== 'undefined' ? performance.now() : 0) - this.bootAt;
    }

    /**
     * Note that something happened, and when.
     *
     * Marks answer the question a list of durations cannot: where did the gaps
     * go. Half of a slow start is usually spent waiting — for IndexedDB, for the
     * game's own data to arrive — and waiting shows up in nobody's duration.
     *
     * @param {string} name - What happened, e.g. `storage:open`
     * @param {Object} [detail] - Anything worth carrying alongside
     */
    mark(name, detail = null) {
        this.marks.push({ name, at: this.sinceBoot(), detail });
    }

    /**
     * Time a part of something already being timed.
     *
     * A feature that takes six seconds is a question, not an answer. Spans are
     * how the answer gets recorded — which call inside it was the six seconds —
     * and they are always on, because the run worth profiling is the one that
     * already happened.
     *
     * @param {string} name - Parent metric, e.g. `init:networth`
     * @param {string} part - What this piece is, e.g. `recalculate`
     * @returns {Function} Call it when the piece is done
     */
    startSpan(name, part) {
        const startedAt = this.sinceBoot();
        return () => {
            const duration = this.sinceBoot() - startedAt;
            if (!this.spans.has(name)) this.spans.set(name, []);
            this.spans.get(name).push({ part, duration, startedAt });
            return duration;
        };
    }

    /**
     * Run a function, recording how long its part took.
     *
     * @param {string} name - Parent metric
     * @param {string} part - What this piece is
     * @param {Function} fn - The work
     * @returns {*} Whatever the work returned
     */
    async span(name, part, fn) {
        const end = this.startSpan(name, part);
        try {
            return await fn();
        } finally {
            end();
        }
    }

    /** @returns {Array<Object>} The parts of one metric, longest first */
    getSpans(name) {
        return [...(this.spans.get(name) || [])].sort((a, b) => b.duration - a.duration);
    }

    /** @returns {Array<Object>} Every mark, in the order they happened */
    getMarks() {
        return [...this.marks].sort((a, b) => a.at - b.at);
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
            if (!monitor.enabled || !monitor._tabVisible) return fn.apply(this, args);
            const start = performance.now();
            try {
                const result = fn.apply(this, args);
                if (result && typeof result.then === 'function') {
                    return result.finally(() => monitor.record(name, performance.now() - start));
                }
                monitor.record(name, performance.now() - start);
                return result;
            } catch (error) {
                monitor.record(name, performance.now() - start);
                throw error;
            }
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
            cpuPercent: Math.min((totalMs / this.windowMs) * 100, 100),
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
        this.spans.clear();
        // Marks are the startup trace and cannot be taken again without a
        // reload, so resetting the rolling stats leaves them alone
    }
}

const performanceMonitor = new PerformanceMonitor();

export default performanceMonitor;
