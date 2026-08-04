/**
 * Tests for Timer Registry Utility
 */
import { describe, test, expect, vi } from 'vitest';
import { createTimerRegistry } from './timer-registry.js';

describe('createTimerRegistry', () => {
    test('clears registered intervals and timeouts', () => {
        vi.useFakeTimers();
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

        const registry = createTimerRegistry();
        const intervalId = setInterval(() => {}, 1000);
        const timeoutId = setTimeout(() => {}, 1000);
        registry.registerInterval(intervalId);
        registry.registerTimeout(timeoutId);

        registry.clearAll();

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);

        vi.useRealTimers();
    });

    test('a timer actually stops firing after clearAll', () => {
        vi.useFakeTimers();
        const registry = createTimerRegistry();
        const callback = vi.fn();
        const intervalId = setInterval(callback, 100);
        registry.registerInterval(intervalId);

        vi.advanceTimersByTime(250);
        expect(callback).toHaveBeenCalledTimes(2);

        registry.clearAll();
        vi.advanceTimersByTime(500);
        expect(callback).toHaveBeenCalledTimes(2); // no further calls

        vi.useRealTimers();
    });

    test('ignores falsy ids without throwing', () => {
        const registry = createTimerRegistry();
        registry.registerInterval(null);
        registry.registerTimeout(0);
        expect(() => registry.clearAll()).not.toThrow();
    });

    test('clearAll empties the internal lists (idempotent)', () => {
        vi.useFakeTimers();
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
        const registry = createTimerRegistry();
        registry.registerInterval(setInterval(() => {}, 100));

        registry.clearAll();
        clearIntervalSpy.mockClear();
        registry.clearAll();

        expect(clearIntervalSpy).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
