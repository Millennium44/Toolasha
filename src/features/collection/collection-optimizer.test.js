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

const game = vi.hoisted(() => ({ setting: true, collections: null, characterId: 'char-1' }));
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
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] },
    },
    '/items/cheese': { name: 'Cheese' },
    '/items/coin': { name: 'Coin' },
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
}));

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
            achievementDetailMap: {
                '/achievements/collection_points_100': { hrid: '/achievements/collection_points_100', target: 100 },
            },
        }),
        getItemDetails: (hrid) => ITEMS[hrid] || null,
        getActionDetails: () => null,
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
        findProductionAction: (hrid) => (hrid === '/items/cheese' ? { actionHrid: '/actions/cheesesmithing/x' } : null),
        calculateProfit: async (hrid) => ({ itemHrid: hrid, actionHrid: '/actions/x', totalItemsPerHour: 360 }),
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
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateDecomposeProfit: (hrid) =>
            RATES[hrid] === undefined
                ? null
                : {
                      itemHrid: hrid,
                      actionsPerHour: 100,
                      successRate: RATES[hrid],
                      requirementCosts: [{ itemHrid: hrid, count: 1, price: BUY[hrid] }],
                      catalystCostPerHour: 0,
                      totalTeaCostPerHour: 0,
                      dropRevenues: [],
                  },
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => BUY[hrid] ?? null,
    getItemPriceInfo: (hrid) => ({ price: BUY[hrid] ?? null }),
    getPricingMode: () => 'ask',
}));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinCost: (hrid) => (hrid === '/items/cheese_sword' ? 50 : 0),
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price }));

const { default: optimizer, buildCollectionRoutes } = await import('./collection-optimizer.js');

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
    bus.handlers = {};
    observer.handlers = [];
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

        expect(routes.craft).toEqual([{ route: 'craft', itemHrid: '/items/cheese', unitCost: 4, unitSeconds: 10 }]);
        const kinds = new Set([...routes.craft, ...routes.sources].map((r) => r.route));
        expect([...kinds].sort()).toEqual(['craft', 'decompose', 'shop']);
        // No route ever yields the source it starts from
        for (const source of routes.sources) expect(source.yields.has(source.sourceHrid)).toBe(false);
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
        for (const route of routes) expect(['craft', 'decompose', 'shop']).toContain(route);
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
