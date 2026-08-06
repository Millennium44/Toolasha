/**
 * Work that should not hold up the rest of the start.
 *
 * Features initialise one after another and each is awaited, so anything heavy
 * inside `initialize()` is time every feature behind it spends waiting. Two of
 * them were spending six seconds each on work nobody was looking at yet.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import performanceMonitor from './performance-monitor.js';
import { runInBackground, yieldToEventLoop } from './background-work.js';

beforeEach(() => {
    performanceMonitor.reset();
    // reset() deliberately keeps marks — they are the startup trace, and it
    // cannot be taken again without a reload. Tests need a clean one anyway.
    performanceMonitor.marks.length = 0;
    vi.stubGlobal('requestIdleCallback', undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('handing work to the background', () => {
    test('the caller is not held up by it', async () => {
        // The whole point: initialize() returns, the rest of the registry runs,
        // and the heavy part happens afterwards
        const order = [];
        const promise = runInBackground('slow', async () => {
            order.push('work');
        });
        order.push('returned');

        await promise;

        expect(order).toEqual(['returned', 'work']);
    });

    test('what it returns still reaches whoever waits for it', async () => {
        await expect(runInBackground('x', async () => 'done')).resolves.toBe('done');
    });

    test('a failure is logged, not thrown at nobody', async () => {
        // Nothing awaits this promise in production; a rejection would be an
        // unhandled one in the console of every user who has the feature on
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(
            runInBackground('broken', async () => {
                throw new Error('storage went away');
            })
        ).resolves.toBe(null);
        expect(console.error).toHaveBeenCalled();
    });
});

describe('what the trace says about it', () => {
    test('background work is recorded apart from the work that blocked', async () => {
        // A startup trace has to distinguish a slow start from a busy one
        await runInBackground('networth', async () => {});

        expect(performanceMonitor.getSnapshots().has('bg:networth')).toBe(true);
    });

    test('and it is timed even when it fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await runInBackground('broken', async () => {
            throw new Error('nope');
        });

        expect(performanceMonitor.getSnapshots().has('bg:broken')).toBe(true);
    });

    test('the snapshot says when it ran, not only how long', async () => {
        await runInBackground('later', async () => {});
        const snapshot = performanceMonitor.getSnapshots().get('bg:later');

        expect(snapshot.startedAt).toBeGreaterThan(0);
    });
});

describe('yielding the main thread', () => {
    test('resolves on a later macrotask, so a synchronous loop is broken into slices', async () => {
        const order = [];
        const promise = yieldToEventLoop().then(() => order.push('after yield'));
        // Synchronous work queued after the yield call still runs first — the
        // yield hands control back rather than continuing inline
        order.push('still synchronous');

        await promise;

        expect(order).toEqual(['still synchronous', 'after yield']);
    });
});

describe('marks and spans', () => {
    test('a mark records when something happened', () => {
        performanceMonitor.mark('storage:open');

        expect(performanceMonitor.getMarks()[0]).toMatchObject({ name: 'storage:open' });
    });

    test('marks come back in the order they happened, not the order they were asked for', () => {
        performanceMonitor.marks.push({ name: 'late', at: 900 }, { name: 'early', at: 100 });

        expect(performanceMonitor.getMarks().map((mark) => mark.name)).toEqual(['early', 'late']);
    });

    test('a span records a part of something bigger', async () => {
        await performanceMonitor.span('init:networth', 'recalculate', async () => {});

        expect(performanceMonitor.getSpans('init:networth')[0].part).toBe('recalculate');
    });

    test('spans of one metric come back longest first, since that is the answer', () => {
        performanceMonitor.startSpan('init:x', 'quick')();
        const slow = performanceMonitor.startSpan('init:x', 'slow');
        performanceMonitor.spans.get('init:x')[0].duration = 1;
        slow();
        performanceMonitor.spans.get('init:x')[1].duration = 500;

        expect(performanceMonitor.getSpans('init:x').map((s) => s.part)).toEqual(['slow', 'quick']);
    });

    test('a span still closes when the work throws', async () => {
        await expect(
            performanceMonitor.span('init:y', 'boom', async () => {
                throw new Error('x');
            })
        ).rejects.toThrow();

        expect(performanceMonitor.getSpans('init:y')).toHaveLength(1);
    });

    test('resetting the rolling stats leaves the startup trace alone', () => {
        // It cannot be taken again without a reload
        performanceMonitor.mark('script:start');

        performanceMonitor.reset();

        expect(performanceMonitor.getMarks()).toHaveLength(1);
    });
});
