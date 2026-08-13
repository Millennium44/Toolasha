/**
 * Networth Calculator — per-item valuation rules and the house/ability
 * category totals. `calculateNetworth` itself (the full character sweep with
 * exclusions and worker batching) is not exercised here; these tests drive
 * `calculateItemValue`, `calculateAllHousesCost` and `calculateAllAbilitiesCost`
 * directly against a mocked game and market.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    initData: null,
    itemDetails: {},
    itemPrices: {}, // itemHrid -> {ask, bid}
    enhancementPaths: {}, // `${hrid}:${level}` -> totalCost
    taskTokenValue: null,
    dungeonTokenValues: {},
    shopCosts: {},
    unpricedAbilities: new Set(),
    marketValues: null, // { marketValuesVersion, marketItemValues } for getMarketItemValues()
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key],
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
        getMarketItemValues: () => mocks.marketValues,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: (hrid) => mocks.itemPrices[hrid] ?? null } }));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    // Null total is "the book has no listing", which the caller must not read as free
    explainAbilityCost: (hrid, level) =>
        mocks.unpricedAbilities.has(hrid) ? { books: 7, total: null } : { books: level, total: level * 1000 },
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateHouseBuildCost: (hrid, level) => level * 500,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (hrid, level) => {
        const key = `${hrid}:${level}`;
        return key in mocks.enhancementPaths ? { optimalStrategy: { totalCost: mocks.enhancementPaths[key] } } : null;
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../tasks/task-profit-calculator.js', () => ({
    calculateTaskTokenValue: () => mocks.taskTokenValue,
}));
vi.mock('../../utils/token-valuation.js', () => ({
    calculateDungeonTokenValue: (hrid) => mocks.dungeonTokenValues[hrid] ?? null,
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { isInitialized: false, calculateExpectedValue: () => null },
}));
vi.mock('./networth-cache.js', () => ({
    default: { get: () => null, set: () => {}, checkAndInvalidate: () => {} },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, opts) => {
        const p = mocks.itemPrices[hrid];
        if (!p) return null;
        return opts?.mode === 'bid' ? p.bid : p.ask;
    },
    getItemPrices: (hrid) => mocks.itemPrices[hrid] ?? null,
}));
vi.mock('../../utils/networth-worker-manager.js', () => ({ calculateItemValueBatch: vi.fn() }));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: (hrid) => mocks.shopCosts[hrid] ?? 0 }));
vi.mock('./networth-exclusions.js', () => ({ isExcluded: () => false, getExclusions: () => [] }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));
// Guild credits are never listed, so their gold value comes from conversions.
// Priced here at a flat rate so the shrine arithmetic is the only thing under test.
vi.mock('../../utils/guild-credit-pricing.js', () => ({
    buildGoldPerCredit: (mode) => ({ '/items/guild_credit_1': mode === 'bid' ? 500 : 750 }),
    priceGuildCreditCosts: (costs, { goldPerCredit }) => ({
        lines: (costs || []).map(({ itemHrid, count }) => {
            const each = goldPerCredit[itemHrid] ?? null;
            return { itemHrid, count, goldEach: each, gold: each === null ? null : each * count };
        }),
        total: null,
        unpriced: [],
    }),
}));

const { calculateItemValue, calculateAllHousesCost, calculateAllAbilitiesCost, calculateGuildShrinesCost } =
    await import('./networth-calculator.js');
const { _resetMarketValues } = await import('../../utils/market-values.js');

beforeEach(() => {
    mocks.settings = {};
    mocks.initData = { houseRoomDetailMap: {} };
    mocks.itemDetails = {};
    mocks.itemPrices = {};
    mocks.enhancementPaths = {};
    mocks.taskTokenValue = null;
    mocks.dungeonTokenValues = {};
    mocks.shopCosts = {};
    mocks.unpricedAbilities = new Set();
    mocks.marketValues = null;
    _resetMarketValues();
});

describe('calculateItemValue', () => {
    test('an unenhanced item prices at the configured mode, scaled by count', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/wood'] = { ask: 100, bid: 90 };

        const value = await calculateItemValue({ itemHrid: '/items/wood', enhancementLevel: 0, count: 5 });
        expect(value).toBe(500);
    });

    test('coins are worth exactly their count, no market lookup needed', async () => {
        const value = await calculateItemValue({ itemHrid: '/items/coin', enhancementLevel: 0, count: 12345 });
        expect(value).toBe(12345);
    });

    test('a low-enhancement item with a market price uses that price directly', async () => {
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/sword'] = { ask: 1000, bid: 900 };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 1 });
        expect(value).toBe(1000);
    });

    test('a low-enhancement item with no market data falls back to the enhancement path cost', async () => {
        mocks.enhancementPaths['/items/sword:3'] = 4200;

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 2 });
        expect(value).toBe(8400);
    });

    test('high-enhancement items use enhancement cost even when a market price exists, once the setting is on', async () => {
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.itemPrices['/items/sword'] = { ask: 999999999, bid: 1 };
        mocks.enhancementPaths['/items/sword:15'] = 50000;

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 15, count: 1 });
        expect(value).toBe(50000);
    });

    test('high-enhancement items stay on market pricing below the configured minimum level', async () => {
        mocks.settings.networth_highEnhancementUseCost = true;
        mocks.settings.networth_highEnhancementMinLevel = 13;
        mocks.itemPrices['/items/sword'] = { ask: 1000, bid: 900 };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 10, count: 1 });
        expect(value).toBe(1000);
    });

    test('a cowbell prices as a tenth of the bag when the setting is enabled', async () => {
        mocks.settings.networth_includeCowbells = true;
        mocks.settings.networth_pricingMode = 'ask';
        mocks.itemPrices['/items/bag_of_10_cowbells'] = { ask: 2_000_000, bid: 1_800_000 };

        const value = await calculateItemValue({ itemHrid: '/items/cowbell', enhancementLevel: 0, count: 10 });
        expect(value).toBe(200_000 * 10);
    });

    test('cowbells are excluded entirely (priced at 0) when the setting is off', async () => {
        mocks.settings.networth_includeCowbells = false;
        mocks.itemPrices['/items/bag_of_10_cowbells'] = { ask: 2_000_000, bid: 1_800_000 };

        const value = await calculateItemValue({ itemHrid: '/items/cowbell', enhancementLevel: 0, count: 10 });
        expect(value).toBe(0);
    });

    test('task tokens use the shop-derived token value when available', async () => {
        mocks.settings.networth_includeTaskTokens = true;
        mocks.taskTokenValue = { tokenValue: 2500 };

        const value = await calculateItemValue({ itemHrid: '/items/task_token', enhancementLevel: 0, count: 4 });
        expect(value).toBe(10000);
    });

    test('an openable container with no market price falls back to its expected value net of key cost', async () => {
        // No market data, not high enhancement, level 0 -> should hit crafting/shop fallback path (0 here)
        mocks.itemDetails['/items/crate'] = { isOpenable: true };
        const value = await calculateItemValue({ itemHrid: '/items/crate', enhancementLevel: 0, count: 1 });
        expect(value).toBe(0); // expectedValueCalculator mocked as uninitialized
    });

    test('an item with no market data and no craftable recipe falls back to shop cost', async () => {
        mocks.shopCosts['/items/shop_item'] = 250;
        const value = await calculateItemValue({ itemHrid: '/items/shop_item', enhancementLevel: 0, count: 3 });
        expect(value).toBe(750);
    });

    test("value source 'officialValue' prices from the game's market value, ignoring the order book", async () => {
        mocks.settings.networth_valueSource = 'officialValue';
        mocks.settings.networth_pricingMode = 'bid';
        mocks.itemPrices['/items/sword'] = { ask: 999, bid: 1 }; // order book ignored
        mocks.marketValues = { marketValuesVersion: 1, marketItemValues: { '/items/sword': { 3: 5000 } } };

        const value = await calculateItemValue({ itemHrid: '/items/sword', enhancementLevel: 3, count: 2 });
        expect(value).toBe(10000);
    });

    test("value source 'orderBook' clamps a stale order-book price into the tradable range", async () => {
        mocks.settings.networth_valueSource = 'orderBook';
        mocks.settings.networth_pricingMode = 'ask';
        // Stale ask five times the value; band max is value * 1.1
        mocks.itemPrices['/items/wood'] = { ask: 5000, bid: 900 };
        mocks.marketValues = { marketValuesVersion: 1, marketItemValues: { '/items/wood': { 0: 1000 } } };

        const value = await calculateItemValue({ itemHrid: '/items/wood', enhancementLevel: 0, count: 1 });
        expect(value).toBeCloseTo(1100, 6); // 1000 * 1.1, not 5000
    });
});

describe('calculateAllHousesCost', () => {
    test('sums build cost across rooms, skipping level-0 rooms', () => {
        mocks.initData.houseRoomDetailMap = {
            '/house_rooms/dojo': { name: 'Dojo' },
            '/house_rooms/kitchen': { name: 'Kitchen' },
        };
        const result = calculateAllHousesCost({
            '/house_rooms/dojo': { level: 4 },
            '/house_rooms/kitchen': { level: 0 },
        });

        expect(result.totalCost).toBe(2000); // 4 * 500
        expect(result.breakdown).toHaveLength(1);
        expect(result.breakdown[0].name).toBe('Dojo');
    });

    test('breakdown is sorted by cost descending', () => {
        mocks.initData.houseRoomDetailMap = {
            '/house_rooms/a': { name: 'A' },
            '/house_rooms/b': { name: 'B' },
        };
        const result = calculateAllHousesCost({
            '/house_rooms/a': { level: 1 },
            '/house_rooms/b': { level: 5 },
        });
        expect(result.breakdown.map((r) => r.name)).toEqual(['B', 'A']);
    });
});

describe('calculateAllAbilitiesCost', () => {
    test('splits total cost into equipped and other, and sums correctly', () => {
        const abilities = [
            { abilityHrid: '/abilities/fireball', level: 3 },
            { abilityHrid: '/abilities/heal', level: 2 },
        ];
        const equipped = { '/abilities/fireball': {} };

        const result = calculateAllAbilitiesCost(abilities, equipped);

        expect(result.totalCost).toBe(3000 + 2000);
        expect(result.equippedCost).toBe(3000);
        expect(result.equippedBreakdown.map((a) => a.hrid)).toEqual(['/abilities/fireball']);
        expect(result.otherBreakdown.map((a) => a.hrid)).toEqual(['/abilities/heal']);
    });

    test('an ability whose book has no listing is marked unpriced, not counted as free', () => {
        mocks.unpricedAbilities.add('/abilities/heal');
        const abilities = [
            { abilityHrid: '/abilities/fireball', level: 3 },
            { abilityHrid: '/abilities/heal', level: 2 },
        ];

        const result = calculateAllAbilitiesCost(abilities, {});

        expect(result.totalCost).toBe(3000);
        const heal = result.breakdown.find((a) => a.hrid === '/abilities/heal');
        expect(heal.unpriced).toBe(true);
        // Still says how many books, which is the part the market cannot answer
        expect(heal.books).toBe(7);
    });

    test('level-0 abilities are skipped entirely', () => {
        const result = calculateAllAbilitiesCost([{ abilityHrid: '/abilities/unlearned', level: 0 }], {});
        expect(result.totalCost).toBe(0);
        expect(result.breakdown).toHaveLength(0);
    });

    test('an empty ability list returns a fully-zeroed structure without throwing', () => {
        const result = calculateAllAbilitiesCost([], {});
        expect(result).toEqual({
            totalCost: 0,
            equippedCost: 0,
            breakdown: [],
            equippedBreakdown: [],
            otherBreakdown: [],
        });
    });
});

describe('calculateGuildShrinesCost', () => {
    const CREDIT = '/items/guild_credit_1';

    beforeEach(() => {
        mocks.initData.guildBuffDetailMap = {
            '/guild_buffs/force_combat': {
                shrineHrid: '/guild_shrines/force',
                isCombat: true,
                levelCosts: {
                    1: { guildTokenCost: 10, creditCosts: [{ itemHrid: CREDIT, count: 10 }] },
                    2: { guildTokenCost: 20, creditCosts: [{ itemHrid: CREDIT, count: 20 }] },
                    3: { guildTokenCost: 30, creditCosts: [{ itemHrid: CREDIT, count: 40 }] },
                },
            },
            '/guild_buffs/scholar_skilling': {
                shrineHrid: '/guild_shrines/scholar',
                isCombat: false,
                levelCosts: { 1: { guildTokenCost: 5, creditCosts: [{ itemHrid: CREDIT, count: 4 }] } },
            },
        };
    });

    /**
     * A shrine map in the shape data-manager holds it.
     * @param {Object} levels - buffHrid → level
     * @returns {Object} characterGuildBuffMap
     */
    function shrines(levels) {
        const map = {};
        for (const [hrid, level] of Object.entries(levels)) map[hrid] = { guildBuffHrid: hrid, level };
        return map;
    }

    test('every level bought so far is charged, not just the current one', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 3 }));

        // levels 1+2+3 = 10+20+40 = 70 credits at 750 gold each
        expect(result.totalCost).toBe(52_500);
        expect(result.tokens).toBe(60);
        expect(result.known).toBe(true);
    });

    test('the pricing mode reaches the credit conversion, like the rest of net worth', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 1 }), 'bid');

        expect(result.totalCost).toBe(5000); // 10 credits at the bid rate of 500
    });

    test('shrines are listed separately, named per buff, sorted by cost', () => {
        const result = calculateGuildShrinesCost(
            shrines({ '/guild_buffs/scholar_skilling': 1, '/guild_buffs/force_combat': 2 })
        );

        expect(result.breakdown.map((r) => r.name)).toEqual(['Force Combat 2', 'Scholar Skilling 1']);
        expect(result.breakdown[0]).toMatchObject({ hrid: '/guild_buffs/force_combat', level: 2, tokens: 30 });
        expect(result.totalCost).toBe(22_500 + 3000);
    });

    test('tokens are counted but never priced into the gold total', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/scholar_skilling': 1 }));

        expect(result.tokens).toBe(5);
        expect(result.totalCost).toBe(3000); // 4 credits at 750, and nothing for the 5 tokens
    });

    test('a shrine at level 0 contributes no row', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 0 }));

        expect(result.totalCost).toBe(0);
        expect(result.breakdown).toEqual([]);
        expect(result.known).toBe(true);
    });

    test('levels that never reached the client read as unknown, not as zero', () => {
        expect(calculateGuildShrinesCost(undefined).known).toBe(false);
        expect(calculateGuildShrinesCost(null).known).toBe(false);
        expect(calculateGuildShrinesCost({}).known).toBe(false);
        expect(calculateGuildShrinesCost({}).breakdown).toEqual([]);
    });

    test('without the game cost table there is nothing to price, so nothing is claimed', () => {
        mocks.initData.guildBuffDetailMap = undefined;

        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/force_combat': 3 }));

        expect(result).toEqual({ totalCost: 0, tokens: 0, breakdown: [], known: false });
    });

    test('a buff the cost table does not know is skipped rather than counted as free', () => {
        const result = calculateGuildShrinesCost(shrines({ '/guild_buffs/mystery_shrine': 5 }));

        expect(result.breakdown).toEqual([]);
        expect(result.totalCost).toBe(0);
    });
});
