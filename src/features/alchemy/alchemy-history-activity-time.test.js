/**
 * When a session was last seen acting.
 *
 * A session recorded only when it STARTED, so the gold attribution had nothing
 * to spread it over and booked the whole net to the start day — a multi-day AFK
 * grind begun before the window contributed nothing to it. `lastActivityTime`
 * is the other end of that span: stamped as the run begins, and advanced by
 * every message the trackers already handle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));

const store = vi.hoisted(() => {
    const saved = [];
    return {
        saved,
        reset: () => {
            saved.length = 0;
        },
    };
});

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
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
    getItemPrice: (hrid) => game.prices[hrid] ?? 0,
    getItemPrices: () => null,
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async (scope, sessions) => {
            store.saved.push({ scope, sessions: structuredClone(sessions) });
        },
        clear: async () => {},
        setCharacter: () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const START = Date.UTC(2026, 7, 4, 9);
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
    game.items = {
        '/items/thing': { itemLevel: 10, sellPrice: 100, alchemyDetail: { bulkMultiplier: 1 } },
        '/items/gem': {
            itemLevel: 10,
            sellPrice: 50,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: '/items/shard' }, { itemHrid: '/items/gem' }],
            },
        },
        '/items/ore': {
            itemLevel: 10,
            sellPrice: 10,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        },
    };
    game.prices = { '/items/shard': 700, '/items/dust': 20 };
    store.reset();
    for (const tracker of [coinifyHistoryTracker, transmuteHistoryTracker, decomposeHistoryTracker]) {
        tracker.activeSession = null;
        tracker.characterId = 'char-1';
    }
    vi.useFakeTimers();
    vi.setSystemTime(START);
});

afterEach(() => {
    vi.useRealTimers();
});

/** @returns {Object} A coinify action_completed message */
const coinifyCompleted = (currentCount, coins) => ({
    endCharacterAction: {
        actionHrid: '/actions/alchemy/coinify',
        primaryItemHash: 'char-1::/item_locations/inventory::/items/thing::0',
        currentCount,
    },
    endCharacterItems: [{ id: 'coinstack', itemHrid: '/items/coin', count: coins }],
});

/** @returns {Object} A transmute action_completed message */
const transmuteCompleted = (currentCount, shards) => ({
    endCharacterAction: {
        actionHrid: '/actions/alchemy/transmute',
        primaryItemHash: 'char-1::/item_locations/inventory::/items/gem::0',
        currentCount,
    },
    endCharacterItems: [{ id: 'shardstack', itemHrid: '/items/shard', count: shards }],
});

/** @returns {Object} A decompose action_completed message */
const decomposeCompleted = (currentCount, dust) => ({
    endCharacterAction: {
        actionHrid: '/actions/alchemy/decompose',
        primaryItemHash: 'char-1::/item_locations/inventory::/items/ore::0',
        currentCount,
    },
    endCharacterItems: [{ id: 'duststack', itemHrid: '/items/dust', count: dust }],
});

/** @returns {Object} An actions_updated message still running the same transmute */
const transmuteStillRunning = () => ({
    endCharacterActions: [
        {
            actionHrid: '/actions/alchemy/transmute',
            primaryItemHash: 'char-1::/item_locations/inventory::/items/gem::0',
        },
    ],
});

describe('a session records when it was last seen acting', () => {
    test('a new session starts with its activity time at its start', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);

        expect(transmuteHistoryTracker.activeSession.lastActivityTime).toBe(START);
    });

    test('coinify advances it with every completed action', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, START);
        await coinifyHistoryTracker.handleActionCompleted(coinifyCompleted(1, 500));

        vi.setSystemTime(START + 30 * HOUR);
        await coinifyHistoryTracker.handleActionCompleted(coinifyCompleted(2, 1000));

        expect(coinifyHistoryTracker.activeSession.startTime).toBe(START);
        expect(coinifyHistoryTracker.activeSession.lastActivityTime).toBe(START + 30 * HOUR);
    });

    test('transmute advances it with every completed action', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        await transmuteHistoryTracker.handleActionCompleted(transmuteCompleted(1, 1));

        vi.setSystemTime(START + 5 * HOUR);
        await transmuteHistoryTracker.handleActionCompleted(transmuteCompleted(2, 2));

        expect(transmuteHistoryTracker.activeSession.lastActivityTime).toBe(START + 5 * HOUR);
    });

    test('decompose advances it with every completed action', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, START);
        await decomposeHistoryTracker.handleActionCompleted(decomposeCompleted(1, 1));

        vi.setSystemTime(START + 5 * HOUR);
        await decomposeHistoryTracker.handleActionCompleted(decomposeCompleted(2, 2));

        expect(decomposeHistoryTracker.activeSession.lastActivityTime).toBe(START + 5 * HOUR);
    });

    test('an actions_updated that finds the same run still going advances it too', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);

        vi.setSystemTime(START + 2 * HOUR);
        await transmuteHistoryTracker.handleActionsUpdated(transmuteStillRunning());

        expect(transmuteHistoryTracker.activeSession.id).toBe(`transmute_${START}`);
        expect(transmuteHistoryTracker.activeSession.lastActivityTime).toBe(START + 2 * HOUR);
    });

    test('it is written out with the session rather than kept in memory', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        await transmuteHistoryTracker.handleActionCompleted(transmuteCompleted(1, 1));

        vi.setSystemTime(START + 26 * HOUR);
        await transmuteHistoryTracker.handleActionCompleted(transmuteCompleted(2, 2));
        await transmuteHistoryTracker.endSession();

        const written = store.saved.at(-1).sessions.find((s) => s.id === `transmute_${START}`);
        expect(written.startTime).toBe(START);
        expect(written.lastActivityTime).toBe(START + 26 * HOUR);
    });
});
