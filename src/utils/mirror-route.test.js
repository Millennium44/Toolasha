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

    test('an unpriced level is not a free copy', () => {
        const { best, mirrorTotals } = cheapestWithMirror([1, null, 4, 8], 1);
        expect(best[1]).toBe(Infinity);
        expect(mirrorTotals[3]).toBe(Infinity);
        expect(best[3]).toBe(8);
    });
});
