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
    spareStock,
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

describe('protection from stock', () => {
    const prices = {
        '/items/sword': 20_000,
        '/items/mirror_of_protection': 8_000,
        '/items/sword_protector': 3_000,
        '/items/other_cape': 6_000,
    };
    const sells = {
        '/items/sword': 18_000,
        '/items/mirror_of_protection': 7_000,
        '/items/sword_protector': 2_500,
        '/items/other_cape': 5_000,
    };
    const priceOf = (hrid) => prices[hrid] || 0;
    const sellPriceOf = (hrid) => sells[hrid] || 0;
    const itemDetails = { protectionItemHrids: ['/items/sword_protector', '/items/other_cape'] };
    const choose = (holdings, reserve) =>
        chooseProtectionOptions({
            itemHrid: '/items/sword',
            itemDetails,
            selectedHrid: '/items/mirror_of_protection',
            priceOf,
            holdingsOf: (hrid) => holdings[hrid] || 0,
            reserve,
            sellPriceOf,
        }).options;
    const cape = { itemHrid: '/items/other_cape', name: 'Cape', price: 6_000, selected: false };

    test('spare stock is what is held above the reserve, never negative', () => {
        expect(spareStock(3, 2)).toBe(1);
        expect(spareStock(1, 2)).toBe(0);
        expect(spareStock(3, 0)).toBe(3);
        expect(spareStock(undefined, 2)).toBe(0);
    });

    test('every held candidate with spare copies gets a column; the slot and cheapest keep theirs', () => {
        const options = choose({ '/items/other_cape': 3, '/items/sword_protector': 1 }, 2);
        expect(options.map((option) => [option.itemHrid, option.role, option.stock])).toEqual([
            ['/items/mirror_of_protection', 'slot', 0],
            ['/items/sword_protector', 'cheapest', 0],
            ['/items/other_cape', 'held', 1],
        ]);
        // Spare copies are valued at what they would sell for
        expect(options[2].stockPrice).toBe(5_000);
        expect(options[2].held).toBe(3);
        expect(options[2].reserve).toBe(2);
    });

    test('reserve 0 spends every copy; reserve 2 keeps two back', () => {
        const all = choose({ '/items/other_cape': 3 }, 0).find((o) => o.itemHrid === '/items/other_cape');
        const kept = choose({ '/items/other_cape': 3 }, 2).find((o) => o.itemHrid === '/items/other_cape');
        expect(all.stock).toBe(3);
        expect(kept.stock).toBe(1);
        expect(choose({ '/items/other_cape': 2 }, 2).some((o) => o.itemHrid === '/items/other_cape')).toBe(false);
    });

    test('no bid falls back to the buy price; a bid above the ask is capped at it', () => {
        const base = { itemHrid: '/items/sword', itemDetails, priceOf, holdingsOf: () => 5, reserve: 2 };
        const noBid = chooseProtectionOptions({ ...base, sellPriceOf: () => 0 }).options;
        expect(noBid.length).toBeGreaterThan(1);
        expect(noBid.every((o) => o.stockPrice === o.price && o.stock === 3)).toBe(true);
        const inverted = chooseProtectionOptions({ ...base, sellPriceOf: (hrid) => priceOf(hrid) * 2 }).options;
        expect(inverted.every((o) => o.stockPrice === o.price)).toBe(true);
    });

    test('held 3, keep 2: one protection from stock at the sell price, the rest bought at the ask', () => {
        const plain = sweep({ protectionOptions: [cape] });
        const stocked = sweep({ protectionOptions: [{ ...cape, held: 3, reserve: 2, stock: 1, stockPrice: 5_000 }] });
        const index = plain.rows.findIndex((row) => row.protections > 1);
        expect(index).toBeGreaterThan(0);
        const before = plain.rows[index];
        const after = stocked.rows[index];
        expect(after.protections).toBe(before.protections);
        expect(after.protectionsFromStock).toBe(1);
        expect(after.protectionsToBuy).toBeCloseTo(before.protections - 1, 10);
        // One copy that would have cost the ask now costs what it would have sold for
        expect(after.expectedCost).toBeCloseTo(before.expectedCost - (6_000 - 5_000), 6);
        // Never more from stock than the run expects to use
        for (const row of stocked.rows) {
            expect(row.protectionsFromStock).toBeLessThanOrEqual(row.protections);
            expect(row.protectionsFromStock + row.protectionsToBuy).toBeCloseTo(row.protections, 10);
        }
    });

    test('reserve 0 versus 2 on the same bag: more stock, cheaper rows', () => {
        const keep0 = sweep({ protectionOptions: [{ ...cape, held: 3, reserve: 0, stock: 3, stockPrice: 5_000 }] });
        const keep2 = sweep({ protectionOptions: [{ ...cape, held: 3, reserve: 2, stock: 1, stockPrice: 5_000 }] });
        const index = keep0.rows.findIndex((row) => row.protections > 3);
        expect(index).toBeGreaterThan(0);
        expect(keep0.rows[index].protectionsFromStock).toBe(3);
        expect(keep2.rows[index].protectionsFromStock).toBe(1);
        expect(keep2.rows[index].expectedCost - keep0.rows[index].expectedCost).toBeCloseTo(2 * 1_000, 6);
    });

    test('no spare stock leaves every row exactly as it was', () => {
        const plain = sweep({ protectionOptions: [cape] });
        const empty = sweep({ protectionOptions: [{ ...cape, held: 2, reserve: 2, stock: 0, stockPrice: 0 }] });
        const pick = ({ expectedCost, costStdDev, p10, p90, protections, goldPerXp }) => ({
            expectedCost,
            costStdDev,
            p10,
            p90,
            protections,
            goldPerXp,
        });
        expect(empty.rows.map(pick)).toEqual(plain.rows.map(pick));
        expect(empty.cheapestIndex).toBe(plain.cheapestIndex);
        expect(empty.rows.every((row) => row.protectionsFromStock === 0)).toBe(true);
    });

    test('the memo misses when holdings or the reserve change', () => {
        const option = (held, reserve) => ({
            ...cape,
            held,
            reserve,
            stock: spareStock(held, reserve),
            stockPrice: 5_000,
        });
        const args = (held, reserve) => ({
            chain,
            targetLevel: 6,
            materialCostPerAttempt: 100,
            protectionOptions: [option(held, reserve)],
            perActionTime: 10,
        });
        const first = sweepProtectFromMemo(args(3, 2));
        expect(sweepProtectFromMemo(args(3, 2))).toBe(first);
        const bought = sweepProtectFromMemo(args(4, 2));
        expect(bought).not.toBe(first);
        // Protect from +2 to +6 spends more than two protections, so the extra copy shows
        expect(bought.rows[1].protectionsFromStock).toBeGreaterThan(first.rows[1].protectionsFromStock);
        expect(sweepProtectFromMemo(args(3, 0))).not.toBe(first);
    });
});
