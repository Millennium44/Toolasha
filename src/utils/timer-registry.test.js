/**
 * Tests for Timer Registry Utility
 */
import { describe, test, expect, vi } from 'vitest';
import { createTimerRegistry, getTimerRegistryCensus } from './timer-registry.js';

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

describe('getTimerRegistryCensus', () => {
    test('counts held timers by kind and drops back to zero on clearAll', () => {
        const before = getTimerRegistryCensus();
        const registry = createTimerRegistry();
        registry.registerInterval(1);
        registry.registerInterval(2);
        registry.registerTimeout(3);

        const held = getTimerRegistryCensus();
        expect(held.intervals - before.intervals).toBe(2);
        expect(held.timeouts - before.timeouts).toBe(1);

        registry.clearAll();
        expect(getTimerRegistryCensus()).toEqual(before);
    });
});

describe('scheduleTimeout / cancelTimeout', () => {
    test('the entry is gone after the timer fires, and the census is exact', () => {
        vi.useFakeTimers();
        const registry = createTimerRegistry();
        const before = getTimerRegistryCensus().timeouts;
        const fn = vi.fn();

        const id = registry.scheduleTimeout(fn, 100, 'test:fire');
        expect(getTimerRegistryCensus().timeouts).toBe(before + 1);

        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(getTimerRegistryCensus().timeouts).toBe(before);

        // Nothing left to clear.
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        registry.clearAll();
        expect(clearSpy).not.toHaveBeenCalledWith(id);
        clearSpy.mockRestore();
        vi.useRealTimers();
    });

    test('the entry is dropped even when the callback throws or reschedules', () => {
        vi.useFakeTimers();
        const registry = createTimerRegistry();
        const before = getTimerRegistryCensus().timeouts;
        registry.scheduleTimeout(() => {
            registry.scheduleTimeout(() => {}, 50);
        }, 10);
        vi.advanceTimersByTime(10);
        expect(getTimerRegistryCensus().timeouts).toBe(before + 1);
        vi.advanceTimersByTime(50);
        expect(getTimerRegistryCensus().timeouts).toBe(before);

        registry.scheduleTimeout(() => {
            throw new Error('boom');
        }, 10);
        expect(() => vi.advanceTimersByTime(10)).toThrow('boom');
        expect(getTimerRegistryCensus().timeouts).toBe(before);
        vi.useRealTimers();
    });

    test('cancelTimeout stops the timer and drops the entry', () => {
        vi.useFakeTimers();
        const registry = createTimerRegistry();
        const before = getTimerRegistryCensus().timeouts;
        const fn = vi.fn();
        const id = registry.scheduleTimeout(fn, 100);
        registry.cancelTimeout(id);
        expect(getTimerRegistryCensus().timeouts).toBe(before);
        vi.advanceTimersByTime(500);
        expect(fn).not.toHaveBeenCalled();
        registry.cancelTimeout(id); // a second cancel does not drive the census negative
        expect(getTimerRegistryCensus().timeouts).toBe(before);
        vi.useRealTimers();
    });

    test('clearAll still cancels pending scheduled timeouts', () => {
        vi.useFakeTimers();
        const registry = createTimerRegistry();
        const before = getTimerRegistryCensus().timeouts;
        const fn = vi.fn();
        registry.scheduleTimeout(fn, 100);
        registry.scheduleTimeout(fn, 200);
        registry.clearAll();
        expect(getTimerRegistryCensus().timeouts).toBe(before);
        vi.advanceTimersByTime(500);
        expect(fn).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
