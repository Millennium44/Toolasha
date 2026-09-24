/**
 * Gathering output revenue must not pay the marketplace fee on an Iron Cow character:
 * it has no market access to pay it on, whatever the price came from (vendor, coinify,
 * or the market-data value-map fallback that `getItemPrice` already resolves
 * transparently for such a character). `gathering-profit.test.js` covers the ordinary
 * (market-character) tax behavior; this file covers the Iron Cow branch specifically.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const game = vi.hoisted(() => ({ initClientData: null }));
const market = vi.hoisted(() => ({ prices: {} }));
const state = vi.hoisted(() => ({ gameMode: 'ironcow' }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getCurrentCharacterGameMode: () => state.gameMode,
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
    calculateBonusRevenue: () => ({
        totalBonusRevenue: 0,
        essenceFindBonus: 0,
        rareFindBonus: 0,
        rareFindBreakdown: {},
        bonusDrops: [],
        hasMissingPrices: false,
    }),
}));

const { calculateGatheringProfit } = await import('./gathering-profit.js');

const MILK = '/items/milk';
const COW = '/actions/milking/cow';

beforeEach(() => {
    state.gameMode = 'ironcow';
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
    market.prices = { [MILK]: 100 }; // getItemPrice already resolves an Iron Cow value here
});

describe('calculateGatheringProfit on an Iron Cow character', () => {
    test('revenue is not taxed: profit equals gross revenue', async () => {
        const result = await calculateGatheringProfit(COW);
        // 360 actions/hr x 1 milk x 100 = 36,000/hr revenue, no drink cost in this fixture
        expect(result.revenuePerHour).toBeCloseTo(36000, 6);
        expect(result.profitPerHour).toBeCloseTo(36000, 6);
    });

    test('the same action on a market character still pays the market tax (sanity check)', async () => {
        state.gameMode = 'standard';
        const result = await calculateGatheringProfit(COW);
        expect(result.profitPerHour).toBeCloseTo(36000 * (1 - MARKET_TAX), 6);
        expect(result.profitPerHour).toBeLessThan(result.revenuePerHour);
    });
});
