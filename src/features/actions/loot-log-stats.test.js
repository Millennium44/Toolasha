import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { LootLogStats, buildLootLogRows, LOOT_LOG_CSV_COLUMNS } from './loot-log-stats.js';

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
// The enhancing summary only needs two pricing functions from here; mock them so
// the test does not pull the whole enhancement bundle's transitive imports.
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getEnhancementMaterialPrice: () => 0,
    getCheapestProtectionPrice: () => ({ price: 0 }),
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    enhancementCalculator: () => null,
    enhancementConfig: () => null,
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

describe('LootLogStats.getModelPrice', () => {
    let stats;

    beforeEach(() => {
        vi.clearAllMocks();
        expectedValueCalculator.isInitialized = false;
        stats = new LootLogStats();
    });

    test('coins are face value without a market lookup', () => {
        expect(stats.getModelPrice('/items/coin')).toBe(1);
        expect(getItemPrices).not.toHaveBeenCalled();
    });

    test('openable containers use expected value when the calculator is ready', () => {
        expectedValueCalculator.isInitialized = true;
        dataManager.getItemDetails.mockReturnValue({ isOpenable: true });
        expectedValueCalculator.calculateExpectedValue.mockReturnValue({ expectedValue: 500 });

        expect(stats.getModelPrice('/items/chest')).toBe(500);
        expect(getItemPrices).not.toHaveBeenCalled();
    });

    test('everything else is the market ask, and no ask is null rather than zero', () => {
        dataManager.getItemDetails.mockReturnValue({});
        getItemPrices.mockReturnValue({ ask: 120, bid: 100 });
        expect(stats.getModelPrice('/items/log')).toBe(120);

        getItemPrices.mockReturnValue(null);
        expect(stats.getModelPrice('/items/unlisted')).toBeNull();
    });
});

describe('LootLogStats.buildLuckReading', () => {
    let stats;

    beforeEach(() => {
        vi.clearAllMocks();
        expectedValueCalculator.isInitialized = false;
        stats = new LootLogStats();
    });

    test('no drops or no drop table (production, combat, alchemy) is no reading', () => {
        expect(stats.buildLuckReading(null)).toBeNull();
        expect(stats.buildLuckReading({ actionHrid: '/actions/cooking/donut', actionCount: 5 })).toBeNull();

        dataManager.getActionDetails.mockReturnValue({});
        expect(stats.buildLuckReading({ actionHrid: '/actions/cooking/donut', actionCount: 5, drops: {} })).toBeNull();
    });

    test('binds the entry to the model: session from the drop table, income from modelled drops only', () => {
        dataManager.getActionDetails.mockReturnValue({
            dropTable: [{ itemHrid: '/items/log', dropRate: 1, minCount: 1, maxCount: 1 }],
        });
        dataManager.getItemDetails.mockReturnValue({});
        getItemPrices.mockReturnValue({ ask: 40, bid: 30 });

        const reading = stats.buildLuckReading({
            actionHrid: '/actions/woodcutting/tree',
            actionCount: 10,
            // The essence is real loot but outside the modelled table, so it
            // must not count toward the income the distribution judges
            drops: { '/items/log': 9, '/items/essence': 2 },
        });

        expect(reading.session.actionCount).toBe(10);
        expect(reading.session.drops).toEqual([
            { itemHrid: '/items/log', minCount: 1, maxCount: 1, dropRate: 1, price: 40 },
        ]);
        expect(reading.income).toBe(9 * 40);
    });
});

describe('buildLootLogRows, the CSV export', () => {
    const resolve = {
        itemInfo: (hrid) => {
            if (hrid === '/items/coin') return { name: 'Coins', askPerItem: 1, bidPerItem: 1 };
            if (hrid === '/items/log') return { name: 'Log', askPerItem: 40, bidPerItem: 30 };
            return { name: hrid.split('/').pop(), askPerItem: 0, bidPerItem: 0 };
        },
        actionName: (hrid) => (hrid === '/actions/woodcutting/tree' ? 'Tree' : 'Unknown'),
    };

    test('no sessions is no rows', () => {
        expect(buildLootLogRows([], resolve)).toEqual([]);
        expect(buildLootLogRows(null, resolve)).toEqual([]);
    });

    test('one row per item per session, ISO start, values at the resolved prices', () => {
        const entries = [
            {
                startTime: '2026-08-04T10:00:00Z',
                actionHrid: '/actions/woodcutting/tree',
                actionCount: 100,
                // An enhancement-levelled drop prices as its base item
                drops: { '/items/log': 250, '/items/coin': 900, '/items/rare_thing::3': 1 },
            },
        ];

        expect(buildLootLogRows(entries, resolve)).toEqual([
            {
                sessionStart: '2026-08-04T10:00:00.000Z',
                action: 'Tree',
                actionHrid: '/actions/woodcutting/tree',
                item: 'Log',
                itemHrid: '/items/log',
                quantity: 250,
                askValue: 250 * 40,
                bidValue: 250 * 30,
            },
            {
                sessionStart: '2026-08-04T10:00:00.000Z',
                action: 'Tree',
                actionHrid: '/actions/woodcutting/tree',
                item: 'Coins',
                itemHrid: '/items/coin',
                quantity: 900,
                askValue: 900,
                bidValue: 900,
            },
            {
                sessionStart: '2026-08-04T10:00:00.000Z',
                action: 'Tree',
                actionHrid: '/actions/woodcutting/tree',
                item: 'rare_thing',
                itemHrid: '/items/rare_thing',
                quantity: 1,
                askValue: 0,
                bidValue: 0,
            },
        ]);
    });

    test('enhancing sessions are skipped, as the panel skips drawing them', () => {
        const entries = [
            { startTime: '2026-08-04T10:00:00Z', actionHrid: '/actions/enhancing/enhance', drops: { '/items/log': 5 } },
            { startTime: '2026-08-04T11:00:00Z', actionHrid: null, drops: null },
        ];

        expect(buildLootLogRows(entries, resolve)).toEqual([]);
    });

    test('every column names a field the rows carry', () => {
        const [row] = buildLootLogRows(
            [
                {
                    startTime: '2026-08-04T10:00:00Z',
                    actionHrid: '/actions/woodcutting/tree',
                    drops: { '/items/log': 1 },
                },
            ],
            resolve
        );
        for (const column of LOOT_LOG_CSV_COLUMNS) {
            expect(row).toHaveProperty(column.key);
        }
    });
});
