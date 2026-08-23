/**
 * Tests for the Task Profit Calculator
 *
 * The game is mocked, not the calculator: each test decides what the Task Shop
 * sells, what the market pays, and what the action underneath the task earns.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';

const game = vi.hoisted(() => ({
    initClientData: null,
    taskSpeedBonus: 0,
}));

const market = vi.hoisted(() => ({
    prices: {},
    expectedValues: {},
    evInitialized: true,
}));

const actions = vi.hoisted(() => ({
    gathering: null,
    production: null,
    cachedStats: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getTaskSpeedBonus: () => game.taskSpeedBonus,
    },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        get isInitialized() {
            return market.evInitialized;
        },
        calculateExpectedValue: (hrid) =>
            market.expectedValues[hrid] === undefined ? null : { expectedValue: market.expectedValues[hrid] },
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => market.prices[hrid] ?? 0,
    getItemPrices: () => null,
}));

vi.mock('../actions/gathering-profit.js', () => ({
    calculateGatheringProfit: async () => actions.gathering,
}));

vi.mock('../actions/production-profit.js', () => ({
    calculateProductionProfit: async () => actions.production,
}));

vi.mock('../actions/action-panel-sort.js', () => ({
    default: {
        get cachedStats() {
            return actions.cachedStats;
        },
    },
}));

const {
    calculateTaskTokenValue,
    calculateTaskRewardValue,
    calculateTaskProfit,
    getCowbellValue,
    getBestAlternativeProfitPerHour,
    findBestTaskShopValue,
} = await import('./task-profit-calculator.js');

const TOKEN = '/items/task_token';

/** A Task Shop with two lines, the second a better deal per token */
function shopWithTwoLines() {
    return {
        initClientData: {
            taskShopItemDetailMap: {
                a: { itemHrid: '/items/large_treasure_chest', cost: { itemHrid: TOKEN, count: 30 } },
                b: { itemHrid: '/items/task_crystal', cost: { itemHrid: TOKEN, count: 10 } },
            },
            itemDetailMap: {
                '/items/large_treasure_chest': { isOpenable: true },
                '/items/task_crystal': {},
            },
            actionDetailMap: {
                '/actions/milking/cow': { name: 'Cow', type: '/action_types/milking' },
            },
        },
    };
}

beforeEach(() => {
    game.initClientData = shopWithTwoLines().initClientData;
    game.taskSpeedBonus = 0;
    market.evInitialized = true;
    market.prices = { '/items/task_crystal': 5000, '/items/bag_of_10_cowbells': 2000000 };
    market.expectedValues = { '/items/large_treasure_chest': 60000, '/items/purples_gift': 500000 };
    actions.gathering = null;
    actions.production = null;
    actions.cachedStats = {};
});

describe('task shop token valuation', () => {
    test('reads the shop map and picks the best coins-per-token line', () => {
        // chest: 60000 / 30 = 2000 (an expected value, already net of tax);
        // crystal: 5000 post-tax / 10 = 475
        const best = findBestTaskShopValue();
        expect(best.itemHrid).toBe('/items/large_treasure_chest');
        expect(best.perToken).toBe(2000);
        expect(calculateTaskTokenValue().tokenValue).toBe(2000);
    });

    test('a market-priced shop line is valued after tax, like every other sell side', () => {
        // A token is worth what the shop line would actually fetch, and selling it pays the
        // marketplace cut. Quoting it gross while the action profit it is weighed against is
        // net made every task look better than it was.
        market.prices['/items/task_crystal'] = 90000; // 90000 × (1 − tax) / 10 tokens
        expect(calculateTaskTokenValue().tokenValue).toBe(calculatePriceAfterTax(90000) / 10);
    });

    test('reports an error when the shop map is unavailable', () => {
        game.initClientData = {};
        expect(calculateTaskTokenValue().error).toBe('Task Shop data unavailable');
    });

    test('ignores lines that are not bought with task tokens', () => {
        game.initClientData.taskShopItemDetailMap.c = {
            itemHrid: '/items/task_crystal',
            cost: { itemHrid: '/items/coin', count: 1 },
        };
        expect(findBestTaskShopValue().itemHrid).toBe('/items/large_treasure_chest');
    });

    test('reads the costs-array shape too, and counts what a purchase hands over', () => {
        game.initClientData.taskShopItemDetailMap = {
            bulk: {
                itemHrid: '/items/task_crystal',
                costs: [{ itemHrid: TOKEN, count: 10 }],
                outputCount: 5, // 5 × 5000 post-tax for 10 tokens
            },
        };
        expect(findBestTaskShopValue().perToken).toBe((calculatePriceAfterTax(5000) * 5) / 10);
    });
});

describe("Purple's Gift accrual", () => {
    test('credits the gift once per task, not once per token', () => {
        const giftPerTask = 500000 / 50;
        const oneToken = calculateTaskRewardValue(0, 1);
        const fiveTokens = calculateTaskRewardValue(0, 5);

        expect(oneToken.purpleGift).toBe(giftPerTask);
        expect(fiveTokens.purpleGift).toBe(giftPerTask);
        // Tokens still scale — only the gift is flat
        expect(fiveTokens.taskTokens).toBe(5 * oneToken.taskTokens);
    });

    test('prorates the gift across a whole board of tasks', () => {
        const board = calculateTaskRewardValue(0, 12, 4);
        expect(board.purpleGift).toBe(4 * (500000 / 50));
    });
});

describe('cowbell valuation', () => {
    test('prices a cowbell as a tenth of a bag', () => {
        expect(getCowbellValue()).toBe(200000);
    });

    test('falls back to vendor value with no bag price', () => {
        market.prices['/items/bag_of_10_cowbells'] = 0;
        expect(getCowbellValue()).toBe(100000);
    });
});

describe('best alternative profit per hour', () => {
    test('returns the best cached figure, excluding the task itself', () => {
        actions.cachedStats = {
            '/actions/milking/cow': { profitPerHour: 999999 },
            '/actions/foraging/egg': { profitPerHour: 1000 },
            '/actions/woodcutting/tree': { profitPerHour: 4000 },
        };
        expect(getBestAlternativeProfitPerHour('/actions/milking/cow')).toBe(4000);
    });

    test('returns null when nothing has been priced', () => {
        expect(getBestAlternativeProfitPerHour('/actions/milking/cow')).toBe(null);
    });
});

/** A gathering action worth 100 coins an action at 100 actions/hr */
function gatheringAction({ drinkCostPerHour = 0 } = {}) {
    return {
        actionsPerHour: 100,
        baseOutputs: [{ revenuePerAction: 100 }],
        bonusRevenue: { bonusDrops: [] },
        processingRevenueBonusPerAction: 0,
        gourmetRevenueBonusPerAction: 0,
        drinkCostPerHour,
        efficiencyMultiplier: 1,
        hasMissingPrices: false,
    };
}

const milkingTask = (quantity, currentProgress) => ({
    description: 'Milking - Cow',
    coinReward: 0,
    taskTokenReward: 0,
    quantity,
    currentProgress,
});

describe('task profit scales to what is left to do', () => {
    test('a half-done task is worth half as much as an untouched one', async () => {
        actions.gathering = gatheringAction();
        market.expectedValues['/items/purples_gift'] = 0;

        const fresh = await calculateTaskProfit(milkingTask(100, 0));
        const halfDone = await calculateTaskProfit(milkingTask(100, 50));

        expect(halfDone.action.totalValue).toBeCloseTo(fresh.action.totalValue / 2, 6);
        // …while the figure the per-hour rating divides stays whole-task
        expect(halfDone.fullTotalProfit).toBeCloseTo(fresh.totalProfit, 6);
    });

    test('a finished task is worth nothing further', async () => {
        actions.gathering = gatheringAction();
        market.expectedValues['/items/purples_gift'] = 0;

        const done = await calculateTaskProfit(milkingTask(100, 100));
        expect(done.action.totalValue).toBe(0);
    });
});

describe('task speed bonus reaches consumable costs', () => {
    test('a faster task burns fewer hours of drinks', async () => {
        actions.gathering = gatheringAction({ drinkCostPerHour: 10000 });
        market.expectedValues['/items/purples_gift'] = 0;

        game.taskSpeedBonus = 0;
        const slow = await calculateTaskProfit(milkingTask(100, 0));

        game.taskSpeedBonus = 100; // twice as fast
        const fast = await calculateTaskProfit(milkingTask(100, 0));

        expect(fast.action.hoursNeeded).toBeCloseTo(slow.action.hoursNeeded / 2, 6);
        // Revenue is unchanged, so the whole gain is drink cost not spent
        expect(fast.totalProfit - slow.totalProfit).toBeCloseTo(10000 * (slow.action.hoursNeeded / 2), 6);
    });
});

describe('marginal value against the best alternative', () => {
    test('charges the task for the hours it takes from something better', async () => {
        actions.gathering = gatheringAction();
        market.expectedValues['/items/purples_gift'] = 0;
        actions.cachedStats = { '/actions/woodcutting/tree': { profitPerHour: 1000 } };

        const result = await calculateTaskProfit(milkingTask(100, 0));

        expect(result.bestAlternativePerHour).toBe(1000);
        expect(result.opportunityCost).toBeCloseTo(1000 * result.action.hoursNeeded, 6);
        expect(result.marginalProfit).toBeCloseTo(result.totalProfit - result.opportunityCost, 6);
        // The gross figure stays the headline and is untouched by the comparison
        expect(result.totalProfit).toBeGreaterThan(result.marginalProfit);
    });

    test('stays null when no alternative has been priced', async () => {
        actions.gathering = gatheringAction();
        market.expectedValues['/items/purples_gift'] = 0;

        const result = await calculateTaskProfit(milkingTask(100, 0));
        expect(result.marginalProfit).toBe(null);
        expect(result.opportunityCost).toBe(null);
    });
});
