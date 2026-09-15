/**
 * `actions_updated` is a partial update — only the actions that changed, not
 * a snapshot of the queue (see `alchemy-running-action.js`). Before this fix,
 * `handleActionsUpdated` scanned that delta directly with
 * `.find(a => a.actionHrid === ACTION_HRID)`, so:
 * - queuing an unrelated action behind a running alchemy action produced an
 *   update with no matching row in it, ending a session that was still
 *   running
 * - queuing a second alchemy action behind the running one put the QUEUED
 *   item's row in the delta, switching the session to an item that had not
 *   started yet
 *
 * These tests drive `handleActionsUpdated()` the way it is actually called
 * now: with no argument, reading `dataManager.getCurrentActions()` — the
 * full, already-merged queue — via `runningAlchemyAction`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {}, actions: [] }));

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
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => 'char-1',
        getCurrentActions: () => game.actions,
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

const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');
const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');

const START = Date.UTC(2026, 7, 4, 9);
const HOUR = 60 * 60 * 1000;

const GEM_HASH = 'char-1::/item_locations/inventory::/items/gem::0';
const SHARD_HASH = 'char-1::/item_locations/inventory::/items/shard::0';
const ORE_HASH = (level) => `char-1::/item_locations/inventory::/items/ore::${level}`;
const THING_HASH = (level) => `char-1::/item_locations/inventory::/items/thing::${level}`;

beforeEach(() => {
    game.items = {
        '/items/gem': {
            itemLevel: 10,
            sellPrice: 50,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: '/items/shard' }, { itemHrid: '/items/gem' }],
            },
        },
        '/items/shard': {
            itemLevel: 10,
            sellPrice: 700,
            alchemyDetail: { bulkMultiplier: 1, transmuteDropTable: [{ itemHrid: '/items/shard' }] },
        },
        '/items/ore': {
            itemLevel: 10,
            sellPrice: 10,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        },
        '/items/thing': { itemLevel: 10, sellPrice: 100, alchemyDetail: { bulkMultiplier: 1 } },
    };
    game.prices = {};
    game.actions = [];
    store.reset();
    for (const tracker of [transmuteHistoryTracker, decomposeHistoryTracker, coinifyHistoryTracker]) {
        tracker.activeSession = null;
        tracker.characterId = 'char-1';
        tracker.lastCurrentCount = null;
    }
    vi.useFakeTimers();
    vi.setSystemTime(START);
});

describe('transmute session continuity across actions_updated', () => {
    test('an update that only adds a queued cooking action leaves the session running', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        const sessionId = transmuteHistoryTracker.activeSession.id;

        // The running transmute keeps the lowest ordinal; the newly queued
        // cooking action sits behind it with a higher one — exactly what an
        // `actions_updated` delta that only reports the new cooking action
        // would merge into the full queue.
        game.actions = [
            { actionHrid: '/actions/alchemy/transmute', primaryItemHash: GEM_HASH, ordinal: 0, isDone: false },
            { actionHrid: '/actions/cooking/apple_gummy', primaryItemHash: '', ordinal: 1, isDone: false },
        ];

        vi.setSystemTime(START + HOUR);
        await transmuteHistoryTracker.handleActionsUpdated();

        expect(transmuteHistoryTracker.activeSession).not.toBeNull();
        expect(transmuteHistoryTracker.activeSession.id).toBe(sessionId);
        expect(transmuteHistoryTracker.activeSession.lastActivityTime).toBe(START + HOUR);
    });

    test('a queued second transmute behind the running one does not switch the session', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        const sessionId = transmuteHistoryTracker.activeSession.id;

        game.actions = [
            { actionHrid: '/actions/alchemy/transmute', primaryItemHash: GEM_HASH, ordinal: 0, isDone: false },
            { actionHrid: '/actions/alchemy/transmute', primaryItemHash: SHARD_HASH, ordinal: 1, isDone: false },
        ];

        await transmuteHistoryTracker.handleActionsUpdated();

        expect(transmuteHistoryTracker.activeSession.id).toBe(sessionId);
        expect(transmuteHistoryTracker.activeSession.inputItemHrid).toBe('/items/gem');
    });

    test('the running transmute finishing with cooking now at the front ends the session', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        transmuteHistoryTracker.activeSession.totalAttempts = 3;

        // A finished action is dropped from the merged queue entirely
        // (dataManager's own merge removes `isDone` rows), so the transmute no
        // longer appears at all — only the next queued action does.
        game.actions = [{ actionHrid: '/actions/cooking/apple_gummy', primaryItemHash: '', ordinal: 1, isDone: false }];

        await transmuteHistoryTracker.handleActionsUpdated();

        expect(transmuteHistoryTracker.activeSession).toBeNull();
        expect(store.saved.at(-1).sessions.some((s) => s.inputItemHrid === '/items/gem')).toBe(true);
    });

    test('the running transmute switching item ends the old session and starts a new one', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', START);
        transmuteHistoryTracker.activeSession.totalAttempts = 2;
        const oldSessionId = transmuteHistoryTracker.activeSession.id;

        vi.setSystemTime(START + HOUR);
        game.actions = [
            { actionHrid: '/actions/alchemy/transmute', primaryItemHash: SHARD_HASH, ordinal: 0, isDone: false },
        ];

        await transmuteHistoryTracker.handleActionsUpdated();

        expect(transmuteHistoryTracker.activeSession).not.toBeNull();
        expect(transmuteHistoryTracker.activeSession.id).not.toBe(oldSessionId);
        expect(transmuteHistoryTracker.activeSession.inputItemHrid).toBe('/items/shard');
        expect(store.saved.some((entry) => entry.sessions.some((s) => s.inputItemHrid === '/items/gem'))).toBe(true);
    });
});

describe('decompose and coinify sessions survive an unrelated queued action too', () => {
    test('decompose: a queued cooking action does not end the running session', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, START);
        const sessionId = decomposeHistoryTracker.activeSession.id;

        game.actions = [
            { actionHrid: '/actions/alchemy/decompose', primaryItemHash: ORE_HASH(0), ordinal: 0, isDone: false },
            { actionHrid: '/actions/cooking/apple_gummy', primaryItemHash: '', ordinal: 1, isDone: false },
        ];

        await decomposeHistoryTracker.handleActionsUpdated();

        expect(decomposeHistoryTracker.activeSession.id).toBe(sessionId);
    });

    test('decompose: the running item switching enhancement level ends the old session and starts a new one', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, START);
        decomposeHistoryTracker.activeSession.totalAttempts = 1;
        const oldSessionId = decomposeHistoryTracker.activeSession.id;

        vi.setSystemTime(START + HOUR);
        game.actions = [
            { actionHrid: '/actions/alchemy/decompose', primaryItemHash: ORE_HASH(1), ordinal: 0, isDone: false },
        ];

        await decomposeHistoryTracker.handleActionsUpdated();

        expect(decomposeHistoryTracker.activeSession.id).not.toBe(oldSessionId);
        expect(decomposeHistoryTracker.activeSession.enhancementLevel).toBe(1);
    });

    test('coinify: a queued cooking action does not end the running session', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, START);
        const sessionId = coinifyHistoryTracker.activeSession.id;

        game.actions = [
            { actionHrid: '/actions/alchemy/coinify', primaryItemHash: THING_HASH(0), ordinal: 0, isDone: false },
            { actionHrid: '/actions/cooking/apple_gummy', primaryItemHash: '', ordinal: 1, isDone: false },
        ];

        await coinifyHistoryTracker.handleActionsUpdated();

        expect(coinifyHistoryTracker.activeSession.id).toBe(sessionId);
    });

    test('coinify: the front becoming cooking after coinify finishes ends the session', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, START);
        coinifyHistoryTracker.activeSession.totalAttempts = 4;

        game.actions = [{ actionHrid: '/actions/cooking/apple_gummy', primaryItemHash: '', ordinal: 1, isDone: false }];

        await coinifyHistoryTracker.handleActionsUpdated();

        expect(coinifyHistoryTracker.activeSession).toBeNull();
    });
});
