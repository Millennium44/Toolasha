/**
 * What the account adds up to, and what it refuses to claim.
 *
 * The arithmetic here is all about characters that were recorded at different
 * times, so most of these tests are about a series with a hole in it rather
 * than about addition.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ id: 'char-1', name: 'Main' }));
const db = vi.hoisted(() => ({ stores: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.id,
        getCurrentCharacterName: () => game.name,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, fallback = null) => {
            if (db.broken) throw new Error(db.broken);
            return db.stores[storeName]?.[key] ?? fallback;
        },
        set: async (key, value, storeName) => {
            if (db.broken) throw new Error(db.broken);
            db.stores[storeName] = db.stores[storeName] || {};
            db.stores[storeName][key] = value;
            return true;
        },
        getAllKeys: async (storeName) => {
            if (db.broken) throw new Error(db.broken);
            return Object.keys(db.stores[storeName] || {});
        },
        getAll: async (storeName) => {
            if (db.broken) throw new Error(db.broken);
            return { ...(db.stores[storeName] || {}) };
        },
    },
}));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

const {
    idsFromKeys,
    combineSeries,
    windowChange,
    queueState,
    summarizeCharacters,
    readAccount,
    refreshAccount,
    clearAccountCache,
    accountReadFailure,
    resetAccountReadFailure,
    rememberCurrentCharacter,
    STALE_SNAPSHOT_MS,
} = await import('./account-data.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => {
    db.stores = {};
    db.broken = null;
    game.id = 'char-1';
    game.name = 'Main';
    toasts.length = 0;
    clearAccountCache();
    resetAccountReadFailure();
});

describe('finding the characters', () => {
    test('a prefix scan names them', () => {
        const keys = ['networth_a', 'networth_b', 'networthDetail_a_5', 'somethingElse'];
        expect(idsFromKeys(keys, 'networth_')).toEqual(['a', 'b']);
    });

    test('the detail prefix is not the compact one', () => {
        // `networthDetail_a_5` starts with `networth` but must not read as a
        // character called `Detail_a_5`
        expect(idsFromKeys(['networthDetail_a_5'], 'networth_')).toEqual([]);
    });
});

describe('adding series that were never recorded together', () => {
    test('each character holds its last value forward', () => {
        const combined = combineSeries({
            a: [
                { t: 1, total: 100 },
                { t: 3, total: 150 },
            ],
            b: [{ t: 2, total: 40 }],
        });

        expect(combined).toEqual([
            { t: 1, total: 100, contributors: 1 },
            { t: 2, total: 140, contributors: 2 },
            { t: 3, total: 190, contributors: 2 },
        ]);
    });

    test('a character contributes nothing before its first reading', () => {
        const combined = combineSeries({
            a: [{ t: 1, total: 100 }],
            b: [{ t: 9, total: 500 }],
        });

        // Not 600 at t=1: b's networth at t=1 is not zero, it is unknown
        expect(combined[0]).toEqual({ t: 1, total: 100, contributors: 1 });
        expect(combined[1].contributors).toBe(2);
    });

    test('a long history is thinned but keeps its latest point', () => {
        const series = Array.from({ length: 5000 }, (_, i) => ({ t: i, total: i }));
        const combined = combineSeries({ a: series });

        expect(combined.length).toBeLessThanOrEqual(400);
        expect(combined[combined.length - 1].total).toBe(4999);
    });
});

describe('what changed over a window', () => {
    const now = 10 * DAY;

    test('the baseline is the last reading before the window opened', () => {
        const points = [
            { t: now - 5 * DAY, total: 100 },
            { t: now - 2 * HOUR, total: 150 },
        ];

        const change = windowChange(points, DAY, now);
        expect(change.delta).toBe(50);
        expect(change.percent).toBeCloseTo(50);
    });

    test('a series with only one reading claims no trend', () => {
        expect(windowChange([{ t: now, total: 100 }], DAY, now)).toBeNull();
    });

    test('a zero baseline reports the delta without a percentage', () => {
        const points = [
            { t: now - 5 * DAY, total: 0 },
            { t: now, total: 90 },
        ];

        expect(windowChange(points, DAY, now)).toMatchObject({ delta: 90, percent: null });
    });
});

describe('what a queue snapshot still implies', () => {
    const now = 1_000_000_000;

    test('a queue with time left is busy', () => {
        const state = queueState({ timestamp: now - HOUR, totalQueueSeconds: 7200 }, now);
        expect(state.state).toBe('busy');
        expect(state.remainingSeconds).toBeCloseTo(3600);
    });

    test('a queue that has run out is idle', () => {
        expect(queueState({ timestamp: now - 3 * HOUR, totalQueueSeconds: 3600 }, now).state).toBe('idle');
    });

    test('an endless action is not idle just because the finite work ended', () => {
        const snapshot = { timestamp: now - 3 * HOUR, totalQueueSeconds: 0, hasInfiniteAction: true };
        expect(queueState(snapshot, now).state).toBe('endless');
    });

    test('an ancient snapshot is marked as such rather than trusted', () => {
        const snapshot = { timestamp: now - STALE_SNAPSHOT_MS - DAY, totalQueueSeconds: 60 };
        expect(queueState(snapshot, now).stale).toBe(true);
    });

    test('no snapshot is unknown, not idle', () => {
        expect(queueState(null, now).state).toBe('unknown');
    });
});

describe('the character rows', () => {
    const now = 1_000_000_000;

    test('the current character leads and the rest follow by value', () => {
        const rows = summarizeCharacters({
            ids: ['a', 'b', 'c'],
            seriesById: {
                a: [{ t: now - HOUR, total: 10 }],
                b: [{ t: now - HOUR, total: 900 }],
                c: [{ t: now - HOUR, total: 400 }],
            },
            snapshotsById: {},
            namesById: { a: 'Main' },
            currentId: 'a',
            now,
        });

        expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
        expect(rows[0].isCurrent).toBe(true);
    });

    test('a queue snapshot names a character no name map has heard of', () => {
        const rows = summarizeCharacters({
            ids: ['b'],
            seriesById: {},
            snapshotsById: { b: { characterId: 'b', characterName: 'Alt', timestamp: now } },
            namesById: {},
            currentId: 'a',
            now,
        });

        expect(rows[0].name).toBe('Alt');
        expect(rows[0].networth).toBeNull();
    });

    test('last seen is the most recent of any recorder', () => {
        const rows = summarizeCharacters({
            ids: ['b'],
            seriesById: { b: [{ t: now - 5 * DAY, total: 10 }] },
            snapshotsById: { b: { characterId: 'b', timestamp: now - HOUR } },
            namesById: {},
            currentId: 'a',
            now,
        });

        expect(rows[0].lastSeen).toBe(now - HOUR);
    });
});

describe('reading it all back out of storage', () => {
    const now = 1_000_000_000;

    test('every recorder contributes a character', async () => {
        db.stores.networthHistory = { networth_a: [{ t: now - HOUR, total: 100 }] };
        db.stores.queueSnapshots = { queueSnapshot_b: { characterId: 'b', characterName: 'Alt', timestamp: now } };
        db.stores.lootLogHistory = { lootLog_c: [] };
        db.stores.settings = { tradeHistory_d: {} };

        const account = await readAccount(now);

        expect(account.characters.map((row) => row.id).sort()).toEqual(['a', 'b', 'c', 'char-1', 'd']);
    });

    test('a character whose recorders have been split into records is still an account member', async () => {
        // No `networth_e`/`lootLog_f` key at all: those characters have been
        // migrated to one record per month and per hour respectively
        db.stores.networthHistory = {
            'networthSeries_e_2026-07': [{ t: now - 2 * HOUR, total: 40 }],
            'networthSeries_e_2026-08': [{ t: now - HOUR, total: 60 }],
            networthDetail_e_123: { t: 123, items: {} },
        };
        db.stores.lootLogHistory = { 'lootLogRec_f_2026-08-01T10': [] };

        const account = await readAccount(now);

        expect(account.characters.map((row) => row.id).sort()).toEqual(['char-1', 'e', 'f']);
        // And the chunks are assembled back into the series the panel reads
        expect(account.characters.find((row) => row.id === 'e').networth).toBe(60);
        expect(account.characters.find((row) => row.id === 'e').points).toBe(2);
    });

    test('a detail snapshot key is not mistaken for a character', async () => {
        db.stores.networthHistory = { networthDetail_g_123: { t: 123, items: {} } };

        const account = await readAccount(now);

        expect(account.characters.map((row) => row.id)).toEqual(['char-1']);
    });

    test('the un-split single key still wins where it is the one that exists', async () => {
        db.stores.networthHistory = {
            networth_h: [{ t: now - HOUR, total: 99 }],
            // A half-finished split beside it is not the record
            'networthSeries_h_1999-01': [{ t: 1, total: 1 }],
        };

        const account = await readAccount(now);

        expect(account.characters.find((row) => row.id === 'h').networth).toBe(99);
    });

    test('the logged-in name is recorded for the next time it is an alt', async () => {
        await rememberCurrentCharacter();
        expect(db.stores.settings.accountCharacterNames).toEqual({ 'char-1': 'Main' });

        game.id = 'char-2';
        game.name = 'Alt';
        await rememberCurrentCharacter();

        expect(db.stores.settings.accountCharacterNames).toEqual({ 'char-1': 'Main', 'char-2': 'Alt' });
    });
});

/**
 * What happens when the database will not answer.
 *
 * This used to be a `console.error` and nothing else, which for a panel that
 * refreshes on a timer means the same line every minute in a place nobody is
 * looking, and a panel that says "Reading the account…" forever. The two things
 * worth asserting are that it is said at all, and that it is said once.
 */
describe('a storage read that fails', () => {
    test('is reported to the player, and the reason is kept for the panel', async () => {
        db.broken = 'IndexedDB is closed';

        expect(await refreshAccount(0)).toBeNull();

        expect(accountReadFailure()).toBe('IndexedDB is closed');
        expect(toasts).toHaveLength(1);
        expect(toasts[0].kind).toBe('error');
        expect(toasts[0].message).toContain('Account panel');
    });

    test('is said once a session, not once a refresh', async () => {
        db.broken = 'IndexedDB is closed';

        await refreshAccount(0);
        await refreshAccount(0);
        await refreshAccount(0);

        expect(toasts).toHaveLength(1);
    });

    test('a failed name write counts as the same trouble, not a second toast', async () => {
        db.broken = 'IndexedDB is closed';

        await rememberCurrentCharacter();
        await refreshAccount(0);

        expect(toasts).toHaveLength(1);
        expect(accountReadFailure()).toBe('IndexedDB is closed');
    });

    test('a read that works again clears the reason, so the panel stops apologising', async () => {
        db.broken = 'IndexedDB is closed';
        await refreshAccount(0);
        expect(accountReadFailure()).toBeTruthy();

        db.broken = null;
        db.stores.networthHistory = { networth_a: [{ t: 1, total: 5 }] };
        await refreshAccount(0);

        expect(accountReadFailure()).toBeNull();
    });

    test('keeps the last good read rather than blanking the panel', async () => {
        db.stores.networthHistory = { networth_a: [{ t: 1, total: 5 }] };
        const good = await refreshAccount(0);
        expect(good.characters.length).toBeGreaterThan(0);

        db.broken = 'IndexedDB is closed';
        expect(await refreshAccount(0)).toBe(good);
    });
});
