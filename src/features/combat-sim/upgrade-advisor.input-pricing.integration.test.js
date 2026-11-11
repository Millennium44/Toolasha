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
const OLD_SWORD = '/items/wooden_sword';
const MIRROR = '/items/philosophers_mirror';
const CHAR = 161296;

const state = vi.hoisted(() => ({
    books: {},
    compareRoutes: false,
    blessedChance: 0,
    inventory: [],
    custom: {},
    craftingSetting: false,
    // The profit mode's book side per transaction side; null is the conservative default (buy ask, sell bid)
    sides: null,
    // The untradable-cape setting: 'zero' | 'mirror'
    capeMode: 'zero',
}));

const CAPE_BASE = '/items/test_cape';
const CAPE_STAR = '/items/test_cape_refined';
const SHARD = '/items/test_refinement_shard';

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
    [OLD_SWORD]: {
        hrid: OLD_SWORD,
        name: 'Wooden Sword',
        isTradable: true,
        itemLevel: 1,
        equipmentDetail: { type: '/equipment_types/main_hand' },
    },
    '/items/mirror_of_protection': { name: 'Mirror of Protection' },
    // Capes carry no isTradable: the game leaves it off untradable gear
    [CAPE_BASE]: { hrid: CAPE_BASE, name: 'Test Cape', equipmentDetail: { type: '/equipment_types/back' } },
    [CAPE_STAR]: { hrid: CAPE_STAR, name: 'Test Cape (Refined)', equipmentDetail: { type: '/equipment_types/back' } },
    [SHARD]: { hrid: SHARD, name: 'Test Refinement Shard', isTradable: true },
};

// The real shape of a refinement: a production skill's recipe, the base cape as upgradeItemHrid
const ACTION_DETAIL_MAP = {
    '/actions/tailoring/test_cape_refined': {
        hrid: '/actions/tailoring/test_cape_refined',
        type: '/action_types/tailoring',
        retainAllEnhancement: true,
        upgradeItemHrid: CAPE_BASE,
        inputItems: [{ itemHrid: SHARD, count: 10 }],
        outputItems: [{ itemHrid: CAPE_STAR, count: 1 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: ACTION_DETAIL_MAP }),
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
        getSettingValue: (key, fallback) =>
            key === 'upgradeAdvisor_compareRoutes'
                ? state.compareRoutes
                : key === 'untradableCapeBaseValue'
                  ? state.capeMode
                  : fallback,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { on: () => {}, getPrice: () => null } }));
vi.mock('../../utils/action-context.js', () => {
    const mod = {
        resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
    };
    return { ...mod, resolveLoadoutContext: (actionTypeHrid) => mod.resolveActionContext(actionTypeHrid) };
});
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
    enhancementSweepParams: () => ({
        teas: { blessed: state.blessedChance > 0 },
        blessedTeaBonus: state.blessedChance,
    }),
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

const { calculateUpgradeCost, explainUpgradeCost, saleTaxRateOf, priceMergedAcquisition } =
    await import('./upgrade-advisor.js');
const { calculateEnhancementPath } = await import('../enhancement/tooltip-enhancement.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP };
const tier = (level, hrid = SWORD) => ({ type: 'equipment', upgradeHrid: hrid, upgradeLevel: level, removedItems: [] });
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
    state.compareRoutes = false;
    state.blessedChance = 0;
    state.inventory = [];
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
    state.capeMode = 'zero';
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

    test('a target the resolver cannot price is not a market trade: the row is an enhance at the bench', () => {
        // A custom price of 0 reads as unpriced, though the book lists the +5. This suite's bench sweep is
        // stubbed, so what is checked is the route; an unpriced sweep is null (upgrade-advisor.test.js)
        state.custom[`${SWORD}:5:buy`] = 0;
        const { detail } = both(enhance());
        expect(detail).toMatchObject({ source: 'sim', enhancementPath: true });
        expect(detail.buys).toEqual([]);
    });

    test('hybrid: a worn level with only an ask is sold at it, not dropped to the bench', () => {
        state.sides = { buy: 'ask', sell: 'ask' };
        state.books[`${SWORD}:3`] = { ask: 600_000 };
        const { cost, detail } = both(enhance());
        expect(detail.source).toBe('market');
        expect(detail.credit).toBe(576_000);
        expect(cost).toBe(2_000_000 - 576_000);
    });

    test('optimistic: a target with only a bid is bought at it', () => {
        state.sides = { buy: 'bid', sell: 'ask' };
        state.books[`${SWORD}:5`] = { bid: 1_500_000 };
        const { cost, detail } = both(enhance());
        expect(detail.source).toBe('market');
        expect(detail.buys[0].price).toBe(1_500_000);
        expect(cost).toBe(1_500_000 - 576_000);
    });

    test('a custom buy price on an unlisted target is the buy', () => {
        delete state.books[`${SWORD}:5`];
        state.custom[`${SWORD}:5:buy`] = 1_800_000;
        const { cost, detail } = both(enhance());
        expect(detail.source).toBe('market');
        expect(cost).toBe(1_800_000 - 480_000);
    });

    test('an unlisted worn level falls back to the bench, as before', () => {
        delete state.books[`${SWORD}:3`];
        const { detail } = both(enhance());
        expect(detail).toMatchObject({ source: 'sim', enhancementPath: true });
        expect(detail.credits).toEqual([]);
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

describe('resale and material buys follow the pricing mode', () => {
    const HYBRID = { buy: 'ask', sell: 'ask' };
    const OPTIMISTIC = { buy: 'bid', sell: 'ask' };
    const PATIENT_BUY = { buy: 'bid', sell: 'bid' };

    /** Cost and breakdown, which must agree */
    const both = (candidate, data = gameData) => {
        const cost = calculateUpgradeCost(candidate, data);
        const detail = explainUpgradeCost(candidate, data);
        expect(detail.net).toBe(cost);
        return { cost, detail };
    };

    describe('a replaced tier piece', () => {
        /** The Cheese Sword +5 in place of a worn Wooden Sword +2, which is sold */
        const swap = () => ({
            type: 'equipment',
            slot: '/equipment_types/main_hand',
            currentHrid: OLD_SWORD,
            currentLevel: 2,
            upgradeHrid: SWORD,
            upgradeLevel: 5,
        });

        beforeEach(() => {
            state.books[`${SWORD}:5`] = { ask: 2_000_000, bid: 1_500_000 };
            state.books[`${OLD_SWORD}:2`] = { ask: 300_000, bid: 200_000 };
        });

        test('conservative: credited at its bid after tax', () => {
            const { cost, detail } = both(swap());
            expect(detail.credits[0].price).toBe(192_000);
            expect(cost).toBe(2_000_000 - 192_000);
        });

        test('patient buy: credited at its bid after tax', () => {
            state.sides = PATIENT_BUY;
            const { cost, detail } = both(swap());
            expect(detail.credits[0].price).toBe(192_000);
            expect(cost).toBe(1_500_000 - 192_000);
        });

        test('hybrid: credited at its ask after tax', () => {
            state.sides = HYBRID;
            const { cost, detail } = both(swap());
            expect(detail.credits[0].price).toBe(288_000);
            expect(cost).toBe(2_000_000 - 288_000);
        });

        test('optimistic: credited at its ask after tax', () => {
            state.sides = OPTIMISTIC;
            const { cost, detail } = both(swap());
            expect(detail.credits[0].price).toBe(288_000);
            expect(cost).toBe(1_500_000 - 288_000);
        });

        test('a custom sell price is the resale, taxed once', () => {
            state.custom[`${OLD_SWORD}:2:sell`] = 250_000;
            expect(both(swap()).detail.credits[0].price).toBe(240_000);
        });
    });

    describe('a house room', () => {
        const ROOM = '/house_rooms/dairy_barn';
        const houseData = {
            ...gameData,
            houseRoomDetailMap: {
                [ROOM]: {
                    upgradeCostsMap: {
                        1: [
                            { itemHrid: '/items/coin', count: 1000 },
                            { itemHrid: MAT, count: 10 },
                        ],
                    },
                },
            },
        };
        const room = { type: 'house', slot: ROOM, roomHrid: ROOM, currentLevel: 0, upgradeLevel: 1 };

        test("buys its materials on the mode's buy side", () => {
            // Cheese books at 50 ask, 40 bid
            expect(calculateUpgradeCost(room, houseData)).toBe(1000 + 10 * 50);
            state.sides = PATIENT_BUY;
            expect(calculateUpgradeCost(room, houseData)).toBe(1000 + 10 * 40);
        });

        test('a material nothing prices leaves the room unpriced, never free', () => {
            delete state.books[`${MAT}:0`];
            expect(calculateUpgradeCost(room, houseData)).toBeNull();
        });
    });

    describe("a mirror route's trade-in", () => {
        // Every level listed, the +5 dear enough that a mirror build of it is the cheaper route
        const enhance = () => ({
            type: 'enhancement',
            slot: '/equipment_types/main_hand',
            currentHrid: SWORD,
            currentLevel: 2,
            upgradeHrid: SWORD,
            upgradeLevel: 5,
        });

        beforeEach(() => {
            state.books[`${SWORD}:1`] = { ask: 100_000, bid: 100_000 };
            state.books[`${SWORD}:2`] = { ask: 200_000, bid: 150_000 };
            state.books[`${SWORD}:3`] = { ask: 400_000, bid: 400_000 };
            state.books[`${SWORD}:4`] = { ask: 800_000, bid: 800_000 };
            state.books[`${SWORD}:5`] = { ask: 3_000_000, bid: 3_000_000 };
            state.books[`${MIRROR}:0`] = { ask: 100_000, bid: 100_000 };
        });

        test("sells the worn +2 on the mode's sell side", () => {
            const conservative = both(enhance());
            state.sides = HYBRID;
            const hybrid = both(enhance());

            // The same build, credited 0.96 x 150K into the bid, and 0.96 x 200K at the ask
            expect(conservative.detail.source).toBe('mirror');
            expect(hybrid.detail.source).toBe('mirror');
            expect(conservative.detail.credit).toBe(144_000);
            expect(hybrid.detail.credit).toBe(192_000);
            expect(conservative.detail.gross).toBe(hybrid.detail.gross);
            expect(conservative.cost - hybrid.cost).toBe(192_000 - 144_000);
        });
    });
});

describe('a refined untradable cape in the advisor follows the cape setting', () => {
    beforeEach(() => {
        // Ten shards at 100 each: the bill is 1000 stones alone, 91,000 with a mirror
        state.books[`${SHARD}:0`] = { ask: 100, bid: 90 };
    });

    /** The row's buy price, its net and the ladder's note */
    const starRow = () => {
        const detail = explainUpgradeCost(tier(0, CAPE_STAR), gameData);
        return { price: detail.buys[0].price, net: detail.net, unpriced: detail.unpriced, ladder: detail.ladder };
    };

    test('"nothing": priced at the stones alone, and the ladder says no base cape is in it', () => {
        state.capeMode = 'zero';
        const row = starRow();
        expect(row.price).toBe(1000);
        expect(row.net).toBe(1000);
        expect(row.unpriced).toEqual([]);
        expect(row.ladder).toMatchObject({ fresh: true, baseCost: 1000, baseStonesOnly: true });
        expect(calculateUpgradeCost(tier(0, CAPE_STAR), gameData)).toBe(1000);
    });

    test('mirror: unpriced, with or without a mirror price, because the mirror is an assumption', () => {
        state.capeMode = 'mirror';
        expect(starRow()).toMatchObject({ price: null, net: null, unpriced: ['Test Cape (Refined)'] });
        delete state.books['/items/mirror_of_protection:0'];
        expect(starRow().price).toBeNull();
        expect(calculateUpgradeCost(tier(0, CAPE_STAR), gameData)).toBeNull();
    });

    test('a custom buy price the player set for the star cape is the buy on either setting, with no stones note', () => {
        state.custom[`${CAPE_STAR}:0:buy`] = 4_000_000;
        for (const mode of ['zero', 'mirror']) {
            state.capeMode = mode;
            const row = starRow();
            expect(row.price).toBe(4_000_000);
            expect(row.ladder.baseStonesOnly).toBeUndefined();
        }
    });
});

describe('route pricing: a supported row ranks on the shared route', () => {
    test('a Buy quote that differs from the advisor quote sets Cost and breakdown together; off restores both', () => {
        const candidate = tier(0);
        const before = explainUpgradeCost(candidate, gameData);
        const cost = calculateUpgradeCost(candidate, gameData);
        // The advisor guards a wide book at the bid; the shared Buy route is the ask Equipment Watch quotes
        expect(cost).toBe(400);
        state.compareRoutes = true;
        const after = explainUpgradeCost(candidate, gameData);
        expect(after.sharedRoute).toMatchObject({ applied: true, route: 'buy', real: 1000, advisorNet: 400 });
        expect(after).toMatchObject({ net: 1000, gross: 1000, source: 'market', ladder: null });
        expect(after.buys).toEqual([expect.objectContaining({ hrid: SWORD, enhancementLevel: 0, price: 1000 })]);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(1000);
        state.compareRoutes = false;
        expect(explainUpgradeCost(candidate, gameData)).toEqual(before);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(cost);
    });
    test('party and multi-slot rows are explicitly unsupported, not priced from the local bag', () => {
        state.compareRoutes = true;
        expect(explainUpgradeCost(tier(0), gameData, false).acquisitionComparison).toMatchObject({
            status: 'unsupported',
            reason: expect.stringContaining('Party'),
        });
        const cross = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/main_hand': { hrid: SWORD, enhancementLevel: 0 } },
            removedItems: [],
        };
        expect(explainUpgradeCost(cross, gameData).acquisitionComparison).toMatchObject({
            status: 'unsupported',
            reason: expect.stringContaining('Multi-item'),
        });
    });
    test('does not invent a replaced copy from a future simulated build', () => {
        state.compareRoutes = true;
        const candidate = { ...tier(0), currentHrid: OLD_SWORD, currentLevel: 13, removedItems: undefined };
        expect(explainUpgradeCost(candidate, gameData).acquisitionComparison).toMatchObject({
            status: 'unsupported',
            reason: expect.stringContaining('not verified'),
        });
    });

    test.each([0, 0.2])('an agreeing recursive Mirror and Blessed Tea cost is unchanged (chance %s)', (blessed) => {
        state.blessedChance = blessed;
        state.books[`${SWORD}:0`] = { ask: 100_000, bid: 100_000 };
        state.books[`${SWORD}:1`] = { ask: 100_000, bid: 100_000 };
        state.books[`${SWORD}:2`] = { ask: 200_000, bid: 150_000 };
        state.books[`${SWORD}:3`] = { ask: 3_000_000, bid: 400_000 };
        state.books[`${SWORD}:4`] = { ask: 4_000_000, bid: 800_000 };
        state.books[`${SWORD}:5`] = { ask: 5_000_000, bid: 3_000_000 };
        state.books[`${MIRROR}:0`] = { ask: 100_000, bid: 100_000 };
        const candidate = tier(5);
        const before = explainUpgradeCost(candidate, gameData);
        const cost = calculateUpgradeCost(candidate, gameData);
        expect(before.source).toBe('mirror');
        expect(before.ladder.mirror.mirrorCount).toBeGreaterThan(1);
        state.compareRoutes = true;
        const { acquisitionComparison, sharedRoute, ...after } = explainUpgradeCost(candidate, gameData);
        // The same Mirror figure on both models: the advisor's own breakdown stands, stamped as agreeing
        expect(after).toEqual(before);
        expect(sharedRoute).toMatchObject({ applied: false, agrees: true, route: 'mirror' });
        expect(calculateUpgradeCost(candidate, gameData)).toBe(cost);
        expect(acquisitionComparison).toMatchObject({ status: 'priced' });
        expect(acquisitionComparison.routes.find((row) => row.id === 'mirror').mirrorCount).toBe(
            before.ladder.mirror.mirrorCount
        );
    });
    test('an unloaded inventory cannot verify an enhancement candidate copy', () => {
        state.compareRoutes = true;
        state.inventory = null;
        const candidate = {
            type: 'enhancement',
            currentHrid: SWORD,
            currentLevel: 4,
            upgradeHrid: SWORD,
            upgradeLevel: 5,
        };
        expect(explainUpgradeCost(candidate, gameData).acquisitionComparison).toMatchObject({
            status: 'unsupported',
            reason: expect.stringContaining('not loaded'),
        });
    });

    test.each([0, 5])('a merged acquisition invalidates member comparison even with credit %s', (credit) => {
        const comparison = { status: 'priced', route: 'buy', cash: 20, real: 20 };
        state.inventory = [{ itemHrid: OLD_SWORD, enhancementLevel: 0, count: 1 }];
        const member = {
            candidate: {
                type: 'enhancement',
                currentHrid: SWORD,
                currentLevel: 3,
                upgradeHrid: SWORD,
                upgradeLevel: 5,
            },
            cost: 20,
            costDetail: { net: 20, gross: 20, credit: 0, credits: [], acquisitionComparison: comparison },
        };
        const other = {
            candidate: { type: 'tier', currentHrid: OLD_SWORD, upgradeHrid: SWORD, upgradeLevel: 5 },
            cost: 100,
        };
        const result = priceMergedAcquisition([member, other], gameData, {
            price: (candidate) =>
                100 - credit * (candidate.removedItems || []).filter((item) => item.hrid === OLD_SWORD).length,
            explain: () => ({ net: 100 }),
        });
        expect(result.costDetail.acquisitionComparison).toMatchObject({
            status: 'unsupported',
            reason: expect.stringContaining('Merged'),
        });
        expect(member.costDetail.acquisitionComparison).toBe(comparison);
        expect(result.cost).toBe(20 - credit);
    });
    test('comparison Mirror cannot borrow a craft-valued fresh input without a listing', () => {
        state.compareRoutes = true;
        // Legacy priceBase may value a +0 from a custom/production fallback.
        // Comparison leaf inputs must instead exist on the same book as Watch.
        state.books = { [`${SWORD}:5`]: { ask: 5000, bid: 5000 }, [`${MIRROR}:0`]: { ask: 100, bid: 100 } };
        state.custom[`${SWORD}:0:buy`] = 10;
        const result = explainUpgradeCost(tier(5), gameData).acquisitionComparison;
        expect(result).toMatchObject({ status: 'priced', route: 'buy' });
        expect(result.routes.some((route) => route.id === 'mirror')).toBe(false);
        expect(result.notes.join(' ')).toContain('listed input levels');
    });
});
