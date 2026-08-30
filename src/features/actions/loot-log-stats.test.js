/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { LootLogStats, buildLootLogRows, buildLootLogSummaryText, LOOT_LOG_CSV_COLUMNS } from './loot-log-stats.js';
import lootLogHistory from './loot-log-history.js';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(),
        getSettingValue: vi.fn(),
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
    default: {
        mergeAndSave: vi.fn(),
        getHistoricalEntries: vi.fn(),
        deleteEntry: vi.fn(async () => undefined),
        _charId: vi.fn(() => 'char-1'),
        _load: vi.fn(async () => []),
        _save: vi.fn(),
    },
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

describe('buildLootLogSummaryText, the copy-button text', () => {
    const resolve = {
        itemInfo: (hrid) => {
            if (hrid === '/items/coin') return { name: 'Coins', askPerItem: 1, bidPerItem: 1 };
            if (hrid === '/items/log') return { name: 'Log', askPerItem: 40, bidPerItem: 30 };
            return { name: hrid.split('/').pop(), askPerItem: 0, bidPerItem: 0 };
        },
        actionName: () => 'Tree',
    };

    test('an empty entry is an empty string, not a header with nothing under it', () => {
        expect(buildLootLogSummaryText(null, resolve)).toBe('');
    });

    test('names the action, the item lines, and the running total', () => {
        const text = buildLootLogSummaryText(
            {
                actionHrid: '/actions/woodcutting/tree',
                actionCount: 100,
                drops: { '/items/log': 10, '/items/coin': 50 },
            },
            resolve
        );

        expect(text).toContain('Tree × 100');
        expect(text).toContain('Log ×10');
        expect(text).toContain('Coins ×50');
        // Total: 10*40+50*1 ask = 450, 10*30+50*1 bid = 350
        expect(text).toContain('Total: 450/350');
    });

    test('a profit figure is appended when one was computed, and omitted when there was none', () => {
        const entry = { actionHrid: '/actions/woodcutting/tree', actionCount: 1, drops: { '/items/log': 1 } };

        const withProfit = buildLootLogSummaryText(entry, { ...resolve, profit: { askProfit: 12, bidProfit: -3 } });
        expect(withProfit).toContain('Profit: 12/-3');

        const withoutProfit = buildLootLogSummaryText(entry, resolve);
        expect(withoutProfit).not.toContain('Profit:');
    });

    test('a session with no drops is still one line naming the action', () => {
        const text = buildLootLogSummaryText(
            { actionHrid: '/actions/woodcutting/tree', actionCount: 5, drops: {} },
            resolve
        );

        expect(text).toBe('Tree × 5\nTotal: 0/0 (ask/bid)');
    });
});

describe('LootLogStats daily extrapolation', () => {
    let stats;

    beforeEach(() => {
        stats = new LootLogStats();
    });

    test('scales a run to 24 hours', () => {
        expect(stats.calculateDailyOutput(1000, 3600)).toBe(24000);
    });

    test('nothing to scale, or no time to scale it over, is 0', () => {
        expect(stats.calculateDailyOutput(0, 3600)).toBe(0);
        expect(stats.calculateDailyOutput(1000, 0)).toBe(0);
    });

    test('a run too short to be a rate is not treated as one', () => {
        // Three minutes multiplied by 480 is not a daily rate: one lucky rare in those
        // three minutes becomes half a billion a day, and the figure reads as a forecast
        expect(stats.isDailyRateMeaningful(180)).toBe(false);
        expect(stats.isDailyRateMeaningful(60)).toBe(false);
    });

    test('a long enough run does read as a rate', () => {
        expect(stats.isDailyRateMeaningful(600)).toBe(true);
        expect(stats.isDailyRateMeaningful(4 * 3600)).toBe(true);
    });

    test('a missing duration is not a rate either', () => {
        expect(stats.isDailyRateMeaningful(undefined)).toBe(false);
        expect(stats.isDailyRateMeaningful(null)).toBe(false);
    });
});

describe('LootLogStats.deleteHistoricalEntry', () => {
    let stats;

    beforeEach(() => {
        vi.clearAllMocks();
        lootLogHistory._charId.mockReturnValue('char-1');
        stats = new LootLogStats();
    });

    test('delegates to lootLogHistory.deleteEntry, which queues on the merge chain', async () => {
        // Deleting used to read and save directly here, off the chain
        // `mergeAndSave` uses to serialize against itself — a merge arriving
        // from a `loot_log_updated` message in flight at the same time could
        // have its stale read put the just-deleted entry straight back.
        // Delegating means the delete is subject to the same serialization.
        await expect(stats.deleteHistoricalEntry(2)).resolves.toBeUndefined();

        expect(lootLogHistory.deleteEntry).toHaveBeenCalledWith(2);
    });
});

describe('LootLogStats.renderHistoricalEntries pagination', () => {
    let stats;
    let container;

    /**
     * @param {number} count - How many historical entries to fabricate
     * @returns {Array<Object>} Entries `renderHistoricalEntries` can render
     */
    const makeEntries = (count) =>
        Array.from({ length: count }, (_, i) => ({
            characterActionId: i + 1,
            actionHrid: '/actions/foraging/dummy',
            startTime: new Date(2026, 0, 1, 0, i).toISOString(),
            endTime: new Date(2026, 0, 1, 0, i, 30).toISOString(),
            actionCount: 1,
            drops: {},
        }));

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '<div class="LootLogPanel_actionLoots__3oTid"></div>';
        container = document.querySelector('.LootLogPanel_actionLoots__3oTid');
        dataManager.getActionDetails.mockReturnValue(undefined);
        getItemPrices.mockReturnValue(undefined);
        stats = new LootLogStats();
        stats.currentLootLogData = [];
    });

    test('a "Show more" expansion survives a rebuild triggered by a later loot_log_updated', async () => {
        // More than the default batch of 20, so "Show more" appears
        const entries = makeEntries(25);
        lootLogHistory.getHistoricalEntries.mockResolvedValue(entries);

        await stats.renderHistoricalEntries();
        expect(container.querySelectorAll('.mwi-loot-log-history-entry')).toHaveLength(20);

        // The user asks to see the rest
        container.querySelector('.mwi-loot-log-history-more').click();
        expect(container.querySelectorAll('.mwi-loot-log-history-entry')).toHaveLength(25);

        // A later `loot_log_updated` message tears the section down and rebuilds
        // it from scratch — this used to reset `historicalRendered` to 0 and
        // redraw only the first batch, collapsing the expansion the user just made
        await stats.renderHistoricalEntries();

        expect(container.querySelectorAll('.mwi-loot-log-history-entry')).toHaveLength(25);
    });

    test('a fully expanded list does not grow a dead "Show more (0 remaining)"', async () => {
        // The button's own click handler removes it once nothing is left, but
        // the rebuild's gate asks whether there are more entries than one
        // BATCH — not more than are currently rendered. So every rebuild after
        // a full expansion put the button back, reading "(0 remaining)", and
        // pressing it sliced an empty range and removed it again until the
        // next loot_log_updated brought it back.
        lootLogHistory.getHistoricalEntries.mockResolvedValue(makeEntries(25));

        await stats.renderHistoricalEntries();
        container.querySelector('.mwi-loot-log-history-more').click();
        expect(container.querySelector('.mwi-loot-log-history-more')).toBe(null);

        await stats.renderHistoricalEntries();

        expect(container.querySelector('.mwi-loot-log-history-more')).toBe(null);
    });
});
