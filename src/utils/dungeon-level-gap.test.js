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

    test('but not until the gap is ten whole levels, however the ratio reads at low levels', () => {
        // 40 against 49 is a ratio of 1.225 — past the fifth — but only nine levels
        expect(levelGapDebuff(40, 49)).toBe(0);
        // one more level and both conditions hold: ratio 1.25, 0.05 past the threshold
        expect(levelGapDebuff(40, 50)).toBeCloseTo(-0.15, 6);
        // and a ten-level gap that is not a fifth is still nothing
        expect(levelGapDebuff(100, 110)).toBe(0);
    });

    test('and it stops at ninety percent rather than reaching everything', () => {
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
        // 200 over 150 is a ratio of 1.333, floored to 0.13 past the threshold
        expect(gaps[2]).toBeCloseTo(-0.39, 6);
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
