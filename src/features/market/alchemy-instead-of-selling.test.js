/**
 * "Instead of selling" — the alchemy actions that pay more for one unit you hold than its bid after
 * tax. Hard fixtures: a stack of three, a nonzero item level, a crate bonus drop, an unpriced
 * output, a zero bid, an estimated bid, a coinify, and the keep list.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

/** `{hrid: {ask, bid, source?}}` — source defaults to the order book */
const world = vi.hoisted(() => ({
    prices: {},
    gold: 0,
    markMeaning: 'keep',
    /** Calculator results by `type|hrid` */
    candidates: {},
    runs: 0,
}));

const ESSENCE = '/items/goblin_essence';
const GEM = '/items/gem';
const BOOMSTICK = '/items/gobo_boomstick';
const AMULET = '/items/amulet';
const JUNK = '/items/junk';
const CRATE = '/items/small_artisans_crate';
const CRATE_CONTENT = '/items/crate_content';
const UNPRICED = '/items/unpriced';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (id) => (id === 'actionPanel_craftingPlanGoldPerHour' ? world.gold : 0),
        getSettingValue: (id, fallback) => (id === 'selfUse_markMeaning' ? world.markMeaning : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => {
    const itemDetailMap = {
        '/items/goblin_essence': { name: 'Goblin Essence' },
        '/items/gem': { name: 'Gem' },
        '/items/crate_content': { name: 'Crate Content' },
        '/items/unpriced': { name: 'Unpriced' },
        // Decomposes into essence and an item with no market
        '/items/gobo_boomstick': {
            name: 'Gobo Boomstick',
            itemLevel: 40,
            alchemyDetail: {
                decomposeItems: [
                    { itemHrid: '/items/goblin_essence', count: 10 },
                    { itemHrid: '/items/unpriced', count: 1 },
                ],
            },
        },
        // Transmutes into gems, or comes back as itself
        '/items/amulet': {
            name: 'Amulet',
            itemLevel: 20,
            alchemyDetail: {
                transmuteSuccessRate: 0.5,
                transmuteDropTable: [
                    { itemHrid: '/items/gem', dropRate: 0.5, minCount: 2, maxCount: 4 },
                    { itemHrid: '/items/amulet', dropRate: 0.5, minCount: 1, maxCount: 1 },
                ],
            },
        },
        // Coinifiable only
        '/items/junk': { name: 'Junk', itemLevel: 1, alchemyDetail: { isCoinifiable: true } },
    };
    return {
        default: {
            currentCharacterId: 1,
            getInitClientData: () => ({
                itemDetailMap,
                openableLootDropMap: {
                    '/items/small_artisans_crate': [
                        { itemHrid: '/items/crate_content', dropRate: 1, minCount: 1, maxCount: 1 },
                    ],
                },
            }),
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
        calculateCandidateResults: (type, hrid) => {
            world.runs += 1;
            return world.candidates[`${type}|${hrid}`] ?? [];
        },
    },
}));
vi.mock('./expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => {
        const entry = world.prices[hrid];
        const base = entry?.[options?.side === 'buy' ? 'ask' : 'bid'];
        if (base == null) return { price: null, source: null, estimated: false };
        const source = entry.source ?? 'book';
        return { price: base, source, estimated: source === 'value' };
    },
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.9,
    calculateActionsPerHour: () => 0,
    calculateTeaCostsPerHour: () => ({ totalCostPerHour: 0 }),
}));

import { clearInsteadCache, findAlchemySellRoutes, liveSellRoutes } from './alchemy-instead-of-buying.js';

/** One setup; `bulk` items are eaten per action, `overhead` is the catalyst spend per hour */
const setup = (type, itemHrid, { bulk = 1, overhead = 0, successRate = 0.5, dropRevenues = [] } = {}) => ({
    actionType: type,
    itemHrid,
    actionsPerHour: 100,
    successRate,
    requirementCosts: [{ itemHrid, count: bulk, price: 0 }],
    catalystCostPerHour: overhead,
    totalTeaCostPerHour: 0,
    dropRevenues,
});

beforeEach(() => {
    clearInsteadCache();
    world.gold = 0;
    world.markMeaning = 'keep';
    world.runs = 0;
    world.candidates = {};
    world.prices = {
        [ESSENCE]: { ask: 320, bid: 300 },
        [GEM]: { ask: 1200, bid: 1000 },
        [CRATE_CONTENT]: { ask: 800, bid: 700 },
        [BOOMSTICK]: { ask: 1200, bid: 1000 },
        [AMULET]: { ask: 3000, bid: 2000 },
        [JUNK]: { ask: 10, bid: 100 },
    };
});

const only = (found, actionType) => found.routes.find((r) => r.actionType === actionType);

describe('decompose', () => {
    test('a win: outputs sold after tax beat the bid after tax, per unit of a stack of three', () => {
        // The unpriced output makes this partial; price it so the figure is exact
        world.prices[UNPRICED] = { ask: 1, bid: 1 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3 })];
        const found = liveSellRoutes(BOOMSTICK, new Set());
        // Per action: 3 × (10 essence × 0.5 × 270 + 1 × 0.5 × 0.9) = 4051.35; the three sticks sold: 2700
        // Per unit: 4051.35 / 3 = 1350.45 against a bid of 900 after tax
        expect(found.sellValue).toBeCloseTo(900);
        const route = only(found, 'decompose');
        expect(route.margin).toBeCloseTo(450.45);
        expect(route.valuePerUnit).toBeCloseTo(1350.45);
        expect(route.partlyUnpriced).toBe(false);
        // 100 actions an hour eating three: 300 units an hour
        expect(route.secondsPerUnit).toBeCloseTo(12);
    });

    test('an unpriced output makes a lower bound that still wins', () => {
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3 })];
        const route = only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose');
        expect(route.partlyUnpriced).toBe(true);
        expect(route.margin).toBeCloseTo(450);
    });

    test('a loss shows nothing', () => {
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { overhead: 1e6 })];
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('a margin of exactly zero shows nothing', () => {
        // 10 essence × 0.5 × 270 = 1350 per action against a bid of 1500 after tax 1350
        world.prices[BOOMSTICK] = { ask: 1200, bid: 1500 };
        world.prices[UNPRICED] = { ask: 0, bid: 0 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { successRate: 0.5 })];
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('the catalyst spend is charged per unit', () => {
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3, overhead: 30000 })];
        // 30000 an hour over 100 actions: 300 an action, 100 a unit off the 450 margin
        expect(only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose').margin).toBeCloseTo(350);
    });

    test('the best of several catalyst setups is the one used', () => {
        world.candidates[`decompose|${BOOMSTICK}`] = [
            setup('decompose', BOOMSTICK, { bulk: 3, overhead: 90000 }),
            setup('decompose', BOOMSTICK, { bulk: 3, overhead: 0, successRate: 0.7 }),
        ];
        // 0.7 success, no spend: 3 × 10 × 0.7 × 270 / 3 = 1890 per unit against 900
        expect(only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose').margin).toBeCloseTo(990);
    });

    test('a gold rate charges the alchemy time against the margin', () => {
        world.gold = 3600 * 5;
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3 })];
        // 12 s a unit at 5 a second: 60 a unit
        const route = only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose');
        expect(route.timeCostPerUnit).toBeCloseTo(60);
        expect(route.margin).toBeCloseTo(390);
        // A rate that eats the whole margin hides the line
        world.gold = 3600 * 100;
        clearInsteadCache();
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('a crate bonus drop is opened and its contents sold after tax', () => {
        world.prices[UNPRICED] = { ask: 1, bid: 1 };
        const crate = { itemHrid: CRATE, isRare: true, dropsPerHour: 100 };
        world.candidates[`decompose|${BOOMSTICK}`] = [
            setup('decompose', BOOMSTICK, { bulk: 3, dropRevenues: [crate] }),
        ];
        // One crate per action: 700 × 0.9 = 630, over three units: +210 a unit
        expect(only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose').margin).toBeCloseTo(660.45);
    });

    test('a crate whose contents are unpriced is a lower bound, not a made-up value', () => {
        world.prices[UNPRICED] = { ask: 1, bid: 1 };
        world.prices[CRATE_CONTENT] = {};
        const crate = { itemHrid: CRATE, isRare: true, dropsPerHour: 100 };
        world.candidates[`decompose|${BOOMSTICK}`] = [
            setup('decompose', BOOMSTICK, { bulk: 3, dropRevenues: [crate] }),
        ];
        const route = only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose');
        expect(route.partlyUnpriced).toBe(true);
        expect(route.margin).toBeCloseTo(450.45);
    });
});

describe('the mark meaning', () => {
    test('outputs are always sold after tax, in either mark meaning', () => {
        world.prices[UNPRICED] = { ask: 1, bid: 1 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3 })];
        for (const meaning of ['sell', 'keep']) {
            world.markMeaning = meaning;
            clearInsteadCache();
            // Essence sold at 300 × 0.9, never kept at its ask of 320
            const route = only(liveSellRoutes(BOOMSTICK), 'decompose');
            expect(route.margin).toBeCloseTo(450.45);
            expect(route.kept).toEqual([]);
        }
    });
});

describe('transmute', () => {
    test('a win: gems sold after tax, the self-return worth the bid after tax', () => {
        world.candidates[`transmute|${AMULET}`] = [setup('transmute', AMULET, { successRate: 0.5 })];
        const route = only(liveSellRoutes(AMULET, new Set()), 'transmute');
        // Per action at 50%: gems 0.5 × 3 × 0.5 × 900 = 337.5; self 0.5 × 0.5 × 1800 = 450 against 1800 in
        // net = 787.5 - 1800 < 0: not a win at this rate
        expect(route).toBeUndefined();
        world.candidates[`transmute|${AMULET}`] = [setup('transmute', AMULET, { successRate: 1 })];
        clearInsteadCache();
        const win = only(liveSellRoutes(AMULET, new Set()), 'transmute');
        // At 100%: gems 0.5 × 3 × 900 = 1350; self 0.5 × 1800 = 900; 2250 against 1800 in: +450
        expect(win.margin).toBeCloseTo(450);
        expect(win.valuePerUnit).toBeCloseTo(2250);
    });

    test('the item level of a nonzero-level source does not change the arithmetic', () => {
        world.candidates[`transmute|${AMULET}`] = [setup('transmute', AMULET, { successRate: 1 })];
        // Level 20 in the fixture's details; the same margin as above
        expect(only(liveSellRoutes(AMULET, new Set()), 'transmute').margin).toBeCloseTo(450);
    });

    test('an unpriced gem leaves the self-return only: no win', () => {
        world.prices[GEM] = {};
        world.candidates[`transmute|${AMULET}`] = [setup('transmute', AMULET, { successRate: 1 })];
        expect(liveSellRoutes(AMULET, new Set()).routes).toEqual([]);
    });

    test('a partly unpriced route that already wins is a lower bound', () => {
        world.prices[GEM] = { ask: 1200, bid: 1000 };
        const crate = { itemHrid: CRATE, isRare: true, dropsPerHour: 100 };
        world.prices[CRATE_CONTENT] = {};
        world.candidates[`transmute|${AMULET}`] = [
            setup('transmute', AMULET, { successRate: 1, dropRevenues: [crate] }),
        ];
        const route = only(liveSellRoutes(AMULET, new Set()), 'transmute');
        expect(route.partlyUnpriced).toBe(true);
        expect(route.margin).toBeCloseTo(450);
    });
});

describe('coinify', () => {
    const coins = (count) => ({ itemHrid: '/items/coin', count });

    test('a win: the coins at face value beat the bid after tax', () => {
        // 500 coins at 50% = 250 against a bid of 100 after tax 90
        world.candidates[`coinify|${JUNK}`] = [setup('coinify', JUNK, { dropRevenues: [coins(500)] })];
        const route = only(liveSellRoutes(JUNK, new Set()), 'coinify');
        expect(route.margin).toBeCloseTo(160);
        expect(route.valuePerUnit).toBeCloseTo(250);
    });

    test('coins worth less than the bid show nothing', () => {
        world.candidates[`coinify|${JUNK}`] = [setup('coinify', JUNK, { dropRevenues: [coins(100)] })];
        expect(liveSellRoutes(JUNK, new Set()).routes).toEqual([]);
    });
});

describe('ranking', () => {
    test('one line per winning action, the best margin first', () => {
        // A fixture item that both decomposes and transmutes
        const both = '/items/both';
        const details = {
            alchemyDetail: {
                decomposeItems: [{ itemHrid: ESSENCE, count: 10 }],
                transmuteDropTable: [{ itemHrid: GEM, dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        };
        const found = findAlchemySellRoutes(both, {
            getItemDetails: () => details,
            bidOf: () => 1000,
            askOf: () => null,
            sellOf: (hrid) => ({ [ESSENCE]: 270, [GEM]: 900 })[hrid] ?? null,
            candidatesOf: (type) => [setup(type, both, { successRate: type === 'decompose' ? 1 : 0.9 })],
        });
        // Decompose: 10 × 270 = 2700 - 900 = 1800; transmute: 0.9 × 900 - 900 < 0
        expect(found.routes.map((r) => r.actionType)).toEqual(['decompose']);
        const second = findAlchemySellRoutes(both, {
            getItemDetails: () => details,
            bidOf: () => 1000,
            askOf: () => null,
            sellOf: (hrid) => ({ [ESSENCE]: 270, [GEM]: 5000 })[hrid] ?? null,
            candidatesOf: (type) => [setup(type, both, { successRate: 1 })],
        });
        expect(second.routes.map((r) => r.actionType)).toEqual(['transmute', 'decompose']);
    });
});

describe('the cap', () => {
    test('three winning routes show only the best two', () => {
        const all = '/items/all';
        const details = {
            alchemyDetail: {
                decomposeItems: [{ itemHrid: ESSENCE, count: 10 }],
                transmuteDropTable: [{ itemHrid: GEM, dropRate: 1, minCount: 1, maxCount: 1 }],
                isCoinifiable: true,
            },
        };
        const run = (limit) =>
            findAlchemySellRoutes(all, {
                getItemDetails: () => details,
                bidOf: () => 1000,
                askOf: () => null,
                // Decompose 2700 - 900 = 1800; transmute 2000 - 900 = 1100; coinify 1500 - 900 = 600
                sellOf: (hrid) => ({ [ESSENCE]: 270, [GEM]: 2000 })[hrid] ?? null,
                candidatesOf: (type) => [
                    setup(type, all, {
                        successRate: 1,
                        dropRevenues: type === 'coinify' ? [{ itemHrid: '/items/coin', count: 1500 }] : [],
                    }),
                ],
                limit,
            });
        expect(run(undefined).routes.map((r) => r.actionType)).toEqual(['decompose', 'transmute']);
        expect(run(3).routes.map((r) => r.actionType)).toEqual(['decompose', 'transmute', 'coinify']);
    });
});

describe('every ending without a line', () => {
    test('no bid: nothing, and no calculator run', () => {
        world.prices[BOOMSTICK] = { ask: 1200 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK)];
        expect(liveSellRoutes(BOOMSTICK, new Set())).toEqual({ sellValue: null, routes: [] });
        expect(world.runs).toBe(0);
    });

    test('a zero bid shows nothing', () => {
        world.prices[BOOMSTICK] = { ask: 1200, bid: 0 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK)];
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('an estimated or custom bid is no price to sell at', () => {
        world.prices[BOOMSTICK] = { ask: 1200, bid: 1, source: 'value' };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK)];
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
        world.prices[BOOMSTICK] = { ask: 1200, bid: 1, source: 'custom' };
        clearInsteadCache();
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('an item with no alchemy action runs nothing', () => {
        expect(liveSellRoutes(ESSENCE, new Set())).toEqual({ sellValue: null, routes: [] });
        expect(world.runs).toBe(0);
    });

    test('every output unpriced: nothing wins', () => {
        world.prices[ESSENCE] = {};
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK)];
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });

    test('no calculator result (no setup was buyable): nothing', () => {
        expect(liveSellRoutes(BOOMSTICK, new Set()).routes).toEqual([]);
    });
});

describe('the cache', () => {
    test('a repeat lookup reads the cache', () => {
        world.prices[UNPRICED] = { ask: 1, bid: 1 };
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK)];
        const first = liveSellRoutes(BOOMSTICK);
        expect(liveSellRoutes(BOOMSTICK)).toBe(first);
    });

    test('a changed gold rate recomputes', () => {
        world.candidates[`decompose|${BOOMSTICK}`] = [setup('decompose', BOOMSTICK, { bulk: 3 })];
        const free = only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose').margin;
        world.gold = 3600 * 5;
        expect(only(liveSellRoutes(BOOMSTICK, new Set()), 'decompose').margin).toBeLessThan(free);
    });
});
