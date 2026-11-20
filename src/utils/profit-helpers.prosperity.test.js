/**
 * Prosperity coins in the production totals: paid per action, untaxed, in profit and not in revenue or tax.
 */

import { describe, test, expect } from 'vitest';
import { calculateProductionActionTotalsFromBase } from './profit-helpers.js';

const base = {
    actionsCount: 100,
    actionsPerHour: 360,
    outputAmount: 2,
    outputPrice: 100,
    gourmetBonus: 0,
    materialCosts: [{ totalCost: 50 }],
    totalTeaCostPerHour: 0,
};

describe('calculateProductionActionTotalsFromBase with Prosperity', () => {
    test('100 actions at 6 coins each add 600 to profit and nothing to revenue or tax', () => {
        const plain = calculateProductionActionTotalsFromBase(base);
        const withCoins = calculateProductionActionTotalsFromBase({ ...base, prosperityCoinsPerAction: 6 });
        expect(withCoins.totalProsperityCoins).toBe(600);
        expect(withCoins.totalProfit - plain.totalProfit).toBeCloseTo(600, 9);
        expect(withCoins.totalRevenue).toBe(plain.totalRevenue);
        expect(withCoins.totalMarketTax).toBe(plain.totalMarketTax);
        expect(withCoins.totalCosts).toBe(plain.totalCosts);
    });

    test('left out, nothing changes', () => {
        expect(calculateProductionActionTotalsFromBase(base).totalProsperityCoins).toBe(0);
    });
});
