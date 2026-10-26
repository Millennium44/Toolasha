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
    // The profit mode's book side per transaction side; null is the conservative default (buy ask, sell bid)
    sides: null,
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
    const modeOf = (context, side) => {
        if (context !== 'profit') return 'ask';
        return state.sides?.[side] ?? (side === 'sell' ? 'bid' : 'ask');
    };
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

const { calculateUpgradeCost, explainUpgradeCost, saleTaxRateOf } = await import('./upgrade-advisor.js');
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
    state.sides = null;
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

describe('an enhancement row prices both levels as the pricing mode and custom prices say', () => {
    /** The worn Cheese Sword +3 enhanced to +5 */
    const enhance = (extra = {}) => ({
        type: 'enhancement',
        slot: '/equipment_types/main_hand',
        currentHrid: SWORD,
        currentLevel: 3,
        upgradeHrid: SWORD,
        upgradeLevel: 5,
        ...extra,
    });
    /** A swap from another weapon to the same Cheese Sword +5, selling nothing */
    const swapTo5 = () => ({ ...tier(5), slot: '/equipment_types/main_hand' });
    const PATIENT_BUY = { buy: 'bid', sell: 'bid' };

    beforeEach(() => {
        state.books[`${SWORD}:3`] = { ask: 600_000, bid: 500_000 };
        state.books[`${SWORD}:5`] = { ask: 2_000_000, bid: 1_500_000 };
    });

    /** Cost and breakdown, which must agree */
    const both = (candidate) => {
        const cost = calculateUpgradeCost(candidate, gameData);
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail.net).toBe(cost);
        return { cost, detail };
    };

    test('conservative: buys the +5 at its ask and sells the +3 into its bid, after tax', () => {
        const { cost, detail } = both(enhance());
        // 2M - floor(500K * 0.96)
        expect(cost).toBe(2_000_000 - 480_000);
        expect(detail).toMatchObject({ gross: 2_000_000, credit: 480_000, rawBid: 500_000, source: 'market' });
    });

    test('patient buy: the row and the matching swap both buy the +5 at its bid', () => {
        state.sides = PATIENT_BUY;
        const { cost, detail } = both(enhance());
        const swapBuy = explainUpgradeCost(swapTo5(), gameData).buys[0].price;

        expect(swapBuy).toBe(1_500_000);
        expect(detail.buys[0].price).toBe(swapBuy);
        expect(cost).toBe(1_500_000 - 480_000);
    });

    test('hybrid: the +3 is sold at its ask, as that mode sells', () => {
        state.sides = { buy: 'ask', sell: 'ask' };
        const { cost, detail } = both(enhance());
        expect(detail.credit).toBe(576_000);
        expect(cost).toBe(2_000_000 - 576_000);
    });

    test('a custom price on the target level is the buy', () => {
        state.custom[`${SWORD}:5:buy`] = 1_800_000;
        const { cost, detail } = both(enhance());
        expect(detail.buys[0].price).toBe(1_800_000);
        expect(cost).toBe(1_800_000 - 480_000);
    });

    test('a target the resolver cannot price leaves the row unpriced, never free', () => {
        // A custom price of 0 reads as unpriced, though the book lists the +5
        state.custom[`${SWORD}:5:buy`] = 0;
        const { cost, detail } = both(enhance());
        expect(cost).toBeNull();
        expect(detail.net).toBeNull();
        expect(detail.unpriced).toEqual(['Cheese Sword']);
    });

    test("an Iron Cow analysed by a market player trades the +3 in untaxed; the live character's own pays the tax", () => {
        const ironCow = enhance({ saleTaxRate: saleTaxRateOf({ gameMode: 'ironcow' }, false) });
        expect(both(ironCow).detail.credit).toBe(500_000);
        expect(both(ironCow).cost).toBe(1_500_000);
        expect(both(enhance()).detail.credit).toBe(480_000);
    });

    test('the outlier cap holds the trade-in to the target as the mode buys it', () => {
        // Patient buy: a +3 bid above the +5 bid is cut to that bid, leaving the row free rather than refunding
        state.sides = PATIENT_BUY;
        state.books[`${SWORD}:3`] = { ask: 9_000_000, bid: 8_000_000 };
        const { cost, detail } = both(enhance());
        expect(cost).toBe(0);
        expect(detail).toMatchObject({ creditCapped: true, credit: 1_500_000, rawCredit: 7_680_000 });
    });
});
