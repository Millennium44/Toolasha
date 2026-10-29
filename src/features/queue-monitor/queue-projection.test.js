import { describe, test, expect } from 'vitest';
import { queueTimeLeft, remainingQueueSeconds } from './queue-projection.js';

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

    test('past the timed prefix the known work keeps shrinking as a lower bound', () => {
        const snap = { totalQueueSeconds: 5400, actions: [timed(3600), untimed, timed(1800)] };
        expect(queueTimeLeft(snap, 3600)).toEqual({ seconds: 1800, isLowerBound: true });
        expect(queueTimeLeft(snap, 5000)).toEqual({ seconds: 400, isLowerBound: true });
    });

    test('a lower bound runs out at zero and stays flagged, never reading as exact', () => {
        const snap = { totalQueueSeconds: 5400, actions: [timed(3600), untimed, timed(1800)] };
        expect(queueTimeLeft(snap, 999_999)).toEqual({ seconds: 0, isLowerBound: true });
    });

    test('an untimed first row: the whole timed total is the bound at elapsed 0', () => {
        expect(queueTimeLeft({ totalQueueSeconds: 3600, actions: [untimed, timed(3600)] }, 0)).toEqual({
            seconds: 3600,
            isLowerBound: true,
        });
        expect(queueTimeLeft({ totalQueueSeconds: 0, actions: [untimed] }, 5)).toEqual({
            seconds: 0,
            isLowerBound: true,
        });
    });

    test('an untimed last row bounds the timed prefix', () => {
        const snap = { totalQueueSeconds: 3600, actions: [timed(3600), untimed] };
        expect(queueTimeLeft(snap, 600)).toEqual({ seconds: 3000, isLowerBound: true });
        expect(queueTimeLeft(snap, 3600)).toEqual({ seconds: 0, isLowerBound: true });
    });

    test('hasUnknownAction alone (no rows to read) is a lower bound too', () => {
        expect(queueTimeLeft({ totalQueueSeconds: 300, hasUnknownAction: true }, 100)).toEqual({
            seconds: 200,
            isLowerBound: true,
        });
    });

    test('an all-timed or empty queue is exact', () => {
        expect(queueTimeLeft({ totalQueueSeconds: 3600, actions: [timed(3600)] }, 600).isLowerBound).toBe(false);
        expect(queueTimeLeft({ totalQueueSeconds: 0, actions: [] }, 0)).toEqual({ seconds: 0, isLowerBound: false });
        expect(queueTimeLeft(null, 5)).toEqual({ seconds: 0, isLowerBound: false });
    });

    test('an endless row ends the walk: counting down to zero, not null', () => {
        const snap = { totalQueueSeconds: 600, actions: [timed(600), endless, untimed] };
        expect(remainingQueueSeconds(snap, 100)).toBe(500);
        expect(remainingQueueSeconds(snap, 9999)).toBe(0);
        expect(queueTimeLeft(snap, 100).isLowerBound).toBe(false);
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
