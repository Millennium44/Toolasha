/**
 * "Instead of buying" — the run signature knows a saved loadout's tea, and the bonus-source
 * ranking weighs each source's real success rate (level penalty, tea, catalysts).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const ESSENCE = '/items/alchemy_essence';
const SHARD = '/items/shard';
const TEA = '/items/loadout_tea';
const TARGET = '/items/gem';
const CATALYST = '/items/catalyst_of_decomposition';
const ALCHEMY_LEVEL = 50;

const world = vi.hoisted(() => ({ prices: {}, listeners: [], calls: [], loadoutDrinks: [] }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/alchemy_essence': { name: 'Alchemy Essence' },
        '/items/shard': { name: 'Shard' },
        '/items/gem': { name: 'Gem' },
        '/items/tea_source': {
            name: 'Tea Source',
            itemLevel: 10,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/gem', count: 1 }] },
        },
    };
    // Heavily penalized (level 100) sources, then level-10 ones with no penalty
    for (let i = 0; i < 40; i++) {
        itemDetailMap[`/items/pen_${i}`] = {
            name: `Pen ${i}`,
            itemLevel: 100,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/shard', count: 2 }] },
        };
        itemDetailMap[`/items/free_${i}`] = {
            name: `Free ${i}`,
            itemLevel: 10,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/shard', count: 2 }] },
        };
    }
    return {
        default: {
            currentCharacterId: 1,
            getInitClientData: () => ({
                itemDetailMap,
                openableLootDropMap: {},
                actionDetailMap: { '/actions/alchemy/decompose': { baseTimeCost: 20e9 } },
            }),
            getSkills: () => [],
            getItemDetails: (hrid) => itemDetailMap[hrid] ?? null,
            getActionDrinkSlots: () => [],
            getInventory: () => [],
            getEquipment: () => new Map(),
            on: () => {},
            off: () => {},
        },
    };
});
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({
        equipment: new Map(),
        drinks: world.loadoutDrinks.map((itemHrid) => ({ itemHrid })),
    }),
}));
// 5 s an action and no efficiency: 720 actions an hour
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 5, totalEfficiency: 0 }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        lastFetchTimestamp: 1,
        on: (callback) => world.listeners.push(callback),
        off: () => {},
    },
}));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateCandidateResults: (actionType, itemHrid) => {
            world.calls.push(itemHrid);
            const setup = (tea) => ({
                actionType,
                itemHrid,
                actionsPerHour: 100,
                successRate: tea ? 0.9 : 0.6,
                requirementCosts: [{ itemHrid, count: 1, price: 0 }],
                catalystCostPerHour: 0,
                totalTeaCostPerHour: 0,
                consumableCosts: tea ? [{ itemHrid: tea }] : [],
                // A tea setup succeeds more often; it exists only while the tea has a price
                dropRevenues: [{ itemHrid: TARGET, dropsPerHour: tea ? 300 : 100 }],
                winningCatalystHrid: null,
            });
            const setups = [setup(null)];
            for (const tea of world.loadoutDrinks) if (world.prices[tea]?.ask != null) setups.push(setup(tea));
            return setups;
        },
        // The calculator's own success-rate logic
        getUnderLevelPenalty: (level) => (ALCHEMY_LEVEL < level ? (0.9 / level) * (ALCHEMY_LEVEL - level) : 0),
        calculateSuccessRateBreakdown: (base, catalyst = 0, tea = null, penalty = 0) => ({
            total: Math.max(0, Math.min(1, base * (1 + catalyst + penalty + (tea ?? world.liveTea ?? 0)))),
            tea: tea ?? world.liveTea ?? 0,
        }),
        catalystSuccessBonus: (hrid) => (hrid === '/items/prime_catalyst' ? 0.25 : 0.15),
        // The calculator folds a speed tea into the action time after calculateActionStats
        actionSpeedStats: (details, { drinkSlots, actionTime }) => ({
            actionTime: drinkSlots.length > 0 ? actionTime / (1 + (world.teaSpeed || 0)) : actionTime,
        }),
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
vi.mock('../../utils/profit-helpers.js', async (importOriginal) => ({
    ...(await importOriginal()),
    calculatePriceAfterTax: (price) => price * 0.9,
}));

import {
    liveAlternatives,
    settleAlternatives,
    clearInsteadCache,
    bonusRankCost,
    makeRateChoices,
} from './alchemy-instead-of-buying.js';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    clearInsteadCache();
    world.calls = [];
    world.loadoutDrinks = [];
    world.liveTea = 0;
    world.teaSpeed = 0;
    world.listeners = [];
    world.prices = { [ESSENCE]: { ask: 5000, bid: 4000 }, [SHARD]: { ask: 1100, bid: 1000 } };
});

afterEach(() => {
    clearInsteadCache();
    vi.useRealTimers();
});

describe('a saved loadout tea in the run signature', () => {
    test('a loadout tea that gains a price reruns the sources', () => {
        world.loadoutDrinks = [TEA];
        world.prices[TARGET] = { ask: 1000, bid: 900 };
        world.prices['/items/tea_source'] = { ask: 400, bid: 300 };
        const before = liveAlternatives(TARGET, new Set());
        const runs = world.calls.length;
        expect(runs).toBeGreaterThan(0);

        // The tea gets a listing: its setup is now buyable and succeeds more often
        world.prices[TEA] = { ask: 10, bid: 8 };
        for (const listener of world.listeners) listener();
        const after = liveAlternatives(TARGET, new Set());
        expect(world.calls.length).toBeGreaterThan(runs);
        expect(after.alternatives[0].costPerUnit).toBeLessThan(before.alternatives[0].costPerUnit);
    });
});

describe('bonus-source ranking with the real success rate', () => {
    const rateDeps = (choices) => ({
        getItemDetails: () => ({ itemLevel: 10, alchemyDetail: { decomposeItems: [{ itemHrid: SHARD, count: 2 }] } }),
        askOf: () => 2000,
        sellOf: () => 900,
        rateChoices: choices ? () => choices : undefined,
    });

    test('a catalyst that raises the rate lowers the ranked cost by its credit less its price', () => {
        const source = { sourceHrid: '/items/x', actionType: 'decompose' };
        const flat = bonusRankCost(ESSENCE, source, rateDeps(undefined));
        const withCatalyst = bonusRankCost(
            ESSENCE,
            source,
            rateDeps([
                { rate: 0.6, catalystPrice: 0 },
                { rate: 0.69, catalystPrice: 50 },
            ])
        );
        // 2,000 minus r x (1,800 minus the catalyst's price), over 110/1800; r = 0.69, price 50
        expect(withCatalyst).toBeCloseTo((2000 + 100 - 0.69 * 1750) / (110 / 1800));
        expect(withCatalyst).toBeLessThan(flat);
    });

    test('a penalty-free source makes the top ten that a flat ranking left it out of', async () => {
        // Every level-100 source is cheaper to buy, so at a flat 60% they fill the top ten
        for (let i = 0; i < 40; i++) {
            world.prices[`/items/pen_${i}`] = { ask: 1500 + i, bid: 900 };
            world.prices[`/items/free_${i}`] = { ask: 1700 + i, bid: 900 };
        }
        // Flat ranking: a level-100 source (more essence per action) beats every free one
        const flatCost = (level, ask) => (ask - 0.6 * 1800) / ((100 + level) / 1800);
        expect(flatCost(100, 1500 + 39)).toBeLessThan(flatCost(10, 1700));
        const settled = settleAlternatives(ESSENCE, new Set());
        await vi.runAllTimersAsync();
        await settled;
        expect(world.calls.some((hrid) => hrid.startsWith('/items/free_'))).toBe(true);
    });

    test('a tea setup is ranked with its spend per action, not as a free rate boost', () => {
        const source = { sourceHrid: '/items/x', actionType: 'decompose' };
        const tea = { rate: 0.9, catalystPrice: 0, teaPerAction: 0 };
        const noTea = { rate: 0.6, catalystPrice: 0 };
        // 2,100 for the source and its fee, 1,800 back per success: 0.9 beats 0.6 only while the tea is free
        const free = bonusRankCost(ESSENCE, source, rateDeps([noTea, tea]));
        expect(free).toBeCloseTo((2100 - 0.9 * 1800) / (110 / 1800));
        // A tea that costs 600 an action is worse than going without
        const dear = bonusRankCost(ESSENCE, source, rateDeps([noTea, { ...tea, teaPerAction: 600 }]));
        expect(dear).toBeCloseTo((2100 - 0.6 * 1800) / (110 / 1800));
        expect(dear).toBeGreaterThan(free);
    });

    test('makeRateChoices charges the tea an hour of drinks spread over the actions in it', () => {
        world.loadoutDrinks = [TEA];
        world.prices[TEA] = { ask: 600, bid: 500 };
        const choices = makeRateChoices()('decompose', { itemLevel: 10 }, 0.6);
        const teaChoices = choices.filter((choice) => choice.teaPerAction > 0);
        expect(teaChoices.length).toBeGreaterThan(0);
        // 12 drinks an hour at 600 over 720 actions an hour
        for (const choice of teaChoices) expect(choice.teaPerAction).toBeCloseTo((12 * 600) / 720);
        expect(choices.some((choice) => choice.teaPerAction === 0)).toBe(true);
    });

    test('a speed tea spreads its hourly spend over the faster actions', () => {
        world.loadoutDrinks = [TEA];
        world.prices[TEA] = { ask: 600, bid: 500 };
        world.teaSpeed = 0.5;
        const choices = makeRateChoices()('decompose', { itemLevel: 10 }, 0.6);
        const teaChoices = choices.filter((choice) => choice.teaPerAction > 0);
        expect(teaChoices.length).toBeGreaterThan(0);
        // 5 s / 1.5 makes 1080 actions an hour, not 720
        for (const choice of teaChoices) expect(choice.teaPerAction).toBeCloseTo((12 * 600) / 1080);
    });

    test('a tea nobody sells adds no rate: only the no-tea setup is offered', () => {
        world.loadoutDrinks = ['/items/success_tea'];
        world.liveTea = 0.5;
        const details = { itemLevel: 10 };
        const unsold = makeRateChoices()('decompose', details, 0.6);
        expect(unsold.every((choice) => choice.rate <= 0.6 + 1e-9)).toBe(true);
        world.prices['/items/success_tea'] = { ask: 100, bid: 90 };
        const sold = makeRateChoices()('decompose', details, 0.6);
        expect(sold.some((choice) => choice.rate > 0.6 + 1e-9)).toBe(true);
        // Both the no-tea and the tea setup are offered when the tea can be bought
        expect(sold.some((choice) => Math.abs(choice.rate - 0.6) < 1e-9)).toBe(true);
    });

    test('ranks hundreds of sources well under a calculator run each', async () => {
        vi.useRealTimers();
        for (let i = 0; i < 40; i++) {
            world.prices[`/items/pen_${i}`] = { ask: 1500 + i, bid: 900 };
            world.prices[`/items/free_${i}`] = { ask: 1700 + i, bid: 900 };
        }
        world.prices[CATALYST] = { ask: 20, bid: 10 };
        // 80 sources x 12 passes is about the hundreds of a real ranking
        const started = performance.now();
        let ranked = 0;
        for (let pass = 0; pass < 12; pass++) {
            clearInsteadCache();
            await settleAlternatives(ESSENCE, new Set());
            ranked += 80;
        }
        const perSource = (performance.now() - started) / ranked;
        console.log(`[rank cost] ${perSource.toFixed(4)} ms per source (including the ten mock runs)`);
        expect(perSource).toBeLessThan(0.5);
    });
});
