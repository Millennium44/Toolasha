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
        getActionDetails: () => game.actionDetails ?? null,
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
                      // The alchemy-wide bonus drop every action rolls
                      dropRevenues: [
                          { itemHrid: '/items/alchemy_essence', isEssence: true, dropsPerHour: 10, price: 0 },
                      ],
                  },
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => BUY[hrid] ?? null,
    getItemPriceInfo: (hrid) =>
        game.estimated.has(hrid)
            ? { price: BUY[hrid] ?? null, source: 'value', estimated: true }
            : { price: BUY[hrid] ?? null, source: 'book', estimated: false },
    getPricingMode: () => 'ask',
}));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinOnlyCost: (hrid) => ({
        coins: hrid === '/items/cheese_sword' && !game.mixedShop ? 50 : 0,
        units: game.shopUnits,
    }),
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => game.ironCow }));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price }));
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
        expect([...kinds].sort()).toEqual(['craft', 'decompose', 'shop']);
        // No route ever yields the source it starts from
        for (const source of routes.sources) expect(source.yields.has(source.sourceHrid)).toBe(false);
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
