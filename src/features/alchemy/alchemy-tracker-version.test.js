/**
 * The tracker-version stamp: written on every new session, carried through a
 * backup untouched, and kept by a reload merge only when every part has it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, inventory: [], actions: [] }));

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
        get characterItems() {
            return game.inventory;
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 10,
    getItemPrices: () => null,
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async () => {},
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const {
    ALCHEMY_TRACKER_VERSION,
    FIRST_MESSAGE_FIX_VERSION,
    isPreFixSession,
    mergedTrackerVersion,
    sessionTrackerVersion,
} = await import('./alchemy-tracker-version.js');
const { mergeReloadSplitSessions } = await import('./alchemy-session-merge.js');
const { validateAlchemySession, planAlchemyImportMerge, buildAlchemyBackupEnvelope, parseAlchemyBackupJson } =
    await import('./alchemy-session-import.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const DONUT = '/items/mooberry_donut';

/**
 * A stored session that ran from `start` for `attempts` attempts, one per second.
 * @param {string} id - Session id
 * @param {number} start - Start time in ms
 * @param {number} attempts - Attempts made
 * @param {number|undefined} trackerVersion - The stamp, or undefined for none
 * @returns {Object} The session
 */
function session(id, start, attempts, trackerVersion) {
    const record = {
        id,
        startTime: start,
        lastActivityTime: start + attempts * 1000,
        inputItemHrid: DONUT,
        totalAttempts: attempts,
        totalSuccesses: Math.floor(attempts / 2),
        bulkMultiplier: 1,
        results: {},
    };
    if (trackerVersion !== undefined) record.trackerVersion = trackerVersion;
    return record;
}

describe('the version helper', () => {
    test('an unstamped session is pre-fix, a stamped one is not', () => {
        expect(isPreFixSession({})).toBe(true);
        expect(isPreFixSession({ trackerVersion: FIRST_MESSAGE_FIX_VERSION })).toBe(false);
        expect(isPreFixSession({ trackerVersion: ALCHEMY_TRACKER_VERSION })).toBe(false);
        expect(isPreFixSession({ trackerVersion: 1 })).toBe(true);
    });

    test('a later threshold makes an older stamp pre-fix', () => {
        expect(isPreFixSession({ trackerVersion: 2 }, 3)).toBe(true);
        expect(isPreFixSession({ trackerVersion: 3 }, 3)).toBe(false);
    });

    test('a malformed stamp reads as no stamp', () => {
        expect(sessionTrackerVersion({ trackerVersion: '2' })).toBeNull();
        expect(sessionTrackerVersion({ trackerVersion: 2.5 })).toBeNull();
        expect(sessionTrackerVersion({ trackerVersion: 0 })).toBeNull();
    });

    test('a merge keeps the lower version, and nothing when a part has none', () => {
        expect(mergedTrackerVersion({ trackerVersion: 3 }, { trackerVersion: 2 })).toBe(2);
        expect(mergedTrackerVersion({ trackerVersion: 2 }, {})).toBeNull();
        expect(mergedTrackerVersion({}, { trackerVersion: 2 })).toBeNull();
    });
});

describe('the reload merge', () => {
    test('two stamped halves merge into a stamped record', () => {
        const merged = mergeReloadSplitSessions([session('a', 0, 10, 2), session('b', 10_500, 10, 2)]);
        expect(merged).toHaveLength(1);
        expect(merged[0].trackerVersion).toBe(2);
    });

    test('a pre-fix half makes the whole merged record pre-fix', () => {
        const merged = mergeReloadSplitSessions([session('a', 0, 10, undefined), session('b', 10_500, 10, 2)]);
        expect(merged).toHaveLength(1);
        expect(merged[0].trackerVersion).toBeUndefined();
        expect(isPreFixSession(merged[0])).toBe(true);

        const reversed = mergeReloadSplitSessions([session('a', 0, 10, 2), session('b', 10_500, 10, undefined)]);
        expect(reversed[0].trackerVersion).toBeUndefined();
    });
});

describe('a JSON backup', () => {
    test('carries the stamp through export and import, and adds none', () => {
        const stamped = session('a', 0, 10, 2);
        const unstamped = session('b', 50_000, 10, undefined);
        const text = JSON.stringify(
            buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'char-1', sessions: [stamped, unstamped] })
        );
        const { envelope } = parseAlchemyBackupJson(text);

        for (const imported of envelope.sessions) {
            expect(validateAlchemySession('transmute', imported).ok).toBe(true);
        }
        const plan = planAlchemyImportMerge([], envelope.sessions);
        expect(plan.merged.find((s) => s.id === 'a').trackerVersion).toBe(2);
        expect('trackerVersion' in plan.merged.find((s) => s.id === 'b')).toBe(false);
    });

    test('a stamp that is not a positive whole number is refused', () => {
        expect(validateAlchemySession('transmute', session('a', 0, 10, 'two')).ok).toBe(false);
        expect(validateAlchemySession('transmute', session('a', 0, 10, -1)).ok).toBe(false);
    });
});

describe('the trackers', () => {
    beforeEach(() => {
        game.items = {
            [DONUT]: {
                name: 'Mooberry Donut',
                itemLevel: 20,
                sellPrice: 100,
                alchemyDetail: {
                    bulkMultiplier: 1,
                    transmuteDropTable: [{ itemHrid: '/items/cooking_essence' }],
                    decomposeItems: [{ itemHrid: '/items/cooking_essence', count: 3 }],
                },
            },
        };
    });

    test.each([
        ['transmute', transmuteHistoryTracker],
        ['coinify', coinifyHistoryTracker],
        ['decompose', decomposeHistoryTracker],
    ])('%s stamps every session it starts', async (_kind, tracker) => {
        tracker.activeSession = null;
        if (tracker === transmuteHistoryTracker) await tracker.startSession(DONUT, 1000);
        else await tracker.startSession(DONUT, 0, 1000);
        expect(tracker.activeSession.trackerVersion).toBe(ALCHEMY_TRACKER_VERSION);
        tracker.activeSession = null;
    });
});
