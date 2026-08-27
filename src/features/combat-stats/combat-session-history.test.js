/**
 * Session history.
 *
 * A run is archived when a *different* one starts, because that is the first
 * moment it is knowable to be over — nothing on the wire announces an ending.
 * The consequences of that choice are what these test: a session seen twice must
 * not appear twice, and a combined view must merge on the item rather than on
 * the game's per-session slot key.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
const game = vi.hoisted(() => ({ characterId: 'char1' }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.characterId, getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    sessionKey,
    withSession,
    combineSessions,
    describeSession,
    MAX_SESSIONS,
    loadSessions,
    archiveSession,
    clearSessions,
} = await import('./combat-session-history.js');

const session = (start, names = ['Millennium44'], loot = {}) => ({
    combatStartTime: start,
    durationSeconds: 600,
    players: names.map((name) => ({ name, loot })),
});

describe('naming a session', () => {
    test('the roster and the start time together', () => {
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).toBe(sessionKey(session('2026-08-03T01:00:00Z')));
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).not.toBe(sessionKey(session('2026-08-03T02:00:00Z')));
    });

    test('the same zone with somebody gone is a different session', () => {
        const party = sessionKey(session('2026-08-03T01:00:00Z', ['A', 'B']));
        const alone = sessionKey(session('2026-08-03T01:00:00Z', ['A']));

        expect(alone).not.toBe(party);
    });

    test('a snapshot that cannot say is not named', () => {
        expect(sessionKey({ players: [] })).toBeNull();
        expect(sessionKey({ players: [{ name: 'A' }] })).toBeNull();
        expect(sessionKey(null)).toBeNull();
    });
});

describe('adding a run to the list', () => {
    test('newest first', () => {
        let history = withSession([], session('2026-08-03T01:00:00Z'));
        history = withSession(history, session('2026-08-03T02:00:00Z'));

        expect(history[0].combatStartTime).toBe('2026-08-03T02:00:00Z');
        expect(history).toHaveLength(2);
    });

    test('the same session twice replaces rather than repeats', () => {
        // The later snapshot is the more complete one — loot totals only grow —
        // so it wins, and the run appears once
        const first = session('2026-08-03T01:00:00Z');
        const later = { ...first, durationSeconds: 1200 };

        const history = withSession(withSession([], first), later);

        expect(history).toHaveLength(1);
        expect(history[0].durationSeconds).toBe(1200);
    });

    test('the list does not grow forever', () => {
        let history = [];
        for (let i = 0; i < MAX_SESSIONS + 5; i++) {
            history = withSession(history, session(`2026-08-03T${String(i).padStart(2, '0')}:00:00Z`));
        }

        expect(history).toHaveLength(MAX_SESSIONS);
    });

    test('a snapshot with no key is ignored rather than stored under one', () => {
        expect(withSession([], { players: [] })).toEqual([]);
    });
});

describe('several runs as one', () => {
    const withLoot = (start, count) => session(start, ['Millennium44'], { 7: { itemHrid: '/items/coin', count } });

    test('loot is merged on the item, not on the game’s slot key', () => {
        // Two sessions number their slots independently, so merging on the raw
        // key would put the same item in two rows
        const combined = combineSessions([
            { ...withLoot('2026-08-03T01:00:00Z', 100) },
            { ...session('2026-08-03T02:00:00Z', ['Millennium44'], { 3: { itemHrid: '/items/coin', count: 50 } }) },
        ]);

        const loot = Object.values(combined.players[0].loot);
        expect(loot).toHaveLength(1);
        expect(loot[0].count).toBe(150);
    });

    test('a character is followed by name across sessions', () => {
        // Position means nothing between runs — the same person is slot 0 in one
        // and slot 3 in the next
        const combined = combineSessions([
            session('2026-08-03T01:00:00Z', ['A', 'B']),
            session('2026-08-03T02:00:00Z', ['B', 'A']),
        ]);

        expect(combined.players.map((player) => player.name).sort()).toEqual(['A', 'B']);
    });

    test('durations add, which is what makes a rate over the lot mean anything', () => {
        const combined = combineSessions([session('2026-08-03T01:00:00Z'), session('2026-08-03T02:00:00Z')]);

        expect(combined.durationSeconds).toBe(1200);
        expect(combined.sessionCount).toBe(2);
    });

    test('nothing to combine is null rather than an empty run', () => {
        expect(combineSessions([])).toBeNull();
        expect(combineSessions([{ players: [] }])).toBeNull();
        expect(combineSessions(null)).toBeNull();
    });
});

describe('describing one in a picker', () => {
    test('the time it started and how long it ran', () => {
        const line = describeSession(session('2026-08-03T01:00:00Z'), (s) => `${s}s`);

        expect(line).toContain('600s');
    });

    test('a session with no start time still gets a line', () => {
        expect(describeSession({ durationSeconds: 0 })).toContain('Unknown time');
    });

    test('a negative stored duration (clock skew, before it was clamped) reads as zero, not nothing', () => {
        const line = describeSession(session('2026-08-03T01:00:00Z'), (s) => `${s}s`);
        const skewed = describeSession({ ...session('2026-08-03T01:00:00Z'), durationSeconds: -2 }, (s) => `${s}s`);

        expect(line).toContain('600s');
        expect(skewed).toContain('(0s)');
    });
});

describe('the list survives a failed read and a second tab', () => {
    const KEY = 'combatSessionHistory_char1';
    const stored = () => storageMock.storeFor('combatStats').get(KEY);
    const starts = (list) => list.map((s) => s.combatStartTime);

    beforeEach(async () => {
        storageMock.reset();
        game.characterId = 'char1';
        await clearSessions();
        storageMock.reset();
    });

    test('archiving appends newest first under the character key', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
        expect(starts(await loadSessions())).toEqual(['2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('a read that cannot be made keeps the list in memory instead of one run over all', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock.unavailable = true;

        const history = await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(history).toHaveLength(2);
        expect(await loadSessions()).toHaveLength(2);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock.unavailable = true;

        await archiveSession(session('2026-08-03T02:00:00Z'));

        storageMock.unavailable = false;
        expect(starts(stored())).toEqual(['2026-08-03T01:00:00Z']);
    });

    test('a save folds in runs another tab archived meanwhile', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        storageMock
            .storeFor('combatStats')
            .set(KEY, [withSession([], session('2026-08-03T03:00:00Z'))[0], ...stored()]);

        await archiveSession(session('2026-08-03T02:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T03:00:00Z', '2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        await archiveSession(session('2026-08-03T01:00:00Z'));
        await archiveSession(session('2026-08-03T02:00:00Z'));
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await archiveSession(session('2026-08-03T03:00:00Z'));

        expect(starts(stored())).toEqual(['2026-08-03T03:00:00Z', '2026-08-03T02:00:00Z', '2026-08-03T01:00:00Z']);
    });

    test('a character switch forgets the departing character’s runs', async () => {
        await archiveSession(session('2026-08-03T01:00:00Z'));
        game.characterId = 'char2';

        await archiveSession(session('2026-08-03T09:00:00Z'));

        expect(starts(storageMock.storeFor('combatStats').get('combatSessionHistory_char2'))).toEqual([
            '2026-08-03T09:00:00Z',
        ]);
        expect(starts(stored())).toEqual(['2026-08-03T01:00:00Z']);
    });
});
