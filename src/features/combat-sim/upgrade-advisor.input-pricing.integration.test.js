/**
 * Two real surfaces on one fixture, with the shared input rule NOT mocked.
 *
 * The suites that mock `enhancement-input-pricing.js` prove each surface calls it; they cannot prove
 * two surfaces that call it read the same number. Here the upgrade advisor's price ladder and the item
 * tooltip's enhancement path are driven for one piece whose book is wide (ask over 1.3x the bid), and
 * every input is asserted to be one figure on both - and to follow a custom price and a changed base
 * crafting setting together.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const SWORD = '/items/cheese_sword';
const MAT = '/items/cheese';
const CHAR = 161296;

const state = vi.hoisted(() => ({
    books: {},
    custom: {},
    craftingSetting: false,
}));

const ITEM_DETAIL_MAP = {
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: '/equipment_types/main_hand' },
        enhancementCosts: [{ itemHrid: MAT, count: 2 }],
    },
    [MAT]: { hrid: MAT, name: 'Cheese' },
    '/items/mirror_of_protection': { name: 'Mirror of Protection' },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: {} }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getBuffStateVersion: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        characterData: { characterAbilities: [] },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: (key) => key === 'enhanceSim_baseItemCraftingCost' && state.craftingSetting,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { on: () => {}, getPrice: () => null } }));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => false }));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPrice: (hrid, level = 0, side = 'sell') => state.custom[`${hrid}:${level}:${side}`] ?? null,
    getCustomPriceVersion: () => 0,
}));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinCost: () => 0,
    getShopCoinOnlyCost: () => 0,
}));
vi.mock('../../utils/market-data.js', () => {
    const reconciled = (hrid, level = 0) => {
        const book = state.books[`${hrid}:${level}`];
        if (!book) return null;
        const ask = book.ask > 0 ? book.ask : book.bid > 0 ? book.bid : null;
        return ask === null ? null : { ask, bid: book.bid > 0 ? book.bid : ask };
    };
    const modeOf = (context, side) => (context === 'profit' && side === 'sell' ? 'bid' : 'ask');
    return {
        getPricingMode: modeOf,
        getItemPriceInfo: (hrid, { mode, context, side = 'sell', enhancementLevel = 0 } = {}) => {
            const book = reconciled(hrid, enhancementLevel);
            if (!book) return { price: null, source: null, estimated: false };
            const picked = mode || modeOf(context, side);
            return { price: picked === 'bid' ? book.bid : book.ask, source: 'book', estimated: false };
        },
        getItemPrices: (hrid, level = 0) => {
            const book = state.books[`${hrid}:${level}`];
            return book ? { ask: book.ask ?? null, bid: book.bid ?? null } : null;
        },
        getItemPrice: (hrid, { mode = 'ask' } = {}) => reconciled(hrid)?.[mode] || 0,
    };
});
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: () => [],
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('./labyrinth-level-finder.js', () => ({ findMaxLabyrinthLevel: vi.fn(), defaultThreshold: () => 0.7 }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
// The sweep's own arithmetic has its suite; here the enhance run adds nothing to the base
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: () => 0,
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    describeEnhancementSource: () => ({ detail: '' }),
    buildSourceChipHTML: () => '',
    enhancementParamsFor: () => ({}),
    sectionAttributes: () => '',
    toggleProRates: () => {},
    SECTION_ATTR: 'data-x',
    SOURCE_CHIP_CLASS: 'x',
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));
vi.mock('../../utils/tea-parser.js', () => ({ parseArtisanBonus: () => 0, getDrinkConcentration: () => 0 }));

const { explainUpgradeCost } = await import('./upgrade-advisor.js');
const { calculateEnhancementPath } = await import('../enhancement/tooltip-enhancement.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP };
const tier = (level) => ({ type: 'equipment', upgradeHrid: SWORD, upgradeLevel: level, removedItems: [] });
const enhancingConfig = {
    enhancingLevel: 100,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
};

beforeEach(() => {
    globalThis.math = mathjs;
    state.books = {
        // A wide book: the ask is over 1.3x the bid and nothing crafts it, so the guarded price is the bid
        [`${SWORD}:0`]: { ask: 1000, bid: 400 },
        [`${MAT}:0`]: { ask: 50, bid: 40 },
        '/items/mirror_of_protection:0': { ask: 90_000, bid: 80_000 },
    };
    state.custom = {};
    state.craftingSetting = false;
});

const tooltipPath = () => calculateEnhancementPath(SWORD, 1, enhancingConfig, { priceContext: 'ask' });
/** What the tooltip's path books for the piece's base item, asked at the ask */
const tooltipBase = () => tooltipPath().optimalStrategy.baseCost;
const advisorBase = () => explainUpgradeCost(tier(0), gameData).buys[0].price;

describe('the advisor ladder and the tooltip read one base-item number', () => {
    test('a wide book: both read the guarded price, not the raw ask', () => {
        expect(advisorBase()).toBe(400);
        expect(tooltipBase()).toBe(400);
    });

    test('a custom buy price wins on both, even over a cheaper craft cost', () => {
        state.custom[`${SWORD}:0:buy`] = 250;
        state.craftingSetting = true;
        expect(advisorBase()).toBe(250);
        expect(tooltipBase()).toBe(250);
    });

    test('the +N rung follows the same side as its base: a custom price for the level is the listing', () => {
        state.books[`${SWORD}:3`] = { ask: 99_999, bid: 99_000 };
        state.custom[`${SWORD}:3:buy`] = 777;
        expect(explainUpgradeCost(tier(3), gameData).buys[0].price).toBe(777);
    });

    test('the material per attempt follows a custom price on the tooltip surface too', () => {
        expect(tooltipPath().optimalStrategy.materialBreakdown[0].unitPrice).toBe(50);
        state.custom[`${MAT}:0:buy`] = 7;
        expect(tooltipPath().optimalStrategy.materialBreakdown[0].unitPrice).toBe(7);
    });
});
