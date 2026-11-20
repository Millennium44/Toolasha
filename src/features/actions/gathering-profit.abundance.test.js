/**
 * Abundance (talisman Special line): a chance to triple what a gathering action gathers, so the gathered amount is
 * (1 + 2 x chance) times larger in expectation. The chance comes from the efficiency context (that half is covered
 * in efficiency.skilling-specials.test.js, from real talisman lines); this file covers how the gathering profit
 * spends it: on the drop table's resources and on the Processing conversions of the same stack, not on essence or
 * rare finds.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({ initClientData: null }));
const market = vi.hoisted(() => ({ prices: {} }));
const ctx = vi.hoisted(() => ({ abundance: 0, processingBonus: 0 }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getCurrentCharacterGameMode: () => 'standard',
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => fallback },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in market.prices ? market.prices[hrid] : null),
}));

vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: () => ({
        equipment: new Map(),
        drinkSlots: [],
        drinkConcentration: 0,
        actionTime: 10, // seconds -> 360 actions/hour
        speedBonus: 0,
        gourmetBonus: 0,
        processingBonus: ctx.processingBonus,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        houseEfficiency: 0,
        teaEfficiency: 0,
        achievementEfficiency: 0,
        personalEfficiency: 0,
        totalGathering: 0,
        gatheringDetails: { gatheringTea: 0, communityGathering: 0, achievementGathering: 0, personalGathering: 0 },
        abundance: ctx.abundance,
        efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0 },
        efficiencyMultiplier: 1,
    }),
}));

vi.mock('../../utils/bonus-revenue-calculator.js', () => ({
    calculateBonusRevenue: () => ({
        totalBonusRevenue: 1000,
        essenceFindBonus: 0,
        rareFindBonus: 0,
        rareFindBreakdown: {},
        bonusDrops: [],
        hasMissingPrices: false,
    }),
}));

const { calculateGatheringProfit } = await import('./gathering-profit.js');

const MILK = '/items/milk';
const CHEESE = '/items/cheese';
const COW = '/actions/milking/cow';

beforeEach(() => {
    ctx.abundance = 0;
    ctx.processingBonus = 0;
    game.initClientData = {
        actionDetailMap: {
            [COW]: {
                type: '/action_types/milking',
                baseTimeCost: 10e9,
                dropTable: [{ itemHrid: MILK, dropRate: 1, minCount: 1, maxCount: 1 }],
            },
            '/actions/cheesesmithing/cheese': {
                type: '/action_types/cheesesmithing',
                inputItems: [{ itemHrid: MILK, count: 1 }],
                outputItems: [{ itemHrid: CHEESE, count: 1 }],
            },
        },
        itemDetailMap: { [MILK]: { name: 'Milk' }, [CHEESE]: { name: 'Cheese' } },
    };
    market.prices = { [MILK]: 100, [CHEESE]: 150 };
});

describe('Abundance in the gathering profit', () => {
    test('no Abundance: 360 actions x 1 milk x 100 coins, plus the 1,000 of essence and rare finds', async () => {
        const result = await calculateGatheringProfit(COW);
        expect(result.baseOutputs[0].itemsPerHour).toBeCloseTo(360, 9);
        expect(result.revenuePerHour).toBeCloseTo(36000 + 1000, 6);
    });

    test('a 5% chance to triple is 1 + 2 x 0.05 = 1.1 times the milk: 396 an hour', async () => {
        ctx.abundance = 0.05;
        const result = await calculateGatheringProfit(COW);
        expect(result.abundance).toBe(0.05);
        expect(result.baseOutputs[0].itemsPerHour).toBeCloseTo(396, 9);
        // 396 x 100 = 39,600 of milk; the 1,000 of essence and rare finds is not tripled
        expect(result.revenuePerHour).toBeCloseTo(39600 + 1000, 6);
        expect(result.profitPerHour).toBeCloseTo(40600 * (1 - MARKET_TAX), 6);
    });

    test('Processing converts the same stack: 0.95 x 1 + 0.05 x 3 = 1.1 conversions a completion', async () => {
        ctx.abundance = 0.05;
        ctx.processingBonus = 1;
        const result = await calculateGatheringProfit(COW);
        // 360 x 1.1 = 396 conversions an hour, each worth 150 - 100 = 50
        expect(result.processingConversions[0].conversionsPerHour).toBeCloseTo(396, 9);
        expect(result.processingRevenueBonus).toBeCloseTo(396 * 50, 6);
    });
});
