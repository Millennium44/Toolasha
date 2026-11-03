/**
 * A refined (★) cape's transmute profit, through the real pricing chain.
 *
 * The input is valued by its refinement stones plus the base cape by the setting (enhancement-input-pricing /
 * the production bill), the other refined capes it can return are valued the same way (untaxed, they cannot be
 * sold), and a stone nothing prices leaves the cape unvalued. The market feed, the settings and the
 * action stats are faked; the calculator, the cape valuation and the input pricing rule are real.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({
    items: {},
    books: {},
    actions: {},
    custom: {},
    capeMode: 'zero',
    craftingSetting: false,
    buffVersion: 0,
    level: 200,
    customVersion: 0,
    loaded: true,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => (game.loaded ? { itemDetailMap: game.items, actionDetailMap: game.actions } : null),
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getBuffStateVersion: () => game.buffVersion,
        getSkills: () => [{ skillHrid: '/skills/alchemy', level: game.level }],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        characterData: {},
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: (key) => key === 'enhanceSim_baseItemCraftingCost' && game.craftingSetting,
        getSettingValue: (key, fallback) => (key === 'untradableCapeBaseValue' ? game.capeMode : (fallback ?? '')),
        getSetting: () => true,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { on: () => {}, getPrice: () => null } }));
vi.mock('../../utils/action-context.js', () => {
    const mod = { resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) };
    return { ...mod, resolveLoadoutContext: () => mod.resolveActionContext() };
});
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false }));
vi.mock('../../utils/ironcow-valuation.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isIronCowCharacter: () => false,
}));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPrice: (hrid, _level, side) => game.custom[`${hrid}:${side}`] ?? null,
    getCustomPriceVersion: () => game.customVersion,
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../../utils/alchemy-shop-value.js', () => ({ getAlchemyOutputShopValue: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', async () => ({
    getProductionCost: (await import('../../utils/enhancement-pricing.js')).getProductionCost,
    calculateEnhancementPath: () => null,
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ enhancementParamsFor: () => ({}) }));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => 0, parseTeaSkillLevelBonus: () => 0 }));
vi.mock('../../utils/buff-parser.js', () => ({ getAlchemySuccessBonus: () => 0 }));
vi.mock('../../utils/equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => 0,
    debugEquipmentSpeedBonuses: () => [],
    parseEssenceFindBonus: () => 0,
    parseRareFindBonus: () => 0,
}));
vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 16, totalEfficiency: 0, efficiencyBreakdown: {} }),
}));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseRareFind: () => 0 }));
vi.mock('./expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, containerMissingCounts: new Map(), isInitialized: false },
}));

/** A one-sided book fills the other side, as the reconciled book does */
function reconciled(hrid) {
    const book = game.books[hrid];
    if (!book) return null;
    const ask = book.ask > 0 ? book.ask : book.bid > 0 ? book.bid : null;
    const bid = book.bid > 0 ? book.bid : ask;
    return ask === null ? null : { ask, bid };
}
vi.mock('../../utils/market-data.js', () => ({
    getPricingMode: () => 'ask',
    isPriceEstimated: () => false,
    getItemPriceInfo: (hrid, { mode, side = 'sell' } = {}) => {
        const custom = game.custom[`${hrid}:${side}`];
        if (custom !== undefined) return { price: custom, source: 'custom', estimated: false };
        const book = reconciled(hrid);
        if (!book) return { price: null, source: null, estimated: false };
        return { price: mode === 'bid' ? book.bid : book.ask, source: 'book', estimated: false };
    },
    getItemPrices: (hrid) =>
        game.books[hrid]
            ? { ask: game.books[hrid].ask ?? null, bid: game.books[hrid].bid ?? null, bidEstimated: false }
            : null,
    getItemPrice: (hrid, { mode, side = 'sell' } = {}) => {
        const custom = game.custom[`${hrid}:${side}`];
        if (custom !== undefined) return custom;
        const book = reconciled(hrid);
        return book ? (mode === 'bid' ? book.bid : book.ask) : null;
    },
}));

const { default: calculator } = await import('./alchemy-profit-calculator.js');

const STONE = '/items/philosophers_stone';
const SHARD = '/items/refinement_shard';
const GATHERER = '/items/gatherer_cape';
const GATHERER_STAR = '/items/gatherer_cape_refined';
const CHANCE = '/items/chance_cape';
const CHANCE_STAR = '/items/chance_cape_refined';
const back = { equipmentDetail: { type: '/equipment_types/back' } };

/** The game's shape: a refined cape returns itself, a sibling ★ cape, or a Philosopher's Stone */
function transmuteDetail(self, sibling) {
    return {
        bulkMultiplier: 1,
        transmuteSuccessRate: 0.6,
        transmuteDropTable: [
            { itemHrid: self, dropRate: 0.9, minCount: 1, maxCount: 1 },
            { itemHrid: sibling, dropRate: 0.04, minCount: 1, maxCount: 1 },
            { itemHrid: STONE, dropRate: 0.06, minCount: 1, maxCount: 1 },
        ],
    };
}

beforeEach(() => {
    game.items = {
        [STONE]: { name: "Philosopher's Stone", isTradable: true, itemLevel: 1 },
        [SHARD]: { name: 'Refinement Shard', isTradable: true },
        [GATHERER]: { name: 'Gatherer Cape', itemLevel: 90, ...back, alchemyDetail: { bulkMultiplier: 1 } },
        [CHANCE]: { name: 'Chance Cape', itemLevel: 90, ...back, alchemyDetail: { bulkMultiplier: 1 } },
        [GATHERER_STAR]: {
            name: 'Gatherer Cape (Refined)',
            itemLevel: 90,
            ...back,
            alchemyDetail: transmuteDetail(GATHERER_STAR, CHANCE_STAR),
        },
        [CHANCE_STAR]: {
            name: 'Chance Cape (Refined)',
            itemLevel: 90,
            ...back,
            alchemyDetail: transmuteDetail(CHANCE_STAR, GATHERER_STAR),
        },
    };
    game.actions = {
        '/actions/alchemy/transmute': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
        '/actions/refine/gatherer': {
            type: '/action_types/alchemy',
            inputItems: [{ itemHrid: SHARD, count: 10 }],
            outputItems: [{ itemHrid: GATHERER_STAR, count: 1 }],
            upgradeItemHrid: GATHERER,
        },
        '/actions/refine/chance': {
            type: '/action_types/alchemy',
            inputItems: [{ itemHrid: SHARD, count: 20 }],
            outputItems: [{ itemHrid: CHANCE_STAR, count: 1 }],
            upgradeItemHrid: CHANCE,
        },
    };
    game.books = { [STONE]: { ask: 1_000_000, bid: 900_000 }, [SHARD]: { ask: 1000, bid: 900 } };
    game.custom = {};
    game.capeMode = 'zero';
    game.craftingSetting = false;
    game.level = 200;
    game.loaded = true;
    game.buffVersion++;
});

describe('a refined cape transmute', () => {
    test('is valued from its stones alone on the "nothing" setting', () => {
        const result = calculator.calculateTransmuteProfit(GATHERER_STAR);
        expect(result).not.toBeNull();
        // 10 shards at the ask
        expect(result.requirementCosts[0].price).toBe(10_000);
        expect(result.assumedCapes[0]).toMatchObject({ itemHrid: GATHERER_STAR, value: 10_000, partial: false });
    });

    test('adds one mirror to its stones on the "mirror" setting', () => {
        game.capeMode = 'mirror';
        game.books['/items/mirror_of_protection'] = { ask: 500_000, bid: 450_000 };
        game.buffVersion++;
        const result = calculator.calculateTransmuteProfit(GATHERER_STAR);
        expect(result).not.toBeNull();
        expect(result.requirementCosts[0].price).toBe(510_000);
        expect(result.assumedCapes[0]).toMatchObject({ itemHrid: GATHERER_STAR, value: 510_000, partial: false });
    });

    test('with no mirror price on the "mirror" setting it is left unvalued, not stones alone', () => {
        game.capeMode = 'mirror';
        game.buffVersion++;
        expect(calculator.calculateTransmuteProfit(GATHERER_STAR)).toBeNull();
    });

    test('a sibling ★ cape it can return is valued by its own stones, untaxed, and marked assumed', () => {
        const result = calculator.calculateTransmuteProfit(GATHERER_STAR);
        const sibling = result.dropRevenues.find((drop) => drop.itemHrid === CHANCE_STAR);
        expect(sibling).toMatchObject({ price: 20_000, isSelfReturn: false });
        expect(result.assumedCapes.map((c) => c.itemHrid)).toEqual([GATHERER_STAR, CHANCE_STAR]);
        expect(result.estimatedOutputs).toContain(CHANCE_STAR);
        expect(result.unpricedOutputs).not.toContain(CHANCE_STAR);
    });

    test('an unpriced stone leaves the cape unvalued: no line, never a free input', () => {
        delete game.books[SHARD];
        game.buffVersion++;
        expect(calculator.calculateTransmuteProfit(GATHERER_STAR)).toBeNull();
    });

    test('a sibling whose stone is unpriced is named as an unpriced output, not valued at 0 silently', () => {
        game.actions['/actions/refine/chance'].inputItems = [{ itemHrid: '/items/other_shard', count: 5 }];
        game.items['/items/other_shard'] = { name: 'Other Shard', isTradable: true };
        game.buffVersion++;
        const result = calculator.calculateTransmuteProfit(GATHERER_STAR);
        expect(result).not.toBeNull();
        expect(result.unpricedOutputs).toContain(CHANCE_STAR);
    });

    test('an enhanced +N cape is not given a transmute row', () => {
        const all = calculator.calculateAllProfits(GATHERER_STAR, 3);
        expect(all.transmute).toBeUndefined();
    });

    test('the item can only do the actions its data allows', () => {
        const all = calculator.calculateAllProfits(GATHERER_STAR, 0);
        expect(Object.keys(all)).toEqual(['transmute']);
    });

    test('game data not loaded yet: no row and no throw', () => {
        game.loaded = false;
        expect(calculator.calculateTransmuteProfit(GATHERER_STAR)).toBeNull();
        expect(calculator.calculateAllProfits(GATHERER_STAR, 0)).toEqual({});
    });

    test('an alchemist under the item level still gets a row, at a lower success rate', () => {
        const full = calculator.calculateTransmuteProfit(GATHERER_STAR);
        game.level = 40;
        const under = calculator.calculateTransmuteProfit(GATHERER_STAR);
        expect(under).not.toBeNull();
        expect(under.successRate).toBeLessThan(full.successRate);
    });

    test('a real quote for the cape (an Iron Cow vendor value, a listing) is used, not the stones', () => {
        game.books[GATHERER_STAR] = { ask: 90_000, bid: 80_000 };
        const result = calculator.calculateTransmuteProfit(GATHERER_STAR);
        expect(result.requirementCosts[0].price).toBe(90_000);
        expect(result.assumedCapes.map((c) => c.itemHrid)).not.toContain(GATHERER_STAR);
    });

    test('a custom price for a stone moves the cape, so the cached bill is not stale', () => {
        const before = calculator.calculateTransmuteProfit(GATHERER_STAR).requirementCosts[0].price;
        game.custom[`${SHARD}:buy`] = 2000;
        game.custom[`${SHARD}:sell`] = 2000;
        game.customVersion++;
        const after = calculator.calculateTransmuteProfit(GATHERER_STAR).requirementCosts[0].price;
        expect(before).toBe(10_000);
        expect(after).toBe(20_000);
    });
});
