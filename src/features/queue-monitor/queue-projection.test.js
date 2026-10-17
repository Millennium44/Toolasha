import { describe, test, expect } from 'vitest';
import { remainingQueueSeconds } from './queue-projection.js';

const timed = (estimatedSeconds) => ({ estimatedSeconds, isInfinite: false });
const untimed = { estimatedSeconds: null, isInfinite: false };
const endless = { estimatedSeconds: null, isInfinite: true };

describe('remainingQueueSeconds', () => {
    test('an all-timed queue burns down by the full elapsed time, floored at zero', () => {
        const snap = { totalQueueSeconds: 3600, actions: [timed(1800), timed(1800)] };
        expect(remainingQueueSeconds(snap, 600)).toBe(3000);
        expect(remainingQueueSeconds(snap, 99_999)).toBe(0);
    });

    test('timed work before an untimed row counts down while the tail behind it stays whole', () => {
        const snap = { totalQueueSeconds: 5400, actions: [timed(3600), untimed, timed(1800)] };
        expect(remainingQueueSeconds(snap, 1800)).toBe(3600);
    });

    test('at or past the timed prefix the answer is null, never zero', () => {
        const snap = { totalQueueSeconds: 5400, actions: [timed(3600), untimed, timed(1800)] };
        expect(remainingQueueSeconds(snap, 3600)).toBeNull();
        expect(remainingQueueSeconds(snap, 999_999)).toBeNull();
    });

    test('an untimed first row has no prefix: null from the start, even with nothing behind it', () => {
        expect(remainingQueueSeconds({ totalQueueSeconds: 3600, actions: [untimed, timed(3600)] }, 0)).toBeNull();
        expect(remainingQueueSeconds({ totalQueueSeconds: 0, actions: [untimed] }, 5)).toBeNull();
    });

    test('an endless row ends the walk: counting down to zero, not null', () => {
        const snap = { totalQueueSeconds: 600, actions: [timed(600), endless, untimed] };
        expect(remainingQueueSeconds(snap, 100)).toBe(500);
        expect(remainingQueueSeconds(snap, 9999)).toBe(0);
    });

    test('an untimed row behind an endless one is irrelevant', () => {
        const snap = { totalQueueSeconds: 0, actions: [endless, untimed] };
        expect(remainingQueueSeconds(snap, 100)).toBe(0);
    });

    test('empty and malformed snapshots are zero', () => {
        expect(remainingQueueSeconds({ totalQueueSeconds: 0, actions: [] }, 10)).toBe(0);
        expect(remainingQueueSeconds(null, 10)).toBe(0);
        expect(remainingQueueSeconds({ totalQueueSeconds: 300 }, 100)).toBe(200);
    });
});
