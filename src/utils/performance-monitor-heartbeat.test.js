/** @vitest-environment happy-dom */
/**
 * Stall watch on browsers without the `longtask` entry type (Firefox): a timer
 * that notices when it fires late stands in for the observer.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import performanceMonitor from './performance-monitor.js';

describe('stall watch without longtask support (heartbeat fallback)', () => {
    let nowMs;
    let hidden;
    let observersCreated;
    const realPO = globalThis.PerformanceObserver;
    const realNow = performance.now;

    const makeObserver = (types) =>
        class {
            static supportedEntryTypes = types;
            constructor() {
                observersCreated += 1;
            }
            observe() {}
            disconnect() {}
        };

    beforeEach(() => {
        vi.useFakeTimers();
        nowMs = 1000;
        hidden = false;
        observersCreated = 0;
        performance.now = () => nowMs;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
        performanceMonitor.stopStallWatch();
        performanceMonitor.stalls = [];
        performanceMonitor.worstStallMs = 0;
        performanceMonitor._tabVisible = true;
        globalThis.PerformanceObserver = makeObserver(['mark', 'measure']);
    });

    afterEach(() => {
        performanceMonitor.stopStallWatch();
        performance.now = realNow;
        globalThis.PerformanceObserver = realPO;
        delete document.hidden;
        vi.useRealTimers();
    });

    const tick = (lateBy = 0) => {
        nowMs += 100 + lateBy;
        vi.advanceTimersByTime(100);
    };

    test('does not register a longtask observer', () => {
        performanceMonitor.startStallWatch();
        expect(observersCreated).toBe(0);
    });

    test('on-time ticks record nothing', () => {
        performanceMonitor.startStallWatch();
        for (let i = 0; i < 10; i++) tick();
        expect(performanceMonitor.getStalls()).toEqual([]);
    });

    test('a late tick is recorded as an estimated stall shaped like a longtask one', () => {
        performanceMonitor.startStallWatch();
        tick();
        tick(400);
        const stalls = performanceMonitor.getStalls();
        expect(stalls).toHaveLength(1);
        expect(stalls[0].duration).toBe(400);
        expect(stalls[0].estimated).toBe(true);
        expect(stalls[0].sinceBoot).toBeGreaterThan(0);
        expect(Array.isArray(stalls[0].suspects)).toBe(true);
        expect(performanceMonitor.getWorstStallMs()).toBe(400);
    });

    test('lateness of 50ms or less is ignored', () => {
        performanceMonitor.startStallWatch();
        tick(50);
        expect(performanceMonitor.getStalls()).toEqual([]);
    });

    test('time while the tab is hidden is not a stall, and the baseline resets on return', () => {
        performanceMonitor.startStallWatch();
        hidden = true;
        performanceMonitor._tabVisible = false;
        tick(900);
        expect(performanceMonitor.getStalls()).toEqual([]);
        hidden = false;
        nowMs += 900;
        performanceMonitor._onVisibilityChange();
        tick();
        expect(performanceMonitor.getStalls()).toEqual([]);
    });

    test('stopStallWatch stops the timer', () => {
        performanceMonitor.startStallWatch();
        performanceMonitor.stopStallWatch();
        nowMs += 1000;
        vi.advanceTimersByTime(1000);
        expect(performanceMonitor.getStalls()).toEqual([]);
        expect(performanceMonitor._stallBeatTimer).toBeNull();
    });

    test('with longtask support the observer is used and no timer starts', () => {
        globalThis.PerformanceObserver = makeObserver(['longtask']);
        performanceMonitor.startStallWatch();
        expect(observersCreated).toBe(1);
        expect(performanceMonitor._stallBeatTimer).toBeFalsy();
    });
});
