/**
 * "Instead of buying" — Alchemy Essence, which no item decomposes or transmutes into but
 * every alchemy action can drop, gets its sources from the bonus drops: ranked on prices,
 * the best few costed in full.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const ESSENCE = '/items/alchemy_essence';
const SHARD = '/items/shard';
const SOURCE_COUNT = 30;
const gear = (i) => `/items/gear_${i}`;

const world = vi.hoisted(() => ({ prices: {}, calls: [] }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = { '/items/alchemy_essence': { name: 'Alchemy Essence' }, '/items/shard': { name: 'Shard' } };
    for (let i = 0; i < 30; i++) {
        itemDetailMap[`/items/gear_${i}`] = {
            name: `Gear ${i}`,
            itemLevel: 10,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/shard', count: 2 }] },
        };
    }
    // Coinifies into 300 × 5 = 1,500 coins; unpriced unless a test gives it an ask
    itemDetailMap['/items/coin_gem'] = {
        name: 'Coin Gem',
        itemLevel: 10,
        sellPrice: 300,
        alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 },
    };
    return {
        default: {
            currentCharacterId: 1,
            getInitClientData: () => ({ itemDetailMap, openableLootDropMap: {} }),
            getItemDetails: (hrid) => itemDetailMap[hrid] ?? null,
            getActionDrinkSlots: () => [],
            getInventory: () => [],
            getEquipment: () => new Map(),
            on: () => {},
            off: () => {},
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({ default: { lastFetchTimestamp: 1, on: () => {}, off: () => {} } }));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        // 100 actions an hour at 60%, a 100-coin fee, and the essence a level-10 item drops
        calculateCandidateResults: (actionType, itemHrid) => {
            world.calls.push(itemHrid);
            if (actionType === 'coinify') {
                // Coinify charges no fee; its coins ride in dropRevenues beside the bonus drops
                return [
                    {
                        actionType,
                        itemHrid,
                        actionsPerHour: 100,
                        successRate: 0.6,
                        requirementCosts: [{ itemHrid, count: 1, price: 0 }],
                        catalystCostPerHour: 0,
                        totalTeaCostPerHour: 0,
                        dropRevenues: [
                            { itemHrid: '/items/coin', count: 1500, dropsPerHour: 1500 * 0.6 * 100 },
                            { itemHrid: ESSENCE, isEssence: true, dropsPerHour: (100 * 110) / 1800 },
                            { itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 0 },
                        ],
                    },
                ];
            }
            return [
                {
                    actionType,
                    itemHrid,
                    actionsPerHour: 100,
                    successRate: 0.6,
                    requirementCosts: [
                        { itemHrid, count: 1, price: 0 },
                        { itemHrid: '/items/coin', count: 100, costPerAction: 100 },
                    ],
                    catalystCostPerHour: 0,
                    totalTeaCostPerHour: 0,
                    dropRevenues: [
                        { itemHrid: SHARD, dropsPerHour: 120 },
                        { itemHrid: ESSENCE, isEssence: true, dropsPerHour: (100 * 110) / 1800 },
                        { itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 0 },
                    ],
                },
            ];
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const side = options?.mode ?? (options?.side === 'buy' ? 'ask' : 'bid');
        const price = world.prices[hrid]?.[side];
        return price == null ? { price: null, source: null, estimated: false } : { price, source: 'book' };
    },
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.9,
    calculateActionsPerHour: () => 0,
    calculateTeaCostsPerHour: () => ({ totalCostPerHour: 0 }),
}));

import {
    liveAlternatives,
    settleAlternatives,
    clearInsteadCache,
    buildBonusSourceIndex,
    bonusRankCost,
    BONUS_SOURCE_LIMIT,
} from './alchemy-instead-of-buying.js';

const settle = async (target) => {
    const settled = settleAlternatives(target, new Set());
    await vi.runAllTimersAsync();
    return settled;
};

beforeEach(() => {
    vi.useFakeTimers();
    clearInsteadCache();
    world.calls = [];
    // A shard sells for 1,000 (900 after tax); gear i costs 1,100 + 50i
    world.prices = { [ESSENCE]: { ask: 3000, bid: 2800 }, [SHARD]: { ask: 1100, bid: 1000 } };
    for (let i = 0; i < SOURCE_COUNT; i++) world.prices[gear(i)] = { ask: 1100 + 50 * i, bid: 900 };
});

afterEach(() => {
    clearInsteadCache();
    vi.useRealTimers();
});

describe('the bonus-drop index', () => {
    test('every decomposable, transmutable or coinifiable item is a source of essence, and the unlisted crates are no target', () => {
        const index = buildBonusSourceIndex({
            '/items/low': { itemLevel: 10, alchemyDetail: { decomposeItems: [{ itemHrid: SHARD, count: 1 }] } },
            '/items/mid': {
                itemLevel: 50,
                alchemyDetail: { transmuteDropTable: [{ itemHrid: SHARD, dropRate: 1, minCount: 1, maxCount: 1 }] },
            },
            '/items/high': {
                itemLevel: 80,
                alchemyDetail: {
                    decomposeItems: [{ itemHrid: SHARD, count: 1 }],
                    transmuteDropTable: [{ itemHrid: SHARD, dropRate: 1, minCount: 1, maxCount: 1 }],
                },
            },
            '/items/no_alchemy': { itemLevel: 10 },
            '/items/coinable': { itemLevel: 10, sellPrice: 50, alchemyDetail: { isCoinifiable: true } },
        });
        expect(index.get(ESSENCE)).toEqual([
            { sourceHrid: '/items/low', actionType: 'decompose' },
            { sourceHrid: '/items/mid', actionType: 'transmute' },
            { sourceHrid: '/items/high', actionType: 'decompose' },
            { sourceHrid: '/items/high', actionType: 'transmute' },
            { sourceHrid: '/items/coinable', actionType: 'coinify' },
        ]);
        // The crates are openable loot, never listed: nothing to buy, so no target
        expect(index.has('/items/small_artisans_crate')).toBe(false);
        expect(index.has('/items/medium_artisans_crate')).toBe(false);
        expect(index.has('/items/large_artisans_crate')).toBe(false);
    });

    test('the ranking puts the source whose outputs pay for more of it first', () => {
        const details = {
            '/items/cheap': { itemLevel: 10, alchemyDetail: { decomposeItems: [{ itemHrid: SHARD, count: 2 }] } },
            '/items/dear': { itemLevel: 10, alchemyDetail: { decomposeItems: [{ itemHrid: SHARD, count: 1 }] } },
        };
        const deps = {
            getItemDetails: (hrid) => details[hrid],
            askOf: () => 1000,
            sellOf: () => 500,
        };
        const cheap = bonusRankCost(ESSENCE, { sourceHrid: '/items/cheap', actionType: 'decompose' }, deps);
        const dear = bonusRankCost(ESSENCE, { sourceHrid: '/items/dear', actionType: 'decompose' }, deps);
        // (1000 + 100 fee − 2 × 0.6 × 500) / (110 / 1800)
        expect(cheap).toBeCloseTo((1100 - 600) / (110 / 1800));
        expect(cheap).toBeLessThan(dear);
    });
});

describe('Alchemy Essence as a target', () => {
    test("gets a route when an action's other outputs pay for most of it", async () => {
        expect(liveAlternatives(ESSENCE, new Set()).pending).toBe(true);
        const { targetAsk, alternatives } = await settle(ESSENCE);
        expect(targetAsk).toBe(3000);
        expect(alternatives[0].sourceHrid).toBe(gear(0));
        expect(alternatives[0].actionType).toBe('decompose');
        // Per action: 1,100 + 100 fee − 2 × 0.6 × 900 = 120, over 110/1800 essence
        expect(alternatives[0].costPerUnit).toBeCloseTo(120 / (110 / 1800));
        expect(alternatives[0].saving).toBeCloseTo(3000 - 120 / (110 / 1800));
    });

    test('a coinify route that beats every decompose is found and named', async () => {
        // 1,000 for 1,500 × 0.6 = 900 coins: 100 an action, against 120 for the best gear
        world.prices['/items/coin_gem'] = { ask: 1000, bid: 900 };
        const { alternatives } = await settle(ESSENCE);
        expect(alternatives[0].sourceHrid).toBe('/items/coin_gem');
        expect(alternatives[0].actionType).toBe('coinify');
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 / (110 / 1800));
        expect(alternatives[1].sourceHrid).toBe(gear(0));
    });

    test('a coinify source is ranked with its coins credited', () => {
        const deps = {
            getItemDetails: (hrid) =>
                hrid === '/items/coin_gem'
                    ? { itemLevel: 10, sellPrice: 300, alchemyDetail: { isCoinifiable: true } }
                    : null,
            askOf: () => 1000,
            sellOf: () => null,
        };
        // (1,000 − 300 × 5 × 0.7 coins at the base rate) / (110 / 1800)
        expect(bonusRankCost(ESSENCE, { sourceHrid: '/items/coin_gem', actionType: 'coinify' }, deps)).toBeCloseTo(
            (1000 - 1050) / (110 / 1800)
        );
    });

    test('only the best-ranked few are costed in full', async () => {
        await settle(ESSENCE);
        expect(world.calls).toHaveLength(BONUS_SOURCE_LIMIT);
        expect(world.calls).toEqual(Array.from({ length: BONUS_SOURCE_LIMIT }, (_, i) => gear(i)));
    });

    test('gets none when buying is cheaper', async () => {
        world.prices[ESSENCE] = { ask: 1000, bid: 900 };
        expect((await settle(ESSENCE)).alternatives).toEqual([]);
    });

    test('an essence with no ask runs nothing', () => {
        delete world.prices[ESSENCE];
        const found = liveAlternatives(ESSENCE, new Set());
        expect(found.pending).toBeUndefined();
        expect(found.alternatives).toEqual([]);
        expect(world.calls).toEqual([]);
    });
});
