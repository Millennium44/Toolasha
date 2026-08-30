/**
 * The protect-from sweep, on a plain table.
 *
 * What is worth pinning is the shape of the answer, not the digits: protecting from a lower
 * level trades attempts for protections, the cheapest row moves with the protection price,
 * the spread brackets the expectation, and the memo hands back the same object for the same
 * question.
 */

import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';
import {
    sweepProtectFrom,
    sweepProtectFromMemo,
    clearProtectSweepMemo,
    chooseProtectionOptions,
    expectedRunXp,
    cheapestProtectPlan,
    protectFromLevels,
    NO_PROTECTION,
    MIN_PROTECT_FROM,
} from './enhancement-protect-sweep.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

beforeEach(() => {
    clearProtectSweepMemo();
});

const chain = {
    enhancingLevel: 80,
    toolBonus: 5,
    speedBonus: 0,
    itemLevel: 60,
    blessedTea: false,
    guzzlingBonus: 1,
};

const sweep = (overrides = {}) =>
    sweepProtectFrom({
        chain,
        targetLevel: 6,
        materialCostPerAttempt: 1000,
        protectionOptions: [{ itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 5000, selected: true }],
        perActionTime: 10,
        xpBaseLevel: 60,
        wisdomDecimal: 0,
        ...overrides,
    });

describe('sweepProtectFrom', () => {
    test('lays out the no-protection row, then every protect-from level 2..target per option', () => {
        const { rows } = sweep();
        expect(rows[0].protectFrom).toBe(NO_PROTECTION);
        expect(rows[0].itemHrid).toBeNull();
        expect(rows[0].protections).toBe(0);
        expect(rows.slice(1).map((row) => row.protectFrom)).toEqual([2, 3, 4, 5, 6]);
        expect(rows.slice(1).every((row) => row.itemHrid === '/items/mirror_of_protection')).toBe(true);
    });

    test('protecting from a lower level costs attempts less and protections more, monotonically', () => {
        const { rows } = sweep();
        const protectedRows = rows.slice(1);
        for (let i = 1; i < protectedRows.length; i++) {
            expect(protectedRows[i].attempts).toBeGreaterThanOrEqual(protectedRows[i - 1].attempts - 1e-9);
            expect(protectedRows[i].protections).toBeLessThanOrEqual(protectedRows[i - 1].protections + 1e-9);
        }
        // Protecting from the target itself means no level is ever protected: same as none
        const last = protectedRows[protectedRows.length - 1];
        expect(last.attempts).toBeCloseTo(rows[0].attempts, 6);
        expect(last.protections).toBeCloseTo(0, 9);
    });

    test('the cheapest row follows the protection price', () => {
        const free = sweep({
            protectionOptions: [{ itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 0 }],
        });
        // Free protection: protect from +2 is the fewest attempts and therefore the cheapest
        expect(free.rows[free.cheapestIndex].protectFrom).toBe(2);

        const ruinous = sweep({
            protectionOptions: [{ itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 1e9 }],
        });
        expect(ruinous.rows[ruinous.cheapestIndex].protectFrom).toBe(NO_PROTECTION);
    });

    test('expected cost is materials per attempt plus protections, and the spread brackets it', () => {
        const { rows } = sweep();
        for (const row of rows) {
            const expected = 1000 * row.attempts + 5000 * row.protections;
            expect(row.expectedCost).toBeCloseTo(expected, 6);
            expect(row.p10).toBeLessThanOrEqual(row.expectedCost + 1e-6);
            expect(row.p90).toBeGreaterThanOrEqual(row.expectedCost - 1e-6);
            expect(row.time).toBeCloseTo(10 * row.attempts, 6);
        }
    });

    test('the spread is flagged approximate exactly where protection is priced in', () => {
        const { rows } = sweep();
        for (const row of rows) {
            // Protection is spent on protected failures, not per attempt, so
            // only the rows that pay for it have an approximated spread
            expect(row.spreadApprox).toBe(row.protectFrom > 0 && row.protections > 0);
        }
        expect(rows[0].protectFrom).toBe(0);
        expect(rows[0].spreadApprox).toBe(false);
    });

    test('XP and gold per XP are populated, and the best gold/XP row is flagged', () => {
        const { rows, bestGoldPerXpIndex } = sweep();
        expect(rows.every((row) => row.xp > 0 && row.goldPerXp > 0)).toBe(true);
        const best = Math.min(...rows.map((row) => row.goldPerXp));
        expect(rows[bestGoldPerXpIndex].goldPerXp).toBe(best);
    });

    test('two options share one chain: attempts agree row for row, costs differ by the price', () => {
        const { rows } = sweep({
            protectionOptions: [
                { itemHrid: '/items/a', name: 'A', price: 5000, selected: true },
                { itemHrid: '/items/b', name: 'B', price: 1000 },
            ],
        });
        const a = rows.filter((row) => row.itemHrid === '/items/a');
        const b = rows.filter((row) => row.itemHrid === '/items/b');
        expect(a.length).toBe(b.length);
        a.forEach((row, i) => {
            expect(b[i].attempts).toBe(row.attempts);
            expect(b[i].expectedCost).toBeCloseTo(row.expectedCost - 4000 * row.protections, 6);
        });
    });

    test('a target below +2 yields the no-protection row only', () => {
        const { rows } = sweep({ targetLevel: 1 });
        expect(rows).toHaveLength(1);
    });
});

describe('sweepProtectFromMemo', () => {
    test('returns the same result for the same inputs and a new one when a price moves', () => {
        const args = {
            chain,
            targetLevel: 5,
            materialCostPerAttempt: 100,
            protectionOptions: [{ itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 500 }],
            perActionTime: 10,
        };
        const first = sweepProtectFromMemo(args);
        expect(sweepProtectFromMemo({ ...args })).toBe(first);
        const moved = sweepProtectFromMemo({
            ...args,
            protectionOptions: [{ itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 600 }],
        });
        expect(moved).not.toBe(first);
    });
});

describe('chooseProtectionOptions', () => {
    const prices = {
        '/items/sword': 20_000,
        '/items/mirror_of_protection': 8_000,
        '/items/sword_protector': 3_000,
    };
    const priceOf = (hrid) => prices[hrid] || 0;
    const itemDetails = { protectionItemHrids: ['/items/sword_protector'] };

    test('the slot item first, then the cheapest other candidate', () => {
        const { options } = chooseProtectionOptions({
            itemHrid: '/items/sword',
            itemDetails,
            selectedHrid: '/items/mirror_of_protection',
            priceOf,
        });
        expect(options.map((option) => option.itemHrid)).toEqual([
            '/items/mirror_of_protection',
            '/items/sword_protector',
        ]);
        expect(options[0].selected).toBe(true);
        expect(options[1].price).toBe(3_000);
    });

    test('no alternative column when the slot already holds the cheapest', () => {
        const { options } = chooseProtectionOptions({
            itemHrid: '/items/sword',
            itemDetails,
            selectedHrid: '/items/sword_protector',
            priceOf,
        });
        expect(options).toHaveLength(1);
    });

    test("a Philosopher's Mirror in the slot is not a protect-from item; the sweep prices the cheapest", () => {
        const { options, selectedIsMirror } = chooseProtectionOptions({
            itemHrid: '/items/sword',
            itemDetails,
            selectedHrid: '/items/philosophers_mirror',
            priceOf,
        });
        expect(selectedIsMirror).toBe(true);
        expect(options.map((option) => option.itemHrid)).toEqual(['/items/sword_protector']);
    });

    test('an empty slot yields the cheapest candidate alone', () => {
        const { options } = chooseProtectionOptions({ itemHrid: '/items/sword', itemDetails, priceOf });
        expect(options).toEqual([
            { itemHrid: '/items/sword_protector', name: '/items/sword_protector', price: 3_000, selected: false },
        ]);
    });
});

describe('expectedRunXp', () => {
    test('weights success and failure XP by the expected visits', () => {
        const calc = {
            visitCounts: [2, 1],
            successRates: [{ actualRate: 50 }, { actualRate: 100 }],
        };
        // +0: success 1.4·1·(10+10)=28, fail 2 → 2 visits × (0.5·28 + 0.5·2) = 30
        // +1: success 1.4·2·20=56, fail 5 → 1 visit × 56 = 56
        expect(expectedRunXp(calc, { xpBaseLevel: 10 })).toBeCloseTo(86, 9);
    });
});

describe('the protect-from search range', () => {
    test('runs 2 to the target, and never bounds itself at the start level', () => {
        expect(MIN_PROTECT_FROM).toBe(2);
        expect(protectFromLevels(6)).toEqual([2, 3, 4, 5, 6]);
        // +1 has no protectable failure: a failure there lands at +0 either way
        expect(protectFromLevels(1)).toEqual([]);

        // The search does not shrink when the run starts higher. Protecting from
        // below the start is not a wasted setting — the first failure drops you
        // under it, and the protection is what stops the next one going to +0.
        const high = sweep({ startLevel: 4 });
        expect(high.rows.slice(1).map((row) => row.protectFrom)).toEqual([2, 3, 4, 5, 6]);
    });
});

describe('cheapestProtectPlan', () => {
    const plan = (overrides = {}) =>
        cheapestProtectPlan({
            chain,
            targetLevel: 6,
            materialCostPerAttempt: 1000,
            protectionOptions: [
                { itemHrid: '/items/mirror_of_protection', name: 'Mirror', price: 5000, selected: true },
            ],
            ...overrides,
        });

    test('is the cheapest row of the sweep it wraps', () => {
        const { rows, cheapestIndex } = sweep({ perActionTime: undefined, xpBaseLevel: undefined });
        const cheapest = rows[cheapestIndex];
        const one = plan();
        expect(one.cost).toBeCloseTo(cheapest.expectedCost, 6);
        expect(one.protectFrom).toBe(cheapest.protectFrom);
    });

    test('starting higher is never dearer than starting lower', () => {
        const costs = [0, 1, 2, 3, 4, 5].map((startLevel) => plan({ startLevel }).cost);
        for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeLessThanOrEqual(costs[i - 1] + 1e-6);
    });

    test('a run nothing about which can be priced is unknown, not free', () => {
        expect(plan({ materialCostPerAttempt: 0, protectionOptions: [] })).toBeNull();
    });

    test('carries the caller’s unpriced-material flag rather than hiding it', () => {
        expect(plan({ hasMissingPrices: true }).hasMissingPrices).toBe(true);
        expect(plan().hasMissingPrices).toBe(false);
    });

    test('with no protection to buy there is only the ruinous unprotected run', () => {
        const bare = plan({ protectionOptions: [] });
        expect(bare.protectFrom).toBe(NO_PROTECTION);
        expect(bare.cost).toBeGreaterThan(plan().cost);
    });
});
