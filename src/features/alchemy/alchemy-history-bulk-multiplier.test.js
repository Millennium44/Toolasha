/**
 * The bulk multiplier a decompose or transmute session was billed at.
 *
 * The coin fee scales with the item's `bulkMultiplier`, and that number is a
 * property of the game data, not of the session — so a viewer that recomputed it
 * at read time restated every past session's profit the moment the game changed
 * a bulk size. The trackers now record the value in force when the session
 * started; the viewers prefer the recorded one and fall back to the item's
 * current value only for sessions saved before it was recorded.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => 'char-1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 0,
    getItemPrices: () => null,
}));
// The real helper drags the marketplace API — and with it a live socket — into
// a suite about arithmetic. The formula is one line and is what is under test.
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * (1 - 0.05),
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        upsert: async () => {},
        clear: async () => {},
        setCharacter: () => {},
    }),
    NO_CHARACTER: 'none',
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => ({ start: () => {}, stop: () => {} }),
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ setTimeout: () => {}, setInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/formatters.js', () => ({ formatKMB: String, formatDateTime: String }));

const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

/** A level-10 item that decomposes and transmutes 5 at a time. */
const BULK_5 = {
    itemLevel: 10,
    sellPrice: 1000,
    alchemyDetail: { bulkMultiplier: 5, decomposeItems: [], transmuteDropTable: [] },
};

beforeEach(() => {
    game.items = { '/items/thing': structuredClone(BULK_5) };
});

describe('the trackers record the multiplier the session ran at', () => {
    test('a decompose session carries the bulk size it started with', async () => {
        await decomposeHistoryTracker.startSession('/items/thing', 0, 1000);
        expect(decomposeHistoryTracker.activeSession.bulkMultiplier).toBe(5);
    });

    test('a transmute session carries the bulk size it started with', async () => {
        await transmuteHistoryTracker.startSession('/items/thing', 1000);
        expect(transmuteHistoryTracker.activeSession.bulkMultiplier).toBe(5);
    });

    test('an item with no alchemy detail records 1 rather than undefined', async () => {
        game.items['/items/plain'] = { itemLevel: 1, sellPrice: 10 };
        await decomposeHistoryTracker.startSession('/items/plain', 0, 1000);
        expect(decomposeHistoryTracker.activeSession.bulkMultiplier).toBe(1);
    });
});

describe('decompose viewer: which multiplier the fee is billed at', () => {
    test('the recorded multiplier wins over the item’s current one', () => {
        game.items['/items/thing'].alchemyDetail.bulkMultiplier = 10; // the game changed it since
        const session = { inputItemHrid: '/items/thing', totalAttempts: 2, bulkMultiplier: 5, results: {} };

        // (10 + 10) * 5 * 5 = 500 a go, twice
        expect(decomposeHistoryViewer.computeSessionProfit(session).coinCost).toBe(1000);
    });

    test('a session saved before the multiplier was recorded falls back to the current one', () => {
        const session = { inputItemHrid: '/items/thing', totalAttempts: 2, results: {} };

        // no recorded value, so the item's current bulk of 5: (10 + 10) * 5 * 5 = 500 a go
        expect(decomposeHistoryViewer.computeSessionProfit(session).coinCost).toBe(1000);
    });

    test('the recorded multiplier also decides how much input the session consumed', () => {
        game.items['/items/thing'].alchemyDetail.bulkMultiplier = 10;
        const session = { inputItemHrid: '/items/thing', totalAttempts: 3, bulkMultiplier: 5, results: {} };

        expect(decomposeHistoryViewer.computeSessionProfit(session).netConsumed).toBe(15);
    });
});

describe('transmute viewer: which multiplier the fee is billed at', () => {
    test('the recorded multiplier wins over the item’s current one', () => {
        game.items['/items/thing'].alchemyDetail.bulkMultiplier = 10;
        const session = { inputItemHrid: '/items/thing', totalAttempts: 2, bulkMultiplier: 5, results: {} };

        // max(50, floor(1000 / 5)) = 200, times bulk 5 = 1000 a go, twice
        expect(transmuteHistoryViewer.computeSessionProfit(session).coinCost).toBe(2000);
    });

    test('a session saved before the multiplier was recorded falls back to the current one', () => {
        const session = { inputItemHrid: '/items/thing', totalAttempts: 2, results: {} };

        expect(transmuteHistoryViewer.computeSessionProfit(session).coinCost).toBe(2000);
    });

    test('the recorded multiplier also decides how much input the session consumed', () => {
        game.items['/items/thing'].alchemyDetail.bulkMultiplier = 10;
        const session = { inputItemHrid: '/items/thing', totalAttempts: 3, bulkMultiplier: 5, results: {} };

        expect(transmuteHistoryViewer.computeSessionProfit(session).netConsumed).toBe(15);
    });
});

/**
 * Recorded profit is quoted the way the forecast is.
 *
 * The trackers record raw sell prices — a record of what the market said, which
 * is what a record should be. The forecast in `alchemy-profit-calculator.js`
 * takes the marketplace cut off everything. Set side by side, history therefore
 * beat forecast by the tax on every single session, on nothing but bookkeeping.
 * The tax is taken at read, so the stored figures stay raw and sessions saved
 * before this are restated the same way.
 */
describe('the marketplace cut on recorded output', () => {
    test('a decompose session’s revenue is quoted after tax', () => {
        const session = {
            inputItemHrid: '/items/thing',
            totalAttempts: 0,
            results: { '/items/shard': { count: 10, totalValue: 1_000_000 } },
        };

        const profit = decomposeHistoryViewer.computeSessionProfit(session);

        expect(profit.revenue).toBe(1_000_000 * 0.95);
        expect(profit.revenue).toBeLessThan(1_000_000);
    });

    test('a transmute session’s revenue is too', () => {
        const session = {
            inputItemHrid: '/items/thing',
            totalAttempts: 0,
            results: { '/items/shard': { count: 10, totalValue: 1_000_000 } },
        };

        const profit = transmuteHistoryViewer.computeSessionProfit(session);

        expect(profit.revenue).toBe(1_000_000 * 0.95);
    });

    test('a self-returned input is not revenue, taxed or otherwise', () => {
        const session = {
            inputItemHrid: '/items/thing',
            totalAttempts: 4,
            bulkMultiplier: 5,
            results: {
                '/items/thing': { count: 10, totalValue: 0, isSelfReturn: true },
                '/items/shard': { count: 2, totalValue: 200_000 },
            },
        };

        const profit = transmuteHistoryViewer.computeSessionProfit(session);

        expect(profit.revenue).toBe(200_000 * 0.95);
        // The returned copies still come off what the session consumed
        expect(profit.netConsumed).toBe(4 * 5 - 10);
    });

    test('a session with nothing recorded still reads as nothing', () => {
        const session = { inputItemHrid: '/items/thing', totalAttempts: 0, results: {} };

        expect(decomposeHistoryViewer.computeSessionProfit(session).revenue).toBe(0);
        expect(transmuteHistoryViewer.computeSessionProfit(session).revenue).toBe(0);
    });
});
