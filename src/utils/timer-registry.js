/**
 * Timer Registry Utility
 * Centralized registration for intervals and timeouts.
 */
import performanceMonitor from './performance-monitor.js';

/**
 * How many timers every live timer registry in this bundle is holding.
 *
 * Additive, O(1), and holds no references — see `getCleanupRegistryCensus` in
 * cleanup-registry.js for why the leak canary needs a count per kind rather
 * than one total.
 */
const census = { intervals: 0, timeouts: 0 };

/**
 * A snapshot of what the live timer registries hold.
 * @returns {{intervals: number, timeouts: number}}
 */
export function getTimerRegistryCensus() {
    return { ...census };
}

/**
 * Create a timer registry for deterministic teardown.
 *
 * `registerTimeout` keeps the id until `clearAll`, so a timer that fires stays
 * listed; new code that schedules a timeout should use `scheduleTimeout`, which
 * drops its entry when the timer fires, and `cancelTimeout` to cancel one.
 * @returns {{
 *   registerInterval: (intervalId: number, label?: string) => void,
 *   registerTimeout: (timeoutId: number, label?: string) => void,
 *   scheduleTimeout: (fn: Function, ms?: number, label?: string) => number,
 *   cancelTimeout: (timeoutId: number) => void,
 *   clearAll: () => void
 * }} Timer registry API
 */
export function createTimerRegistry() {
    const intervals = [];
    // A Set so a fired or cancelled timer is dropped in O(1).
    const timeouts = new Set();

    // Optional: names the pformance-panel row this timer's ticks report under
    // (`interval:<label>`) instead of leaving it to the guessed call site or
    // late `anon#n` name — see `labelTimer` in performance-monitor.js.
    const registerInterval = (intervalId, label) => {
        if (!intervalId) {
            console.warn('[TimerRegistry] registerInterval called with invalid interval id');
            return;
        }

        intervals.push(intervalId);
        census.intervals += 1;
        if (label) performanceMonitor.labelTimer(intervalId, label);
    };

    const registerTimeout = (timeoutId, label) => {
        if (!timeoutId) {
            console.warn('[TimerRegistry] registerTimeout called with invalid timeout id');
            return;
        }

        if (!timeouts.has(timeoutId)) {
            timeouts.add(timeoutId);
            census.timeouts += 1;
        }
        if (label) performanceMonitor.labelTimer(timeoutId, label);
    };

    const dropTimeout = (timeoutId) => {
        if (!timeouts.delete(timeoutId)) return;
        census.timeouts -= 1;
        performanceMonitor.unlabelTimer?.(timeoutId);
    };

    // The entry is dropped before `fn` runs, so `fn` may schedule again (or
    // throw) without leaving this one behind.
    const scheduleTimeout = (fn, ms, label) => {
        const timeoutId = setTimeout(() => {
            dropTimeout(timeoutId);
            fn();
        }, ms);
        registerTimeout(timeoutId, label);
        return timeoutId;
    };

    const cancelTimeout = (timeoutId) => {
        clearTimeout(timeoutId);
        dropTimeout(timeoutId);
    };

    const clearAll = () => {
        intervals.forEach((intervalId) => {
            try {
                clearInterval(intervalId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear interval:', error);
            }
        });
        census.intervals -= intervals.length;
        intervals.length = 0;

        timeouts.forEach((timeoutId) => {
            try {
                clearTimeout(timeoutId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear timeout:', error);
            }
        });
        census.timeouts -= timeouts.size;
        timeouts.clear();
    };

    return {
        registerInterval,
        registerTimeout,
        scheduleTimeout,
        cancelTimeout,
        clearAll,
    };
}
