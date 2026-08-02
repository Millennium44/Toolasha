import { describe, test, expect } from 'vitest';
import { upgradeCost, savingsProgress, timeToAffordSeconds, totalSavings } from './equipment-savings.js';

describe('upgradeCost', () => {
    test('the ask less what the old piece fetches', () => {
        // Reading the ask alone overstates every upgrade by the value of the
        // gear you are already wearing
        expect(upgradeCost({ targetAsk: 500_000_000, equippedBid: 400_000_000 })).toBe(100_000_000);
    });

    test('keeping the old piece means paying the whole ask', () => {
        expect(upgradeCost({ targetAsk: 500_000_000, equippedBid: 400_000_000, noSell: true })).toBe(500_000_000);
    });

    test('an empty slot has nothing to trade in', () => {
        expect(upgradeCost({ targetAsk: 500 })).toBe(500);
    });

    test('an upgrade worth less than what you wear costs nothing, not less than nothing', () => {
        // A negative cost would make a progress bar meaningless
        expect(upgradeCost({ targetAsk: 100, equippedBid: 900 })).toBe(0);
    });

    test('a target nobody is selling has no cost rather than a cost of nothing', () => {
        // Zero would report it as already affordable, which is the most
        // misleading thing this could say
        expect(upgradeCost({ targetAsk: 0, equippedBid: 100 })).toBeNull();
        expect(upgradeCost({ targetAsk: null })).toBeNull();
    });
});

describe('savingsProgress', () => {
    test('how far along, and how much is left', () => {
        expect(savingsProgress(1000, 250)).toEqual({ fraction: 0.25, affordable: false, needed: 750 });
    });

    test('the bar caps at full but the shortfall does not', () => {
        const progress = savingsProgress(1000, 4000);
        expect(progress.fraction).toBe(1);
        expect(progress.affordable).toBe(true);
        expect(progress.needed).toBe(0);
    });

    test('exactly enough is affordable', () => {
        expect(savingsProgress(1000, 1000).affordable).toBe(true);
    });

    test('nothing to save for is already there rather than a division by zero', () => {
        expect(savingsProgress(0, 0)).toEqual({ fraction: 1, affordable: true, needed: 0 });
    });

    test('an unpriced target has no progress to report', () => {
        expect(savingsProgress(null, 10_000)).toEqual({ fraction: null, affordable: false, needed: null });
    });
});

describe('timeToAffordSeconds', () => {
    test('what is left over what you earn', () => {
        expect(timeToAffordSeconds(200, 100)).toBe(2 * 86400);
    });

    test('already affordable is no time at all', () => {
        expect(timeToAffordSeconds(0, 100)).toBe(0);
    });

    test('no income is unmeasurable rather than never', () => {
        // A figure here would be a claim about the future
        expect(timeToAffordSeconds(500, 0)).toBeNull();
        expect(timeToAffordSeconds(500, -1)).toBeNull();
    });

    test('an unpriced target has no arrival time', () => {
        expect(timeToAffordSeconds(null, 100)).toBe(0);
    });
});

describe('totalSavings', () => {
    test('sums what it can price and counts what it cannot', () => {
        expect(totalSavings([{ cost: 100 }, { cost: 250 }, { cost: null }])).toEqual({ cost: 350, unpriced: 1 });
    });

    test('nothing watched is zero rather than nothing', () => {
        expect(totalSavings([])).toEqual({ cost: 0, unpriced: 0 });
    });
});
