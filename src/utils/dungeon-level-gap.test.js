/**
 * The level gap debuff.
 *
 * The cases worth a test are the boundary — where a party is close enough that
 * there is no penalty at all — the cap, and the difference between "no penalty"
 * and "no level to check", which a naive version collapses into the same zero.
 */

import { describe, test, expect } from 'vitest';
import { levelGapDebuff, partyLevelGaps, isLevelGapped, MAX_LEVEL_GAP_DEBUFF } from './dungeon-level-gap.js';

describe('one character against the party', () => {
    test('within a fifth of the top there is no penalty', () => {
        expect(levelGapDebuff(100, 100)).toBe(0);
        expect(levelGapDebuff(100, 120)).toBe(0);
    });

    test('past that it bites, three points per point of ratio', () => {
        // 100 against 130 is a ratio of 1.3, which is 0.10 past the threshold
        expect(levelGapDebuff(100, 130)).toBeCloseTo(-0.3, 6);
    });

    test('and it is continuous, not stepped to whole percents', () => {
        // 100 against 120.1 is a thousandth past the threshold — a real -0.3%,
        // where quantizing the ratio to whole percents would call it nothing
        expect(levelGapDebuff(100, 120.1)).toBeCloseTo(-0.003, 9);
    });

    test('but not until the gap is ten whole levels, however the ratio reads at low levels', () => {
        // At 40 the threshold is 50/40 = 1.25, so the top must exceed 50 exactly
        expect(levelGapDebuff(40, 49)).toBe(0);
        // Exactly ten levels above is exactly at the threshold, and the server's
        // comparison is strict — still no penalty
        expect(levelGapDebuff(40, 50)).toBe(0);
        // One past it: ratio 51/40 = 1.275, a quarter of a percent past 1.25
        expect(levelGapDebuff(40, 51)).toBeCloseTo(-0.075, 6);
        // and a ten-level gap that is not a fifth is still nothing
        expect(levelGapDebuff(100, 110)).toBe(0);
    });

    test('and it stops at ninety percent rather than reaching everything', () => {
        // The server floors its multiplier at a tenth; 100 against 160 is already
        // past that, and the ratios beyond it go nowhere further
        expect(levelGapDebuff(100, 160)).toBe(-MAX_LEVEL_GAP_DEBUFF);
        expect(levelGapDebuff(10, 1000)).toBe(-MAX_LEVEL_GAP_DEBUFF);
    });

    test('being above the party is not a bonus', () => {
        expect(levelGapDebuff(200, 100)).toBe(0);
    });

    test('an unknown level is unknown, not unpenalised', () => {
        // The distinction the panel depends on: a missing level must not be
        // drawn as a clean bill of health
        expect(levelGapDebuff(null, 100)).toBeNull();
        expect(levelGapDebuff(100, 0)).toBeNull();
        expect(levelGapDebuff(undefined, undefined)).toBeNull();
    });
});

describe('the party at once', () => {
    test('everybody is measured against whoever is highest', () => {
        const gaps = partyLevelGaps([200, 200, 150, 100]);

        expect(gaps[0]).toBe(0);
        expect(gaps[1]).toBe(0);
        // 200 over 150 is a ratio of 1.333, 0.1333 past the threshold
        expect(gaps[2]).toBeCloseTo(-0.4, 6);
        expect(gaps[3]).toBe(-MAX_LEVEL_GAP_DEBUFF);
    });

    test('alone there is nobody to be below', () => {
        expect(partyLevelGaps([100])).toEqual([0]);
    });

    test('a party with one level missing still measures the rest', () => {
        const gaps = partyLevelGaps([200, null, 100]);

        expect(gaps[0]).toBe(0);
        expect(gaps[1]).toBeNull();
        expect(gaps[2]).toBe(-MAX_LEVEL_GAP_DEBUFF);
    });

    test('no levels at all is no verdict on anybody', () => {
        expect(partyLevelGaps([null, null])).toEqual([null, null]);
        expect(partyLevelGaps()).toEqual([]);
    });
});

describe('whether to trust a luck reading', () => {
    test('a penalty means the reading is about the party, not the gear', () => {
        expect(isLevelGapped(-0.3)).toBe(true);
        expect(isLevelGapped(0)).toBe(false);
    });

    test('and an unknown level is not evidence of one', () => {
        expect(isLevelGapped(null)).toBe(false);
    });
});
