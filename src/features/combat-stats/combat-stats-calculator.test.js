/**
 * Tests for dungeon key costs in the combat statistics calculator
 *
 * The costing itself — and which of buying and crafting a key's cost actually
 * follows — belongs to `src/utils/key-cost.js` and is tested there. What this
 * pins is what the profit figure does with whatever `describeKeyCost` hands
 * back: that a run is charged its `unitCost`, that the alternative survives
 * into the breakdown so the display can show it, that a key nobody can price is
 * skipped rather than counted as free, and that the pricing mode comes back out
 * with the numbers. The `cost()` fixture below reproduces the market basis's
 * cheaper-of comparison only because that is a convenient way to vary which
 * route a test exercises — it is not asserting that production picks the
 * cheaper side.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const keys = vi.hoisted(() => ({ mode: 'ask', basis: 'market', costs: {}, calls: [] }));
const ev = vi.hoisted(() => ({ value: 0 }));
const luck = vi.hoisted(() => ({ enabled: false, measured: null }));

vi.mock('../../utils/key-cost.js', () => ({
    resolveKeyPricing: () => ({ priceSide: keys.mode, basis: keys.basis }),
    describeKeyCost: (keyHrid, options) => {
        keys.calls.push({ keyHrid, options });
        return (
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
            }
        );
    },
}));

const market = vi.hoisted(() => ({ prices: {} }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: (hrid) => market.prices[hrid] || null } }));

// The configured Buy/Sell pricing (`.value`) is read through `getItemPrice`
// rather than the raw book — mocked directly here rather than exercising the
// real `market-data.js`, which pulls in custom price overrides, the value-map
// band clamp and the patient tick, none of which this file is about.
// `configured.price(itemHrid, side)` lets a test hand back whatever the
// pricing setting under test would resolve to.
const configured = vi.hoisted(() => ({ price: () => null }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, options) => configured.price(itemHrid, options?.side),
}));

// The sale-tax netting is a shared flag; default it off so the existing income
// tests read gross, and the tax tests below turn it on explicitly.
const salesTax = vi.hoisted(() => ({ netted: false }));
vi.mock('./sales-tax-view.js', () => ({ salesTaxNetted: () => salesTax.netted }));

// Iron Cow valuation is not what most tests are about; default both answers to
// "not an Iron Cow character, no book price" (the real module's answer with no
// character loaded) and let the sum-equivalence test below opt one item in.
const ironCow = vi.hoisted(() => ({ book: {}, isCharacter: false }));
vi.mock('../../utils/ironcow-valuation.js', () => ({
    ironCowBook: (itemHrid) => ironCow.book[itemHrid] || null,
    isIronCowCharacter: () => ironCow.isCharacter,
}));

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

// The calculator reaches the treasure tracker through the global, so the test
// provides one — {ratio, opened} as `measuredReturn` answers
globalThis.window = globalThis.window || {};
globalThis.window.Toolasha = { Market: { treasureTracker: { measuredReturn: () => luck.measured } } };

const {
    calculateKeyCosts,
    calculatePlayerStats,
    calculateIncome,
    calculateIncomeItems,
    calculateIncomeBreakdown,
    describeLuckAdjustment,
    calculateConsumableCosts,
} = await import('./combat-stats-calculator.js');
const { MARKET_TAX, COWBELL_BAG_TAX } = await import('../../utils/profit-constants.js');

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
    keys.basis = 'market';
    keys.calls = [];
    keys.costs = {
        [ENTRY_KEY]: cost(ENTRY_KEY, { buyPrice: 20000 }),
        [CHEST_KEY]: cost(CHEST_KEY, { buyPrice: 8000, craftCost: 5000, craftSeconds: 60 }),
    };
    ev.value = 0;
    luck.enabled = false;
    luck.measured = null;
    ironCow.book = {};
    ironCow.isCharacter = false;
    // Mirrors the real `getItemPrice`'s shape closely enough for these tests:
    // an Iron Cow item values the same on both sides, and otherwise 'buy'
    // reads the ask and 'sell' the bid — the `hybrid` pricing mode's mapping,
    // which is the schema default. A test after the configured price itself
    // (rather than this approximation) overrides `configured.price` directly.
    configured.price = (itemHrid, side) => {
        if (ironCow.book[itemHrid]) return ironCow.book[itemHrid].ask;
        const prices = market.prices[itemHrid];
        if (!prices) return null;
        return side === 'buy' ? prices.ask : prices.bid;
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

    test('passes the craft basis through to the key costing when the setting is craft', () => {
        // Regression: the costing used to be called with only `mode` (the market
        // side), which forces `describeKeyCost`'s own basis resolution to
        // 'market' whenever a caller supplies an explicit mode — silently
        // ignoring a `craft` setting. Combat income must reach the same craft
        // basis the setting promises.
        keys.mode = 'ask';
        keys.basis = 'craft';

        calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        const chestKeyCall = keys.calls.find((call) => call.keyHrid === CHEST_KEY);
        expect(chestKeyCall.options.mode).toBe('ask');
        expect(chestKeyCall.options.basis).toBe('craft');
    });

    test.each(['ask', 'bid', 'synced'])('still costs the market basis when the setting is %s', (mode) => {
        keys.mode = mode === 'synced' ? 'bid' : mode;
        keys.basis = 'market';

        calculateKeyCosts({ a: { itemHrid: CHIMERICAL_CHEST, count: 1 } }, 3600);

        const chestKeyCall = keys.calls.find((call) => call.keyHrid === CHEST_KEY);
        expect(chestKeyCall.options.basis).toBe('market');
        expect(chestKeyCall.options.mode).toBe(keys.mode);
    });
});

describe('calculateConsumableCosts', () => {
    beforeEach(() => {
        market.prices = {};
    });

    test('an item the market has never priced is not billed as if it cost 500 coins', () => {
        // marketAPI.getPrice returns null (mocked above, matching the real
        // module's contract) for an item nobody has ever listed — not the same
        // thing as an item that is listed with a genuine ask of 0. Billing it at
        // a fabricated 500 coins/unit is exactly the "unknown treated as a real
        // price" bug: the forecast and buy-recommendation math downstream both
        // read pricePerItem as "a real, known price" the moment it is not null.
        const result = calculateConsumableCosts(
            [{ itemHrid: '/items/unpriced_food', consumed: 10, consumedPerDay: 240 }],
            3600
        );

        expect(result.breakdown[0].pricePerItem).toBeNull();
        expect(result.total).toBe(0);
    });

    test('an item the market does price is billed at its real ask', () => {
        market.prices['/items/priced_food'] = { ask: 120, bid: 100 };

        const result = calculateConsumableCosts(
            [{ itemHrid: '/items/priced_food', consumed: 10, consumedPerDay: 240 }],
            3600
        );

        expect(result.breakdown[0].pricePerItem).toBe(120);
        expect(result.total).toBe(1200);
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

    test('an unpriced consumable costs nothing in the daily total rather than poisoning it', () => {
        // pricePerItem is null for an unpriced item now (see calculateConsumableCosts
        // above). null coerces to 0 in the multiplication, so this is a belt-and-braces
        // check on dailyConsumableCosts rather than a second bug: it pins that a
        // null price contributes nothing to the sum, and that a priced item alongside
        // it is still charged correctly.
        market.prices['/items/priced_food'] = { ask: 100, bid: 90 };

        const stats = calculatePlayerStats(
            {
                name: 'You',
                loot: {},
                deathCount: 0,
                consumables: [
                    { itemHrid: '/items/unpriced_food', consumed: 10, consumedPerDay: 240 },
                    { itemHrid: '/items/priced_food', consumed: 5, consumedPerDay: 120 },
                ],
            },
            3600
        );

        expect(Number.isNaN(stats.dailyConsumableCosts)).toBe(false);
        expect(stats.dailyConsumableCosts).toBe(120 * 100);
    });
});

describe('what a dungeon run banked, as the Party Loot panel and the Total Profit tile read it', () => {
    // Both readers subtract `consumableCosts.bid` and `keyCosts.bid` from
    // `income.bid`. `consumableCosts` used to come back as a bare number, so
    // `.bid` read undefined and every banked figure — Party Loot's cards, its
    // party total, its copy and CSV export, and the Total Profit tile — charged
    // a run nothing for the food and drink it ate while the daily rate beside
    // it did subtract them.
    test('consumables come back as {ask, bid}, so the banked figure subtracts them', () => {
        ev.value = 5_830_000;
        market.prices['/items/spaceberry_cake'] = { ask: 2000, bid: 1800 };
        market.prices['/items/ultra_melee_coffee'] = { ask: 40000, bid: 38000 };

        const stats = calculatePlayerStats(
            {
                name: 'You',
                loot: { '/items/chimerical_chest::0': { itemHrid: CHIMERICAL_CHEST, count: 8 } },
                deathCount: 0,
                consumables: [
                    { itemHrid: '/items/spaceberry_cake', consumed: 43, consumedPerDay: 338 },
                    { itemHrid: '/items/ultra_melee_coffee', consumed: 41, consumedPerDay: 320 },
                ],
            },
            11040
        );

        const eaten = 43 * 2000 + 41 * 40000;
        expect(stats.consumableCosts).toEqual({ ask: eaten, bid: eaten, value: eaten });

        // 8 entry keys at 20,000 and 8 chest keys crafted at 5,000
        expect(stats.keyCosts.bid).toBe(8 * 20000 + 8 * 5000);
        const banked = stats.income.bid - (stats.consumableCosts?.bid || 0) - (stats.keyCosts?.bid || 0);
        expect(banked).toBe(8 * 5_830_000 - eaten - 8 * 25000);
    });

    test('a run that has eaten nothing reports zero on both sides, not undefined', () => {
        const stats = calculatePlayerStats({ name: 'You', loot: {}, deathCount: 0, consumables: [] }, 600);
        expect(stats.consumableCosts).toEqual({ ask: 0, bid: 0, value: 0 });
    });
});

describe('measured-luck adjustment of a dungeon chest EV', () => {
    const lootOf = (hrid = CHIMERICAL_CHEST) => ({ a: { itemHrid: hrid, count: 2 } });

    beforeEach(() => {
        ev.value = 100000;
        luck.measured = { ratio: 0.926, opened: 5490 };
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

    test('a reading under the opening floor is withheld, however confident it looks', () => {
        luck.enabled = true;
        luck.measured = { ratio: 0.5, opened: 299 };

        expect(calculateIncome(lootOf()).ask).toBe(200000);
        expect(calculateIncomeBreakdown(lootOf()).breakdown[0].luckAdjustment).toBeNull();
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
            'Chimerical Chest EV adjusted by your measured -7.4% return (5,490 opened)'
        );
    });
});

describe('income and the market sale tax', () => {
    const loot = (hrid, count) => ({ [hrid]: { itemHrid: hrid, count } });

    beforeEach(() => {
        market.prices = {};
        salesTax.netted = true;
    });

    afterEach(() => {
        salesTax.netted = false;
    });

    test('nets the market tax off an ordinary drop when the toggle is on', () => {
        market.prices['/items/cheese'] = { ask: 1000, bid: 900 };
        const income = calculateIncome(loot('/items/cheese', 2));
        expect(income.ask).toBeCloseTo(2 * 1000 * (1 - MARKET_TAX), 6);
        expect(income.bid).toBeCloseTo(2 * 900 * (1 - MARKET_TAX), 6);
    });

    test('leaves income gross when the toggle is off', () => {
        salesTax.netted = false;
        market.prices['/items/cheese'] = { ask: 1000, bid: 900 };
        const income = calculateIncome(loot('/items/cheese', 2));
        expect(income.ask).toBe(2000);
        expect(income.bid).toBe(1800);
    });

    test('taxes a cowbell bag at its own higher rate', () => {
        market.prices['/items/bag_of_10_cowbells'] = { ask: 1000, bid: 1000 };
        const income = calculateIncome(loot('/items/bag_of_10_cowbells', 1));
        expect(income.ask).toBeCloseTo(1000 * (1 - COWBELL_BAG_TAX), 6);
    });

    test('leaves coin untaxed — it is not sold', () => {
        const income = calculateIncome(loot('/items/coin', 5000));
        expect(income.ask).toBe(5000);
        expect(income.bid).toBe(5000);
    });
});

describe('calculateIncomeItems rows sum to calculateIncome', () => {
    // `calculatePlayerStats` now builds its `income` total by summing these
    // rows instead of also calling `calculateIncome` — this pins that the two
    // can never drift apart, across the pricing rules a lootMap can mix:
    // coin, an openable priced by measured luck, an Iron Cow character's own
    // valuation (untaxed), and an ordinary taxed market item.
    const IRON_COW_ITEM = '/items/iron_cow_only_item';

    const mixedLoot = () => ({
        coin: { itemHrid: '/items/coin', count: 12345 },
        chest: { itemHrid: CHIMERICAL_CHEST, count: 2 },
        ironCowItem: { itemHrid: IRON_COW_ITEM, count: 3 },
        ordinary: { itemHrid: '/items/cheese', count: 7 },
    });

    const sumRows = (items, side) => items.reduce((sum, item) => sum + item.totalValue[side], 0);

    beforeEach(() => {
        ev.value = 100000;
        luck.enabled = true;
        luck.measured = { ratio: 0.926, opened: 5490 };
        ironCow.book[IRON_COW_ITEM] = { ask: 400, bid: 400 };
        market.prices['/items/cheese'] = { ask: 1000, bid: 900 };
    });

    afterEach(() => {
        salesTax.netted = false;
    });

    test('with the sale tax off', () => {
        salesTax.netted = false;

        const totals = calculateIncome(mixedLoot());
        const items = calculateIncomeItems(mixedLoot());

        expect(sumRows(items, 'ask')).toBeCloseTo(totals.ask, 6);
        expect(sumRows(items, 'bid')).toBeCloseTo(totals.bid, 6);
        expect(sumRows(items, 'value')).toBeCloseTo(totals.value, 6);
    });

    test('with the sale tax on — the Iron Cow item stays untaxed among taxed neighbors', () => {
        salesTax.netted = true;

        const totals = calculateIncome(mixedLoot());
        const items = calculateIncomeItems(mixedLoot());

        expect(sumRows(items, 'ask')).toBeCloseTo(totals.ask, 6);
        expect(sumRows(items, 'bid')).toBeCloseTo(totals.bid, 6);
        expect(sumRows(items, 'value')).toBeCloseTo(totals.value, 6);

        // Sanity check that the Iron Cow row really did dodge the tax, so the
        // sum-equivalence above is not accidentally comparing two zeroes
        const ironCowRow = items.find((item) => item.itemHrid === IRON_COW_ITEM);
        expect(ironCowRow.totalValue.ask).toBe(400 * 3);
    });
});

describe('the configured Buy/Sell price (`.value`)', () => {
    // Party Loot and the Total Profit tile used to read `.bid` unconditionally,
    // so changing the Buy/Sell quick-settings row never moved a single figure
    // on either — only `keyCosts`, via `key-cost.js`, actually followed a
    // setting. `.value` is what fixes that: loot priced at `getItemPrice`'s
    // 'sell' side, consumables at its 'buy' side, whatever that setting says.
    test('loot income follows the configured sell side, not the raw bid', () => {
        market.prices['/items/cheese'] = { ask: 1000, bid: 900 };

        // 'Instant' sell reads the bid
        configured.price = () => 900;
        const instant = calculateIncome({ a: { itemHrid: '/items/cheese', count: 2 } });
        expect(instant.value).toBe(1800);
        expect(instant.bid).toBe(1800); // the raw bid happens to agree here…

        // …but 'Patient' sell reads the ask, which the raw bid above cannot
        // reflect — this is the setting actually taking hold
        configured.price = () => 1000;
        const patient = calculateIncome({ a: { itemHrid: '/items/cheese', count: 2 } });
        expect(patient.value).toBe(2000);
        expect(patient.bid).toBe(1800); // unchanged: `.bid` is still the raw book
    });

    test('a drop missing from the market snapshot is still valued when the configured price can price it', () => {
        delete market.prices['/items/override_only'];
        configured.price = () => 500;

        const income = calculateIncome({ a: { itemHrid: '/items/override_only', count: 2 } });

        // An override or the official value map prices it; the raw book cannot
        expect(income.value).toBeGreaterThan(0);
        expect(income.bid).toBe(0);
    });

    test('consumable costs follow the configured buy side, not the raw ask', () => {
        market.prices['/items/priced_food'] = { ask: 120, bid: 100 };

        // 'Instant' buy reads the ask
        configured.price = () => 120;
        const instant = calculateConsumableCosts(
            [{ itemHrid: '/items/priced_food', consumed: 10, consumedPerDay: 240 }],
            3600
        );
        expect(instant.totalValue).toBe(1200);
        expect(instant.total).toBe(1200); // the raw ask happens to agree here…

        // …but 'Patient' buy reads the bid, which the raw ask above cannot
        // reflect
        configured.price = () => 100;
        const patient = calculateConsumableCosts(
            [{ itemHrid: '/items/priced_food', consumed: 10, consumedPerDay: 240 }],
            3600
        );
        expect(patient.totalValue).toBe(1000);
        expect(patient.total).toBe(1200); // unchanged: `.total` is still the raw ask
    });

    test('a Buy/Sell change moves the card figures `calculatePlayerStats` hands Party Loot', () => {
        market.prices['/items/cheese'] = { ask: 1000, bid: 900 };
        const player = { name: 'You', loot: { a: { itemHrid: '/items/cheese', count: 2 } }, deathCount: 0 };

        configured.price = () => 900; // Sell: Instant
        const instant = calculatePlayerStats(player, 3600);

        configured.price = () => 1000; // Sell: Patient
        const patient = calculatePlayerStats(player, 3600);

        expect(patient.income.value).toBeGreaterThan(instant.income.value);
        expect(patient.dailyProfit.value).toBeGreaterThan(instant.dailyProfit.value);
        // `.bid` never moved — it is not what the setting is supposed to touch
        expect(patient.income.bid).toBe(instant.income.bid);
    });

    test('coins and openable chests price the same on every side — nothing to configure', () => {
        ev.value = 100000;
        const stats = calculatePlayerStats(
            {
                name: 'You',
                loot: {
                    coin: { itemHrid: '/items/coin', count: 500 },
                    chest: { itemHrid: CHIMERICAL_CHEST, count: 1 },
                },
                deathCount: 0,
            },
            3600
        );

        expect(stats.income.value).toBe(stats.income.bid);
        expect(stats.income.value).toBe(500 + 100000);
    });
});
