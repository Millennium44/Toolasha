/**
 * Invigoration in the production profit: the drinks as they are or twice as strong, each outcome worked out whole and
 * weighted, so efficiency and Gourmet (which come from the same drinks) stay correlated inside the product.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initData: null,
    itemDetails: {},
    efficiencyContext: () => ({}),
    marketPrices: {},
    context: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => undefined, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
        getSkills: () =>
            ['cheesesmithing', 'crafting', 'tailoring', 'brewing', 'cooking'].map((name) => ({
                skillHrid: `/skills/${name}`,
                level: 50,
            })),
        getActionDetails: (hrid) => mocks.initData?.actionDetailMap?.[hrid] ?? null,
        getCommunityBuffLevel: () => 0,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => mocks.context ?? { equipment: new Map(), drinks: [] },
}));
vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: (_action, options) => mocks.efficiencyContext(options.actionContext?.drinkOutcome),
}));
vi.mock('../../utils/bonus-revenue-calculator.js', () => ({
    calculateBonusRevenue: () => ({ totalBonusRevenue: 0, taxExemptBonusRevenue: 0, hasMissingPrices: false }),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getProductionCost: () => 0,
    getProductionChainTime: () => 0,
}));
vi.mock('../../utils/enhancement-pricing.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getProductionCostDetailed: () => ({ cost: 0, partial: false }),
    getProductionCost: () => 0,
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => mocks.marketPrices[hrid] ?? null,
    getItemPrices: () => null,
    getPricingMode: () => 'ask',
}));
vi.mock('../../utils/profit-constants.js', () => ({ MARKET_TAX: 0.02 }));
// The tooltip path: no tile scrolls are assumed, so calculateTooltipCraftProfit calls calculateProfit straight
vi.mock('../actions/tile-scrolls.js', () => ({
    getTileScrolls: () => new Set(),
    runWithTileScrolls: (_type, fn) => ({ result: fn(), simulated: [] }),
    runWithoutScrolls: (_type, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculateActionsPerHour: (t) => (t > 0 ? 3600 / Math.max(3, t) : 0),
    calculatePriceAfterTax: (price, tax = 0.02) => price * (1 - tax),
    outputTaxRate: (tax = 0.02) => tax,
    calculateProfitPerAction: (perHour, actionsPerHour) => (actionsPerHour > 0 ? perHour / actionsPerHour : 0),
    calculateProfitPerDay: (perHour) => perHour * 24,
    calculateTeaCostsPerHour: () => ({ costs: [], totalCostPerHour: 0, hasMissingPrices: false }),
    createPriceCache: (fn) => fn,
    resolveItemPrice: (hrid) => ({ price: mocks.marketPrices[hrid] ?? null, custom: false, missing: false }),
}));

const { default: profitCalculator } = await import('./profit-calculator.js');
const { attachTalismanBonuses } = await import('../../utils/talisman-bonuses.js');

const wearing = (noncombat) => attachTalismanBonuses(new Map(), { noncombat, buffs: {}, combat: {} });

/** The efficiency context of one outcome: the doubled drinks give more efficiency and more Gourmet together */
function outcomeContext(equipment, outcome) {
    const doubled = outcome === 'doubled';
    return {
        equipment,
        drinkSlots: [],
        drinkConcentration: 0,
        itemDetailMap: {},
        actionTime: 10, // 360 actions an hour
        artisanBonus: doubled ? 0.2 : 0.1,
        gourmetBonus: doubled ? 0.5 : 0,
        processingBonus: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        houseEfficiency: 0,
        teaEfficiency: 0,
        achievementEfficiency: 0,
        personalEfficiency: 0,
        actionLevelBonus: 0,
        teaSkillLevelBonus: 0,
        baseRequirement: 1,
        speedBonus: 0,
        personalSpeedBonus: 0,
        efficiencyBreakdown: { totalEfficiency: doubled ? 100 : 0, levelEfficiency: 0, effectiveRequirement: 1 },
        efficiencyMultiplier: doubled ? 2 : 1,
    };
}

beforeEach(() => {
    mocks.context = null;
    mocks.itemDetails = { '/items/cooking_cheese': { name: 'Cheese' }, '/items/milk': { name: 'Milk' } };
    mocks.initData = {
        actionDetailMap: {
            '/actions/cooking/cheese': {
                type: '/action_types/cooking',
                baseTimeCost: 10e9,
                inputItems: [{ itemHrid: '/items/milk', count: 1 }],
                outputItems: [{ itemHrid: '/items/cooking_cheese', count: 1 }],
            },
        },
        communityBuffTypeDetailMap: {},
    };
    mocks.marketPrices = { '/items/milk': 0, '/items/cooking_cheese': 100 };
    profitCalculator._itemDetailMap = null;
    profitCalculator._actionDetailMap = null;
    profitCalculator._communityBuffMap = null;
});

describe('calculateProfit with Invigoration', () => {
    test('each outcome is worked out whole: 50% x (360 items) + 50% x (720 x 1.5 = 1,080) = 720 items, 72,000 revenue', async () => {
        const equipment = wearing({ invigoration: 0.5 });
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        const result = await profitCalculator.calculateProfit('/items/cooking_cheese', {
            actionContext: { equipment, drinks: [] },
        });
        expect(result.totalItemsPerHour).toBeCloseTo(720, 9);
        expect(result.revenuePerHour).toBeCloseTo(72000, 6);
        // averaging the drinks first (efficiency x1.5, Gourmet 0.25) would have made 675 items, 67,500 coins
        expect(result.revenuePerHour).not.toBeCloseTo(67500, 0);
    });

    test('the outcomes behind the mix are exposed, but not as an enumerable key', async () => {
        const equipment = wearing({ invigoration: 0.5 });
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        const result = await profitCalculator.calculateProfit('/items/cooking_cheese', {
            actionContext: { equipment, drinks: [] },
        });
        expect(result.outcomeRuns.map((run) => run.weight)).toEqual([0.5, 0.5]);
        expect(result.outcomeRuns.map((run) => run.value.gourmetBonus)).toEqual([0, 0.5]);
        expect(Object.keys(result)).not.toContain('outcomeRuns');
        expect({ ...result }.outcomeRuns).toBeUndefined();
    });

    test('without the line, one outcome: the plain figure and no outcome list', async () => {
        const equipment = wearing({});
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        const result = await profitCalculator.calculateProfit('/items/cooking_cheese', {
            actionContext: { equipment, drinks: [] },
        });
        expect(result.outcomeRuns).toBeUndefined();
    });

    test('without the line, one outcome: the plain figure', async () => {
        const equipment = wearing({});
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        const result = await profitCalculator.calculateProfit('/items/cooking_cheese', {
            actionContext: { equipment, drinks: [] },
        });
        expect(result.revenuePerHour).toBeCloseTo(36000, 6);
    });

    test('Artisan: the material lines are mixed entry by entry, so the queue totals read the same total (90 vs 80)', async () => {
        const { calculateProductionActionTotalsFromBase } = await vi.importActual('../../utils/profit-helpers.js');
        const equipment = wearing({ invigoration: 0.12 });
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        mocks.initData.actionDetailMap['/actions/cooking/cheese'].inputItems = [{ itemHrid: '/items/milk', count: 10 }];
        mocks.marketPrices['/items/milk'] = 10;

        const result = await profitCalculator.calculateProfit('/items/cooking_cheese', {
            actionContext: { equipment, drinks: [] },
        });

        // normal: 10 milk x (1 - 0.1) x 10 = 90; doubled: 10 x (1 - 0.2) x 10 = 80; 0.88 x 90 + 0.12 x 80 = 88.8
        expect(result.totalMaterialCost).toBeCloseTo(88.8, 9);
        expect(result.materialCosts).toHaveLength(1);
        expect(result.materialCosts[0].totalCost).toBeCloseTo(88.8, 9);
        expect(result.materialCosts[0].amount).toBeCloseTo(0.88 * 9 + 0.12 * 8, 9);
        const totals = calculateProductionActionTotalsFromBase({
            actionsCount: 1,
            actionsPerHour: result.actionsPerHour,
            outputAmount: 1,
            outputPrice: result.outputPrice,
            gourmetBonus: 0,
            materialCosts: result.materialCosts,
            totalTeaCostPerHour: 0,
        });
        expect(totals.totalMaterialCost).toBeCloseTo(88.8, 9);
    });
});

describe('the held-materials line reads the real calculateProfit figure through the tooltip path', () => {
    test('each outcome is compared before the mix, so a figure that lost its outcomes on the way reads differently', async () => {
        const equipment = wearing({ invigoration: 0.5 });
        mocks.efficiencyContext = (outcome) => outcomeContext(equipment, outcome);
        mocks.initData.actionDetailMap['/actions/cooking/cheese'].inputItems = [{ itemHrid: '/items/milk', count: 10 }];
        mocks.marketPrices['/items/milk'] = 10;
        const { calculateTooltipCraftProfit } = await import('./tooltip-tile-scrolls.js');
        const { heldCraftCompare } = await import('./tooltip-prices.js');

        // The tooltip passes no context, so the worn drinks come from the resolver
        mocks.context = { equipment, drinks: [] };
        const { profitData } = await calculateTooltipCraftProfit('/items/cooking_cheese');
        expect(profitData.outcomeRuns).toHaveLength(2);

        const sellOf = () => 9;
        const compared = heldCraftCompare(profitData, null, { sellOf });
        const perOutcome = profitData.outcomeRuns.reduce(
            (sum, run) => sum + run.weight * heldCraftCompare(run.value, null, { sellOf }).net,
            0
        );
        expect(compared.net).toBeCloseTo(perOutcome, 9);
        // The averaged figure gives a different answer, which is what a lost property would silently fall back to
        const averaged = heldCraftCompare({ ...profitData }, null, { sellOf });
        expect(Math.abs(averaged.net - compared.net)).toBeGreaterThan(1e-6);
    });
});
