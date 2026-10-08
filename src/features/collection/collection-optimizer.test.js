/**
 * @vitest-environment happy-dom
 *
 * The Collection Points optimizer panel, built rather than reasoned about.
 *
 * The game is mocked, the panel is not: the data manager hands over a
 * `collections_updated` list in the game's shape, the calculators answer for
 * the measured hood decompose chain (umbral_hood → 90 umbral_leather + 1
 * beast_hood, beast_hood → 60 beast_leather + 1 gobo_hood, gobo_hood → 30
 * gobo_leather) and cheese_sword → 18 cheese, sold in the shop.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    collections: null,
    characterId: 'char-1',
    craftable: new Set(['/items/cheese']),
    profitExtra: {},
    shopUnits: 1,
    actionDetails: null,
}));
/** Per-character storage as the character-key helpers see it: `${characterId}:${base}` → value */
const scoped = vi.hoisted(() => ({ values: new Map(), gate: null }));
const bus = vi.hoisted(() => ({ handlers: {} }));
const observer = vi.hoisted(() => ({ handlers: [] }));

const ITEMS = vi.hoisted(() => ({
    '/items/umbral_hood': {
        name: 'Umbral Hood',
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/umbral_leather', count: 90 },
                { itemHrid: '/items/beast_hood', count: 1 },
            ],
        },
    },
    '/items/beast_hood': {
        name: 'Beast Hood',
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/beast_leather', count: 60 },
                { itemHrid: '/items/gobo_hood', count: 1 },
            ],
        },
    },
    '/items/gobo_hood': {
        name: 'Gobo Hood',
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/gobo_leather', count: 30 }] },
    },
    '/items/umbral_leather': { name: 'Umbral Leather' },
    '/items/beast_leather': { name: 'Beast Leather' },
    '/items/gobo_leather': { name: 'Gobo Leather' },
    '/items/cheese_sword': {
        name: 'Cheese Sword',
        equipmentDetail: {},
        alchemyDetail: { bulkMultiplier: 2, decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] },
    },
    '/items/cheese': { name: 'Cheese' },
    '/items/coin': { name: 'Coin' },
    // The game's own data: the whole recipe comes back on a success
    '/items/earrings_of_essence_find': {
        name: 'Earrings Of Essence Find',
        itemLevel: 30,
        equipmentDetail: {},
        alchemyDetail: {
            bulkMultiplier: 1,
            decomposeItems: [
                { itemHrid: '/items/star_fragment', count: 600 },
                { itemHrid: '/items/amber', count: 6 },
            ],
        },
    },
    '/items/star_fragment': { name: 'Star Fragment' },
    // Amber's transmute, cut to three of its eight rows (the game's rates for those three)
    '/items/amber': {
        name: 'Amber',
        itemLevel: 25,
        alchemyDetail: {
            bulkMultiplier: 1,
            transmuteSuccessRate: 0.35,
            transmuteDropTable: [
                { itemHrid: '/items/star_fragment', dropRate: 0.1, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/amber', dropRate: 0.16, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/garnet', dropRate: 0.12, minCount: 1, maxCount: 1 },
            ],
        },
    },
    '/items/garnet': { name: 'Garnet' },
    '/items/milk': { name: 'Milk' },
    '/items/milking_essence': { name: 'Milking Essence' },
}));

/** Milking a cow, as the game lists it: a level requirement and a drop table */
const ACTIONS = vi.hoisted(() => ({
    '/actions/milking/cow': {
        hrid: '/actions/milking/cow',
        name: 'Cow',
        type: '/action_types/milking',
        levelRequirement: { skillHrid: '/skills/milking', level: 1 },
        dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
    },
}));

const BUY = vi.hoisted(() => ({
    '/items/umbral_hood': 400_000,
    '/items/beast_hood': 150_000,
    '/items/gobo_hood': 20_000,
    '/items/umbral_leather': 1000,
    '/items/beast_leather': 300,
    '/items/gobo_leather': 50,
    '/items/cheese': 10,
    '/items/cheese_sword': 2000,
    // The bonus drop every alchemy action rolls has a market in the game
    '/items/alchemy_essence': 100,
    // Live books, 2026-10-08
    '/items/earrings_of_essence_find': 6_300_000,
    '/items/star_fragment': 13_750,
    '/items/amber': 20_240,
    '/items/garnet': 21_000,
    '/items/milk': 100,
    '/items/milking_essence': 50,
}));

/** The bid side, where it differs from the ask above */
const BID = vi.hoisted(() => ({
    '/items/earrings_of_essence_find': 5_940_000,
    '/items/star_fragment': 13_700,
    '/items/amber': 20_160,
    '/items/milk': 90,
}));

/** What an Artisan's Crate opens into, when a test has one drop (game.crateDrop) */
const LOOT = vi.hoisted(() => ({
    '/items/small_artisans_crate': [
        { itemHrid: '/items/star_fragment', dropRate: 1, minCount: 2, maxCount: 4 },
        { itemHrid: '/items/garnet', dropRate: 0.5, minCount: 1, maxCount: 1 },
    ],
}));

/** Measured daily volumes, for the liquidity bound */
const VOLUME = vi.hoisted(() => ({ perDay: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'collectionOptimizer' ? game.setting : undefined),
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCharacterCollections: () => game.collections,
        getCurrentCharacterId: () => game.characterId,
        getInitClientData: () => ({
            itemDetailMap: ITEMS,
            actionDetailMap: ACTIONS,
            openableLootDropMap: LOOT,
            achievementDetailMap: {
                '/achievements/collection_points_100': { hrid: '/achievements/collection_points_100', target: 100 },
            },
        }),
        getItemDetails: (hrid) => ITEMS[hrid] || null,
        getActionDetails: (hrid) => ACTIONS[hrid] ?? game.actionDetails ?? null,
        getSkills: () => [{ skillHrid: '/skills/milking', level: game.milkingLevel }],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            const entry = { name, classNames, callback };
            observer.handlers.push(entry);
            return () => {
                observer.handlers = observer.handlers.filter((h) => h !== entry);
            };
        },
    },
}));

// Only Cheese is made at a bench here, at 4 gold a unit and 360 an hour
vi.mock('../market/profit-calculator.js', () => ({
    default: {
        findProductionAction: (hrid) => (game.craftable.has(hrid) ? { actionHrid: '/actions/cheesesmithing/x' } : null),
        calculateProfit: async (hrid, options = {}) =>
            options.actionHrid === '/actions/alt'
                ? { itemHrid: hrid, actionHrid: '/actions/alt', totalItemsPerHour: 360, ...game.altProfit }
                : {
                      itemHrid: hrid,
                      actionHrid: '/actions/x',
                      totalItemsPerHour: 360,
                      productionCandidates: game.altProfit ? ['/actions/x', '/actions/alt'] : ['/actions/x'],
                      ...game.profitExtra,
                  },
    },
}));
// The cow at 360 actions an hour and +50% efficiency: 1.5 milk an action, 10% of it turned into
// cheese by Processing, an essence every 100 completions, and 720 an hour of tea
vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async (hrid) =>
        hrid !== '/actions/milking/cow'
            ? null
            : {
                  actionsPerHour: 360,
                  efficiencyMultiplier: 1.5,
                  baseOutputs: [{ itemHrid: '/items/milk', itemsPerHour: 540 }],
                  processingConversions: [
                      {
                          rawItemHrid: '/items/milk',
                          processedItemHrid: '/items/cheese',
                          rawConsumedPerHour: 54,
                          conversionsPerHour: 54,
                      },
                  ],
                  bonusRevenue: { bonusDrops: [{ itemHrid: '/items/milking_essence', dropsPerHour: 3.6 }] },
                  drinkCostPerHour: 720,
                  drinkCosts: game.unpricedTea ? [{ missingPrice: true }] : [],
              },
}));
vi.mock('../market/tooltip-prices.js', () => ({
    ownUseCompare: () => ({ make: 4, buy: 10, saves: 6, cheaper: 'make', priceBasis: 'ask' }),
}));

const RATES = vi.hoisted(() => ({
    '/items/umbral_hood': 0.6,
    '/items/beast_hood': 0.5,
    '/items/gobo_hood': 0.8,
    '/items/cheese_sword': 1,
    // The rate the maintainer's row implies: base 60% raised by a catalyst and tea
    '/items/earrings_of_essence_find': 0.8,
}));
/** Coins per decompose ((10 + level 30) × 5) and the catalyst used on each success */
const OVERHEAD = vi.hoisted(() => ({
    '/items/earrings_of_essence_find': { coin: 200, catalystPerSuccess: 7920 },
}));
/**
 * Amber's transmute: by default 50% after its catalyst and tea, 100 attempts an hour, 125 coins
 * and 3,000 of catalyst an hour, and the essence every attempt can roll
 */
const amberTransmute = (hrid, setup = {}) => ({
    itemHrid: hrid,
    actionsPerHour: 100,
    successRate: 0.5,
    requirementCosts: [
        { itemHrid: hrid, count: 1, price: BUY[hrid] },
        { itemHrid: '/items/coin', count: 125, costPerAction: 125 },
    ],
    catalystCostPerHour: 3000,
    totalTeaCostPerHour: 0,
    winningCatalystHrid: '/items/catalyst_of_transmutation',
    winningTeaUsed: true,
    dropRevenues: [
        { itemHrid: '/items/alchemy_essence', isEssence: true, dropsPerHour: 10, price: 0 },
        ...(game.crateDrop
            ? [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 0 }]
            : []),
    ],
    ...setup,
});
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateTransmuteProfit: (hrid) => (hrid !== '/items/amber' || game.noTransmute ? null : amberTransmute(hrid)),
        // The setups the calculator weighs, when a test lists them
        calculateCandidateResults: (type, hrid) =>
            type === 'transmute' && hrid === '/items/amber' && !game.noTransmute
                ? game.transmuteSetups.map((setup) => amberTransmute(hrid, setup))
                : [],
        calculateDecomposeProfit: (hrid) =>
            RATES[hrid] === undefined
                ? null
                : {
                      itemHrid: hrid,
                      actionsPerHour: 100,
                      successRate: RATES[hrid],
                      requirementCosts: [
                          { itemHrid: hrid, count: 1, price: BUY[hrid] },
                          ...(OVERHEAD[hrid]
                              ? [
                                    {
                                        itemHrid: '/items/coin',
                                        count: OVERHEAD[hrid].coin,
                                        costPerAction: OVERHEAD[hrid].coin,
                                    },
                                ]
                              : []),
                      ],
                      catalystCostPerHour: OVERHEAD[hrid] ? OVERHEAD[hrid].catalystPerSuccess * RATES[hrid] * 100 : 0,
                      totalTeaCostPerHour: 0,
                      // The alchemy-wide bonus drop every action rolls
                      dropRevenues: [
                          { itemHrid: '/items/alchemy_essence', isEssence: true, dropsPerHour: 10, price: 0 },
                      ],
                  },
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => BUY[hrid] ?? null,
    getItemPriceInfo: (hrid, options = {}) => {
        // The profit pricing mode picks the side when no mode is named: 'optimistic' buys at the bid
        const side = options.mode ?? (game.pricingMode === 'optimistic' && options.side === 'buy' ? 'bid' : 'ask');
        const price = side === 'bid' ? (BID[hrid] ?? BUY[hrid] ?? null) : (BUY[hrid] ?? null);
        return game.estimated.has(hrid)
            ? { price, source: 'value', estimated: true }
            : { price, source: 'book', estimated: false };
    },
    getPricingMode: () => 'ask',
}));
// The shared liquidity bound: a quarter of the measured daily volume, per hour
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitRateCached: ({ goldPerHour, sells }) => {
        const perDay = VOLUME.perDay[sells[0].itemHrid];
        if (perDay === undefined) return { goldPerHour, capped: false, limit: null };
        const throttle = Math.min(1, (0.25 * perDay) / 24 / sells[0].unitsPerHour);
        return throttle < 1
            ? { goldPerHour: goldPerHour * throttle, capped: true, limit: { throttle } }
            : { goldPerHour, capped: false, limit: null };
    },
    prefetchLiquidity: async () => {},
}));
vi.mock('../planner/market-liquidity.js', () => ({ LIQUIDITY_HORIZON_DAYS: 7 }));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinOnlyCost: (hrid) => ({
        coins: hrid === '/items/cheese_sword' && !game.mixedShop ? 50 : 0,
        units: game.shopUnits,
    }),
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => game.ironCow }));
// The 4% market tax, off for an Iron Cow
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => (game.ironCow ? price : price * 0.96),
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, _store, fallback) => {
        const key = `${game.characterId}:${base}`;
        if (scoped.gate) await scoped.gate;
        return scoped.values.has(key) ? scoped.values.get(key) : fallback;
    },
    writeScoped: async (base, value) => {
        scoped.values.set(`${game.characterId}:${base}`, value);
        return true;
    },
}));

const {
    default: optimizer,
    buildCollectionRoutes,
    realizedSalePrice,
    weeklySellable,
    formatNet,
} = await import('./collection-optimizer.js');
const { bestOptions, collectionCounts, evaluateOption } = await import('./collection-optimizer-plan.js');

/** The game's Collections tab: controls, then the tile categories */
function drawCollectionsTab() {
    document.body.innerHTML =
        '<div class="AchievementsPanel_collections__qA6CY">' +
        '<div class="AchievementsPanel_controls__3bGFT"></div>' +
        '<div class="AchievementsPanel_categories__34hno"></div>' +
        '</div>';
    return document.querySelector('.AchievementsPanel_collections__qA6CY');
}

const COLLECTIONS = [
    { characterID: 1, itemHrid: '/items/umbral_hood', count: 331, enhancementData: '{}' },
    { characterID: 1, itemHrid: '/items/cheese', count: 5, enhancementData: '{}' },
];

const panel = () => document.querySelector('.toolasha-collopt');

beforeEach(() => {
    game.setting = true;
    game.collections = COLLECTIONS;
    game.characterId = 'char-1';
    scoped.values = new Map();
    scoped.gate = null;
    bus.handlers = {};
    observer.handlers = [];
    game.craftable = new Set(['/items/cheese']);
    game.profitExtra = {};
    game.shopUnits = 1;
    game.actionDetails = null;
    game.estimated = new Set();
    game.altProfit = null;
    game.mixedShop = false;
    game.ironCow = false;
    VOLUME.perDay = {};
    game.pricingMode = 'hybrid';
    game.noTransmute = false;
    game.milkingLevel = 10;
    game.unpricedTea = false;
    game.crateDrop = false;
    game.transmuteSetups = [];
});

afterEach(() => {
    optimizer.disable();
    optimizer.collapsed = false;
    document.body.innerHTML = '';
});

describe('the routes', () => {
    test('decompose chains credit the lower hoods; shop gear is priced at the shop; nothing is bought', async () => {
        const routes = await buildCollectionRoutes();
        const umbral = routes.sources.find((s) => s.sourceHrid === '/items/umbral_hood' && s.route === 'decompose');
        expect(umbral.yields.get('/items/beast_hood')).toBeCloseTo(0.6, 9);
        expect(umbral.yields.get('/items/gobo_hood')).toBeCloseTo(0.3, 9);
        expect(umbral.yields.get('/items/umbral_leather')).toBeCloseTo(54, 9);
        expect(umbral.yields.get('/items/gobo_leather')).toBeCloseTo(0.3 * 0.8 * 30, 9);
        // A bought source: its own-use cost is its buy price
        expect(umbral.cost).toBe(400_000);

        const sword = routes.sources.find((s) => s.sourceHrid === '/items/cheese_sword' && s.route === 'shop');
        expect(sword.cost).toBe(50);
        expect(sword.yields.get('/items/cheese')).toBe(18);

        expect(routes.craft).toEqual([
            { route: 'craft', itemHrid: '/items/cheese', unitCost: 4, unitSeconds: 10, batch: 1 },
        ]);
        const kinds = new Set([...routes.craft, ...routes.sources].map((r) => r.route));
        expect([...kinds].sort()).toEqual(['craft', 'decompose', 'gather', 'shop', 'transmute']);
        // No decompose or shop route ever yields the source it starts from
        for (const source of routes.sources.filter((r) => ['decompose', 'shop'].includes(r.route))) {
            expect(source.yields.has(source.sourceHrid)).toBe(false);
        }
    });
});

describe("the maintainer's Amber row: Decompose 1472× Earrings Of Essence Find, −430.3M", () => {
    const earringsRoute = (routes) =>
        routes.sources.find((s) => s.sourceHrid === '/items/earrings_of_essence_find' && s.route === 'decompose');
    // Amber at 3,000 toward 10,000: 4.8 per earring is 1,459 earrings
    const counts = new Map([
        ['/items/amber', 3000],
        ['/items/star_fragment', 1_000_000],
    ]);

    test('the bought earring is charged at the ask, with its coins and catalyst', async () => {
        const route = earringsRoute(await buildCollectionRoutes());
        expect(route.cost).toBeCloseTo(6_300_000 + 200 + 7920 * 0.8, 6);
        // 600 × 0.8 fragments, 6 × 0.8 Amber
        expect(route.yields.get('/items/star_fragment')).toBeCloseTo(480, 9);
        expect(route.yields.get('/items/amber')).toBeCloseTo(4.8, 9);
    });

    test('a patient-buy pricing mode does not price a buy of hundreds at the bid', async () => {
        game.pricingMode = 'optimistic';
        const route = earringsRoute(await buildCollectionRoutes());
        expect(route.cost).toBeCloseTo(6_300_000 + 200 + 7920 * 0.8, 6);
    });

    test('Star Fragments are sold at the bid after tax: the earring no longer earns 293k', async () => {
        const route = earringsRoute(await buildCollectionRoutes());
        const option = evaluateOption('/items/amber', counts, route);
        expect(option.units).toBe(1459);
        expect(option.gold).toBeGreaterThan(-10e6);
        // At the untaxed ask the same route earned 480 × 13,750 − 6,306,536 = 293,464 an earring
        // (−428M over 1,459; the panel's 1,472 at its own count: −430.3M). At 13,152 a fragment it
        // is 6,424 an earring, plus the essence
        const essence = 0.1 * 100 * 0.96;
        expect(option.gold / option.units).toBeCloseTo(6_306_536 - 480 * 13_152 - essence, 3);
        expect(route.kept.get('/items/star_fragment').unit).toBeCloseTo(13_700 * 0.96, 6);
    });

    test('and only as many as the market takes in a week: the route costs ~8.7B', async () => {
        VOLUME.perDay['/items/star_fragment'] = 22_885;
        const route = earringsRoute(await buildCollectionRoutes());
        const option = evaluateOption('/items/amber', counts, route, { sellable: weeklySellable });
        const week = 0.25 * 22_885 * 7;
        expect(option.sold.get('/items/star_fragment')).toBeCloseTo(week, 3);
        expect(option.gold).toBeGreaterThan(8e9);
    });

    test('an Iron Cow sells to the vendor: no market bound', () => {
        VOLUME.perDay['/items/star_fragment'] = 22_885;
        expect(weeklySellable('/items/star_fragment')).toBeCloseTo(0.25 * 22_885 * 7, 6);
        game.ironCow = true;
        expect(weeklySellable('/items/star_fragment')).toBe(Infinity);
        // Nothing measured: unbounded
        game.ironCow = false;
        expect(weeklySellable('/items/amber')).toBe(Infinity);
    });

    test('an output nobody bids on realizes nothing, unless it is a crate to open', () => {
        expect(realizedSalePrice('/items/star_fragment')).toBeCloseTo(13_700 * 0.96, 6);
        game.estimated = new Set(['/items/star_fragment']);
        expect(realizedSalePrice('/items/star_fragment')).toBe(0);
        expect(realizedSalePrice('/items/star_fragment', () => true)).toBeNull();
        expect(realizedSalePrice('/items/no_such_item')).toBeNull();
    });
});

describe('transmute routes', () => {
    const amberRoute = (routes) =>
        routes.sources.find((s) => s.route === 'transmute' && s.sourceHrid === '/items/amber');

    test('buy Amber at the ask and transmute it, and every Amber that comes back, until none is left', async () => {
        const route = amberRoute(await buildCollectionRoutes());
        // 0.16 × 0.5 = 0.08 Amber back per attempt: 1 / 0.92 attempts per Amber bought
        const attempts = 1 / 0.92;
        expect(route.yields.get('/items/garnet')).toBeCloseTo(0.12 * 0.5 * attempts, 12);
        expect(route.yields.get('/items/star_fragment')).toBeCloseTo(0.1 * 0.5 * attempts, 12);
        // The Amber that comes back is collected as it arrives, and transmuted again, never sold
        expect(route.yields.get('/items/amber')).toBeCloseTo(0.08 * attempts, 12);
        expect(route.kept.has('/items/amber')).toBe(false);
        // Bought at the ask; each attempt pays 125 coins and 30 of catalyst
        expect(route.cost).toBeCloseTo(20_240 + attempts * (125 + 30), 9);
        expect(route.seconds).toBeCloseTo(attempts * 36, 9);
        expect(route.batch).toBe(1);
        // The others are sold at the bid after tax; the essence is credited and sold, never a target
        expect(route.kept.get('/items/garnet').unit).toBeCloseTo(21_000 * 0.96, 9);
        expect(route.kept.get('/items/star_fragment').unit).toBeCloseTo(13_700 * 0.96, 9);
        expect(route.bonus.has('/items/alchemy_essence')).toBe(true);
        expect(route.yields.get('/items/alchemy_essence')).toBeCloseTo(0.1 * attempts, 12);
    });

    test('a first Garnet: 16 Amber, at the arithmetic above', async () => {
        const route = amberRoute(await buildCollectionRoutes());
        const option = evaluateOption('/items/garnet', new Map([['/items/star_fragment', 1e6]]), route);
        const attempts = 1 / 0.92;
        // 0.0652 Garnet per Amber: 16 Amber for the first
        expect(option.units).toBe(Math.ceil(1 / (0.06 * attempts)));
        // Star Fragments and the essence are sold; the Amber that comes back is transmuted again
        const sold = option.units * attempts * (0.1 * 0.5 * 13_700 * 0.96 + 0.1 * 100 * 0.96);
        expect(option.gold).toBeCloseTo(option.units * (20_240 + attempts * 155) - sold, 6);
        expect(option.sold.has('/items/garnet')).toBe(false);
    });

    test('ranks with the other routes and says what it transmutes', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const garnet = [...document.querySelectorAll('.toolasha-collopt-row')].find(
            (row) => row.dataset.item === '/items/garnet'
        );
        expect(garnet.dataset.route).toBe('transmute');
        expect(garnet.textContent).toContain('Transmute: 16× Amber');
    });

    test('a crate nobody bids on is sold as its contents, each bounded by its own market', async () => {
        game.crateDrop = true;
        // No live bid on the crate, and a crate market that is measured dead
        game.estimated = new Set(['/items/small_artisans_crate']);
        VOLUME.perDay['/items/small_artisans_crate'] = 0;
        const route = amberRoute(await buildCollectionRoutes());
        const attempts = 1 / 0.92;
        // One crate an hour over 100 attempts: 3 fragments and half a Garnet each
        const crates = (1 / 100) * attempts;
        expect(route.kept.has('/items/small_artisans_crate')).toBe(false);
        expect(route.kept.get('/items/star_fragment').perSource).toBeCloseTo(0.1 * 0.5 * attempts + crates * 3, 12);
        expect(route.kept.get('/items/garnet').perSource).toBeCloseTo(0.12 * 0.5 * attempts + crates * 0.5, 12);
        expect(route.kept.get('/items/star_fragment').unit).toBeCloseTo(13_700 * 0.96, 9);
        // The crate is still collected as it drops
        expect(route.yields.get('/items/small_artisans_crate')).toBeCloseTo(crates, 12);
        // The dead crate market no longer erases what its contents sell for
        const option = evaluateOption('/items/garnet', new Map([['/items/star_fragment', 1e6]]), route, {
            sellable: weeklySellable,
        });
        expect(option.sold.has('/items/small_artisans_crate')).toBe(false);
        expect(option.sold.get('/items/star_fragment')).toBeCloseTo(
            option.units * route.kept.get('/items/star_fragment').perSource,
            9
        );
    });

    test('every setup the calculator weighs is a route, and the ranking picks by gold per point', async () => {
        // The calculator's pick is the type-specific catalyst. Prime raises the success rate to 75%
        // for 9,000 of catalyst an hour: more Garnet per Amber bought, so fewer Amber for a point
        game.transmuteSetups = [
            {},
            { successRate: 0.75, catalystCostPerHour: 9000, winningCatalystHrid: '/items/prime_catalyst' },
            // No tea to drink: the same as the first, offered once
            { winningTeaUsed: false },
        ];
        const routes = (await buildCollectionRoutes()).sources.filter(
            (s) => s.route === 'transmute' && s.sourceHrid === '/items/amber'
        );
        expect(routes.map((r) => r.setup.catalystHrid)).toEqual([
            '/items/catalyst_of_transmutation',
            '/items/prime_catalyst',
        ]);
        const counts = new Map([['/items/star_fragment', 1e6]]);
        const [typeSpecific, prime] = routes.map((r) => evaluateOption('/items/garnet', counts, r));
        expect(prime.goldPerPoint).toBeLessThan(typeSpecific.goldPerPoint);
        const index = new Map([['/items/garnet', routes]]);
        const [best] = bestOptions(counts, index);
        expect(best.setup.catalystHrid).toBe('/items/prime_catalyst');
        // Fastest compares the same routes on time per point
        const [fastest] = bestOptions(counts, index, { sort: 'fastest' });
        expect(fastest.secondsPerPoint).toBeLessThanOrEqual(typeSpecific.secondsPerPoint);
    });

    test('the row says which catalyst and teas the transmute uses', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const garnet = [...document.querySelectorAll('.toolasha-collopt-row')].find(
            (row) => row.dataset.item === '/items/garnet'
        );
        expect(garnet.textContent).toContain('Transmute: 16× Amber (catalyst_of_transmutation, teas)');
    });

    test('an output with no price at all leaves the route out', async () => {
        const saved = BUY['/items/garnet'];
        delete BUY['/items/garnet'];
        try {
            const route = amberRoute(await buildCollectionRoutes());
            expect(route.partlyUnpriced).toBe(true);
        } finally {
            BUY['/items/garnet'] = saved;
        }
    });

    test('nothing to transmute without a live ask, on an Iron Cow, or when the calculator cannot run it', async () => {
        game.estimated = new Set(['/items/amber']);
        expect(amberRoute(await buildCollectionRoutes())).toBeUndefined();
        game.estimated = new Set();
        game.ironCow = true;
        expect(amberRoute(await buildCollectionRoutes())).toBeUndefined();
        game.ironCow = false;
        game.noTransmute = true;
        expect(amberRoute(await buildCollectionRoutes())).toBeUndefined();
    });
});

describe('gathering routes', () => {
    const cowRoute = (routes) => routes.sources.find((s) => s.route === 'gather');

    test('one action: its drops net of Processing, its bonus drops, and its tea', async () => {
        const route = cowRoute(await buildCollectionRoutes());
        expect(route.actionHrid).toBe('/actions/milking/cow');
        // (540 − 54) / 360 milk and 54 / 360 cheese an action; essence 3.6 / 360 × 1.5
        expect(route.yields.get('/items/milk')).toBeCloseTo(1.35, 12);
        expect(route.yields.get('/items/cheese')).toBeCloseTo(0.15, 12);
        expect(route.yields.get('/items/milking_essence')).toBeCloseTo(0.015, 12);
        expect(route.bonus.has('/items/milking_essence')).toBe(true);
        // Nothing goes in but the tea: 720 an hour is 2 an action; an action is 10 s
        expect(route.cost).toBeCloseTo(2, 12);
        expect(route.seconds).toBeCloseTo(10, 12);
        expect(route.batch).toBe(1);
        // Everything is sold at the bid after tax, unless it is the target
        expect(route.kept.get('/items/milk').unit).toBeCloseTo(90 * 0.96, 12);
    });

    test('ten Milk: seven actions, the cheese and essence sold', async () => {
        const route = cowRoute(await buildCollectionRoutes());
        const option = evaluateOption('/items/milk', new Map([['/items/milk', 1]]), route);
        // 9 more at 1.35 an action
        expect(option.units).toBe(7);
        expect(option.seconds).toBeCloseTo(70, 9);
        const sold = 7 * (0.15 * 10 * 0.96 + 0.015 * 50 * 0.96);
        expect(option.gold).toBeCloseTo(7 * 2 - sold, 9);
        expect(option.sold.has('/items/milk')).toBe(false);
    });

    test('ranks with the other routes and says where', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const milk = [...document.querySelectorAll('.toolasha-collopt-row')].find(
            (row) => row.dataset.item === '/items/milk'
        );
        expect(milk.dataset.route).toBe('gather');
        expect(milk.textContent).toContain('Gather: 1 action at Cow');
    });

    test('a zone above the character’s level is no route; an unpriced tea leaves it out', async () => {
        ACTIONS['/actions/milking/cow'].levelRequirement.level = 20;
        try {
            expect(cowRoute(await buildCollectionRoutes())).toBeUndefined();
        } finally {
            ACTIONS['/actions/milking/cow'].levelRequirement.level = 1;
        }
        game.unpricedTea = true;
        expect(cowRoute(await buildCollectionRoutes()).partlyUnpriced).toBe(true);
    });
});

describe('whole actions for sources', () => {
    test('a decompose action eats its bulk of sources; a shop bundle is bought whole', async () => {
        game.craftable = new Set(['/items/cheese', '/items/cheese_sword']);
        game.shopUnits = 3;
        const routes = await buildCollectionRoutes();
        const sword = (route) =>
            routes.sources.find((s) => s.sourceHrid === '/items/cheese_sword' && s.route === route);
        // Bulk 2 for decompose and craft + decompose; a 3-unit bundle with bulk 2 is a run of 6
        expect(sword('decompose').batch).toBe(2);
        expect(sword('craftDecompose').batch).toBe(2);
        expect(sword('shop').batch).toBe(6);
        // Priced per unit received
        expect(sword('shop').cost).toBeCloseTo(50 / 3, 9);
        // A source with no bulk is a batch of one
        expect(routes.sources.find((s) => s.sourceHrid === '/items/umbral_hood' && s.route === 'decompose').batch).toBe(
            1
        );
    });
});

describe('Gourmet and a craft batch', () => {
    test('the batch is the expected output per action, base count times one plus the Gourmet chance', async () => {
        game.actionDetails = { outputItems: [{ itemHrid: '/items/cheese', count: 2 }] };
        game.profitExtra = { gourmetBonus: 0.25 };
        const routes = await buildCollectionRoutes();
        expect(routes.craft[0].batch).toBeCloseTo(2.5, 9);
        // Without Gourmet it is the recipe's own count
        game.profitExtra = {};
        expect((await buildCollectionRoutes()).craft[0].batch).toBe(2);
    });
});

describe('a recipe the character cannot start', () => {
    test('above their level gives no craft or craft + decompose route', async () => {
        game.craftable = new Set(['/items/cheese', '/items/cheese_sword']);
        game.profitExtra = { baseRequirement: 50, skillLevel: 40, teaSkillLevelBonus: 0, actionLevelBonus: 0 };
        const routes = await buildCollectionRoutes();
        expect(routes.craft).toEqual([]);
        expect(routes.sources.filter((s) => s.route === 'craftDecompose')).toEqual([]);
    });

    test('a locked best-margin recipe does not hide another recipe the character can start', async () => {
        game.profitExtra = { baseRequirement: 50, skillLevel: 40, teaSkillLevelBonus: 0, actionLevelBonus: 0 };
        game.altProfit = { baseRequirement: 30, skillLevel: 40, teaSkillLevelBonus: 0, actionLevelBonus: 0 };
        const routes = await buildCollectionRoutes();
        expect(routes.craft).toHaveLength(1);
        expect(routes.craft[0].itemHrid).toBe('/items/cheese');
    });

    test('an Action Level tea that raises the requirement past the level blocks it too', async () => {
        game.profitExtra = { baseRequirement: 40, skillLevel: 42, teaSkillLevelBonus: 0, actionLevelBonus: 5 };
        expect((await buildCollectionRoutes()).craft).toEqual([]);
        game.profitExtra = { baseRequirement: 40, skillLevel: 45, teaSkillLevelBonus: 0, actionLevelBonus: 5 };
        expect((await buildCollectionRoutes()).craft).toHaveLength(1);
    });
});

describe('how a source can be got', () => {
    test('a value-map estimate is not a price anyone can buy at', async () => {
        game.estimated = new Set(['/items/umbral_hood']);
        const routes = await buildCollectionRoutes();
        expect(
            routes.sources.find((s) => s.sourceHrid === '/items/umbral_hood' && s.route === 'decompose')
        ).toBeUndefined();
    });

    test('an Iron Cow buys nothing', async () => {
        game.ironCow = true;
        const routes = await buildCollectionRoutes();
        expect(routes.sources.filter((s) => s.route === 'decompose')).toEqual([]);
    });

    test('a shop offer that also asks for another currency is no shop route', async () => {
        game.mixedShop = true;
        const routes = await buildCollectionRoutes();
        expect(routes.sources.filter((s) => s.route === 'shop')).toEqual([]);
    });
});

describe('a source made at a bench', () => {
    test('is a craft + decompose route that collects itself and pays its making time', async () => {
        game.craftable = new Set(['/items/cheese', '/items/cheese_sword']);
        const routes = await buildCollectionRoutes();
        const crafted = routes.sources.find(
            (s) => s.sourceHrid === '/items/cheese_sword' && s.route === 'craftDecompose'
        );
        expect(crafted.yields.get('/items/cheese_sword')).toBe(1);
        expect(crafted.yields.get('/items/cheese')).toBe(18);
        // Made at 4 a unit and 360 an hour (10 s), then decomposed at 100 an hour (36 s)
        expect(crafted.cost).toBe(4);
        expect(crafted.seconds).toBeCloseTo(46, 6);
        // The bought route is still there, at the buy price, and collects no sword
        const bought = routes.sources.find((s) => s.sourceHrid === '/items/cheese_sword' && s.route === 'decompose');
        expect(bought.cost).toBe(2000);
        expect(bought.yields.has('/items/cheese_sword')).toBe(false);
    });
});

describe('the panel', () => {
    test('setting off: no panel', () => {
        game.setting = false;
        drawCollectionsTab();
        optimizer.initialize();
        expect(observer.handlers).toHaveLength(0);
        expect(panel()).toBeNull();
    });

    test('waits for collections_updated before it appears', async () => {
        game.collections = null;
        drawCollectionsTab();
        optimizer.initialize();
        expect(panel()).toBeNull();

        game.collections = COLLECTIONS;
        for (const handler of bus.handlers.collections_updated || []) handler({ collections: COLLECTIONS });
        expect(panel()).not.toBeNull();
    });

    test('draws the ranking with each row’s route, and never a Buy route', async () => {
        const tab = drawCollectionsTab();
        optimizer.initialize();
        expect(panel()).not.toBeNull();
        // Sits above the tiles
        expect(tab.children[1]).toBe(panel());
        expect(panel().textContent).toContain('7 points');
        expect(panel().textContent).toContain('next achievement at 100');

        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const rows = [...document.querySelectorAll('.toolasha-collopt-row')];
        const routes = rows.map((row) => row.dataset.route);
        for (const route of routes) expect(['craft', 'decompose', 'shop', 'transmute', 'gather']).toContain(route);
        expect(panel().textContent).not.toMatch(/\bBuy\b:/);
        // The lower hoods are on offer, collected by decomposing an Umbral Hood
        const items = rows.map((row) => row.dataset.item);
        expect(items).toContain('/items/gobo_hood');
        expect(items).toContain('/items/beast_hood');
        // An uncollected item's first unit is worth its first point
        const gobo = rows.find((row) => row.dataset.item === '/items/gobo_hood');
        expect(gobo.textContent).toContain('0 → 1');
    });

    test('the target box plans +N points with a total', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelector('.toolasha-collopt-plan')).not.toBeNull());
        document.querySelector('.toolasha-collopt-target').value = '5';
        document.querySelector('.toolasha-collopt-plan').click();
        const result = document.querySelector('.toolasha-collopt-plan-result');
        expect(result.textContent).toMatch(/^\+\d+ points: /);
        expect(result.querySelectorAll('li').length).toBeGreaterThan(0);
    });

    test('collapses on a header click', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelector('.toolasha-collopt-table')).not.toBeNull());
        document.querySelector('.toolasha-collopt-header').click();
        expect(document.querySelector('.toolasha-collopt-table')).toBeNull();
        expect(panel()).not.toBeNull();
    });

    test('the bonus drop is credited but never a row of its own', async () => {
        const routes = await buildCollectionRoutes();
        const umbral = routes.sources.find((s) => s.sourceHrid === '/items/umbral_hood');
        expect(umbral.yields.get('/items/alchemy_essence')).toBeGreaterThan(0);
        expect(umbral.bonus.has('/items/alchemy_essence')).toBe(true);

        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const items = [...document.querySelectorAll('.toolasha-collopt-row')].map((row) => row.dataset.item);
        expect(items).not.toContain('/items/alchemy_essence');
    });

    test('max time per step: 8 h by default, drops slower rows, and is kept per character', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        await vi.waitFor(() => expect(document.querySelector('.toolasha-collopt-maxstep')).not.toBeNull());
        expect(document.querySelector('.toolasha-collopt-maxstep').value).toBe('8');
        const items = () => [...document.querySelectorAll('.toolasha-collopt-row')].map((row) => row.dataset.item);
        // At 100 actions an hour: Gobo Hood's first unit is 2 Beast Hood chains (108 s), Beast Hood's
        // 2 Umbral Hood chains (133 s); Gobo Leather's first is one Gobo Hood decompose (36 s)
        expect(items()).toContain('/items/gobo_hood');
        expect(items()).toContain('/items/beast_hood');

        const input = document.querySelector('.toolasha-collopt-maxstep');
        input.value = '0.01';
        input.dispatchEvent(new Event('change'));
        expect(items()).not.toContain('/items/gobo_hood');
        expect(items()).not.toContain('/items/beast_hood');
        expect(items()).toContain('/items/gobo_leather');
        await vi.waitFor(() => expect(scoped.values.get('char-1:collectionOptimizerMaxStepHours')).toBe(0.01));

        // The next opening reads it back for this character, and not for another
        optimizer.disable();
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        // The route build yields by time, so the panel can land a task later
        await vi.waitFor(() => expect(document.querySelector('.toolasha-collopt-maxstep')).not.toBeNull());
        expect(document.querySelector('.toolasha-collopt-maxstep').value).toBe('0.01');
        optimizer.disable();
        game.characterId = 'char-2';
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        expect(optimizer.maxStepHours).toBe(8);
    });

    test("a switch during the read never applies one character's choice to another", async () => {
        scoped.values.set('char-1:collectionOptimizerMaxStepHours', 2);
        let release;
        scoped.gate = new Promise((resolve) => {
            release = resolve;
        });
        drawCollectionsTab();
        optimizer.initialize();
        game.characterId = 'char-2';
        release();
        await optimizer.prefsLoaded;
        expect(optimizer.maxStepHours).toBe(8);
    });

    test('a panel opened while the routes are still pricing is finished by that build', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        // The tab is left and reopened before the build lands: the game draws a new panel
        drawCollectionsTab();
        for (const handler of bus.handlers.collections_updated || []) handler({ collections: COLLECTIONS });
        expect(panel().textContent).toContain('Pricing routes');
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
    });

    test('a character switched mid-build still gets its panel priced', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        game.characterId = 'char-2';
        for (const handler of bus.handlers.collections_updated || []) handler({ collections: COLLECTIONS });
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        expect(optimizer.routesFor).toBe('char-2');
    });

    test('money is net gold: + earns, − costs, in the columns that say so', async () => {
        expect(formatNet(-1500)).toBe('+1.5K');
        expect(formatNet(2_000_000)).toBe('\u22122.0M');
        expect(formatNet(0)).toBe('0');

        drawCollectionsTab();
        optimizer.initialize();
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const heads = [...document.querySelectorAll('.toolasha-collopt-table th')].map((th) => th.textContent);
        expect(heads).toEqual(['Item', 'Count → next', 'Points', 'Route', 'Net gold', 'Time', 'Net/pt']);
        // Each row's net gold carries its sign, and both kinds of step are on offer here
        const nets = [...document.querySelectorAll('.toolasha-collopt-row')].map((row) => row.children[4].textContent);
        for (const text of nets) expect(text).toMatch(/^[+\u2212]/);
        expect(nets.some((text) => text.startsWith('+'))).toBe(true);
        expect(nets.some((text) => text.startsWith('\u2212'))).toBe(true);
    });

    test('the sort: most profitable by default, fastest on request, kept per character', async () => {
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        await vi.waitFor(() => expect(document.querySelectorAll('.toolasha-collopt-row').length).toBeGreaterThan(0));
        const select = () => document.querySelector('.toolasha-collopt-sort');
        expect(select().value).toBe('profit');
        expect([...select().options].map((o) => o.value)).toEqual(['profit', 'fastest']);
        const order = () => [...document.querySelectorAll('.toolasha-collopt-row')].map((row) => row.dataset.item);
        const byProfit = order();

        select().value = 'fastest';
        select().dispatchEvent(new Event('change'));
        expect(optimizer.sort).toBe('fastest');
        expect(select().value).toBe('fastest');
        // The same items, now in time-per-point order
        expect([...order()].sort()).toEqual([...byProfit].sort());
        const fastest = bestOptions(collectionCounts(COLLECTIONS), optimizer.index, {
            maxSeconds: optimizer.maxSeconds,
            sort: 'fastest',
        });
        expect(order()).toEqual(fastest.slice(0, 40).map((o) => o.itemHrid));
        expect(order()).not.toEqual(byProfit);
        await vi.waitFor(() => expect(scoped.values.get('char-1:collectionOptimizerSort')).toBe('fastest'));
        // Choosing an order does not collapse the panel
        expect(document.querySelector('.toolasha-collopt-table')).not.toBeNull();

        optimizer.disable();
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        expect(optimizer.sort).toBe('fastest');
        await vi.waitFor(() => expect(document.querySelector('.toolasha-collopt-sort').value).toBe('fastest'));

        optimizer.disable();
        game.characterId = 'char-2';
        drawCollectionsTab();
        optimizer.initialize();
        await optimizer.prefsLoaded;
        expect(optimizer.sort).toBe('profit');
    });

    test('disable removes the panel and stops listening', () => {
        drawCollectionsTab();
        optimizer.initialize();
        expect(panel()).not.toBeNull();
        optimizer.disable();
        expect(panel()).toBeNull();
        expect(bus.handlers.collections_updated).toHaveLength(0);
        expect(observer.handlers).toHaveLength(0);
    });
});
