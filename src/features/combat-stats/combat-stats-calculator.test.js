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
const ev = vi.hoisted(() => ({ value: 0 }));
const luck = vi.hoisted(() => ({ enabled: false, measured: null }));

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
        isInitialized: true,
        getCachedValue: () => ev.value,
        calculateSingleContainer: () => ev.value,
        calculateExpectedValue: (hrid) =>
            ev.value > 0 ? { itemHrid: hrid, itemName: hrid, expectedValue: ev.value, drops: [] } : null,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (id) => (id === 'dropLuck_profitAdjust' ? luck.enabled : false) },
}));

vi.mock('../combat/combat-drop-luck.js', () => ({
    measuredChestLuck: () => luck.measured,
}));

const { calculateKeyCosts, calculatePlayerStats, calculateIncome, calculateIncomeBreakdown, describeLuckAdjustment } =
    await import('./combat-stats-calculator.js');

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
    ev.value = 0;
    luck.enabled = false;
    luck.measured = null;
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

describe('measured-luck adjustment of a dungeon chest EV', () => {
    const lootOf = (hrid = CHIMERICAL_CHEST) => ({ a: { itemHrid: hrid, count: 2 } });

    beforeEach(() => {
        ev.value = 100000;
        luck.measured = { ratio: 0.926, chests: 5490 };
    });

    test('the setting gates the adjustment: off means drop-table EV even with data', () => {
        luck.enabled = false;

        expect(calculateIncome(lootOf()).ask).toBe(200000);
        const row = calculateIncomeBreakdown(lootOf()).breakdown[0];
        expect(row.evPerChest).toBe(100000);
        expect(row.luckAdjustment).toBeNull();
    });

    test('on, the measured ratio scales income and rides the breakdown for labelling', () => {
        luck.enabled = true;

        expect(calculateIncome(lootOf()).ask).toBeCloseTo(2 * 100000 * 0.926, 6);
        expect(calculateIncome(lootOf()).bid).toBeCloseTo(2 * 100000 * 0.926, 6);

        const row = calculateIncomeBreakdown(lootOf()).breakdown[0];
        expect(row.evPerChest).toBeCloseTo(92600, 6);
        expect(row.totalValue).toBeCloseTo(185200, 6);
        expect(row.luckAdjustment).toEqual({ ratio: 0.926, chests: 5490 });
    });

    test('no measurement means no adjustment, even with the setting on', () => {
        luck.enabled = true;
        luck.measured = null;

        expect(calculateIncome(lootOf()).ask).toBe(200000);
        expect(calculateIncomeBreakdown(lootOf()).breakdown[0].luckAdjustment).toBeNull();
    });

    test('only a dungeon chest: another openable is left at its drop-table EV', () => {
        luck.enabled = true;

        // Openable under the mock, but not a chest a dungeon completion pays
        expect(calculateIncome(lootOf('/items/treasure_chest')).ask).toBe(200000);
        expect(calculateIncomeBreakdown(lootOf('/items/treasure_chest')).breakdown[0].luckAdjustment).toBeNull();
    });

    test('the adjustments surface on the player stats, and profit is built on them', () => {
        luck.enabled = true;

        const stats = calculatePlayerStats({ name: 'You', loot: lootOf(), deathCount: 0 }, 3600);

        expect(stats.chestLuckAdjustments).toEqual([{ itemName: CHIMERICAL_CHEST, ratio: 0.926, chests: 5490 }]);
        // Adjusted income of 185,200 less two entry keys and two chest keys
        expect(stats.dailyProfit.ask).toBeCloseTo((185200 - 2 * 25000) * 24, 6);
    });

    test('describeLuckAdjustment words the adjustment for wherever it is shown', () => {
        expect(describeLuckAdjustment({ itemName: 'Chimerical Chest', ratio: 0.926, chests: 5490 })).toBe(
            'Chimerical Chest EV adjusted by your measured -7.4% (5,490 chests)'
        );
    });
});
