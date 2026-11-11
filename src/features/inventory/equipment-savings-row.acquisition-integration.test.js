/**
 * @vitest-environment happy-dom
 *
 * Real Watch, advisor, recursive planner, eligibility and shopping calculations.
 * Recipes and prices are synthetic fixtures in the game's documented shapes.
 * Deterministic market/character and enhancement doubles are not live-game proof.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    inventory: [],
    equipment: new Map(),
    details: {},
    prices: {},
    actions: {},
    shops: {},
    artisan: 0,
    skills: [],
    drinks: [],
    // What `networthHistory.recentSeries` hands back — empty by default, so
    // tests that are not about the fallback see the same "nothing measured"
    // behaviour they did before it existed
    networthSeries: () => [],
    // What the tile's `version()` subscribes to, so a test can fire a price
    // update or a game event the way the real feeds would
    priceListeners: [],
    gameListeners: {},
    // Everything the module has written back, so a test about a setting
    // surviving a reload can look at what would actually be reloaded rather
    // than at the module's own memory of it
    writes: [],
    // What is already in storage for this character, for a test about what a
    // record written by an older build turns into when it is read back. Null —
    // nothing stored — for every other test, which is what they assume.
    stored: null,
    // The character's abilities, which is where an ability goal's progress
    // comes from
    abilities: [],
    abilityDetails: {},
    // Books are priced through marketAPI rather than through the item price
    // helper, as the sim's own ability costing is
    bookPrices: {},
    levelXp: [],
    // The character's house rooms, which is where a room goal's progress comes
    // from, and the game's own build costs, which is where its price does
    houseRooms: new Map(),
    houseDetails: {},
    // Every marketplace the panel's links opened, so a test can prove a row
    // about a +12 opens the +12 order book rather than the base item's
    navigations: [],
    // The override store's own counter, which the tile's version() reads
    customVersion: 0,
    // The profit pricing mode the mocked config answers with
    profitMode: 'conservative',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getSkills: () => game.skills,
        getActionDrinkSlots: () => game.drinks,
        getEquipment: () => game.equipment,
        getItemDetails: (hrid) => game.details[hrid],
        getActionDetails: (hrid) => game.actions[hrid],
        getLearnedAbilities: () => game.abilities,
        getHouseRooms: () => game.houseRooms,
        // The picker builds its list from the whole item map, which is the same
        // fixture the per-item lookups read
        getInitClientData: () => ({
            itemDetailMap: game.details,
            actionDetailMap: game.actions,
            abilityDetailMap: game.abilityDetails,
            houseRoomDetailMap: game.houseDetails,
            levelExperienceTable: game.levelXp,
            ...game.shops,
        }),
        // Gear targets are one character's, so the module keys on the character
        // and listens for the switch
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getGuildBuildingLevel: () => 0,
        getBuffStateVersion: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        characterData: { characterAbilities: [] },
        on: (event, handler) => {
            (game.gameListeners[event] ||= []).push(handler);
        },
        off: () => {},
    },
}));
// A real registry, not a stub, so a test can prove cleanup() actually
// unregisters what initialize() registered rather than only that neither call
// throws
const settingChangeCallbacks = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: () => false,
        isFeatureEnabled: () => false,
        onSettingChange: (key, callback) => {
            (settingChangeCallbacks[key] ||= []).push(callback);
        },
        offSettingChange: (key, callback) => {
            if (!settingChangeCallbacks[key]) return;
            settingChangeCallbacks[key] = settingChangeCallbacks[key].filter((cb) => cb !== callback);
        },
        getSettingValue: (key, fallback) =>
            key === 'upgradeAdvisor_compareRoutes'
                ? game.compareRoutes
                : key === 'profitCalc_patientTickBuy' || key === 'profitCalc_patientTickSell'
                  ? game.patientTick?.[key] === true
                  : key === 'profitCalc_pricingMode'
                    ? game.profitMode
                    : key === 'equipmentWatch_routePreference'
                      ? (game.routePreference ?? 'auto')
                      : (fallback ?? 'full'),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        db: {},
        ready: Promise.resolve(true),
        getJSON: async () => null,
        setJSON: async () => {},
        get: async (_k, _s, fallback = null) => fallback,
        tryGet: async () =>
            game.stored ? { found: true, value: structuredClone(game.stored) } : { found: false, value: null },
        set: async (key, value) => {
            game.writes.push({ key, value });
            return true;
        },
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    // Called from a deferred callback, so only a test that waits past it sees
    // the panel complain that the mock is missing it
    clampPanelToViewport: () => {},
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid, enhancementLevel = 0) => game.navigations.push({ itemHrid, enhancementLevel }),
}));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinOnlyCost: () => 0,
    getShopCoinCost: () => 0,
    getItemHridFromName: () => null,
}));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPrice: () => null,
    getCustomPriceVersion: () => game.customVersion,
}));
// Kept rather than discarded, so the tile's own `version()` — which is what
// spares the overlay this module's whole render sixty times a minute — can be
// tested against the same fixtures the arithmetic is
const rowsByKey = vi.hoisted(() => new Map());
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => rowsByKey.set(definition.key, definition),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getDataAge: () => 60_000,
        fetch: async () => {},
        // The book price, which is what an ability level is actually bought with
        getPrice: (hrid) => game.bookPrices[hrid] || null,
        // The tile's `version()` treats a new price feed as a new tile
        on: (handler) => game.priceListeners.push(handler),
    },
}));
vi.mock('../networth/networth-history.js', () => ({
    default: { recentSeries: (hours) => game.networthSeries(hours) },
}));
vi.mock('../../utils/market-data.js', () => ({
    getPricingMode: (_context, side = 'sell') => {
        const mode = game.profitMode;
        if (mode === 'hybrid') return 'ask';
        if (mode === 'patientBuy') return 'bid';
        if (mode === 'optimistic') return side === 'buy' ? 'bid' : 'ask';
        return side === 'buy' ? 'ask' : 'bid';
    },
    // The profit resolver's book read: a one-sided quote fills the other side
    getItemPriceInfo: (hrid) => {
        const quote = game.prices[`${hrid}:0`];
        const price = quote?.ask > 0 ? quote.ask : quote?.bid > 0 ? quote.bid : null;
        return { price, source: price === null ? null : 'book', estimated: false };
    },
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
    // The shared pricing rules fall back to a production cost when a book has
    // neither side, and that walk prices the recipe's inputs through here
    getItemPrice: (hrid, { mode = 'ask' } = {}) => game.prices[`${hrid}:0`]?.[mode] || 0,
}));
// The real one resolves a loadout and parses teas; what this file cares about
// is that the saving reaches the recipe, whatever produced it
vi.mock('../../utils/material-calculator.js', () => ({ calculateArtisanBonus: () => game.artisan }));

// The card resolves its bench through the shared resolver now, rather than reaching for
// `getAutoDetectedParams` itself. This suite is about the card's arithmetic and its rendering,
// not about which bench gets picked — that lives in enhancement-params-parity.test.js — so the
// resolver is routed back to the bench this file already injects through window.Toolasha, and
// still answers undefined when nothing is loaded, the way the bundle bridge did.
vi.mock('../enhancement/enhancement-params-source.js', async (importOriginal) => ({
    ...(await importOriginal()),
    enhancementParamsFor: () => window.Toolasha?.Utils?.enhancementConfig?.getAutoDetectedParams?.(),
}));

// A protection quote that a recipe input nobody prices has made a floor carries `partial`. The pricing
// helper reports it from its own pass; here a test sets it directly on the quote the card receives.
const protectionQuote = vi.hoisted(() => ({ partial: false }));
vi.mock('../../utils/enhancement-input-pricing.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getCheapestProtectionPrice: (...args) => {
            const quote = actual.getCheapestProtectionPrice(...args);
            return protectionQuote.partial ? { ...quote, partial: true } : quote;
        },
    };
});

const { equipmentSavingsPanel, watchTarget, watchedTargets, setRoutePin, setNoSell, resetEquipmentSavings } =
    await import('./equipment-savings-row.js');

beforeEach(() => {
    game.skills = [];
    game.drinks = [];
    game.customVersion = 0;
    game.profitMode = 'conservative';
    game.routePreference = 'auto';
    game.inventory = [
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', count: 60_000_000 },
        // Coins turn up under more than one location; only the inventory one is
        // money you can spend
        { itemHrid: '/items/coin', itemLocationHrid: '/item_locations/market_listing', count: 51_000_000_000_000 },
    ];
    game.actions = {
        // An upgrade: shards plus the spear you already hold
        '/actions/refine': {
            outputItems: [{ itemHrid: '/items/refined_spear', count: 1 }],
            inputItems: [{ itemHrid: '/items/shard', count: 30 }],
            upgradeItemHrid: '/items/plain_spear',
        },
    };
    game.details = {
        '/items/refined_spear': { name: 'Refined Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/plain_spear': { name: 'Plain Spear', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/shard': { name: 'Shard' },
        '/items/cheese_sword': { name: 'Cheese Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/holy_sword': { name: 'Holy Sword', equipmentDetail: { type: '/equipment_types/main_hand' } },
        '/items/rough_boots': { name: 'Rough Boots', equipmentDetail: { type: '/equipment_types/feet' } },
        '/items/cheese': { name: 'Cheese' },
    };
    // Keyed by item LOCATION, which is not the same string as the equipment type
    game.equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_sword', enhancementLevel: 0 }]]);
    game.prices = {
        '/items/holy_sword:0': { ask: 100_000_000, bid: 90_000_000 },
        '/items/cheese_sword:0': { ask: 45_000_000, bid: 40_000_000 },
        '/items/rough_boots:0': { ask: 5_000_000, bid: 4_000_000 },
        '/items/refined_spear:0': { ask: 900_000_000, bid: 800_000_000 },
        '/items/plain_spear:0': { ask: 300_000_000, bid: 250_000_000 },
        '/items/shard:0': { ask: 1_000_000, bid: 900_000 },
    };
    game.shops = {};
    game.artisan = 0;
    game.networthSeries = () => [];
    game.writes = [];
    game.stored = null;
    // One learned ability at Lv40 with the experience of exactly that level, and
    // an experience table where every level is a round million
    game.abilities = [{ abilityHrid: '/abilities/fierce_aura', level: 40, experience: 40_000_000 }];
    game.abilityDetails = {
        '/abilities/fierce_aura': { name: 'Fierce Aura' },
        '/abilities/toxic_pollen': { name: 'Toxic Pollen' },
    };
    game.levelXp = Array.from({ length: 101 }, (_, level) => level * 1_000_000);
    game.bookPrices = { '/items/fierce_aura': { ask: 12_000, bid: 8_000 } };
    // A room part-built, one at the cap the game stops at, and one never started
    game.houseRooms = new Map([
        ['/house_rooms/mystical_study', { houseRoomHrid: '/house_rooms/mystical_study', level: 3 }],
        ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 8 }],
    ]);
    game.houseDetails = {
        // Lv4 is 10M of coins and 10 lumber, Lv5 is 20M and 40 lumber, so
        // 3 → 5 is 80M with lumber asking a million
        '/house_rooms/mystical_study': {
            name: 'Mystical Study',
            upgradeCostsMap: {
                4: [
                    { itemHrid: '/items/coin', count: 10_000_000 },
                    { itemHrid: '/items/lumber', count: 10 },
                ],
                5: [
                    { itemHrid: '/items/coin', count: 20_000_000 },
                    { itemHrid: '/items/lumber', count: 40 },
                ],
            },
        },
        '/house_rooms/dojo': { name: 'Dojo', upgradeCostsMap: { 4: [{ itemHrid: '/items/coin', count: 1 }] } },
        '/house_rooms/gym': {
            name: 'Gym',
            upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 1_000_000 }] },
        },
    };
    game.prices['/items/lumber:0'] = { ask: 1_000_000, bid: 900_000 };
    game.navigations = [];
    resetEquipmentSavings();
});

afterEach(() => {
    equipmentSavingsPanel.hide();
    resetEquipmentSavings();
});

const text = () => equipmentSavingsPanel.panel.textContent;
const FAILED = 'could not be drawn';

// Integration harness: real Watch, advisor, recursive planner, tea parser, eligibility,
// accounting and route selection. Recipe topology/counts and prices are synthetic.
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: game.equipment, drinks: game.drinks }),
    resolveLoadoutContext: () => ({ equipment: game.equipment, drinks: game.drinks }),
}));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: () => [],
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('../combat-sim/labyrinth-level-finder.js', () => ({
    findMaxLabyrinthLevel: vi.fn(),
    defaultThreshold: () => 0.7,
}));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('../combat-sim/direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: (_hrid, from, to) => (from < to ? game.enhanceCost : 0),
    enhancementSweepParams: () => ({ teas: { blessed: false }, blessedTeaBonus: 0 }),
}));
vi.mock('../combat-sim/skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));
const { computeBestCraftingPlan } = await import('../crafting-plan/crafting-plan-calculator.js');
const { explainUpgradeCost, calculateUpgradeCost, explainLabCandidateCost, priceMergedAcquisition } =
    await import('../combat-sim/upgrade-advisor.js');
const { actionStartEligibility } = await import('../../utils/craft-start-eligibility.js');
const M = 1_000_000;
const TARGET = '/items/refined_spear';
const BASE = '/items/plain_spear';
const SHARD = '/items/shard';
const RAW = '/items/raw_shard';
const candidate = () => ({
    type: 'equipment',
    upgradeHrid: TARGET,
    upgradeLevel: 13,
    removedItems: [],
    ...game.candidateOverrides,
});
const data = () => ({ itemDetailMap: game.details, actionDetailMap: game.actions });
const comparison = () => explainUpgradeCost(candidate(), data()).acquisitionComparison;
const watch = () => watchedTargets()[0];
const craft = (value) => value.routes.find((row) => row.id === 'craft');
const plan = (hrid, count = 1, variant = 'current', respect = true) =>
    computeBestCraftingPlan(
        hrid,
        count,
        'conservative',
        new Set(),
        new Map(),
        0,
        undefined,
        false,
        false,
        0,
        false,
        false,
        undefined,
        variant,
        respect
    );
function initializeRoutes() {
    game.compareRoutes = true;
    game.candidateOverrides = {};
    game.equipment = new Map();
    game.inventory = [
        { itemHrid: BASE, enhancementLevel: 12, count: 3, itemLocationHrid: '/item_locations/inventory' },
    ];
    game.skills = [
        { skillHrid: '/skills/cheesesmithing', level: 100 },
        { skillHrid: '/skills/crafting', level: 65 },
    ];
    game.actions = {
        '/actions/refine': {
            hrid: '/actions/refine',
            name: 'Audit refined spear',
            type: '/action_types/cheesesmithing',
            levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 60 },
            retainAllEnhancement: true,
            upgradeItemHrid: BASE,
            inputItems: [{ itemHrid: SHARD, count: 20 }],
            outputItems: [{ itemHrid: TARGET, count: 1 }],
        },
        '/actions/shard': {
            hrid: '/actions/shard',
            name: 'Audit shard',
            type: '/action_types/crafting',
            levelRequirement: { skillHrid: '/skills/crafting', level: 90 },
            inputItems: [{ itemHrid: RAW, count: 2 }],
            outputItems: [{ itemHrid: SHARD, count: 1 }],
        },
    };
    game.details[BASE].isTradable = game.details[TARGET].isTradable = game.details[SHARD].isTradable = true;
    game.details[BASE].itemLevel = 90;
    game.details[BASE].enhancementCosts = [{ itemHrid: SHARD, count: 1 }];
    game.details[RAW] = { name: 'Audit raw shard', isTradable: true };
    game.prices = {
        [BASE + ':0']: { ask: 300 * M, bid: 250 * M },
        [BASE + ':12']: { ask: 120 * M, bid: 104166667 },
        [BASE + ':13']: { ask: 150 * M, bid: 130 * M },
        [TARGET + ':13']: { ask: 180 * M, bid: 170 * M },
        [SHARD + ':0']: { ask: M, bid: M },
        [RAW + ':0']: { ask: 100000, bid: 100000 },
    };
    game.enhanceCost = 80 * M;
    game.bills = [];
    window.Toolasha = {
        Utils: {
            enhancementCalculator: { calculateEnhancement: () => ({ attempts: 80, protectionCount: 0 }) },
            enhancementConfig: { getAutoDetectedParams: () => ({ enhancingLevel: 100, toolBonus: 10 }) },
        },
        Actions: {
            craftingPlanCalculator: { computeBestCraftingPlan },
            missingMaterialsButton: { openMissingMaterials: (...args) => game.bills.push(args) },
        },
    };
    watchTarget(TARGET, 13);
}
function artisan() {
    game.artisan = 0.1;
    game.details['/items/artisan_tea'] = {
        consumableDetail: {
            buffs: [
                { typeHrid: '/buff_types/action_level', flatBoost: 6 },
                { typeHrid: '/buff_types/artisan', flatBoost: 0.1 },
            ],
        },
    };
    for (const skill of ['cheesesmithing', 'crafting'])
        game.details['/items/ultra_' + skill + '_tea'] = {
            name: 'Ultra ' + skill + ' Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/' + skill + '_level', flatBoost: 8 }] },
        };
    game.drinks = [{ itemHrid: '/items/artisan_tea' }];
    game.details['/items/pouch'] = { equipmentDetail: { combatStats: { drinkSlots: 2 } } };
    game.equipment.set('/item_locations/pouch', { itemHrid: '/items/pouch', enhancementLevel: 0 });
}
async function clickBill() {
    equipmentSavingsPanel.show();
    expect(text()).not.toContain(FAILED);
    [...equipmentSavingsPanel.panel.querySelectorAll('button')]
        .find((el) => el.textContent === 'Missing Mats Marketplace')
        .click();
    await vi.waitFor(() => expect(game.bills).toHaveLength(1));
    return game.bills[0];
}
describe('integrated acquisition routes', () => {
    beforeEach(initializeRoutes);
    afterEach(() => delete window.Toolasha);
    test('purchases a blocked intermediate with a real recursive planner, retains owned base and buys cheaper real-cost +13', async () => {
        expect(actionStartEligibility(game.actions['/actions/refine']).status).toBe('available');
        expect(actionStartEligibility(game.actions['/actions/shard']).status).toBe('blocked');
        expect(plan(SHARD, 20)).toMatchObject({ strategy: 'buy', totalCost: 20 * M });
        expect(plan(SHARD, 20, 'current', false)).toMatchObject({ strategy: 'craft', totalCost: 4 * M });
        expect(watch()).toMatchObject({ route: 'craft', cost: 170 * M, realCost: 170 * M, upgradeBaseLevel: 13 });
        expect(comparison()).toMatchObject({ route: 'craft', cash: 170 * M, real: 170 * M });
        expect(craft(comparison())).toMatchObject({
            upgradeBaseLevel: 13,
            consumed: [],
            eligibility: { status: 'available' },
            materialBill: [
                { itemHrid: SHARD, enhancementLevel: 0, count: 20 },
                { itemHrid: BASE, enhancementLevel: 13, count: 1 },
            ],
        });
        expect(await clickBill()).toEqual([
            '/actions/refine',
            1,
            {
                upgradeItemLevel: 13,
                upgradeBaseAcquisition: { kind: 'buy', itemHrid: BASE, startLevel: 13, targetLevel: 13 },
            },
        ]);
    });
    test('owned alternative wins when its sale is low; cash differs from real and inventory stays intact', () => {
        game.prices[BASE + ':12'].bid = 10 * M;
        expect(watch()).toMatchObject({ route: 'craft', cost: 100 * M, realCost: 109.6 * M, upgradeBaseLevel: 0 });
        expect(comparison()).toMatchObject({ route: 'craft', cash: 100 * M, real: 109.6 * M });
        expect(craft(comparison()).consumed).toHaveLength(1);
        expect(game.inventory[0].count).toBe(3);
    });
    test('unknown owned sale is not free, but known cash survives an explicit Watch pin', () => {
        delete game.prices[BASE + ':12'];
        delete game.prices[BASE + ':13'];
        delete game.prices[BASE + ':0'];
        expect(comparison()).toMatchObject({ route: 'buy', cash: 180 * M });
        expect(craft(comparison())).toMatchObject({ cash: 100 * M, real: null });
        setRoutePin(TARGET, 13, 'craft');
        expect(watch()).toMatchObject({ route: 'craft', cost: 100 * M, realCost: null, pin: 'craft' });
    });
    test('blocked root never wins Auto/Prefer; pinned Watch keeps hypothetical cash', () => {
        game.skills[0].level = 65;
        artisan();
        expect(comparison().route).toBe('buy');
        expect(watch().route).toBe('buy');
        game.routePreference = 'craft';
        expect(comparison().route).toBe('buy');
        expect(watch().route).toBe('buy');
        setRoutePin(TARGET, 13, 'craft');
        expect(watch()).toMatchObject({ route: 'craft', cost: 168 * M, realCost: 168 * M });
        expect(craft(watch()).eligibility.status).toBe('blocked');
    });
    test('Ultra and no-Artisan suggestions retain all-tier arithmetic and never change selected setup', () => {
        game.skills[0].level = 65;
        game.skills[1].level = 95;
        artisan();
        const before = structuredClone(game.drinks);
        const alternatives = craft(watch()).alternatives;
        expect(alternatives).toContainEqual(
            expect.objectContaining({
                label: 'Requires Ultra cheesesmithing Tea + Ultra crafting Tea',
                materialsCost: 153.24 * M,
                realCost: 153.24 * M,
            })
        );
        expect(alternatives).toContainEqual(
            expect.objectContaining({ label: 'Without Artisan', materialsCost: 154 * M, realCost: 154 * M })
        );
        expect(game.drinks).toEqual(before);
        expect(watch().route).toBe('buy');
    });
    test('unknown skill remains distinct from blocked and eligible for Auto', () => {
        game.skills = [];
        expect(watch().route).toBe('craft');
        expect(craft(watch()).eligibility.status).toBe('unknown');
        expect(comparison().route).toBe('craft');
        expect(craft(comparison()).eligibility.status).toBe('unknown');
    });
    test('missing quote for blocked intermediate retains a blocked diagnostic on both surfaces', () => {
        delete game.prices[SHARD + ':0'];
        expect(craft(watch()).eligibility.status).toBe('blocked');
        expect(craft(comparison()).eligibility.status).toBe('blocked');
        expect(craft(comparison()).eligibility.message).toContain('Audit shard');
        expect(craft(comparison()).cash).toBeNull();
        game.prices[SHARD + ':0'] = { ask: M, bid: M };
        expect(craft(comparison())).toMatchObject({ cash: 170 * M, eligibility: { status: 'available' } });
    });
    test('an unrelated unpriced raw leaf does not revive a blocked recipe for a buyable intermediate', () => {
        const composite = '/items/composite';
        const missing = '/items/unpriced_raw';
        game.details[composite] = { name: 'Composite', isTradable: true };
        game.details[missing] = { name: 'Unpriced raw', isTradable: true };
        game.actions['/actions/composite'] = {
            hrid: '/actions/composite',
            name: 'Composite',
            type: '/action_types/cheesesmithing',
            levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 60 },
            inputItems: [
                { itemHrid: SHARD, count: 1 },
                { itemHrid: missing, count: 1 },
            ],
            outputItems: [{ itemHrid: composite, count: 1 }],
        };
        game.actions['/actions/refine'].inputItems = [{ itemHrid: composite, count: 1 }];
        expect(plan(composite).children.find((child) => child.itemHrid === SHARD)).toMatchObject({
            strategy: 'buy',
            buyPrice: M,
        });
        expect(craft(comparison())).toMatchObject({ cash: null, eligibility: { status: 'available' } });
    });
    test('a raw material without a quote has no invented skill block', () => {
        delete game.actions['/actions/shard'];
        delete game.prices[SHARD + ':0'];
        expect(craft(comparison())).toMatchObject({ cash: null, eligibility: { status: 'available' } });
    });
});

describe('route-aware shopping consumer', () => {
    beforeEach(initializeRoutes);
    afterEach(() => delete window.Toolasha);
    test('owned +12 enhancement route does not buy a second +0 base', async () => {
        game.prices[BASE + ':12'].bid = 10 * M;
        expect(watch()).toMatchObject({ route: 'craft', cost: 100 * M, realCost: 109.6 * M, upgradeBaseLevel: 0 });
        const [action, count, options] = await clickBill();
        const actual = await vi.importActual('../../utils/material-calculator.js');
        const requirements = actual.calculateMaterialRequirements(action, count, false, options);
        const base = requirements.find((row) => row.itemHrid === BASE);
        expect(base).toMatchObject({
            isUpgradeItem: true,
            missing: 0,
            enhancementLevel: 12,
            requiresEnhancement: true,
            acquisition: { kind: 'owned-enhance', startLevel: 12, targetLevel: 13 },
        });
        expect(requirements.find((row) => row.itemHrid === SHARD)).toMatchObject({
            required: 100,
            recipeRequired: 20,
            enhancementRequired: 80,
            missing: 100,
        });
    });
    test.each([
        {
            label: 'worn copy without count',
            inventory: [{ itemHrid: BASE, enhancementLevel: 12, itemLocationHrid: '/item_locations/main_hand' }],
        },
        {
            label: 'three-copy stack',
            inventory: [
                { itemHrid: BASE, enhancementLevel: 12, count: 3, itemLocationHrid: '/item_locations/inventory' },
            ],
        },
    ])('keeps the $label as a preparation step, not an already crafted +13', async ({ inventory }) => {
        game.prices[BASE + ':12'].bid = 10 * M;
        game.inventory = inventory;
        const [action, count, options] = await clickBill();
        const actual = await vi.importActual('../../utils/material-calculator.js');
        const base = actual
            .calculateMaterialRequirements(action, count, false, options)
            .find((row) => row.itemHrid === BASE);
        expect(base).toMatchObject({
            missing: 0,
            requiresEnhancement: true,
            enhancementLevel: 12,
            acquisitionUnavailable: false,
        });
        expect(game.inventory).toEqual(inventory);
    });
    test.each(['removed', 'listed', 'zero'])(
        'revalidates an owned copy that is %s after the card is rendered',
        async (change) => {
            game.prices[BASE + ':12'].bid = 10 * M;
            const [action, count, options] = await clickBill();
            if (change === 'removed') game.inventory = [];
            if (change === 'listed') game.inventory[0].itemLocationHrid = '/item_locations/market_listing';
            if (change === 'zero') game.inventory[0].count = 0;
            const actual = await vi.importActual('../../utils/material-calculator.js');
            const base = actual
                .calculateMaterialRequirements(action, count, false, options)
                .find((row) => row.itemHrid === BASE);
            expect(base).toMatchObject({
                missing: 1,
                enhancementLevel: 12,
                acquisitionUnavailable: true,
                isTradeable: false,
            });
        }
    );
    test('a stale bag-source quote cannot switch to the same-level worn copy it already credits as sold', async () => {
        game.prices[BASE + ':12'].bid = 10 * M;
        const worn = { itemHrid: BASE, enhancementLevel: 12 };
        game.equipment.set('/item_locations/main_hand', worn);
        game.inventory = [
            { ...worn, count: 1, itemLocationHrid: '/item_locations/inventory' },
            { ...worn, itemLocationHrid: '/item_locations/main_hand' },
        ];
        const quoted = watch();
        expect(quoted.wornConsumed).toBe(false);
        expect(quoted.cost).toBe(90.4 * M);
        const [action, count, options] = await clickBill();
        expect(options.upgradeBaseAcquisition.sourceLocation).toBe('/item_locations/inventory');
        game.inventory.shift();
        const actual = await vi.importActual('../../utils/material-calculator.js');
        expect(
            actual.calculateMaterialRequirements(action, count, false, options).find((line) => line.itemHrid === BASE)
        ).toMatchObject({ have: 0, missing: 1, acquisitionUnavailable: true });
    });
    test('fresh enhancement buys +0, retains the final +13 prerequisite and includes its enhancement inputs', async () => {
        game.inventory = [];
        game.prices[BASE + ':0'].ask = 5 * M;
        const [action, count, options] = await clickBill();
        expect(options.upgradeBaseAcquisition).toMatchObject({ kind: 'fresh-enhance', startLevel: 0, targetLevel: 13 });
        const actual = await vi.importActual('../../utils/material-calculator.js');
        const requirements = actual.calculateMaterialRequirements(action, count, false, options);
        expect(requirements.find((row) => row.itemHrid === BASE)).toMatchObject({
            missing: 1,
            requiresEnhancement: true,
        });
        expect(requirements.find((row) => row.itemHrid === SHARD).required).toBe(100);
    });
    test('an owned over-level base never labels a selected lower-level purchase as already held', async () => {
        game.inventory = [
            { itemHrid: BASE, enhancementLevel: 15, count: 3, itemLocationHrid: '/item_locations/inventory' },
        ];
        const original = structuredClone(game.inventory);
        expect(watch().upgradeBaseAcquisition).toMatchObject({ kind: 'buy', startLevel: 13, targetLevel: 13 });
        const [action, count, options] = await clickBill();
        const actual = await vi.importActual('../../utils/material-calculator.js');
        const requirements = actual.calculateMaterialRequirements(action, count, false, options);
        expect(requirements.find((row) => row.itemHrid === BASE)).toMatchObject({ enhancementLevel: 13, missing: 1 });
        expect(text()).toContain('buy a +13 base, counted in');
        expect(text()).not.toContain('you have one');
        expect(game.inventory).toEqual(original);

        game.inventory.push({
            itemHrid: BASE,
            enhancementLevel: 13,
            count: 1,
            itemLocationHrid: '/item_locations/inventory',
        });
        equipmentSavingsPanel.render();
        expect(watch().upgradeBaseAcquisition).toMatchObject({ kind: 'owned', startLevel: 13, targetLevel: 13 });
        expect(text()).toContain('you have one');
        expect(text()).not.toContain('buy a +13 base');
    });

    test('bought +13 route shopping really includes one +13 and twenty purchased blocked intermediates', async () => {
        const [action, count, options] = await clickBill();
        const actual = await vi.importActual('../../utils/material-calculator.js');
        const requirements = actual.calculateMaterialRequirements(action, count, false, options);
        expect(requirements.find((row) => row.itemHrid === BASE)).toMatchObject({ enhancementLevel: 13, missing: 1 });
        expect(requirements.find((row) => row.itemHrid === SHARD)).toMatchObject({ missing: 20 });
    });
});

describe('audit current and kept worn copies', () => {
    beforeEach(initializeRoutes);
    afterEach(() => delete window.Toolasha);
    test('a bought +13 base leaves exactly one worn +12 sale credit', () => {
        game.equipment.set('/item_locations/main_hand', { itemHrid: BASE, enhancementLevel: 12 });
        game.inventory.push({ itemHrid: BASE, enhancementLevel: 12, itemLocationHrid: '/item_locations/main_hand' });
        game.candidateOverrides = { currentHrid: BASE, currentLevel: 12, removedItems: undefined };
        expect(watch()).toMatchObject({ route: 'craft', cost: 70 * M, realCost: 70 * M });
        expect(comparison()).toMatchObject({ route: 'craft', cash: 70 * M, real: 70 * M });
        expect(craft(comparison())).toMatchObject({ credit: 100 * M, consumed: [] });
    });
    test('keeping the worn base removes its sale credit in both models', () => {
        game.equipment.set('/item_locations/main_hand', { itemHrid: BASE, enhancementLevel: 12 });
        game.inventory.push({ itemHrid: BASE, enhancementLevel: 12, itemLocationHrid: '/item_locations/main_hand' });
        setNoSell(true);
        game.candidateOverrides = {
            currentHrid: BASE,
            currentLevel: 12,
            removedItems: [],
            keptItems: [{ hrid: BASE, enhancementLevel: 12 }],
        };
        expect(watch()).toMatchObject({ route: 'craft', cost: 170 * M, realCost: 170 * M });
        expect(comparison()).toMatchObject({ route: 'craft', cash: 170 * M, real: 170 * M });
    });
    test('changing the buy mode reprices both target and base alternatives', () => {
        game.profitMode = 'patientBuy';
        expect(watch()).toMatchObject({ route: 'craft', cost: 150 * M, realCost: 150 * M, upgradeBaseLevel: 13 });
        expect(comparison()).toMatchObject({ route: 'craft', cash: 150 * M, real: 150 * M });
    });
});

describe('the advisor ranks a supported row on the shared route', () => {
    beforeEach(initializeRoutes);
    afterEach(() => delete window.Toolasha);
    const own = (c = candidate()) => {
        const was = game.compareRoutes;
        game.compareRoutes = false;
        const quote = { cost: calculateUpgradeCost(c, data()), detail: explainUpgradeCost(c, data()) };
        game.compareRoutes = was;
        return quote;
    };
    const priced = (c = candidate(), isSelf = true) => ({
        cost: calculateUpgradeCost(c, data(), isSelf),
        detail: explainUpgradeCost(c, data(), isSelf),
    });

    test('Craft wins: Cost, breakdown and shopping all follow the craft; off restores the advisor quote', () => {
        const before = own();
        const beforeCandidate = structuredClone(candidate());
        expect(before.cost).toBe(400 * M);
        const { cost, detail } = priced();
        expect(cost).toBe(170 * M);
        expect(detail).toMatchObject({ net: 170 * M, gross: 170 * M, credit: 0, source: 'craft', ladder: null });
        expect(detail.sharedRoute).toMatchObject({
            applied: true,
            route: 'craft',
            real: 170 * M,
            advisorNet: 400 * M,
            shop: {
                kind: 'craft',
                actionHrid: '/actions/refine',
                upgradeItemLevel: 13,
                upgradeBaseAcquisition: { kind: 'buy', itemHrid: BASE, startLevel: 13, targetLevel: 13 },
                bill: [
                    { itemHrid: SHARD, enhancementLevel: 0, count: 20 },
                    { itemHrid: BASE, enhancementLevel: 13, count: 1 },
                ],
            },
        });
        // Nothing from the advisor's own route survives into the figure
        expect(detail.enhanceSource).toBeNull();
        expect(detail.buys).toEqual([expect.objectContaining({ hrid: TARGET, price: 170 * M, source: 'craft' })]);
        expect(candidate()).toEqual(beforeCandidate);
        game.compareRoutes = false;
        expect(calculateUpgradeCost(candidate(), data())).toBe(before.cost);
        expect(explainUpgradeCost(candidate(), data())).toEqual(before.detail);
    });

    test('Buy wins: the listing sets Cost and the shopping stays on the item', () => {
        game.prices[TARGET + ':13'] = { ask: 100 * M, bid: 90 * M };
        const { cost, detail } = priced();
        expect(cost).toBe(100 * M);
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'buy', shop: { kind: 'buy' } });
        expect(detail.buys).toEqual([expect.objectContaining({ hrid: TARGET, enhancementLevel: 13, price: 100 * M })]);
    });

    test('Mirror wins: the build sets Cost and its bill is the mirror and the listed copies', () => {
        game.prices[TARGET + ':11'] = { ask: 30 * M, bid: 29 * M };
        game.prices[TARGET + ':12'] = { ask: 40 * M, bid: 39 * M };
        game.prices['/items/philosophers_mirror:0'] = { ask: 10 * M, bid: 10 * M };
        const { cost, detail } = priced();
        expect(cost).toBe(80 * M);
        expect(detail).toMatchObject({ net: 80 * M, source: 'mirror' });
        expect(detail.sharedRoute.shop).toEqual({
            kind: 'mirror',
            bill: [
                { itemHrid: '/items/philosophers_mirror', enhancementLevel: 0, count: 1 },
                { itemHrid: TARGET, enhancementLevel: 12, count: 1 },
                { itemHrid: TARGET, enhancementLevel: 11, count: 1 },
            ],
        });
    });

    test('a preferred route that is dearer is still the one priced, and named as preferred', () => {
        game.prices[TARGET + ':13'] = { ask: 100 * M, bid: 90 * M };
        game.routePreference = 'craft';
        const { cost, detail } = priced();
        expect(cost).toBe(170 * M);
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'craft', preference: 'craft' });
    });

    test('an unpriced input is never a free one: Craft is out and Buy, the next cheapest, sets Cost', () => {
        delete game.prices[SHARD + ':0'];
        delete game.actions['/actions/shard'];
        const { cost, detail } = priced();
        expect(detail.acquisitionComparison.routes.find((r) => r.id === 'craft').cash).toBeNull();
        expect(cost).toBe(180 * M);
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'buy' });
    });

    test('nothing priced on any shared route keeps the advisor quote', () => {
        delete game.prices[SHARD + ':0'];
        delete game.actions['/actions/shard'];
        delete game.prices[TARGET + ':13'];
        const { cost, detail } = priced();
        expect(cost).toBe(own().cost);
        expect(detail.sharedRoute).toMatchObject({ applied: false, reason: 'No shared route is fully priced.' });
    });

    test('ask vs bid: patient buy reprices the craft on the bid side', () => {
        game.profitMode = 'patientBuy';
        const { cost, detail } = priced();
        expect(cost).toBe(150 * M);
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'craft', real: 150 * M });
    });

    test('a party member is priced on the advisor model, never from your bag or crafting setup', () => {
        const { cost, detail } = priced(candidate(), false);
        game.compareRoutes = false;
        expect(cost).toBe(calculateUpgradeCost(candidate(), data(), false));
        expect(detail.sharedRoute).toMatchObject({ applied: false, reason: expect.stringContaining('Party') });
    });

    test('an enhancement row on a worn +10: the worn copy is sold once, after tax, against the craft', () => {
        const worn = { itemHrid: TARGET, enhancementLevel: 10 };
        game.equipment.set('/item_locations/main_hand', worn);
        game.inventory.push({ ...worn, itemLocationHrid: '/item_locations/main_hand' });
        game.prices[TARGET + ':10'] = { ask: 60 * M, bid: 50 * M };
        const row = {
            type: 'enhancement',
            currentHrid: TARGET,
            currentLevel: 10,
            upgradeHrid: TARGET,
            upgradeLevel: 13,
        };
        // Enhancing the worn copy is cheaper, and the shared routes have no enhance: the advisor quote stands
        expect(own(row).cost).toBe(80 * M);
        expect(priced(row).cost).toBe(80 * M);
        expect(priced(row).detail.sharedRoute).toMatchObject({
            applied: false,
            route: 'craft',
            reason: expect.stringContaining('no shared equivalent'),
        });
        game.enhanceCost = 500 * M;
        // A dearer enhance loses to the cheaper craft, net of the worn copy's one after-tax sale
        expect(own(row).cost).toBe(500 * M);
        const { cost, detail } = priced(row);
        expect(cost).toBe(170 * M - 48 * M);
        expect(detail).toMatchObject({ gross: 170 * M, credit: 48 * M, net: 122 * M, creditApplied: true });
        expect(detail.credits).toEqual([
            expect.objectContaining({ hrid: TARGET, enhancementLevel: 10, price: 48 * M }),
        ]);
    });

    test('a resale credit larger than the route spends keeps the advisor quote', () => {
        const worn = { itemHrid: TARGET, enhancementLevel: 10 };
        game.equipment.set('/item_locations/main_hand', worn);
        game.inventory.push({ ...worn, itemLocationHrid: '/item_locations/main_hand' });
        game.prices[TARGET + ':10'] = { ask: 300 * M, bid: 250 * M };
        const row = {
            type: 'enhancement',
            currentHrid: TARGET,
            currentLevel: 10,
            upgradeHrid: TARGET,
            upgradeLevel: 13,
        };
        const { cost, detail } = priced(row);
        expect(cost).toBe(own(row).cost);
        expect(detail.sharedRoute).toMatchObject({ applied: false, reason: expect.stringContaining('resale credit') });
    });

    test.each([
        ['an owned base is prepared', () => (game.prices[BASE + ':12'].bid = 10 * M), 'prepares a base'],
        ['the craft may not start', () => (game.skills = []), 'not known to be startable'],
        ['an input is crafted', () => (game.skills[1].level = 95), 'crafts an input'],
        [
            'a held base at the level makes it ambiguous',
            () => {
                // Selling the held +13 fetches more than a listed one costs, so the bought base wins
                game.prices[BASE + ':13'].bid = 160 * M;
                game.inventory.push({
                    itemHrid: BASE,
                    enhancementLevel: 13,
                    count: 1,
                    itemLocationHrid: '/item_locations/inventory',
                });
            },
            'ambiguous',
        ],
    ])('Craft wins but %s: cost and shopping both stay on the advisor quote', (_label, setup, reason) => {
        setup();
        const { cost, detail } = priced();
        expect(detail.acquisitionComparison.route).toBe('craft');
        expect(cost).toBe(own().cost);
        expect(detail.net).toBe(own().cost);
        expect(detail.sharedRoute.applied).toBe(false);
        expect(detail.sharedRoute.reason).toContain(reason);
    });

    test('a refined target compares Buy and Craft only, and Craft sets its Cost', () => {
        const REF = '/items/spear_refined';
        game.details[REF] = { ...game.details[TARGET], name: 'Spear (R)' };
        game.actions['/actions/refine'].outputItems = [{ itemHrid: REF, count: 1 }];
        game.prices[REF + ':13'] = { ask: 180 * M, bid: 170 * M };
        game.prices['/items/philosophers_mirror:0'] = { ask: M, bid: M };
        game.candidateOverrides = { upgradeHrid: REF };
        const { cost, detail } = priced();
        expect(detail.acquisitionComparison.routes.map((r) => r.id)).not.toContain('mirror');
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'craft' });
        expect(cost).toBe(170 * M);
    });

    test('a merged acquisition stays on the advisor model, members included', () => {
        expect(priced({ ...candidate(), mergedAcquisition: true }).cost).toBe(400 * M);
        const member = (skillKey) => ({ candidate: { ...candidate(), skillKey }, cost: 170 * M });
        const merged = priceMergedAcquisition([member('/skills/a'), member('/skills/b'), member('/skills/c')], data());
        expect(merged.cost).toBe(400 * M);
        expect(merged.costDetail.sharedRoute).toMatchObject({
            applied: false,
            reason: expect.stringContaining('Merged'),
        });
        expect(priceMergedAcquisition([member('/skills/a')], data()).cost).toBe(170 * M);
    });

    test('the Lab breakdown keeps its kept-gear note on a route-priced row', () => {
        const row = { ...candidate(), keptItems: [{ hrid: BASE, enhancementLevel: 12 }] };
        const detail = explainLabCandidateCost(row, data());
        expect(detail.sharedRoute).toMatchObject({ applied: true, route: 'craft' });
        expect(detail.kept).toEqual([expect.objectContaining({ hrid: BASE, enhancementLevel: 12 })]);
        expect(detail.net).toBe(calculateUpgradeCost(row, data()));
    });
});
