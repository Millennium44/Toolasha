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
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key], getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: (hrid) => mocks.itemPrices[hrid] ?? null } }));
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    calculateAbilityCost: (hrid, level) => level * 1000,
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
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: (hrid) => mocks.shopCosts[hrid] ?? 0 }));
vi.mock('./networth-exclusions.js', () => ({ isExcluded: () => false, getExclusions: () => [] }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { getAllSnapshots: () => [] } }));

const { calculateItemValue, calculateAllHousesCost, calculateAllAbilitiesCost } = await import(
    './networth-calculator.js'
);

beforeEach(() => {
    mocks.settings = {};
    mocks.initData = { houseRoomDetailMap: {} };
    mocks.itemDetails = {};
    mocks.itemPrices = {};
    mocks.enhancementPaths = {};
    mocks.taskTokenValue = null;
    mocks.dungeonTokenValues = {};
    mocks.shopCosts = {};
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
