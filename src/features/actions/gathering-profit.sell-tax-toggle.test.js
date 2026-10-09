/**
 * The personal-use sell-tax exclusion (`profitCalc_excludeSellTax`) in the gathering calculator.
 * Off: unchanged numbers. On: the market tax is not deducted and the result says so. An Iron Cow
 * character is already untaxed, so it is never flagged. `keepSellTax` opts a consumer out.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({ initClientData: null }));
const market = vi.hoisted(() => ({ prices: {} }));
const state = vi.hoisted(() => ({ gameMode: 'standard', settings: {}, bonusOptions: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getCurrentCharacterGameMode: () => state.gameMode,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => (key in state.settings ? state.settings[key] : fallback) },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in market.prices ? market.prices[hrid] : null),
}));

vi.mock('../../utils/efficiency.js', () => ({
    getActionEfficiencyContext: () => ({
        equipment: new Map(),
        drinkSlots: [],
        drinkConcentration: 0,
        actionTime: 10,
        speedBonus: 0,
        gourmetBonus: 0,
        processingBonus: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        houseEfficiency: 0,
        teaEfficiency: 0,
        achievementEfficiency: 0,
        personalEfficiency: 0,
        totalGathering: 0,
        gatheringDetails: {
            gatheringTea: 0,
            communityGathering: 0,
            achievementGathering: 0,
            personalGathering: 0,
        },
        efficiencyBreakdown: { totalEfficiency: 0, levelEfficiency: 0 },
        efficiencyMultiplier: 1,
    }),
}));

vi.mock('../../utils/bonus-revenue-calculator.js', () => ({
    calculateBonusRevenue: (_a, _b, _c, _d, options) => {
        state.bonusOptions.push(options);
        return {
            totalBonusRevenue: 0,
            essenceFindBonus: 0,
            rareFindBonus: 0,
            rareFindBreakdown: {},
            bonusDrops: [],
            hasMissingPrices: false,
        };
    },
}));

const { calculateGatheringProfit } = await import('./gathering-profit.js');

const MILK = '/items/milk';
const COW = '/actions/milking/cow';

beforeEach(() => {
    state.gameMode = 'standard';
    state.settings = {};
    game.initClientData = {
        actionDetailMap: {
            [COW]: {
                type: '/action_types/milking',
                baseTimeCost: 10e9,
                dropTable: [{ itemHrid: MILK, dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        },
        itemDetailMap: { [MILK]: { name: 'Milk' } },
    };
    market.prices = { [MILK]: 100 };
});

describe('calculateGatheringProfit sell-tax exclusion', () => {
    test('off (default): the tax is deducted exactly as before and nothing is flagged', async () => {
        const result = await calculateGatheringProfit(COW);

        // 360 actions/hr x 1 milk x 100
        expect(result.revenuePerHour).toBeCloseTo(36000, 6);
        expect(result.marketTax).toBeCloseTo(36000 * MARKET_TAX, 6);
        expect(result.profitPerHour).toBeCloseTo(36000 * (1 - MARKET_TAX), 6);
        expect(result.excludeSellTax).toBe(false);
    });

    test('on: no tax, profit equals revenue, and the result carries the flag', async () => {
        state.settings.profitCalc_excludeSellTax = true;

        const result = await calculateGatheringProfit(COW);

        expect(result.revenuePerHour).toBeCloseTo(36000, 6);
        expect(result.marketTax).toBe(0);
        expect(result.profitPerHour).toBeCloseTo(36000, 6);
        expect(result.excludeSellTax).toBe(true);
    });

    test('on: container drops are valued gross; off or keepSellTax: they are not', async () => {
        state.settings.profitCalc_excludeSellTax = true;
        state.bonusOptions.length = 0;
        await calculateGatheringProfit(COW);
        expect(state.bonusOptions.at(-1)).toEqual({ grossContainers: true });

        await calculateGatheringProfit(COW, { keepSellTax: true });
        expect(state.bonusOptions.at(-1)).toEqual({ grossContainers: false });

        state.settings.profitCalc_excludeSellTax = false;
        await calculateGatheringProfit(COW);
        expect(state.bonusOptions.at(-1)).toEqual({ grossContainers: false });
    });

    test('keepSellTax: the setting is ignored (planners, optimizers, rankings)', async () => {
        state.settings.profitCalc_excludeSellTax = true;

        const result = await calculateGatheringProfit(COW, { keepSellTax: true });

        expect(result.profitPerHour).toBeCloseTo(36000 * (1 - MARKET_TAX), 6);
        expect(result.excludeSellTax).toBe(false);
    });

    test('Iron Cow: untaxed either way, and never flagged as an exclusion', async () => {
        state.gameMode = 'ironcow';

        const off = await calculateGatheringProfit(COW);
        state.settings.profitCalc_excludeSellTax = true;
        const on = await calculateGatheringProfit(COW);

        expect(off.profitPerHour).toBeCloseTo(36000, 6);
        expect(on.profitPerHour).toBeCloseTo(36000, 6);
        expect(off.excludeSellTax).toBe(false);
        expect(on.excludeSellTax).toBe(false);
    });
});
