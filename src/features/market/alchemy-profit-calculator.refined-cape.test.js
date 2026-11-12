/**
 * A refined (★) cape's transmute profit, through the real pricing chain.
 *
 * The input is valued by its refinement stones plus the base cape by the setting (enhancement-input-pricing /
 * the production bill), and a stone nothing prices leaves the cape unvalued. A refined cape returns itself or a
 * Philosopher's Stone; the capes that return other capes are the four unrefined ones, whose siblings are valued
 * the same way (untaxed, they cannot be sold). The market feed, the settings and the action stats are faked; the
 * calculator, the cape valuation and the input pricing rule are real.
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
    parseEquipmentTalismanBuff: () => 0,
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
const { calculatePriceAfterTax } = await import('../../utils/profit-helpers.js');

const STONE = '/items/philosophers_stone';
const SHARD = '/items/labyrinth_refinement_shard';
const MIRROR = '/items/mirror_of_protection';
const ARTIFICER = '/items/artificer_cape';
const ARTIFICER_STAR = '/items/artificer_cape_refined';
const CHANCE = '/items/chance_cape';
const CULINARY = '/items/culinary_cape';
const GATHERER = '/items/gatherer_cape';
const GATHERER_STAR = '/items/gatherer_cape_refined';
const UNREFINED = [ARTIFICER, CHANCE, CULINARY, GATHERER];
const back = { equipmentDetail: { type: '/equipment_types/back' } };

/** A refined cape as the game sends it: itself and a Philosopher's Stone, 100 shards, decomposes into them */
function refinedDetail(self, base) {
    return {
        isCoinifiable: true,
        decomposeItems: [
            { itemHrid: SHARD, count: 100 },
            { itemHrid: base, count: 1 },
        ],
        bulkMultiplier: 1,
        transmuteSuccessRate: 0.5,
        transmuteDropTable: [
            { itemHrid: self, dropRate: 0.9, minCount: 1, maxCount: 1 },
            { itemHrid: STONE, dropRate: 0.1, minCount: 1, maxCount: 1 },
        ],
    };
}

/** An unrefined cape as the game sends it: the other three at 0.25 each, no stone */
function unrefinedDetail(self) {
    return {
        bulkMultiplier: 1,
        transmuteSuccessRate: 0.5,
        transmuteDropTable: UNREFINED.filter((hrid) => hrid !== self).map((itemHrid) => ({
            itemHrid,
            dropRate: 0.25,
            minCount: 1,
            maxCount: 1,
        })),
    };
}

beforeEach(() => {
    game.items = {
        [STONE]: { name: "Philosopher's Stone", isTradable: true, itemLevel: 1 },
        [SHARD]: { name: 'Labyrinth Refinement Shard', isTradable: true },
        [MIRROR]: { name: 'Mirror of Protection', isTradable: true },
        ...Object.fromEntries(
            UNREFINED.map((hrid) => [
                hrid,
                { name: hrid.split('/').pop(), itemLevel: 90, ...back, alchemyDetail: unrefinedDetail(hrid) },
            ])
        ),
        [ARTIFICER_STAR]: {
            name: 'Artificer Cape (Refined)',
            itemLevel: 90,
            ...back,
            alchemyDetail: refinedDetail(ARTIFICER_STAR, ARTIFICER),
        },
        [GATHERER_STAR]: {
            name: 'Gatherer Cape (Refined)',
            itemLevel: 90,
            ...back,
            alchemyDetail: refinedDetail(GATHERER_STAR, GATHERER),
        },
    };
    game.actions = {
        '/actions/alchemy/transmute': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
        '/actions/alchemy/coinify': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
        '/actions/alchemy/decompose': { type: '/action_types/alchemy', baseTimeCost: 20e9 },
        '/actions/tailoring/artificer_cape_refined': {
            type: '/action_types/tailoring',
            retainAllEnhancement: true,
            inputItems: [{ itemHrid: SHARD, count: 100 }],
            outputItems: [{ itemHrid: ARTIFICER_STAR, count: 1 }],
            upgradeItemHrid: ARTIFICER,
        },
        '/actions/tailoring/gatherer_cape_refined': {
            type: '/action_types/tailoring',
            retainAllEnhancement: true,
            inputItems: [{ itemHrid: SHARD, count: 100 }],
            outputItems: [{ itemHrid: GATHERER_STAR, count: 1 }],
            upgradeItemHrid: GATHERER,
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
        const result = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        expect(result).not.toBeNull();

        expect(result.requirementCosts[0].price).toBe(100_000);
        expect(result.assumedCapes[0]).toMatchObject({ itemHrid: ARTIFICER_STAR, value: 100_000, partial: false });
    });

    test('adds one mirror to its stones on the "mirror" setting', () => {
        game.capeMode = 'mirror';
        game.books[MIRROR] = { ask: 500_000, bid: 450_000 };
        game.buffVersion++;
        const result = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        expect(result).not.toBeNull();
        expect(result.requirementCosts[0].price).toBe(600_000);
        expect(result.assumedCapes[0]).toMatchObject({ itemHrid: ARTIFICER_STAR, value: 600_000, partial: false });
    });

    test('with no mirror price on the "mirror" setting it is left unvalued, not stones alone', () => {
        game.capeMode = 'mirror';
        game.buffVersion++;
        expect(calculator.calculateTransmuteProfit(ARTIFICER_STAR)).toBeNull();
    });

    test('the real refined cape row: itself at 0.9 is a self-return, the stone is taxed once', () => {
        const result = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        const tableDrops = result.dropRevenues.filter((drop) => drop.dropRate !== undefined && !drop.isEssence);
        const self = tableDrops.find((drop) => drop.itemHrid === ARTIFICER_STAR);
        const stone = tableDrops.find((drop) => drop.itemHrid === STONE);

        expect(tableDrops.filter((drop) => [ARTIFICER_STAR, STONE].includes(drop.itemHrid))).toHaveLength(2);
        expect(self).toMatchObject({ dropRate: 0.9, isSelfReturn: true, revenuePerAttempt: 0 });
        expect(stone.revenuePerAttempt).toBeCloseTo(0.1 * calculatePriceAfterTax(1_000_000) * result.successRate, 6);
        expect(result.requirementCosts[0].selfReturnValue).toBeCloseTo(100_000 * 0.9 * result.successRate, 6);
        expect(result.requirementCosts[0].costPerAction).toBeCloseTo(100_000 * (1 - 0.9 * result.successRate), 6);
        expect(result.assumedCapes.map((c) => c.itemHrid)).toEqual([ARTIFICER_STAR]);
        expect(result.estimatedOutputs).not.toContain(ARTIFICER_STAR);
        expect(result.unpricedOutputs).not.toContain(STONE);
    });

    test('an unrefined cape on the mirror setting values the three it can return by a mirror each, untaxed', () => {
        game.capeMode = 'mirror';
        game.books[MIRROR] = { ask: 500_000, bid: 450_000 };
        game.buffVersion++;
        const result = calculator.calculateTransmuteProfit(GATHERER);
        const siblings = result.dropRevenues.filter((drop) => UNREFINED.includes(drop.itemHrid));

        expect(result.requirementCosts[0].price).toBe(500_000);
        expect(siblings.map((drop) => drop.itemHrid).sort()).toEqual([ARTIFICER, CHANCE, CULINARY]);
        for (const drop of siblings) {
            expect(drop).toMatchObject({ dropRate: 0.25, price: 500_000, isSelfReturn: false });
            expect(drop.revenuePerAttempt).toBeCloseTo(0.25 * 500_000 * result.successRate, 6);
        }
        expect(result.assumedCapes.map((c) => c.itemHrid).sort()).toEqual([ARTIFICER, CHANCE, CULINARY, GATHERER]);
        expect(result.unpricedOutputs).not.toContain(CHANCE);
    });

    test('an unrefined cape on the "nothing" setting has no row: its input is unvalued', () => {
        expect(calculator.calculateTransmuteProfit(GATHERER)).toBeNull();
    });

    test('an unpriced stone leaves the cape unvalued: no line, never a free input', () => {
        delete game.books[SHARD];
        game.buffVersion++;
        expect(calculator.calculateTransmuteProfit(ARTIFICER_STAR)).toBeNull();
    });

    test('defensive, not the game shape: a refined cape dropping another refined cape with an unpriced stone is flagged', () => {
        game.items[ARTIFICER_STAR].alchemyDetail.transmuteDropTable.push({
            itemHrid: GATHERER_STAR,
            dropRate: 0.02,
            minCount: 1,
            maxCount: 1,
        });
        game.actions['/actions/tailoring/gatherer_cape_refined'].inputItems = [
            { itemHrid: '/items/other_shard', count: 5 },
        ];
        game.items['/items/other_shard'] = { name: 'Other Shard', isTradable: true };
        game.buffVersion++;
        const result = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        expect(result).not.toBeNull();
        expect(result.unpricedOutputs).toContain(GATHERER_STAR);
    });

    test('an enhanced +N cape is not given a transmute row', () => {
        const all = calculator.calculateAllProfits(ARTIFICER_STAR, 3);
        expect(all.transmute).toBeUndefined();
    });

    test('the real refined cape gets the actions its data allows: coinify, decompose and transmute', () => {
        const all = calculator.calculateAllProfits(ARTIFICER_STAR, 0);
        expect(Object.keys(all)).toEqual(['coinify', 'decompose', 'transmute']);
        expect(all.decompose.unpricedOutputs).toContain(ARTIFICER);
    });

    test('game data not loaded yet: no row and no throw', () => {
        game.loaded = false;
        expect(calculator.calculateTransmuteProfit(ARTIFICER_STAR)).toBeNull();
        expect(calculator.calculateAllProfits(ARTIFICER_STAR, 0)).toEqual({});
    });

    test('an alchemist under the item level still gets a row, at a lower success rate', () => {
        const full = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        game.level = 40;
        const under = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        expect(under).not.toBeNull();
        expect(under.successRate).toBeLessThan(full.successRate);
    });

    test('a real quote for the cape (an Iron Cow vendor value, a listing) is used, not the stones', () => {
        game.books[ARTIFICER_STAR] = { ask: 90_000, bid: 80_000 };
        const result = calculator.calculateTransmuteProfit(ARTIFICER_STAR);
        expect(result.requirementCosts[0].price).toBe(90_000);
        expect(result.assumedCapes.map((c) => c.itemHrid)).not.toContain(ARTIFICER_STAR);
    });

    test('a custom price for a stone moves the cape, so the cached bill is not stale', () => {
        const before = calculator.calculateTransmuteProfit(ARTIFICER_STAR).requirementCosts[0].price;
        game.custom[`${SHARD}:buy`] = 2000;
        game.custom[`${SHARD}:sell`] = 2000;
        game.customVersion++;
        const after = calculator.calculateTransmuteProfit(ARTIFICER_STAR).requirementCosts[0].price;
        expect(before).toBe(100_000);
        expect(after).toBe(200_000);
    });
});
