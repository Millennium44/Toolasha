/**
 * "Instead of buying" — a target with many sources is worked out off the hover call, in
 * slices, and the calculator runs survive a price change that leaves their prices alone.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const TARGET = '/items/philosophers_stone';
const SOURCE_COUNT = 120;
const sourceHrid = (i) => `/items/source_${i}`;

/** `{hrid: {ask, bid}}`, all from the order book */
const world = vi.hoisted(() => ({
    prices: {},
    listeners: [],
    dataListeners: new Map(),
    calls: [],
    msPerRun: 2,
    /** The slotted alchemy drinks, all in stock */
    drinks: [],
    alchemyLevel: 50,
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = { '/items/philosophers_stone': { name: "Philosopher's Stone" } };
    for (let i = 0; i < 120; i++) {
        itemDetailMap[`/items/source_${i}`] = {
            name: `Source ${i}`,
            alchemyDetail: {
                decomposeItems: [
                    { itemHrid: '/items/philosophers_stone', count: 1 },
                    { itemHrid: '/items/shard', count: 2 },
                ],
            },
        };
    }
    return {
        default: {
            currentCharacterId: 1,
            getInitClientData: () => ({ itemDetailMap, openableLootDropMap: {} }),
            getItemDetails: (hrid) => itemDetailMap[hrid] ?? null,
            getActionDrinkSlots: () => world.drinks.map((itemHrid) => ({ itemHrid })),
            getInventory: () => world.drinks.map((itemHrid) => ({ itemHrid, count: 10 })),
            getEquipment: () => new Map(),
            getSkills: () => [{ skillHrid: '/skills/alchemy', level: world.alchemyLevel }],
            on: (event, callback) => {
                world.dataListeners.set(event, [...(world.dataListeners.get(event) ?? []), callback]);
            },
            off: (event, callback) => {
                world.dataListeners.set(
                    event,
                    (world.dataListeners.get(event) ?? []).filter((cb) => cb !== callback)
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
        // Each run takes `msPerRun` of the clock, like the ~2 ms a real one does
        calculateCandidateResults: (actionType, itemHrid) => {
            world.calls.push(itemHrid);
            vi.setSystemTime(Date.now() + world.msPerRun);
            const setup = (catalyst, overhead, tea = null) => ({
                actionType,
                itemHrid,
                actionsPerHour: 100,
                successRate: (catalyst ? 0.9 : 0.5) + (tea ? 0.05 : 0),
                requirementCosts: [{ itemHrid, count: 1, price: 0 }],
                catalystCostPerHour: overhead,
                // A tea setup charges the slotted tea at its ask, 10 an hour
                totalTeaCostPerHour: tea ? 10 * (world.prices[tea]?.ask ?? 0) : 0,
                consumableCosts: tea ? [{ itemHrid: tea }] : [],
                dropRevenues: [],
                winningCatalystHrid: catalyst,
            });
            const setups = [setup(null, 0), setup('/items/catalyst_of_decomposition', 2000)];
            for (const tea of world.drinks) setups.push(setup('/items/catalyst_of_decomposition', 2000, tea));
            return setups;
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const entry = world.prices[hrid];
        // The calculator's own read (profit context, buy side) is the ask
        const side = options?.mode ?? (options?.side === 'buy' ? 'ask' : 'bid');
        const price = entry?.[side];
        return price == null ? { price: null, source: null, estimated: false } : { price, source: 'book' };
    },
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.9 }));

import {
    liveAlternatives,
    settleAlternatives,
    clearInsteadCache,
    stopInsteadListeners,
    findAlchemyAlternatives,
    SYNC_SOURCE_RUNS,
} from './alchemy-instead-of-buying.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
import dataManager from '../../core/data-manager.js';

/** Every source decomposed now, with the same arithmetic the tooltip uses */
function expectedNow() {
    const askOf = (hrid) => world.prices[hrid]?.ask ?? null;
    return findAlchemyAlternatives(TARGET, {
        sources: Array.from({ length: SOURCE_COUNT }, (_, i) => ({
            sourceHrid: sourceHrid(i),
            actionType: 'decompose',
        })),
        getItemDetails: (hrid) => dataManager.getItemDetails(hrid),
        askOf,
        sellOf: (hrid) => (world.prices[hrid]?.bid == null ? null : world.prices[hrid].bid * 0.9),
        candidatesOf: (type, hrid) => alchemyProfitCalculator.calculateCandidateResults(type, hrid),
        isWanted: () => false,
        goldPerHour: 0,
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    clearInsteadCache();
    world.calls = [];
    world.drinks = [];
    world.alchemyLevel = 50;
    world.prices = {
        [TARGET]: { ask: 1000, bid: 900 },
        '/items/shard': { ask: 40, bid: 30 },
        '/items/catalyst_of_decomposition': { ask: 10, bid: 8 },
    };
    // Source i costs 400 + 3i: source 0 is the cheapest route
    for (let i = 0; i < SOURCE_COUNT; i++) world.prices[sourceHrid(i)] = { ask: 400 + 3 * i, bid: 350 };
});

afterEach(() => {
    clearInsteadCache();
    vi.useRealTimers();
});

describe('a high-fanout target', () => {
    test('the hover call runs no calculator for it, and says the routes are pending', () => {
        const found = liveAlternatives(TARGET, new Set());
        expect(found.pending).toBe(true);
        expect(found.alternatives).toEqual([]);
        expect(world.calls.length).toBeLessThanOrEqual(SYNC_SOURCE_RUNS);
    });

    test('the background work runs in slices that yield to the page', async () => {
        liveAlternatives(TARGET, new Set());
        // The job's first turn
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(world.calls.length).toBeGreaterThan(0);
        expect(world.calls.length).toBeLessThan(SOURCE_COUNT);
    });

    test('the settled routes are exactly what running every source at once gives', async () => {
        liveAlternatives(TARGET, new Set());
        const settled = settleAlternatives(TARGET, new Set());
        await vi.runAllTimersAsync();
        const found = await settled;
        // Each source ran once, off the hover
        expect(world.calls).toHaveLength(SOURCE_COUNT);
        const expected = expectedNow();
        expect(found.targetAsk).toBe(expected.targetAsk);
        expect(found.alternatives.map(({ result: _result, ...rest }) => rest)).toEqual(
            expected.alternatives.map(({ result: _result, ...rest }) => rest)
        );
        expect(found.alternatives[0].sourceHrid).toBe(sourceHrid(0));
    });

    test('once settled, the hover call reads the finished routes', async () => {
        const settled = settleAlternatives(TARGET, new Set());
        await vi.runAllTimersAsync();
        const found = await settled;
        world.calls = [];
        expect(liveAlternatives(TARGET, new Set())).toBe(found);
        expect(world.calls).toEqual([]);
    });

    test("the feature's teardown cancels a running job", async () => {
        liveAlternatives(TARGET, new Set());
        const settled = settleAlternatives(TARGET, new Set());
        // Part-way: some sources have run
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(world.calls.length).toBeGreaterThan(0);
        stopInsteadListeners();
        await vi.runAllTimersAsync();
        const found = await settled;
        expect(found.cancelled).toBe(true);
        expect(found.alternatives).toEqual([]);
        expect(world.calls.length).toBeLessThan(SOURCE_COUNT);
    });

    test('a cleared cache cancels a running job', async () => {
        const settled = settleAlternatives(TARGET, new Set());
        clearInsteadCache();
        await vi.runAllTimersAsync();
        expect((await settled).cancelled).toBe(true);
    });
});

describe('calculator runs across a price change', () => {
    const settleAll = async () => {
        const settled = settleAlternatives(TARGET, new Set());
        await vi.runAllTimersAsync();
        return settled;
    };

    test('a change that leaves their prices alone reuses every run', async () => {
        await settleAll();
        world.calls = [];
        // Only the target's ask moved
        world.prices[TARGET] = { ask: 1100, bid: 950 };
        for (const listener of world.listeners) listener();
        const found = liveAlternatives(TARGET, new Set());
        expect(found.pending).toBeUndefined();
        expect(world.calls).toEqual([]);
        expect(found.targetAsk).toBe(1100);
    });

    test("a source's own price moving reruns that source only", async () => {
        await settleAll();
        world.calls = [];
        world.prices[sourceHrid(7)] = { ask: 10, bid: 5 };
        for (const listener of world.listeners) listener();
        const found = liveAlternatives(TARGET, new Set());
        expect(world.calls).toEqual([sourceHrid(7)]);
        expect(found.alternatives[0].sourceHrid).toBe(sourceHrid(7));
    });

    test("a catalyst's price moving reruns every source", async () => {
        await settleAll();
        world.calls = [];
        world.prices['/items/catalyst_of_decomposition'] = { ask: 20, bid: 15 };
        for (const listener of world.listeners) listener();
        expect(liveAlternatives(TARGET, new Set()).pending).toBe(true);
        const found = await settleAll();
        expect(world.calls).toHaveLength(SOURCE_COUNT);
        expect(found.alternatives[0].sourceHrid).toBe(sourceHrid(0));
    });

    test('a pushed value-map refresh rechecks the runs and the routes', async () => {
        await settleAll();
        world.calls = [];
        // The band moved source 7's clamped ask; no market notification fires
        world.prices[sourceHrid(7)] = { ask: 10, bid: 5 };
        for (const listener of world.dataListeners.get('market_item_values_updated') ?? []) listener({});
        const found = liveAlternatives(TARGET, new Set());
        expect(world.calls).toEqual([sourceHrid(7)]);
        expect(found.alternatives[0].sourceHrid).toBe(sourceHrid(7));
    });

    test("a slotted tea's price moving reruns every source that charged it", async () => {
        world.drinks = ['/items/catalytic_tea'];
        world.prices['/items/catalytic_tea'] = { ask: 100, bid: 90 };
        await settleAll();
        world.calls = [];
        world.prices['/items/catalytic_tea'] = { ask: 500, bid: 450 };
        for (const listener of world.listeners) listener();
        expect(liveAlternatives(TARGET, new Set()).pending).toBe(true);
        await settleAll();
        expect(world.calls).toHaveLength(SOURCE_COUNT);
    });
});

describe('calculator runs across a change of setup', () => {
    const settleAll = async () => {
        const settled = settleAlternatives(TARGET, new Set());
        await vi.runAllTimersAsync();
        return settled;
    };

    test('swapping the slotted tea for one at the same price reruns every source', async () => {
        world.drinks = ['/items/catalytic_tea'];
        world.prices['/items/catalytic_tea'] = { ask: 100, bid: 90 };
        world.prices['/items/efficiency_tea'] = { ask: 100, bid: 90 };
        await settleAll();
        world.calls = [];
        world.drinks = ['/items/efficiency_tea'];
        expect(liveAlternatives(TARGET, new Set()).pending).toBe(true);
        const found = await settleAll();
        expect(world.calls).toHaveLength(SOURCE_COUNT);
        expect(found.alternatives.length).toBeGreaterThan(0);
    });

    test('an alchemy level-up reruns every source', async () => {
        await settleAll();
        world.calls = [];
        world.alchemyLevel = 51;
        expect(liveAlternatives(TARGET, new Set()).pending).toBe(true);
        await settleAll();
        expect(world.calls).toHaveLength(SOURCE_COUNT);
    });

    test('an unchanged setup reuses every run', async () => {
        world.drinks = ['/items/catalytic_tea'];
        world.prices['/items/catalytic_tea'] = { ask: 100, bid: 90 };
        await settleAll();
        world.calls = [];
        for (const listener of world.listeners) listener();
        expect(liveAlternatives(TARGET, new Set()).pending).toBeUndefined();
        expect(world.calls).toEqual([]);
    });
});
