/**
 * Prosperity (talisman Special line, Cheesesmithing, Crafting and Tailoring only): with its chance an action also pays
 * coins equal to the vendor value (`sellPrice`) of what it produced. Coins are untaxed, so the gain is
 * chance x sellPrice x items made, straight into the profit, and not into the taxed revenue.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ initData: null, itemDetails: {}, efficiencyContext: {}, marketPrices: {} }));

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
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => mocks.efficiencyContext }));
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

/** An equipment Map carrying a talisman share of the given noncombat stats */
const wearing = (noncombat) => attachTalismanBonuses(new Map(), { noncombat, buffs: {}, combat: {} });

function context(equipment, extra = {}) {
    return {
        equipment,
        drinkSlots: [],
        drinkConcentration: 0,
        itemDetailMap: {},
        actionTime: 10, // 360 actions an hour
        artisanBonus: 0,
        gourmetBonus: 0,
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
        efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0, effectiveRequirement: 1 },
        efficiencyMultiplier: 1,
        ...extra,
    };
}

function recipe(type) {
    const skill = type.replace('/action_types/', '');
    const output = `/items/${skill}_cheese`;
    mocks.itemDetails[output] = { name: 'Cheese', sellPrice: 20 };
    mocks.itemDetails['/items/milk'] = { name: 'Milk' };
    mocks.initData = {
        actionDetailMap: {
            [`/actions/${skill}/cheese`]: {
                type,
                baseTimeCost: 10e9,
                inputItems: [{ itemHrid: '/items/milk', count: 1 }],
                outputItems: [{ itemHrid: output, count: 1 }],
            },
        },
        communityBuffTypeDetailMap: {},
    };
    mocks.marketPrices = { '/items/milk': 10, [output]: 100 };
    return output;
}

beforeEach(() => {
    mocks.itemDetails = {};
    profitCalculator._itemDetailMap = null;
    profitCalculator._actionDetailMap = null;
    profitCalculator._communityBuffMap = null;
});

describe('Prosperity in the production profit', () => {
    test('a 5% chance on 360 cheese an hour at a vendor value of 20 is 0.05 x 20 x 360 = 360 untaxed coins an hour', async () => {
        const out = recipe('/action_types/cheesesmithing');
        mocks.efficiencyContext = context(wearing({}));
        const bare = await profitCalculator.calculateProfit(out);

        mocks.efficiencyContext = context(wearing({ prosperity: 0.05 }));
        const result = await profitCalculator.calculateProfit(out);

        expect(result.prosperityCoinsPerHour).toBeCloseTo(360, 9);
        expect(result.profitPerHour - bare.profitPerHour).toBeCloseTo(360, 9);
        // not sold on the market: the taxed revenue and the tax are what they were
        expect(result.revenuePerHour).toBe(bare.revenuePerHour);
        expect(result.marketTax).toBe(bare.marketTax);
    });

    test('Gourmet copies are not counted: only the 360 items the recipe makes', async () => {
        const out = recipe('/action_types/crafting');
        mocks.efficiencyContext = context(wearing({ prosperity: 0.05 }), { gourmetBonus: 0.5 });
        const result = await profitCalculator.calculateProfit(out);
        expect(result.prosperityCoinsPerHour).toBeCloseTo(360, 9);
    });

    test('efficiency repeats count: 1.5 repeats an action is 540 items an hour, 540 coins', async () => {
        const out = recipe('/action_types/tailoring');
        mocks.efficiencyContext = context(wearing({ prosperity: 0.05 }), { efficiencyMultiplier: 1.5 });
        const result = await profitCalculator.calculateProfit(out);
        expect(result.prosperityCoinsPerHour).toBeCloseTo(540, 9);
    });

    test('brewing and cooking get nothing, whatever the stat says', async () => {
        for (const type of ['/action_types/brewing', '/action_types/cooking']) {
            profitCalculator._actionDetailMap = null;
            const out = recipe(type);
            mocks.efficiencyContext = context(wearing({ prosperity: 0.05 }));
            const result = await profitCalculator.calculateProfit(out);
            expect(result.prosperityCoinsPerHour, type).toBe(0);
        }
    });

    test('an output with no vendor value pays nothing, and says so as zero coins, not NaN', async () => {
        const out = recipe('/action_types/cheesesmithing');
        mocks.itemDetails[out] = { name: 'Cheese' };
        mocks.efficiencyContext = context(wearing({ prosperity: 0.05 }));
        const result = await profitCalculator.calculateProfit(out);
        expect(result.prosperityCoinsPerHour).toBe(0);
        expect(Number.isFinite(result.profitPerHour)).toBe(true);
    });
});
