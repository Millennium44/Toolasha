/**
 * Profit Calculator — material cost breakdown, time breakdown, community buff
 * math, skill lookup, production-action lookup and the crafting-cost fallback.
 * `calculateProfit` itself pulls in the full efficiency/bonus-revenue web and
 * is not exercised end-to-end here; these are the self-contained pieces it is
 * built from.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: {},
    initData: null,
    itemDetails: {},
    resolvedPrices: {},
    productionCosts: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key], getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseEfficiency: () => 0 }));
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => ({}) }));
vi.mock('../../utils/bonus-revenue-calculator.js', () => ({ calculateBonusRevenue: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getProductionCost: (hrid) => mocks.productionCosts[hrid] ?? 0,
    getProductionChainTime: () => 0,
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => null }));
vi.mock('../../utils/profit-constants.js', () => ({ MARKET_TAX: 0.02 }));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculateActionsPerHour: (t) => (t > 0 ? 3600 / Math.max(3, t) : 0),
    calculatePriceAfterTax: (price, tax = 0.02) => price * (1 - tax),
    calculateProfitPerAction: (perHour, actionsPerHour) => (actionsPerHour > 0 ? perHour / actionsPerHour : 0),
    calculateProfitPerDay: (perHour) => perHour * 24,
    calculateTeaCostsPerHour: () => ({ costs: [], totalCostPerHour: 0, hasMissingPrices: false }),
    createPriceCache: (fn) => fn,
    resolveItemPrice: (hrid) =>
        hrid in mocks.resolvedPrices
            ? { price: mocks.resolvedPrices[hrid], custom: false, missing: false }
            : { price: 0, custom: false, missing: true },
}));

const { default: profitCalculator } = await import('./profit-calculator.js');

beforeEach(() => {
    mocks.settings = {};
    mocks.initData = { actionDetailMap: {}, communityBuffTypeDetailMap: {} };
    mocks.itemDetails = {};
    mocks.resolvedPrices = {};
    mocks.productionCosts = {};
    profitCalculator._itemDetailMap = null;
    profitCalculator._actionDetailMap = null;
    profitCalculator._communityBuffMap = null;
});

describe('calculateMaterialCosts', () => {
    test('applies the artisan reduction to regular inputs only', () => {
        mocks.itemDetails['/items/wood'] = { name: 'Wood' };
        mocks.resolvedPrices['/items/wood'] = 100;

        const actionDetails = { inputItems: [{ itemHrid: '/items/wood', count: 10 }] };
        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0.1);

        expect(costs[0].baseAmount).toBe(10);
        expect(costs[0].amount).toBeCloseTo(9, 6); // 10 * (1 - 0.1)
        expect(costs[0].totalCost).toBeCloseTo(900, 6);
    });

    test('coin inputs price at exactly 1, bypassing the resolver', () => {
        const actionDetails = { inputItems: [{ itemHrid: '/items/coin', count: 500 }] };
        mocks.itemDetails['/items/coin'] = { name: 'Coin' };

        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0);
        expect(costs[0].askPrice).toBe(1);
        expect(costs[0].totalCost).toBe(500);
    });

    test('upgrade items are not affected by the artisan reduction', () => {
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.resolvedPrices['/items/rune'] = 1000;

        const actionDetails = { upgradeItemHrid: '/items/rune' };
        const costs = profitCalculator.calculateMaterialCosts(actionDetails, 0.5);

        expect(costs[0].amount).toBe(1); // untouched by 50% artisan reduction
        expect(costs[0].isUpgradeItem).toBe(true);
        expect(costs[0].totalCost).toBe(1000);
    });

    test('an upgrade item cheaper to craft than to buy is flagged and priced at craft cost', () => {
        mocks.settings.profitCalc_craftUpgradeItems = true;
        mocks.itemDetails['/items/rune'] = { name: 'Rune' };
        mocks.resolvedPrices['/items/rune'] = 1000; // market price
        mocks.productionCosts['/items/rune'] = 400; // cheaper to craft

        const costs = profitCalculator.calculateMaterialCosts({ upgradeItemHrid: '/items/rune' }, 0);

        expect(costs[0].isCrafted).toBe(true);
        expect(costs[0].askPrice).toBe(400);
    });

    test('a missing price is reported on the row rather than silently zeroed', () => {
        mocks.itemDetails['/items/mystery'] = { name: 'Mystery' };
        const costs = profitCalculator.calculateMaterialCosts(
            { inputItems: [{ itemHrid: '/items/mystery', count: 1 }] },
            0
        );
        expect(costs[0].missingPrice).toBe(true);
        expect(costs[0].totalCost).toBe(0);
    });

    test('an item with no known details is skipped entirely, not included at zero', () => {
        const costs = profitCalculator.calculateMaterialCosts(
            { inputItems: [{ itemHrid: '/items/unknown', count: 1 }] },
            0
        );
        expect(costs).toHaveLength(0);
    });
});

describe('calculateTimeBreakdown', () => {
    test('with no speed bonus, final time equals base time and there are no steps', () => {
        const breakdown = profitCalculator.calculateTimeBreakdown(10, 0);
        expect(breakdown).toEqual({
            baseTime: 10,
            steps: [],
            finalTime: 10,
            actionsPerHour: 360,
        });
    });

    test('a speed bonus reduces time and is reported as a step', () => {
        const breakdown = profitCalculator.calculateTimeBreakdown(10, 0.25);
        expect(breakdown.finalTime).toBeCloseTo(8, 6); // 10 / 1.25
        expect(breakdown.steps[0].bonus).toBeCloseTo(25, 6);
        expect(breakdown.steps[0].reduction).toBeCloseTo(2, 6);
    });
});

describe('calculateCommunityBuffBonus', () => {
    test('zero buff level is zero bonus, no lookup needed', () => {
        expect(profitCalculator.calculateCommunityBuffBonus(0, '/action_types/milking')).toBe(0);
    });

    test('a buff that does not apply to this action type contributes nothing', () => {
        mocks.initData.communityBuffTypeDetailMap = {
            '/community_buff_types/production_efficiency': {
                usableInActionTypeMap: { '/action_types/cooking': true },
                buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
            },
        };
        expect(profitCalculator.calculateCommunityBuffBonus(5, '/action_types/milking')).toBe(0);
    });

    test('applies the flat boost plus a per-level bonus above level 1', () => {
        mocks.initData.communityBuffTypeDetailMap = {
            '/community_buff_types/production_efficiency': {
                usableInActionTypeMap: { '/action_types/cooking': true },
                buff: { flatBoost: 0.14, flatBoostLevelBonus: 0.003 },
            },
        };
        // level 1: just the base 14%
        expect(profitCalculator.calculateCommunityBuffBonus(1, '/action_types/cooking')).toBeCloseTo(14, 6);
        // level 11: 14% + 10 * 0.3%
        expect(profitCalculator.calculateCommunityBuffBonus(11, '/action_types/cooking')).toBeCloseTo(17, 6);
    });
});

describe('getSkillLevel', () => {
    test('maps an action type hrid to its skill and reads the level', () => {
        const skills = [{ skillHrid: '/skills/milking', level: 42 }];
        expect(profitCalculator.getSkillLevel(skills, '/action_types/milking')).toBe(42);
    });

    test('an unknown skill defaults to level 1 rather than throwing', () => {
        expect(profitCalculator.getSkillLevel([], '/action_types/milking')).toBe(1);
    });
});

describe('findProductionAction', () => {
    test('finds the action whose outputItems include the target item', () => {
        mocks.initData.actionDetailMap = {
            '/actions/milking/cow': { outputItems: [{ itemHrid: '/items/milk', count: 1 }] },
        };
        const action = profitCalculator.findProductionAction('/items/milk');
        expect(action.actionHrid).toBe('/actions/milking/cow');
        expect(action.count).toBe(1);
    });

    test('returns null for an item nothing produces', () => {
        mocks.initData.actionDetailMap = { '/actions/milking/cow': { outputItems: [] } };
        expect(profitCalculator.findProductionAction('/items/nonexistent')).toBeNull();
    });
});

describe('calculateCraftingCostFallback', () => {
    test('sums priced inputs plus the upgrade item, divided by output count', () => {
        mocks.initData.actionDetailMap = {
            '/actions/craft/thing': {
                upgradeItemHrid: '/items/rune',
                inputItems: [{ itemHrid: '/items/wood', count: 4 }],
                outputItems: [{ itemHrid: '/items/thing', count: 2 }],
            },
        };
        const getCachedPrice = (hrid) => ({ '/items/rune': 100, '/items/wood': 10 })[hrid] ?? 0;

        const cost = profitCalculator.calculateCraftingCostFallback('/items/thing', getCachedPrice);
        // (100 + 4*10) / 2 = 70
        expect(cost).toBe(70);
    });

    test('an item with no crafting action falls back to zero', () => {
        mocks.initData.actionDetailMap = {};
        expect(profitCalculator.calculateCraftingCostFallback('/items/nothing', () => 0)).toBe(0);
    });
});
