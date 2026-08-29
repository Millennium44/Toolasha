/**
 * Tests for Performance Monitor
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import performanceMonitor, { installIntervalTracing } from './performance-monitor.js';

describe('PerformanceMonitor', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('record() is a no-op when disabled', () => {
        performanceMonitor.enabled = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('record() is a no-op when the tab is not visible', () => {
        performanceMonitor._tabVisible = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('getStats aggregates calls, totalMs, avgMs within the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('feature', 10);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(2);
        expect(stats.totalMs).toBe(30);
        expect(stats.avgMs).toBe(15);
        vi.useRealTimers();
    });

    test('getStats excludes measurements older than the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        performanceMonitor.record('feature', 10);

        vi.setSystemTime(performanceMonitor.windowMs + 1);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(1);
        expect(stats.totalMs).toBe(20);
        vi.useRealTimers();
    });

    test('getStats returns null for an unknown metric', () => {
        expect(performanceMonitor.getStats('nonexistent')).toBeNull();
    });

    test('cpuPercent is capped at 100', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('busy', performanceMonitor.windowMs * 5);
        expect(performanceMonitor.getStats('busy').cpuPercent).toBe(100);
        vi.useRealTimers();
    });

    test('getAllStats cleans up and returns stats for every active metric', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('a', 5);
        performanceMonitor.record('b', 15);

        const all = performanceMonitor.getAllStats();
        expect(all.get('a').totalMs).toBe(5);
        expect(all.get('b').totalMs).toBe(15);
        vi.useRealTimers();
    });

    test('snapshot() stores a one-time measurement independent of the rolling window', () => {
        performanceMonitor.snapshot('init:feature', 42, 100);
        const snap = performanceMonitor.getSnapshots().get('init:feature');
        expect(snap.duration).toBe(42);
        expect(snap.startedAt).toBe(100);
    });

    test('mark() records name and time, and getMarks() sorts chronologically', () => {
        performanceMonitor.mark('second');
        performanceMonitor.marks[0].at = 200;
        performanceMonitor.mark('first');
        performanceMonitor.marks[1].at = 50;

        const marks = performanceMonitor.getMarks();
        expect(marks.map((m) => m.name)).toEqual(['first', 'second']);
    });

    test('startSpan()/getSpans() records a duration and sorts longest first', () => {
        const end1 = performanceMonitor.startSpan('parent', 'partA');
        end1();
        const end2 = performanceMonitor.startSpan('parent', 'partB');
        end2();

        // Force distinguishable durations for a deterministic sort
        performanceMonitor.spans.get('parent')[0].duration = 5;
        performanceMonitor.spans.get('parent')[1].duration = 50;

        const spans = performanceMonitor.getSpans('parent');
        expect(spans[0].part).toBe('partB');
        expect(spans[0].duration).toBe(50);
    });

    test('span() times an async function and always records even on throw', async () => {
        await performanceMonitor.span('parent', 'ok', async () => 'result');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(1);

        await expect(
            performanceMonitor.span('parent', 'fails', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(2);
    });

    test('wrap() times a synchronous function and re-throws on error while still recording', () => {
        performanceMonitor.enabled = true;
        const wrapped = performanceMonitor.wrap('sync', () => {
            throw new Error('fail');
        });
        expect(() => wrapped()).toThrow('fail');
        expect(performanceMonitor.getStats('sync').calls).toBe(1);
    });

    test('wrap() passes through untimed when disabled', () => {
        performanceMonitor.enabled = false;
        const fn = vi.fn(() => 'value');
        const wrapped = performanceMonitor.wrap('sync', fn);
        expect(wrapped()).toBe('value');
        expect(performanceMonitor.getStats('sync')).toBeNull();
    });

    test('reset() clears measurements, snapshots, and spans', () => {
        performanceMonitor.record('a', 5);
        performanceMonitor.snapshot('b', 5);
        const end = performanceMonitor.startSpan('c', 'x');
        end();

        performanceMonitor.reset();

        expect(performanceMonitor.getStats('a')).toBeNull();
        expect(performanceMonitor.getSnapshots().size).toBe(0);
        expect(performanceMonitor.getSpans('c')).toEqual([]);
    });
});

describe('stall attribution', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('work recorded inside the stall window is named as a suspect, biggest first', () => {
        performanceMonitor.record('event:items_updated', 12);
        performanceMonitor.record('networth:recalculate', 171);
        performanceMonitor.record('dom:Tiny', 1); // under the 5ms floor

        const now = performance.now();
        const suspects = performanceMonitor._suspectsFor({ startTime: now - 200, duration: 200 });

        expect(suspects.map((s) => s.name)).toEqual(['networth:recalculate', 'event:items_updated']);
    });

    test('work recorded long before the stall is not blamed for it', () => {
        performanceMonitor.record('networth:recalculate', 171);
        const suspects = performanceMonitor._suspectsFor({ startTime: performance.now() + 5000, duration: 100 });
        expect(suspects).toEqual([]);
    });

    test('getStalls() is empty and safe before the watch ever starts', () => {
        expect(performanceMonitor.getStalls()).toEqual([]);
    });
});

describe('interval tracing', () => {
    test('a traced interval reports its ticks into the rolling stats under a call-site name', async () => {
        installIntervalTracing();
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;

        const id = setInterval(() => {
            const t0 = performance.now();
            while (performance.now() - t0 < 3) {
                // burn >1ms so the tick clears the recording floor
            }
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 40));
        clearInterval(id);

        const traced = [...performanceMonitor.measurements.keys()].filter((name) => name.startsWith('interval:'));
        expect(traced.length).toBeGreaterThan(0);
    });

    test('installing twice does not double-wrap', () => {
        installIntervalTracing();
        const once = globalThis.setInterval;
        installIntervalTracing();
        expect(globalThis.setInterval).toBe(once);
    });
});
