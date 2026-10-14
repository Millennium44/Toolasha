import { describe, test, expect } from 'vitest';
import { cheapestWithMirror, MIRROR_FIRST_LEVEL } from './mirror-route.js';

describe('cheapestWithMirror', () => {
    test('never mirrors below the first level a mirror can make', () => {
        const { best, mirrorTotals } = cheapestWithMirror([100, 100, 100], 1);
        expect(MIRROR_FIRST_LEVEL).toBe(3);
        expect(mirrorTotals[2]).toBeUndefined();
        expect(best).toEqual([100, 100, 100]);
    });

    test('a mirror level is two cheaper levels plus the mirror, compounding upward', () => {
        const { best } = cheapestWithMirror([1, 2, 4, 8, 16, 32], 1);
        expect(best[3]).toBe(4 + 2 + 1);
        expect(best[4]).toBe(7 + 4 + 1);
        expect(best[5]).toBe(best[4] + best[3] + 1);
    });

    test('Blessed Tea: a +2 success means the next step is only run some of the time', () => {
        // Plain: level 4 = 7 + 4 + 1. With a 50% chance the +3 step skipped to +4, the +4 step is
        // run half the time: cost[4] = cost[3] + landing[3] * (cost[2] + price), landing[3] = 0.5
        const ordinary = [1, 2, 4, 8, 16, 32];
        const { best } = cheapestWithMirror(ordinary, 1, 0.5);
        expect(best[3]).toBe(7);
        expect(best[4]).toBe(7 + 0.5 * (4 + 1));
        expect(cheapestWithMirror(ordinary, 1, 0).best).toEqual(cheapestWithMirror(ordinary, 1).best);
        expect(cheapestWithMirror(ordinary, 1, 1).best[4]).toBe(7);
    });

    test('an unpriced level is not a free copy', () => {
        const { best, mirrorTotals } = cheapestWithMirror([1, null, 4, 8], 1);
        expect(best[1]).toBe(Infinity);
        expect(mirrorTotals[3]).toBe(Infinity);
        expect(best[3]).toBe(8);
    });
});
