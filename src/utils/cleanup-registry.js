/**
 * Cleanup Registry Utility
 * Centralized registration for listeners, observers, timers, and custom cleanup.
 */

/**
 * Create a cleanup registry for deterministic teardown.
 * @returns {{
 *   registerListener: (target: EventTarget, event: string, handler: Function, options?: Object) => void,
 *   registerObserver: (observer: MutationObserver|{ disconnect: Function }) => void,
 *   registerInterval: (intervalId: number) => void,
 *   registerTimeout: (timeoutId: number) => void,
 *   registerCleanup: (cleanupFn: Function) => void,
 *   cleanupAll: () => void
 * }} Cleanup registry API
 */
export function createCleanupRegistry() {
    const listeners = [];
    const observers = [];
    const intervals = [];
    const timeouts = [];
    const customCleanups = [];

    const registerListener = (target, event, handler, options) => {
        if (!target || !event || !handler) {
            console.warn('[CleanupRegistry] registerListener called with invalid arguments');
            return;
        }

        target.addEventListener(event, handler, options);
        listeners.push({ target, event, handler, options });
    };

    const registerObserver = (observer) => {
        if (!observer || typeof observer.disconnect !== 'function') {
            console.warn('[CleanupRegistry] registerObserver called with invalid observer');
            return;
        }

        observers.push(observer);
    };

    const registerInterval = (intervalId) => {
        if (!intervalId) {
            console.warn('[CleanupRegistry] registerInterval called with invalid interval id');
            return;
        }

        intervals.push(intervalId);
    };

    const registerTimeout = (timeoutId) => {
        if (!timeoutId) {
            console.warn('[CleanupRegistry] registerTimeout called with invalid timeout id');
            return;
        }

        timeouts.push(timeoutId);
    };

    const registerCleanup = (cleanupFn) => {
        if (typeof cleanupFn !== 'function') {
            console.warn('[CleanupRegistry] registerCleanup called with invalid function');
            return;
        }

        customCleanups.push(cleanupFn);
    };

    const cleanupAll = () => {
        listeners.forEach(({ target, event, handler, options }) => {
            try {
                target.removeEventListener(event, handler, options);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to remove listener:', error);
            }
        });
        listeners.length = 0;

        observers.forEach((observer) => {
            try {
                observer.disconnect();
            } catch (error) {
                console.error('[CleanupRegistry] Failed to disconnect observer:', error);
            }
        });
        observers.length = 0;

        intervals.forEach((intervalId) => {
            try {
                clearInterval(intervalId);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to clear interval:', error);
            }
        });
        intervals.length = 0;

        timeouts.forEach((timeoutId) => {
            try {
                clearTimeout(timeoutId);
            } catch (error) {
                console.error('[CleanupRegistry] Failed to clear timeout:', error);
            }
        });
        timeouts.length = 0;

        customCleanups.forEach((cleanupFn) => {
            try {
                cleanupFn();
            } catch (error) {
                console.error('[CleanupRegistry] Custom cleanup failed:', error);
            }
        });
        customCleanups.length = 0;
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
