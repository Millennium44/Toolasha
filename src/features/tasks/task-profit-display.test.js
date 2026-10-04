/**
 * @vitest-environment happy-dom
 *
 * Tests for Task Profit Display helpers
 */

import { describe, test, expect } from 'vitest';
import {
    calculateTaskCompletionSeconds,
    calculateTaskEfficiencyRating,
    getRelativeEfficiencyGradientColor,
    getRatingMode,
    readVisibleTaskRatings,
} from './task-profit-display.js';

const createProfitData = ({
    actionsPerHour = 600,
    efficiencyMultiplier = 1,
    quantity = 100,
    currentProgress = 0,
    rewardTotal = 0,
    rewardError = null,
    tokensReceived = 0,
    totalProfit = rewardTotal,
} = {}) => ({
    action: {
        details: {
            actionsPerHour,
            efficiencyMultiplier,
        },
    },
    taskInfo: {
        quantity,
        currentProgress,
    },
    rewards: {
        total: rewardTotal,
        error: rewardError,
        breakdown: {
            tokensReceived,
        },
    },
    totalProfit,
});

/** Build a task card carrying a rendered rating, as the display leaves it */
const createRatedCard = ({
    value,
    mode = 'gold',
    completionSeconds = 3600,
    ratingHours = null,
    partial = false,
} = {}) => {
    const card = document.createElement('div');
    const container = document.createElement('div');
    if (completionSeconds !== null) {
        container.dataset.completionSeconds = `${completionSeconds}`;
    }
    if (value !== null) {
        const rating = document.createElement('div');
        rating.className = 'mwi-task-profit-rating';
        rating.dataset.ratingValue = `${value}`;
        rating.dataset.ratingMode = mode;
        if (partial) rating.dataset.ratingPartial = 'true';
        if (ratingHours !== null) rating.dataset.ratingHours = `${ratingHours}`;
        container.appendChild(rating);
    }
    card.appendChild(container);
    return card;
};

describe('calculateTaskCompletionSeconds', () => {
    test('returns null when required data is missing', () => {
        expect(calculateTaskCompletionSeconds({})).toBe(null);
        expect(calculateTaskCompletionSeconds(createProfitData({ actionsPerHour: 0 }))).toBe(null);
        expect(calculateTaskCompletionSeconds(createProfitData({ quantity: 0 }))).toBe(null);
    });

    test('returns 0 when task is already complete', () => {
        const profitData = createProfitData({ quantity: 50, currentProgress: 50 });
        expect(calculateTaskCompletionSeconds(profitData)).toBe(0);
    });

    test('calculates seconds using efficiency multiplier', () => {
        const profitData = createProfitData({
            actionsPerHour: 600,
            quantity: 100,
            currentProgress: 40,
            efficiencyMultiplier: 2,
        });

        expect(calculateTaskCompletionSeconds(profitData)).toBe(180);
    });
});

describe('calculateTaskEfficiencyRating', () => {
    test('returns null when completion time is unavailable', () => {
        const profitData = createProfitData({ actionsPerHour: 0 });
        expect(calculateTaskEfficiencyRating(profitData, 'tokens')).toBe(null);
    });

    test('calculates token efficiency per hour', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            tokensReceived: 30,
        });

        const result = calculateTaskEfficiencyRating(profitData, 'tokens');
        expect(result).toEqual({ value: 30, hours: 1, unitLabel: 'tokens/hr', error: null });
    });

    test('calculates gold efficiency per hour', () => {
        const profitData = createProfitData({
            actionsPerHour: 30,
            quantity: 60,
            rewardTotal: 1200,
            totalProfit: 1200,
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: 600, hours: 2, unitLabel: 'gold/hr', isPartial: false, error: null });
    });

    test('returns warning when gold rewards are unavailable', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            rewardError: 'Market data not loaded',
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: null, hours: 1, unitLabel: 'gold/hr', error: 'Market data not loaded' });
    });

    test('returns warning when total profit is unavailable', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            totalProfit: null,
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: null, hours: 1, unitLabel: 'gold/hr', error: 'Missing price data' });
    });
});

describe('rating mode default', () => {
    test('an unset setting falls back to the schema default, not tokens', () => {
        // The settings UI advertises "Task profit per hour" as the default; a
        // rating that quietly rates in tokens instead is a different feature
        expect(getRatingMode()).toBe('gold');
    });
});

describe('calculateTaskEfficiencyRating over a partly-done task', () => {
    test('rates the whole task, so progress does not deflate the rate', () => {
        const profitData = createProfitData({
            actionsPerHour: 30,
            quantity: 60,
            currentProgress: 30,
            rewardTotal: 600,
            totalProfit: 600, // what is left to earn
        });
        profitData.fullTotalProfit = 1200; // what the whole task is worth

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: 600, hours: 2, unitLabel: 'gold/hr', isPartial: false, error: null });
    });

    test('falls back to the remaining figure when no whole-task figure exists', () => {
        const profitData = createProfitData({
            actionsPerHour: 30,
            quantity: 60,
            rewardTotal: 1200,
            totalProfit: 1200,
        });

        expect(calculateTaskEfficiencyRating(profitData, 'gold').value).toBe(600);
    });
});

describe('partial task reward ratings', () => {
    test('marks a gold rating derived from incomplete reward prices as a floor', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            rewardTotal: 1200,
            totalProfit: 1200,
        });
        profitData.isPartial = true;
        profitData.fullTotalProfit = 1200;

        expect(calculateTaskEfficiencyRating(profitData, 'gold')).toEqual({
            value: 1200,
            hours: 1,
            unitLabel: 'gold/hr',
            isPartial: true,
            error: null,
        });
    });

    test('a lower-bound rating does not enter the auto-reroll board comparison', () => {
        const cards = [createRatedCard({ value: 100 }), createRatedCard({ value: 900, partial: true })];

        const board = readVisibleTaskRatings(cards);

        expect(board.entries.has(cards[0])).toBe(true);
        expect(board.entries.has(cards[1])).toBe(false);
    });
});

describe('readVisibleTaskRatings', () => {
    test('summarises the rated cards on the board', () => {
        const cards = [
            createRatedCard({ value: 100 }),
            createRatedCard({ value: 300 }),
            createRatedCard({ value: 200 }),
        ];

        const board = readVisibleTaskRatings(cards);
        expect(board.ratingMode).toBe('gold');
        expect(board.median).toBe(200);
        expect(board.entries.get(cards[0])).toEqual({ value: 100, hours: 1 });
    });

    test('the hours are the rating’s own span, not the time left on the card', () => {
        // A task 90% done: 0.4h left, but the rate it is quoted at is over the
        // whole 4h. Amortising a reroll over the 0.4h would make its per-hour
        // cost ten times what the rate it is compared against was built on —
        // which is why a nearly-finished bad task could never be flagged.
        const card = createRatedCard({ value: 100, completionSeconds: 1440, ratingHours: 4 });

        expect(readVisibleTaskRatings([card]).entries.get(card)).toEqual({ value: 100, hours: 4 });
    });

    test('paint from before the rating carried its span still reads its remaining time', () => {
        const card = createRatedCard({ value: 100, completionSeconds: 7200 });

        expect(readVisibleTaskRatings([card]).entries.get(card)).toEqual({ value: 100, hours: 2 });
    });

    test('averages the middle pair for an even board', () => {
        const cards = [
            createRatedCard({ value: 100 }),
            createRatedCard({ value: 200 }),
            createRatedCard({ value: 300 }),
            createRatedCard({ value: 500 }),
        ];
        expect(readVisibleTaskRatings(cards).median).toBe(250);
    });

    test('stays silent when too few cards carry a rating', () => {
        const board = readVisibleTaskRatings([createRatedCard({ value: 100 }), createRatedCard({ value: 900 })]);
        expect(board.median).toBe(null);
        expect(board.entries.size).toBe(2);
    });

    test('ignores cards rated in another mode or not rated at all', () => {
        const cards = [
            createRatedCard({ value: 100 }),
            createRatedCard({ value: 999, mode: 'tokens' }),
            createRatedCard({ value: null }),
            createRatedCard({ value: 300 }),
            createRatedCard({ value: 200 }),
        ];

        const board = readVisibleTaskRatings(cards);
        expect(board.entries.size).toBe(3);
        expect(board.median).toBe(200);
    });

    test('reports no hours when the card carries no completion time', () => {
        const card = createRatedCard({ value: 100, completionSeconds: null });
        expect(readVisibleTaskRatings([card]).entries.get(card).hours).toBe(null);
    });
});

describe('getRelativeEfficiencyGradientColor', () => {
    test('returns fallback color for invalid values', () => {
        expect(getRelativeEfficiencyGradientColor(Number.NaN, 0, 10, '#ff0000', '#00ff00', '#888')).toBe('#888');
        expect(getRelativeEfficiencyGradientColor(5, 10, 10, '#ff0000', '#00ff00', '#888')).toBe('#888');
        expect(getRelativeEfficiencyGradientColor(5, 0, 10, '#ff', '#00ff00', '#888')).toBe('#888');
    });

    test('maps relative values to gradient', () => {
        expect(getRelativeEfficiencyGradientColor(-5, 0, 10, '#ff0000', '#00ff00', '#888')).toBe('rgb(255, 0, 0)');
        expect(getRelativeEfficiencyGradientColor(10, 0, 10, '#ff0000', '#00ff00', '#888')).toBe('rgb(0, 255, 0)');
        expect(getRelativeEfficiencyGradientColor(5, 0, 10, '#ff0000', '#00ff00', '#888')).toBe('rgb(128, 128, 0)');
        expect(getRelativeEfficiencyGradientColor(0, 0, 10, '#ff0000', '#00ff00', '#888')).toBe('rgb(255, 0, 0)');
    });
});

describe('buildBreakdownHTML drink lines', () => {
    test('itemized drinks use the calculator hours, so they sum to the total drink cost under a task speed bonus', async () => {
        const { default: display } = await import('./task-profit-display.js');
        // 100 actions at a base 100/h would be 1h; a +100% task speed bonus makes it 0.5h.
        // The calculator reports 0.5h and charges 20000/h of drinks -> 10000 in total.
        const profitData = {
            type: 'production',
            hasMissingPrices: false,
            rewards: {
                error: null,
                coins: 0,
                taskTokens: 0,
                purpleGift: 0,
                breakdown: { tokensReceived: 0, tokenValue: 0, giftPerTaskPoint: 0 },
            },
            action: {
                totalProfit: 0,
                hoursNeeded: 0.5,
                breakdown: { quantity: 100, materialCost: 10000, perAction: 0 },
                details: {
                    actionsPerHour: 100,
                    efficiencyMultiplier: 1,
                    materialCosts: [],
                    teaCosts: [
                        { itemName: 'Tea A', drinksPerHour: 12, pricePerDrink: 1000, totalCost: 12000 },
                        { itemName: 'Tea B', drinksPerHour: 8, pricePerDrink: 1000, totalCost: 8000 },
                    ],
                },
            },
        };
        const html = display.buildBreakdownHTML(profitData);
        const costs = [...html.matchAll(/Tea [AB]: [\d.]+ drinks @ [^=]+= ([\d.]+)(K?)/g)].map(
            (m) => parseFloat(m[1]) * (m[2] ? 1000 : 1)
        );
        expect(costs).toHaveLength(2);
        expect(costs[0] + costs[1]).toBe(10000);
    });
});

describe('task reward completeness in the profit breakdown', () => {
    test('an unpriced task reward keeps the total unknown', async () => {
        const { default: display } = await import('./task-profit-display.js');
        const html = display.buildBreakdownHTML({
            type: 'production',
            hasMissingPrices: true,
            rewards: { error: 'Task Shop data unavailable', coins: 100, taskTokens: 0, purpleGift: 0, breakdown: {} },
            action: { totalProfit: 500, breakdown: { quantity: 1, materialCost: 0, perAction: 500 }, details: null },
            totalProfit: null,
        });

        expect(html).toContain('Task Tokens: Unavailable');
        expect(html).toContain('Total Profit: -- ⚠');
        expect(html).not.toContain('Total Profit: 600');
    });

    test('a partial task reward marks the combined total as a floor', async () => {
        const { default: display } = await import('./task-profit-display.js');
        const html = display.buildBreakdownHTML({
            type: 'production',
            hasMissingPrices: false,
            isPartial: true,
            rewards: {
                error: null,
                coins: 100,
                taskTokens: 200,
                purpleGift: 50,
                tokenRewardIsPartial: true,
                tokenPartialDrops: 1,
                giftRewardIsPartial: false,
                giftPartialDrops: 0,
                breakdown: { tokensReceived: 1, tokenValue: 200, giftPerTaskPoint: 50 },
            },
            action: { totalProfit: 500, breakdown: { quantity: 1, materialCost: 0, perAction: 500 }, details: null },
            totalProfit: 850,
        });

        expect(html).toContain('Task Tokens: ≥');
        expect(html).toContain('Total Profit: ≥');
        expect(html).toContain('per Task Point');
    });
});
