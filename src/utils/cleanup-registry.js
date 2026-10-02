/**
 * Cleanup Registry Utility
 * Centralized registration for listeners, observers, timers, and custom cleanup.
 */
import performanceMonitor from './performance-monitor.js';

/**
 * How many things every live cleanup registry in this bundle is holding right
 * now, by kind.
 *
 * Additive and O(1): each `register*` increments, `cleanupAll` decrements by
 * what it released. Nothing is retained here that the registries were not
 * already retaining — these are counters, not references — so reading them
 * cannot itself leak, and sampling them costs a property read.
 *
 * The point of counting by kind rather than in total is that "which of our
 * registries is growing" is the only actionable half of a leak report.
 */
const census = {
    listeners: 0,
    observers: 0,
    intervals: 0,
    timeouts: 0,
    cleanups: 0,
};

/**
 * A snapshot of what the live cleanup registries hold.
 * @returns {{listeners: number, observers: number, intervals: number, timeouts: number, cleanups: number}}
 */
export function getCleanupRegistryCensus() {
    return { ...census };
}

/**
 * Create a cleanup registry for deterministic teardown.
 *
 * Every `register*` returns an unregister function that releases just that one
 * registration right away (removes the listener, disconnects the observer,
 * clears the timer, or runs the cleanup) and drops it from the registry. A
 * feature that registers per mount of a game panel calls it when the panel
 * remounts, so the registry holds the current mount rather than every mount
 * since the feature started — the old mount's closures otherwise pin its
 * detached DOM until `cleanupAll`. Calling it twice, or after `cleanupAll`, is
 * a no-op. Callers that ignore the return value behave exactly as before.
 *
 * @returns {{
 *   registerListener: (target: EventTarget, event: string, handler: Function, options?: Object) => (() => void),
 *   registerObserver: (observer: MutationObserver|{ disconnect: Function }) => (() => void),
 *   registerInterval: (intervalId: number, label?: string) => (() => void),
 *   registerTimeout: (timeoutId: number, label?: string) => (() => void),
 *   registerCleanup: (cleanupFn: Function) => (() => void),
 *   cleanupAll: () => void
 * }} Cleanup registry API
 */
export function createCleanupRegistry() {
    const listeners = [];
    const observers = [];
    const intervals = [];
    const timeouts = [];
    const customCleanups = [];
    const noop = () => {};

    /**
     * Build the unregister function for one entry: release it once, and only
     * while it is still held (cleanupAll may already have released it).
     */
    const makeUnregister = (array, entry, kind, release, label) => () => {
        const index = array.indexOf(entry);
        if (index === -1) return;
        array.splice(index, 1);
        census[kind] -= 1;
        try {
            release();
        } catch (error) {
            console.error(`[CleanupRegistry] Failed to release ${label}:`, error);
        }
    };

    const registerListener = (target, event, handler, options) => {
        if (!target || !event || !handler) {
            console.warn('[CleanupRegistry] registerListener called with invalid arguments');
            return noop;
        }

        target.addEventListener(event, handler, options);
        const entry = { target, event, handler, options };
        listeners.push(entry);
        census.listeners += 1;
        return makeUnregister(
            listeners,
            entry,
            'listeners',
            () => target.removeEventListener(event, handler, options),
            'listener'
        );
    };

    const registerObserver = (observer) => {
        if (!observer || typeof observer.disconnect !== 'function') {
            console.warn('[CleanupRegistry] registerObserver called with invalid observer');
            return noop;
        }

        observers.push(observer);
        census.observers += 1;
        return makeUnregister(observers, observer, 'observers', () => observer.disconnect(), 'observer');
    };

    // Optional: names the pformance-panel row this timer's ticks report under
    // (`interval:<label>`) instead of leaving it to the guessed call site or
    // late `anon#n` name — see `labelTimer` in performance-monitor.js.
    const registerInterval = (intervalId, label) => {
        if (!intervalId) {
            console.warn('[CleanupRegistry] registerInterval called with invalid interval id');
            return noop;
        }

        intervals.push(intervalId);
        census.intervals += 1;
        if (label) performanceMonitor.labelTimer(intervalId, label);
        return makeUnregister(intervals, intervalId, 'intervals', () => clearInterval(intervalId), 'interval');
    };

    const registerTimeout = (timeoutId, label) => {
        if (!timeoutId) {
            console.warn('[CleanupRegistry] registerTimeout called with invalid timeout id');
            return noop;
        }

        timeouts.push(timeoutId);
        census.timeouts += 1;
        if (label) performanceMonitor.labelTimer(timeoutId, label);
        return makeUnregister(timeouts, timeoutId, 'timeouts', () => clearTimeout(timeoutId), 'timeout');
    };

    const registerCleanup = (cleanupFn) => {
        if (typeof cleanupFn !== 'function') {
            console.warn('[CleanupRegistry] registerCleanup called with invalid function');
            return noop;
        }

        // Wrapped so the same function registered twice is two entries, each
        // released by its own unregister.
        const entry = { cleanupFn };
        customCleanups.push(entry);
        census.cleanups += 1;
        return makeUnregister(customCleanups, entry, 'cleanups', cleanupFn, 'cleanup');
    };

    // Each kind is taken out of its array before it is released, so a cleanup
    // that calls another entry's unregister mid-teardown finds it already gone
    // (a no-op) instead of splicing the array this loop is walking.
    const releaseAll = (array, kind, release, failure) => {
        const pending = array.splice(0);
        census[kind] -= pending.length;
        pending.forEach((entry) => {
            try {
                release(entry);
            } catch (error) {
                console.error(`[CleanupRegistry] ${failure}:`, error);
            }
        });
    };

    const cleanupAll = () => {
        releaseAll(
            listeners,
            'listeners',
            ({ target, event, handler, options }) => target.removeEventListener(event, handler, options),
            'Failed to remove listener'
        );
        releaseAll(observers, 'observers', (observer) => observer.disconnect(), 'Failed to disconnect observer');
        releaseAll(intervals, 'intervals', (intervalId) => clearInterval(intervalId), 'Failed to clear interval');
        releaseAll(timeouts, 'timeouts', (timeoutId) => clearTimeout(timeoutId), 'Failed to clear timeout');
        releaseAll(customCleanups, 'cleanups', ({ cleanupFn }) => cleanupFn(), 'Custom cleanup failed');
    };

    return {
        registerListener,
        registerObserver,
        registerInterval,
        registerTimeout,
        registerCleanup,
        cleanupAll,
    };
}
