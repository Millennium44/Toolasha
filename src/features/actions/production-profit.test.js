/**
 * Tests for the Production Profit Calculator
 *
 * production-profit.js is a thin adapter: it decides whether an action is a
 * production action, hands the output item to the shared profit calculator, and
 * reshapes the answer for the action panel. Both halves are pinned here — the
 * gate (which actions it accepts, and what it asks the calculator about) and
 * the reshaping arithmetic (rounding, decimal rules, pass-through fields).
 *
 * The market profit calculator is mocked at its module boundary; it has its own
 * math and is not what this file is responsible for.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
}));

const calculator = vi.hoisted(() => ({
    /** Records every itemHrid the adapter asked about */
    requestedItems: [],
    result: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
    },
}));

vi.mock('../market/profit-calculator.js', () => ({
    default: {
        calculateProfit: async (itemHrid) => {
            calculator.requestedItems.push(itemHrid);
            return calculator.result;
        },
    },
}));

const { calculateProductionProfit, formatProfitDisplay } = await import('./production-profit.js');

const TEA = '/items/efficiency_tea';
const BREW = '/actions/brewing/efficiency_tea';

/**
 * A realistic profit-calculator result: 300 actions/hour at 120% efficiency,
 * one tea per action selling for 490 after tax.
 */
function profitCalculatorResult(overrides = {}) {
    return {
        profitPerHour: 61234.6,
        profitPerDay: 1469630.4,
        itemsPerHour: 660,
        gourmetBonusItems: 39.6,
        priceAfterTax: 490.2,
        actionsPerHour: 300,
        materialCostPerHour: 200000.4,
        totalTeaCostPerHour: 6900.6,
        totalEfficiency: 120,
        materialCosts: [{ itemHrid: '/items/cotton', totalCost: 250 }],
        teaCosts: [{ itemHrid: '/items/gathering_tea', totalCost: 300 }],
        pricingMode: 'hybrid',
        levelEfficiency: 45,
        houseEfficiency: 12,
        teaEfficiency: 13.5,
        equipmentEfficiency: 49.5,
        artisanBonus: 0.112,
        gourmetBonus: 0.06,
        efficiencyMultiplier: 2.2,
        ...overrides,
    };
}

beforeEach(() => {
    calculator.requestedItems = [];
    calculator.result = profitCalculatorResult();
    game.initClientData = {
        actionDetailMap: {
            [BREW]: {
                type: '/action_types/brewing',
                outputItems: [{ itemHrid: TEA, count: 1 }],
            },
            '/actions/cooking/donut': {
                type: '/action_types/cooking',
                outputItems: [
                    { itemHrid: '/items/donut', count: 1 },
                    { itemHrid: '/items/crumbs', count: 1 },
                ],
            },
            '/actions/milking/cow': {
                type: '/action_types/milking',
                dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
            '/actions/crafting/nothing': {
                type: '/action_types/crafting',
                outputItems: [],
            },
        },
    };
});

describe('calculateProductionProfit', () => {
    test('asks the profit calculator about the action output', async () => {
        const result = await calculateProductionProfit(BREW);

        expect(calculator.requestedItems).toEqual([TEA]);
        expect(result).toBe(calculator.result);
    });

    test('uses the first output when an action makes several things', async () => {
        await calculateProductionProfit('/actions/cooking/donut');

        expect(calculator.requestedItems).toEqual(['/items/donut']);
    });

    test('returns null for an unknown action', async () => {
        expect(await calculateProductionProfit('/actions/brewing/nonexistent')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null for a gathering action', async () => {
        expect(await calculateProductionProfit('/actions/milking/cow')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null for a production action with no outputs', async () => {
        expect(await calculateProductionProfit('/actions/crafting/nothing')).toBeNull();
        expect(calculator.requestedItems).toEqual([]);
    });

    test('returns null when the calculator cannot price the item', async () => {
        calculator.result = null;

        expect(await calculateProductionProfit(BREW)).toBeNull();
        expect(calculator.requestedItems).toEqual([TEA]);
    });
});

describe('formatProfitDisplay', () => {
    test('returns null for missing profit data', () => {
        expect(formatProfitDisplay(null)).toBeNull();
    });

    test('pins revenue, costs and rounding', () => {
        const display = formatProfitDisplay(profitCalculatorResult());

        // revenue = (660 base + 39.6 gourmet) × 490.2 = 699.6 × 490.2 = 342,943.92 → 342,944
        expect(display.revenue).toBe(342944);
        // costs = 200,000.4 materials + 6,900.6 tea = 206,901
        expect(display.costs).toBe(206901);
        expect(display.profit).toBe(61235); // 61,234.6 rounded
        expect(display.profitPerDay).toBe(1469630); // 1,469,630.4 rounded
        expect(display.priceEach).toBe(490); // 490.2 rounded
        expect(display.totalMaterialCost).toBe(200000);
        expect(display.totalTeaCost).toBe(6901);
    });

    test('keeps one decimal on rates at or above 1 and two below it', () => {
        const display = formatProfitDisplay(
            profitCalculatorResult({
                actionsPerHour: 300.456,
                itemsPerHour: 660.44,
                gourmetBonusItems: 0.396,
            })
        );

        expect(display.actionsPerHour).toBe(300.5);
        expect(display.baseOutputItems).toBe(660.4);
        expect(display.gourmetBonusItems).toBe(0.4); // 0.396 → 2dp → 0.40 → 0.4
    });

    test('carries the pricing mode and efficiency breakdown through untouched', () => {
        const source = profitCalculatorResult({ pricingMode: 'bid' });
        const display = formatProfitDisplay(source);

        expect(display.pricingMode).toBe('bid');
        expect(display.totalEfficiency).toBe(120);
        expect(display.details).toEqual({
            levelEfficiency: 45,
            houseEfficiency: 12,
            teaEfficiency: 13.5,
            equipmentEfficiency: 49.5,
            artisanBonus: 0.112,
            gourmetBonus: 0.06,
            efficiencyMultiplier: 2.2,
        });
        expect(display.materialCosts).toBe(source.materialCosts);
        expect(display.teaCosts).toBe(source.teaCosts);
    });

    test('reports a loss without mangling the sign', () => {
        const display = formatProfitDisplay(profitCalculatorResult({ profitPerHour: -1500.4, profitPerDay: -36009.6 }));

        expect(display.profit).toBe(-1500);
        expect(display.profitPerDay).toBe(-36010);
    });
});
