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
const createRatedCard = ({ value, mode = 'gold', completionSeconds = 3600 } = {}) => {
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
        expect(result).toEqual({ value: 30, unitLabel: 'tokens/hr', error: null });
    });

    test('calculates gold efficiency per hour', () => {
        const profitData = createProfitData({
            actionsPerHour: 30,
            quantity: 60,
            rewardTotal: 1200,
            totalProfit: 1200,
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: 600, unitLabel: 'gold/hr', error: null });
    });

    test('returns warning when gold rewards are unavailable', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            rewardError: 'Market data not loaded',
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: null, unitLabel: 'gold/hr', error: 'Market data not loaded' });
    });

    test('returns warning when total profit is unavailable', () => {
        const profitData = createProfitData({
            actionsPerHour: 60,
            quantity: 60,
            totalProfit: null,
        });

        const result = calculateTaskEfficiencyRating(profitData, 'gold');
        expect(result).toEqual({ value: null, unitLabel: 'gold/hr', error: 'Missing price data' });
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
        expect(result).toEqual({ value: 600, unitLabel: 'gold/hr', error: null });
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
