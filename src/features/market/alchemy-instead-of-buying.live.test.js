/**
 * "Instead of buying" — the live wiring: which prices count as tradable, and
 * when the cached routes are dropped.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

/** `{hrid: {ask, bid, source?}}` — source defaults to the order book */
const world = vi.hoisted(() => ({ prices: {}, listeners: [], dataListeners: new Map() }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/goblin_essence': { name: 'Goblin Essence' },
        '/items/gobo_boomstick': {
            name: 'Gobo Boomstick',
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/goblin_essence', count: 10 }] },
        },
    };
    return {
        default: {
            currentCharacterId: 1,
            getInitClientData: () => ({ itemDetailMap, openableLootDropMap: {} }),
            getItemDetails: (hrid) => itemDetailMap[hrid] ?? null,
            on: (event, callback) => {
                const list = world.dataListeners.get(event) ?? [];
                list.push(callback);
                world.dataListeners.set(event, list);
            },
            off: (event, callback) => {
                const list = world.dataListeners.get(event) ?? [];
                world.dataListeners.set(
                    event,
                    list.filter((cb) => cb !== callback)
                );
            },
        },
    };
});
vi.mock('../../api/marketplace.js', () => ({
    default: {
        lastFetchTimestamp: 1,
        on: (callback) => world.listeners.push(callback),
        off: (callback) => {
            world.listeners = world.listeners.filter((cb) => cb !== callback);
        },
    },
}));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        // 100 actions/hr, 50% success, no coin, catalyst or tea
        calculateCandidateResults: (_type, itemHrid) => [
            {
                actionType: 'decompose',
                itemHrid,
                actionsPerHour: 100,
                successRate: 0.5,
                requirementCosts: [{ itemHrid, count: 1, price: 0 }],
                catalystCostPerHour: 0,
                totalTeaCostPerHour: 0,
                dropRevenues: [],
            },
        ],
    },
}));
vi.mock('./expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const entry = world.prices[hrid];
        const price = entry?.[options?.mode];
        if (price == null) return { price: null, source: null, estimated: false };
        const source = entry.source ?? 'book';
        return { price, source, estimated: source === 'value' };
    },
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.9 }));

import { liveAlternatives, clearInsteadCache, stopInsteadListeners } from './alchemy-instead-of-buying.js';

const ESSENCE = '/items/goblin_essence';
const BOOMSTICK = '/items/gobo_boomstick';

beforeEach(() => {
    clearInsteadCache();
    world.prices = { [ESSENCE]: { ask: 300, bid: 280 }, [BOOMSTICK]: { ask: 600, bid: 550 } };
});

describe('tradable prices only', () => {
    test('an order-book source makes a route', () => {
        // 600 / 5 essence = 120 each against an ask of 300
        const { alternatives } = liveAlternatives(ESSENCE, new Set());
        expect(alternatives.map((a) => a.sourceHrid)).toEqual([BOOMSTICK]);
        expect(alternatives[0].costPerUnit).toBeCloseTo(120);
    });

    test("a player's custom price on the source is no ask to buy at", () => {
        world.prices[BOOMSTICK] = { ask: 600, bid: 550, source: 'custom' };
        expect(liveAlternatives(ESSENCE, new Set()).alternatives).toEqual([]);
    });

    test("a player's custom price on the target is nothing to compare against", () => {
        world.prices[ESSENCE] = { ask: 300, bid: 280, source: 'custom' };
        const found = liveAlternatives(ESSENCE, new Set());
        expect(found.targetAsk).toBeNull();
        expect(found.alternatives).toEqual([]);
    });
});

describe('the cache follows the market', () => {
    test('a price update from the market drops the cached routes', () => {
        expect(liveAlternatives(ESSENCE, new Set()).alternatives).toHaveLength(1);
        // A fresher order book: the boomstick now costs more than its essence is worth
        world.prices[BOOMSTICK] = { ask: 2000, bid: 1900 };
        for (const listener of world.listeners) listener();
        expect(liveAlternatives(ESSENCE, new Set()).alternatives).toEqual([]);
    });

    test('a pushed value-map refresh drops the cached routes too', () => {
        expect(liveAlternatives(ESSENCE, new Set()).alternatives).toHaveLength(1);
        // The hourly band push moves the clamped ask without any market notification
        world.prices[BOOMSTICK] = { ask: 2000, bid: 1900 };
        for (const listener of world.dataListeners.get('market_item_values_updated') ?? []) listener({});
        expect(liveAlternatives(ESSENCE, new Set()).alternatives).toEqual([]);
    });

    test('teardown unsubscribes, and the next lookup subscribes again', () => {
        liveAlternatives(ESSENCE, new Set());
        stopInsteadListeners();
        expect(world.listeners).toHaveLength(0);
        expect(world.dataListeners.get('market_item_values_updated') ?? []).toHaveLength(0);
        liveAlternatives(ESSENCE, new Set());
        expect(world.listeners).toHaveLength(1);
        expect(world.dataListeners.get('market_item_values_updated')).toHaveLength(1);
        stopInsteadListeners();
    });
});
