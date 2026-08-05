/**
 * Tests for Cleanup Registry Utility
 */
import { describe, test, expect, vi } from 'vitest';
import { createCleanupRegistry } from './cleanup-registry.js';

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
