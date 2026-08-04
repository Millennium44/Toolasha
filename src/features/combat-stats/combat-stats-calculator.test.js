/**
 * Tests for dungeon key costs in the combat statistics calculator
 *
 * The costing itself belongs to `src/utils/key-cost.js` and is tested there.
 * What this pins is what the profit figure does with it: that a run is charged
 * the cheaper of buying and crafting each key, that the alternative survives
 * into the breakdown so the display can show it, that a key nobody can price is
 * skipped rather than counted as free, and that the pricing mode comes back out
 * with the numbers.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const keys = vi.hoisted(() => ({ mode: 'ask', costs: {} }));

vi.mock('../../utils/key-cost.js', () => ({
    getKeyPricingMode: () => keys.mode,
    describeKeyCost: (keyHrid) =>
        keys.costs[keyHrid] ?? {
            itemHrid: keyHrid,
            itemName: keyHrid,
            pricingMode: keys.mode,
            buyPrice: null,
            craftCost: null,
            craftSeconds: null,
            craftActionHrid: null,
            cheaper: null,
            unitCost: null,
            savings: 0,
        },
}));

vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => ({ name: hrid, isOpenable: hrid.includes('chest') }) },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: false,
        getCachedValue: () => 0,
        calculateSingleContainer: () => 0,
        calculateExpectedValue: () => null,
    },
}));

const { calculateKeyCosts, calculatePlayerStats } = await import('./combat-stats-calculator.js');

const CHIMERICAL_CHEST = '/items/chimerical_chest';
const CHIMERICAL_REFINEMENT = '/items/chimerical_refinement_chest';
const ENTRY_KEY = '/items/chimerical_entry_key';
const CHEST_KEY = '/items/chimerical_chest_key';

/** A costed key, the shape `describeKeyCost` returns */
function cost(itemHrid, { buyPrice = null, craftCost = null, craftSeconds = null }) {
    let cheaper = null;
    if (craftCost === null) cheaper = buyPrice === null ? null : 'buy';
    else if (buyPrice === null) cheaper = 'craft';
    else cheaper = craftCost < buyPrice ? 'craft' : 'buy';

    return {
        itemHrid,
        itemName: itemHrid,
        pricingMode: keys.mode,
        buyPrice,
        craftCost,
        craftSeconds,
        craftActionHrid: craftCost === null ? null : `/actions/crafting/${itemHrid}`,
        cheaper,
        unitCost: cheaper === 'craft' ? craftCost : buyPrice,
        savings: buyPrice !== null && craftCost !== null ? Math.abs(buyPrice - craftCost) : 0,
    };
}

beforeEach(() => {
    keys.mode = 'ask';
    keys.costs = {
        [ENTRY_KEY]: cost(ENTRY_KEY, { buyPrice: 20000 }),
        [CHEST_KEY]: cost(CHEST_KEY, { buyPrice: 8000, craftCost: 5000, craftSeconds: 60 }),
    };
});

describe('calculateKeyCosts', () => {
    test('charges the cheaper of buying and crafting each key', () => {
        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 2 } }, 3600);

        // One entry key and one chest key per chest: 2 × (20000 bought + 5000 crafted)
        expect(result.ask).toBe(50000);
        expect(result.bid).toBe(50000);

        const chestKeyRow = result.breakdown.find((row) => row.itemHrid === CHEST_KEY);
        expect(chestKeyRow.pricePerItem).toBe(5000);
        expect(chestKeyRow.totalCost).toBe(10000);
    });

    test('keeps the alternative and the craft time in the breakdown', () => {
        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        const chestKeyRow = result.breakdown.find((row) => row.itemHrid === CHEST_KEY);
        expect(chestKeyRow.keyCost.cheaper).toBe('craft');
        expect(chestKeyRow.keyCost.buyPrice).toBe(8000);
        expect(chestKeyRow.keyCost.craftCost).toBe(5000);
        expect(chestKeyRow.keyCost.craftSeconds).toBe(60);
        expect(chestKeyRow.keyCost.savings).toBe(3000);
    });

    test('charges the market price when buying is the cheaper side', () => {
        keys.costs[CHEST_KEY] = cost(CHEST_KEY, { buyPrice: 3000, craftCost: 5000, craftSeconds: 60 });

        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        expect(result.ask).toBe(23000);
        expect(result.breakdown.find((row) => row.itemHrid === CHEST_KEY).keyCost.cheaper).toBe('buy');
    });

    test('crafts a key the market has none of', () => {
        keys.costs[CHEST_KEY] = cost(CHEST_KEY, { craftCost: 5000, craftSeconds: 60 });

        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        expect(result.ask).toBe(25000);
        expect(result.breakdown.find((row) => row.itemHrid === CHEST_KEY).pricePerItem).toBe(5000);
    });

    test('skips a key that can be neither bought nor crafted', () => {
        keys.costs[CHEST_KEY] = cost(CHEST_KEY, {});

        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        expect(result.ask).toBe(20000);
        expect(result.breakdown.map((row) => row.itemHrid)).toEqual([ENTRY_KEY]);
    });

    test('refinement chests take a chest key but not an entry key', () => {
        const result = calculateKeyCosts(
            {
                a: { itemHrid: CHIMERICAL_CHEST, count: 1 },
                b: { itemHrid: CHIMERICAL_REFINEMENT, count: 3 },
            },
            3600
        );

        const entryRow = result.breakdown.find((row) => row.itemHrid === ENTRY_KEY);
        const chestKeyRow = result.breakdown.find((row) => row.itemHrid === CHEST_KEY);
        expect(entryRow.count).toBe(1);
        expect(chestKeyRow.count).toBe(4);
        expect(result.ask).toBe(20000 + 4 * 5000);
    });

    test('reports the pricing mode it costed with', () => {
        keys.mode = 'bid';
        expect(calculateKeyCosts({}, 3600).pricingMode).toBe('bid');
        expect(calculateKeyCosts(null, 3600).pricingMode).toBe('bid');
    });

    test('turns the run cost into a daily rate', () => {
        const result = calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        expect(result.dailyCost).toBe(25000 * 24);
    });
});

describe('calculatePlayerStats', () => {
    test('carries the key pricing mode out with the profit figures', () => {
        keys.mode = 'bid';

        const stats = calculatePlayerStats(
            { name: 'You', loot: { a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, deathCount: 0 },
            3600
        );

        expect(stats.keyPricingMode).toBe('bid');
        expect(stats.keyBreakdown.find((row) => row.itemHrid === CHEST_KEY).keyCost.cheaper).toBe('craft');
        expect(stats.dailyProfit.ask).toBe(-25000 * 24);
    });
});
