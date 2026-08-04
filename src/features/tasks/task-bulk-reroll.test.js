/**
 * Tests for the Task Bulk Reroller's stopping rule.
 *
 * The rule these cover is the one that decides whether a card gets another
 * reroll or gets discarded — the one place where a divergence from what the
 * shield popup shows costs the player a task they meant to keep. Cap protection
 * paints its orange edge on EITHER category hitting its limit, so bulk reroll
 * has to stop on the same condition.
 */

import { describe, test, expect } from 'vitest';

import { isAtRerollCap } from './task-bulk-reroll.js';

// Thresholds as the shield popup stores them
const bothOpen = { coin: 320000, cowbell: 32 };

describe('isAtRerollCap', () => {
    test('a fresh card with both categories open is not at cap', () => {
        expect(isAtRerollCap(10000, 1, bothOpen)).toBe(false);
    });

    test('either category hitting its limit stops the card', () => {
        // Coins exhausted, cowbells still cheap — the old rule kept spending
        // cowbells here, which is exactly what protection calls "at cap"
        expect(isAtRerollCap(320000, 1, bothOpen)).toBe(true);
        expect(isAtRerollCap(10000, 32, bothOpen)).toBe(true);
    });

    test('a category allowing zero rerolls is ignored while the other is live', () => {
        const noCoins = { coin: 10000, cowbell: 32 };
        expect(isAtRerollCap(10000, 1, noCoins)).toBe(false);
        expect(isAtRerollCap(10000, 32, noCoins)).toBe(true);

        const noCowbells = { coin: 320000, cowbell: 1 };
        expect(isAtRerollCap(10000, 1, noCowbells)).toBe(false);
        expect(isAtRerollCap(320000, 1, noCowbells)).toBe(true);
    });

    test('both categories at zero means no rerolls at all', () => {
        expect(isAtRerollCap(10000, 1, { coin: 10000, cowbell: 1 })).toBe(true);
    });

    test('matches cap protection on the same inputs', () => {
        // Mirror of task-reroll-protection.js _cardIsAtCap
        const protectionRule = (coinCost, cowbellCost, limits) => {
            const coinAtCap = coinCost >= limits.coin;
            const cowbellAtCap = cowbellCost >= limits.cowbell;
            const coinZero = limits.coin <= 10000;
            const cowbellZero = limits.cowbell <= 1;
            if (coinZero && !cowbellZero) return cowbellAtCap;
            if (cowbellZero && !coinZero) return coinAtCap;
            return coinAtCap || cowbellAtCap;
        };

        const coinCosts = [10000, 20000, 40000, 80000, 160000, 320000];
        const cowbellCosts = [1, 2, 4, 8, 16, 32];
        const limitSets = [
            bothOpen,
            { coin: 10000, cowbell: 32 },
            { coin: 320000, cowbell: 1 },
            { coin: 80000, cowbell: 8 },
            { coin: 10000, cowbell: 1 },
        ];

        for (const limits of limitSets) {
            for (const coinCost of coinCosts) {
                for (const cowbellCost of cowbellCosts) {
                    expect(isAtRerollCap(coinCost, cowbellCost, limits)).toBe(
                        protectionRule(coinCost, cowbellCost, limits)
                    );
                }
            }
        }
    });
});
