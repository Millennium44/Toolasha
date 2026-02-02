/**
 * Timer Registry Utility
 * Centralized registration for intervals and timeouts.
 */

/**
 * Create a timer registry for deterministic teardown.
 * @returns {{
 *   registerInterval: (intervalId: number) => void,
 *   registerTimeout: (timeoutId: number) => void,
 *   clearAll: () => void
 * }} Timer registry API
 */
export function createTimerRegistry() {
    const intervals = [];
    const timeouts = [];

    const registerInterval = (intervalId) => {
        if (!intervalId) {
            console.warn('[TimerRegistry] registerInterval called with invalid interval id');
            return;
        }

        intervals.push(intervalId);
    };

    const registerTimeout = (timeoutId) => {
        if (!timeoutId) {
            console.warn('[TimerRegistry] registerTimeout called with invalid timeout id');
            return;
        }

        timeouts.push(timeoutId);
    };

    const clearAll = () => {
        intervals.forEach((intervalId) => {
            try {
                clearInterval(intervalId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear interval:', error);
            }
        });
        intervals.length = 0;

        timeouts.forEach((timeoutId) => {
            try {
                clearTimeout(timeoutId);
            } catch (error) {
                console.error('[TimerRegistry] Failed to clear timeout:', error);
            }
        });
        timeouts.length = 0;
    };

    return {
        registerInterval,
        registerTimeout,
        clearAll,
    };
}
