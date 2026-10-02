/**
 * Tests for Cleanup Registry Utility
 */
import { describe, test, expect, vi } from 'vitest';
import { createCleanupRegistry, getCleanupRegistryCensus } from './cleanup-registry.js';

function makeTarget() {
    return {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
}

describe('registerListener', () => {
    test('attaches the listener and removes it on cleanupAll', () => {
        const registry = createCleanupRegistry();
        const target = makeTarget();
        const handler = () => {};
        registry.registerListener(target, 'click', handler, { capture: true });

        expect(target.addEventListener).toHaveBeenCalledWith('click', handler, { capture: true });

        registry.cleanupAll();
        expect(target.removeEventListener).toHaveBeenCalledWith('click', handler, { capture: true });
    });

    test('ignores calls with missing arguments', () => {
        const registry = createCleanupRegistry();
        const target = makeTarget();
        registry.registerListener(null, 'click', () => {});
        registry.registerListener(target, null, () => {});
        registry.registerListener(target, 'click', null);
        expect(target.addEventListener).not.toHaveBeenCalled();

        registry.cleanupAll();
        expect(target.removeEventListener).not.toHaveBeenCalled();
    });
});

describe('registerObserver', () => {
    test('disconnects registered observers on cleanupAll', () => {
        const registry = createCleanupRegistry();
        const observer = { disconnect: vi.fn() };
        registry.registerObserver(observer);
        registry.cleanupAll();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    test('rejects an object without a disconnect function', () => {
        const registry = createCleanupRegistry();
        const notObserver = {};
        registry.registerObserver(notObserver);
        // Nothing to disconnect and nothing should throw
        expect(() => registry.cleanupAll()).not.toThrow();
    });

    test('an observer that throws on disconnect does not stop other cleanup', () => {
        const registry = createCleanupRegistry();
        const throwing = {
            disconnect: () => {
                throw new Error('boom');
            },
        };
        const target = makeTarget();
        registry.registerObserver(throwing);
        registry.registerListener(target, 'click', () => {});

        expect(() => registry.cleanupAll()).not.toThrow();
        expect(target.removeEventListener).toHaveBeenCalled();
    });
});

describe('registerInterval / registerTimeout', () => {
    test('clears registered intervals and timeouts', () => {
        vi.useFakeTimers();
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        const registry = createCleanupRegistry();
        const intervalId = setInterval(() => {}, 1000);
        const timeoutId = setTimeout(() => {}, 1000);
        registry.registerInterval(intervalId);
        registry.registerTimeout(timeoutId);

        registry.cleanupAll();

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);

        vi.useRealTimers();
    });

    test('ignores falsy ids', () => {
        const registry = createCleanupRegistry();
        registry.registerInterval(null);
        registry.registerInterval(0);
        registry.registerTimeout(undefined);
        expect(() => registry.cleanupAll()).not.toThrow();
    });
});

describe('registerCleanup', () => {
    test('calls every registered cleanup function exactly once', () => {
        const registry = createCleanupRegistry();
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        registry.registerCleanup(fn1);
        registry.registerCleanup(fn2);

        registry.cleanupAll();

        expect(fn1).toHaveBeenCalledTimes(1);
        expect(fn2).toHaveBeenCalledTimes(1);
    });

    test('rejects non-function values', () => {
        const registry = createCleanupRegistry();
        registry.registerCleanup('not a function');
        expect(() => registry.cleanupAll()).not.toThrow();
    });

    test('a throwing cleanup does not prevent the next one from running', () => {
        const registry = createCleanupRegistry();
        const fn2 = vi.fn();
        registry.registerCleanup(() => {
            throw new Error('boom');
        });
        registry.registerCleanup(fn2);

        registry.cleanupAll();
        expect(fn2).toHaveBeenCalledTimes(1);
    });
});

describe('cleanupAll idempotency', () => {
    test('running cleanupAll twice does not double-invoke handlers', () => {
        const registry = createCleanupRegistry();
        const fn = vi.fn();
        registry.registerCleanup(fn);

        registry.cleanupAll();
        registry.cleanupAll();

        expect(fn).toHaveBeenCalledTimes(1);
    });
});

/**
 * The census the leak canary samples. Counters only — nothing here retains a
 * reference the registry was not already holding.
 */
describe('getCleanupRegistryCensus', () => {
    test('counts what live registries hold, by kind rather than in total', () => {
        const before = getCleanupRegistryCensus();
        const registry = createCleanupRegistry();

        registry.registerListener(makeTarget(), 'click', () => {});
        registry.registerListener(makeTarget(), 'click', () => {});
        registry.registerObserver({ disconnect: () => {} });
        registry.registerCleanup(() => {});

        const after = getCleanupRegistryCensus();
        expect(after.listeners - before.listeners).toBe(2);
        expect(after.observers - before.observers).toBe(1);
        expect(after.cleanups - before.cleanups).toBe(1);
        expect(after.intervals - before.intervals).toBe(0);
    });

    test('cleanupAll takes the count back down, so a registry that is torn down cannot read as a leak', () => {
        const before = getCleanupRegistryCensus();
        const registry = createCleanupRegistry();
        registry.registerListener(makeTarget(), 'click', () => {});
        registry.registerObserver({ disconnect: () => {} });

        registry.cleanupAll();

        expect(getCleanupRegistryCensus()).toEqual(before);
    });

    test('the snapshot is a copy, not the live object', () => {
        const snapshot = getCleanupRegistryCensus();
        snapshot.listeners = 999;

        expect(getCleanupRegistryCensus().listeners).not.toBe(999);
    });
});

/**
 * Per-registration release: a feature that registers per mount of a game panel
 * releases the previous mount instead of holding every mount until cleanupAll.
 */
describe('unregister functions', () => {
    test('a listener unregister removes just that listener, once', () => {
        const registry = createCleanupRegistry();
        const target = makeTarget();
        const a = () => {};
        const b = () => {};
        const before = getCleanupRegistryCensus().listeners;
        const unregisterA = registry.registerListener(target, 'click', a);
        registry.registerListener(target, 'click', b);

        unregisterA();
        unregisterA();
        expect(target.removeEventListener).toHaveBeenCalledTimes(1);
        expect(target.removeEventListener).toHaveBeenCalledWith('click', a, undefined);
        expect(getCleanupRegistryCensus().listeners).toBe(before + 1);

        registry.cleanupAll();
        expect(target.removeEventListener).toHaveBeenCalledTimes(2);
        expect(target.removeEventListener).toHaveBeenLastCalledWith('click', b, undefined);
        expect(getCleanupRegistryCensus().listeners).toBe(before);
    });

    test('an observer unregister disconnects it and cleanupAll does not disconnect it again', () => {
        const registry = createCleanupRegistry();
        const observer = { disconnect: vi.fn() };
        const unregister = registry.registerObserver(observer);

        unregister();
        registry.cleanupAll();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    test('timer unregisters clear the timer', () => {
        vi.useFakeTimers();
        try {
            const registry = createCleanupRegistry();
            const tick = vi.fn();
            const unregisterInterval = registry.registerInterval(setInterval(tick, 10));
            const fire = vi.fn();
            const unregisterTimeout = registry.registerTimeout(setTimeout(fire, 10));

            unregisterInterval();
            unregisterTimeout();
            vi.advanceTimersByTime(50);
            expect(tick).not.toHaveBeenCalled();
            expect(fire).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    test('a cleanup unregister runs it now; the same function registered twice is two entries', () => {
        const registry = createCleanupRegistry();
        const cleanup = vi.fn();
        const unregisterFirst = registry.registerCleanup(cleanup);
        registry.registerCleanup(cleanup);

        unregisterFirst();
        expect(cleanup).toHaveBeenCalledTimes(1);

        registry.cleanupAll();
        expect(cleanup).toHaveBeenCalledTimes(2);
    });

    test('unregister after cleanupAll is a no-op and the census does not go negative', () => {
        const registry = createCleanupRegistry();
        const observer = { disconnect: vi.fn() };
        const before = getCleanupRegistryCensus().observers;
        const unregister = registry.registerObserver(observer);

        registry.cleanupAll();
        unregister();
        expect(observer.disconnect).toHaveBeenCalledTimes(1);
        expect(getCleanupRegistryCensus().observers).toBe(before);
    });

    test('a cleanup that unregisters another entry during cleanupAll releases each exactly once', () => {
        const registry = createCleanupRegistry();
        const later = vi.fn();
        let unregisterLater = null;
        registry.registerCleanup(() => unregisterLater());
        unregisterLater = registry.registerCleanup(later);

        registry.cleanupAll();
        expect(later).toHaveBeenCalledTimes(1);
    });

    test('invalid registrations still return a callable unregister', () => {
        const registry = createCleanupRegistry();
        expect(() => registry.registerListener(null, 'click', () => {})()).not.toThrow();
        expect(() => registry.registerObserver(null)()).not.toThrow();
        expect(() => registry.registerInterval(0)()).not.toThrow();
        expect(() => registry.registerTimeout(0)()).not.toThrow();
        expect(() => registry.registerCleanup(null)()).not.toThrow();
    });
});

describe('cleanup registry scheduleTimeout / cancelTimeout', () => {
    test('the entry is gone after the timer fires, and the census is exact', () => {
        vi.useFakeTimers();
        const registry = createCleanupRegistry();
        const before = getCleanupRegistryCensus().timeouts;
        const fn = vi.fn();

        const id = registry.scheduleTimeout(fn, 100, 'test:fire');
        expect(getCleanupRegistryCensus().timeouts).toBe(before + 1);

        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(getCleanupRegistryCensus().timeouts).toBe(before);

        // Nothing left to clear.
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        registry.cleanupAll();
        expect(clearSpy).not.toHaveBeenCalledWith(id);
        clearSpy.mockRestore();
        vi.useRealTimers();
    });

    test('the entry is dropped even when the callback throws or reschedules', () => {
        vi.useFakeTimers();
        const registry = createCleanupRegistry();
        const before = getCleanupRegistryCensus().timeouts;
        registry.scheduleTimeout(() => {
            registry.scheduleTimeout(() => {}, 50);
        }, 10);
        vi.advanceTimersByTime(10);
        expect(getCleanupRegistryCensus().timeouts).toBe(before + 1);
        vi.advanceTimersByTime(50);
        expect(getCleanupRegistryCensus().timeouts).toBe(before);

        registry.scheduleTimeout(() => {
            throw new Error('boom');
        }, 10);
        expect(() => vi.advanceTimersByTime(10)).toThrow('boom');
        expect(getCleanupRegistryCensus().timeouts).toBe(before);
        vi.useRealTimers();
    });

    test('cancelTimeout stops the timer and drops the entry', () => {
        vi.useFakeTimers();
        const registry = createCleanupRegistry();
        const before = getCleanupRegistryCensus().timeouts;
        const fn = vi.fn();
        const id = registry.scheduleTimeout(fn, 100);
        registry.cancelTimeout(id);
        expect(getCleanupRegistryCensus().timeouts).toBe(before);
        vi.advanceTimersByTime(500);
        expect(fn).not.toHaveBeenCalled();
        registry.cancelTimeout(id); // a second cancel does not drive the census negative
        expect(getCleanupRegistryCensus().timeouts).toBe(before);
        vi.useRealTimers();
    });

    test('clearAll still cancels pending scheduled timeouts', () => {
        vi.useFakeTimers();
        const registry = createCleanupRegistry();
        const before = getCleanupRegistryCensus().timeouts;
        const fn = vi.fn();
        registry.scheduleTimeout(fn, 100);
        registry.scheduleTimeout(fn, 200);
        registry.cleanupAll();
        expect(getCleanupRegistryCensus().timeouts).toBe(before);
        vi.advanceTimersByTime(500);
        expect(fn).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
