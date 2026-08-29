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
     * Start recording main-thread stalls, with attribution.
     *
     * A stall — a "longtask", any main-thread block over 50ms — is what a
     * player actually feels: the progress bars hitch. Every hunt so far has
     * started by hand-rolling exactly this observer in the console, then
     * guessing at attribution; the 2026-08-29 networth stutter took hours that
     * way. Recorded here instead, each stall is stamped with the instrumented
     * work (`record()` calls — dom handlers, event fan-outs, anything timed)
     * that finished inside or just after it, which is usually the culprit's
     * name.
     *
     * Runs while the pformance panel has measuring on, like the rolling stats.
     */
    startStallWatch() {
        if (this.stallObserver || typeof PerformanceObserver === 'undefined') return;
        this.stalls = this.stalls || [];
        try {
            this.stallObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    this.stalls.push({
                        time: Date.now(),
                        sinceBoot: Math.round(entry.startTime),
                        duration: Math.round(entry.duration),
                        suspects: this._suspectsFor(entry),
                        recentEvents: this._eventsFor(entry),
                    });
                    if (this.stalls.length > 200) this.stalls.shift();
                }
            });
            this.stallObserver.observe({ entryTypes: ['longtask'] });
        } catch {
            this.stallObserver = null;
        }
    }

    /** Stop recording stalls; what was recorded stays readable. */
    stopStallWatch() {
        this.stallObserver?.disconnect();
        this.stallObserver = null;
    }

    /**
     * The instrumented work that overlapped a stall.
     *
     * Measurements are stamped with `Date.now()` when they *finish*; a longtask
     * entry carries `performance.now()` times. Aligned onto one clock, anything
     * timed that ended between the stall starting and shortly after it ended is
     * a suspect — "shortly after" because the observer and the recorder both
     * run a beat behind the work itself.
     *
     * @param {PerformanceEntry} entry - The longtask
     * @returns {Array<{name: string, ms: number}>} Largest first, at most five
     */
    _suspectsFor(entry) {
        const clockSkew = Date.now() - performance.now();
        const windowStart = entry.startTime + clockSkew - 50;
        const windowEnd = entry.startTime + entry.duration + clockSkew + 100;

        const suspects = [];
        for (const [name, entries] of this.measurements) {
            for (let i = entries.length - 1; i >= 0; i--) {
                const m = entries[i];
                if (m.time < windowStart) break;
                if (m.time <= windowEnd && m.duration >= 5) {
                    suspects.push({ name, ms: Math.round(m.duration) });
                }
            }
        }
        return suspects.sort((a, b) => b.ms - a.ms).slice(0, 5);
    }

    /**
     * Note that something arrived or happened, without a duration.
     *
     * For work this script can see but cannot time — a game message whose
     * processing happens in the page's own handler. A stall carrying no
     * measured suspects but a `ws:action_completed` moments before it is the
     * game's work, and knowing that ends the hunt instead of widening it.
     *
     * @param {string} name - e.g. `ws:items_updated`
     */
    noteEvent(name) {
        if (!this.enabled) return;
        this.events = this.events || [];
        this.events.push({ name, time: Date.now() });
        if (this.events.length > 300) this.events.shift();
    }

    /**
     * The noted events shortly before and inside a stall's window.
     * @param {PerformanceEntry} entry - The longtask
     * @returns {string[]} Names, most recent last, at most five
     */
    _eventsFor(entry) {
        if (!this.events?.length) return [];
        const clockSkew = Date.now() - performance.now();
        const windowStart = entry.startTime + clockSkew - 300;
        const windowEnd = entry.startTime + entry.duration + clockSkew;
        const names = [];
        for (let i = this.events.length - 1; i >= 0; i--) {
            const event = this.events[i];
            if (event.time < windowStart) break;
            if (event.time <= windowEnd) names.unshift(event.name);
        }
        return names.slice(-5);
    }

    /**
     * The recorded stalls, oldest first.
     * @returns {Array<{time: number, sinceBoot: number, duration: number, suspects: Array}>}
     */
    getStalls() {
        return [...(this.stalls || [])];
    }

    /**
     * Clear all measurements
     */
    reset() {
        this.measurements.clear();
        this.snapshots.clear();
        this.spans.clear();
        this.stalls = [];
        // Marks are the startup trace and cannot be taken again without a
        // reload, so resetting the rolling stats leaves them alone
    }
}

const performanceMonitor = new PerformanceMonitor();

/**
 * Name the code that asked for a timer, from the stack.
 *
 * Both stack formats are parsed: Chrome's (`Error` line, then `at name (url:line:col)`)
 * and Firefox's (`name@url:line:col` from the first line). Frames are skipped
 * by NAME, not by position — a fixed skip count picked the wrong frame on
 * Firefox and collapsed every interval into one call site (seen on the 3.29.0
 * trace). Production keeps function names, so the caller's name is part of the
 * label; line numbers only mean anything within one exact build.
 *
 * @returns {string} e.g. `_startRefreshing@53201`, or `unknown`
 */
const TIMER_TRACE_INTERNALS = new Set(['timerCallSite', 'traced', 'tracedTimeout', 'installIntervalTracing']);

function timerCallSite() {
    const stack = new Error().stack || '';
    for (const raw of stack.split('\n')) {
        const line = raw.trim();
        if (!line || line === 'Error') continue;
        // Chrome: "at name (url:line:col)" or "at url:line:col" — Firefox: "name@url:line:col"
        const chrome = /^at (?:(\S+) \()?.*?(\d+):\d+\)?$/.exec(line);
        const firefox = /^([^@\s]*)@.*?(\d+):\d+$/.exec(line);
        const match = chrome || firefox;
        if (!match) continue;
        // "Proxy.traced" / "Object.installIntervalTracing" — the qualifier is
        // the call shape, not the function; strip it before the internals check
        const name = (match[1] || '').split('.').pop() || '';
        if (TIMER_TRACE_INTERNALS.has(name)) continue;
        return `${name || 'anon'}@${match[2]}`;
    }
    return 'unknown';
}

/**
 * Every interval this script creates reports into the rolling stats.
 *
 * The stall ledger can only name work that was measured, and hand-picking
 * which intervals to instrument is how the 2026-08-29 hunt kept finding
 * "nothing instrumented overlapped it". Wrapping the sandbox's setInterval
 * catches them all — the game is untouched, it has its own window — and the
 * wrapper costs one `enabled` check per tick while measuring is off.
 */
export function installIntervalTracing(target = globalThis) {
    // Each timer is wrapped on its own merits: if the page (or a library)
    // saved a reference to setTimeout before install and restored it after,
    // the next install must re-net it even though setInterval is still
    // traced. A single early return here silently left setTimeout bare.
    const original = target.setInterval;
    if (typeof original === 'function' && !original.__toolashaTraced) {
        const traced = function (handler, delay, ...args) {
            if (typeof handler !== 'function') return original.call(this, handler, delay, ...args);
            const name = `interval:${timerCallSite()}`;
            const wrapped = function (...tickArgs) {
                if (!performanceMonitor.enabled) return handler.apply(this, tickArgs);
                const startedAt = performance.now();
                try {
                    return handler.apply(this, tickArgs);
                } finally {
                    const duration = performance.now() - startedAt;
                    if (duration >= 1) performanceMonitor.record(name, duration);
                }
            };
            return original.call(this, wrapped, delay, ...args);
        };
        traced.__toolashaTraced = true;
        target.setInterval = traced;
    }

    // Timeouts get the same net. Only ticks over the 1ms floor are recorded,
    // so the zero-delay yields sprinkled through chunked work stay invisible.
    const originalTimeout = target.setTimeout;
    if (typeof originalTimeout === 'function' && !originalTimeout.__toolashaTraced) {
        const tracedTimeout = function (handler, delay, ...args) {
            if (typeof handler !== 'function') return originalTimeout.call(this, handler, delay, ...args);
            const name = `timeout:${timerCallSite()}`;
            const wrapped = function (...tickArgs) {
                if (!performanceMonitor.enabled) return handler.apply(this, tickArgs);
                const startedAt = performance.now();
                try {
                    return handler.apply(this, tickArgs);
                } finally {
                    const duration = performance.now() - startedAt;
                    if (duration >= 1) performanceMonitor.record(name, duration);
                }
            };
            return originalTimeout.call(this, wrapped, delay, ...args);
        };
        tracedTimeout.__toolashaTraced = true;
        target.setTimeout = tracedTimeout;
    }
}

export default performanceMonitor;
