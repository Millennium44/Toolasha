import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { LootLogStats } from './loot-log-stats.js';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(),
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_GOLD: '#ff0',
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn() },
}));

vi.mock('../../core/websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: vi.fn(),
        getItemDetails: vi.fn(),
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: vi.fn(),
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: false,
        calculateExpectedValue: vi.fn(),
    },
}));

vi.mock('./loot-log-history.js', () => ({
    default: { mergeAndSave: vi.fn(), getHistoricalEntries: vi.fn() },
}));

describe('LootLogStats.calculateExpectedRunValue', () => {
    let stats;

    beforeEach(() => {
        vi.clearAllMocks();
        expectedValueCalculator.isInitialized = false;
        stats = new LootLogStats();
    });

    test('returns null without an actionHrid or actionCount', () => {
        expect(stats.calculateExpectedRunValue(null, 10)).toBeNull();
        expect(stats.calculateExpectedRunValue('/actions/foraging/x', 0)).toBeNull();
    });

    test('returns null when the action has no drop table (e.g. production)', () => {
        dataManager.getActionDetails.mockReturnValue({});

        expect(stats.calculateExpectedRunValue('/actions/cooking/donut', 50)).toBeNull();
    });

    test('computes expected ask/bid totals from drop rate x average count x actions', () => {
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [{ itemHrid: '/items/log', dropRate: 0.5, minCount: 2, maxCount: 4 }],
        });
        getItemPrices.mockReturnValue({ ask: 100, bid: 80 });

        const result = stats.calculateExpectedRunValue('/actions/woodcutting/tree', 20);

        // avgCount = 3, expectedCount = 0.5 * 3 * 20 = 30
        expect(result.askExpected).toBeCloseTo(30 * 100, 6);
        expect(result.bidExpected).toBeCloseTo(30 * 80, 6);
    });

    test('values coin drops at face value without a market lookup', () => {
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [{ itemHrid: '/items/coin', dropRate: 1, minCount: 10, maxCount: 10 }],
        });

        const result = stats.calculateExpectedRunValue('/actions/foraging/x', 5);

        expect(result.askExpected).toBe(50);
        expect(result.bidExpected).toBe(50);
        expect(getItemPrices).not.toHaveBeenCalled();
    });

    test('prices openable drops via expected value when the calculator is ready', () => {
        expectedValueCalculator.isInitialized = true;
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [{ itemHrid: '/items/chest', dropRate: 0.1, minCount: 1, maxCount: 1 }],
        });
        dataManager.getItemDetails.mockReturnValue({ isOpenable: true });
        expectedValueCalculator.calculateExpectedValue.mockReturnValue({ expectedValue: 500 });

        const result = stats.calculateExpectedRunValue('/actions/foraging/x', 10);

        // expectedCount = 0.1 * 1 * 10 = 1, value = 500 per chest
        expect(result.askExpected).toBeCloseTo(500, 6);
        expect(getItemPrices).not.toHaveBeenCalled();
    });

    test('returns null when no drop in the table resolves to a price', () => {
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [{ itemHrid: '/items/unpriced', dropRate: 0.5, minCount: 1, maxCount: 1 }],
        });
        getItemPrices.mockReturnValue(null);

        expect(stats.calculateExpectedRunValue('/actions/foraging/x', 10)).toBeNull();
    });

    test('skips drops with no drop chance or zero average count', () => {
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [
                { itemHrid: '/items/a', dropRate: 0, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/b', dropRate: 1, minCount: 0, maxCount: 0 },
            ],
        });

        expect(stats.calculateExpectedRunValue('/actions/foraging/x', 10)).toBeNull();
        expect(getItemPrices).not.toHaveBeenCalled();
    });
});
