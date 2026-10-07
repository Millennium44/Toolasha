/**
 * Two game tabs on one character share the sessions key, and every attempt in
 * either tab saves the whole map. A tab used to write its memory whole once it
 * had loaded, so a session the other tab deleted or merged away came back on its
 * next save, and one the other tab started vanished. Saves now merge by session
 * id, with removals carried as tombstones.
 *
 * Each "tab" is a fresh import of the storage module over one shared database.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const dataManagerMock = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    currentGameMode: 'standard',
    getCurrentCharacterId: vi.fn(() => dataManagerMock.currentCharacterId),
    getCurrentCharacterGameMode: vi.fn(() => dataManagerMock.currentGameMode),
    on: vi.fn(),
    off: vi.fn(),
}));

// One database for both tabs. Reads and writes copy, as IndexedDB does, so one
// tab's in-place edits never show through in the other's memory.
//
// With `deferCommits`, `set` behaves as the real `Storage._debouncedSave` does: the
// value is handed over at once and lands three seconds later, last timer wins.
// `update` is one readwrite transaction — the read and the write with nothing
// between them, which is what IndexedDB's per-store serialization across tabs gives.
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const read = async (key, store = 'settings', fallback = null) => {
        const held = storeFor(store).get(key);
        return held === undefined || held === null ? fallback : structuredClone(held);
    };
    const mock = {
        stores,
        storeFor,
        get: vi.fn(read),
        tryGet: vi.fn(async (key, store = 'settings') => {
            const held = storeFor(store).get(key);
            return held === undefined || held === null
                ? { found: false, value: null }
                : { found: true, value: structuredClone(held) };
        }),
        getJSON: vi.fn(read),
        deferCommits: false,
        teardownListeners: [],
        set: vi.fn(async (key, value, store = 'settings') => {
            const copy = structuredClone(value);
            if (!mock.deferCommits) {
                storeFor(store).set(key, copy);
                return true;
            }
            setTimeout(() => storeFor(store).set(key, copy), 3000);
            return true;
        }),
        update: vi.fn(async (key, mutate, store = 'settings') => {
            await Promise.resolve();
            const held = storeFor(store).get(key);
            const found = held !== undefined;
            const next = mutate(found ? structuredClone(held) : undefined, found);
            if (next === undefined) return { written: false, value: held };
            storeFor(store).set(key, structuredClone(next));
            return { written: true, value: next };
        }),
        onBeforeTeardown: vi.fn((listener) => {
            mock.teardownListeners.push(listener);
            return () => {};
        }),
        // What `importEverything` restores through
        listStores: vi.fn(async () => Array.from(stores.keys())),
        putAll: vi.fn(async (store, entries) => {
            for (const [key, value] of Object.entries(entries)) storeFor(store).set(key, structuredClone(value));
            return Object.keys(entries).length;
        }),
        beginRestore: vi.fn(async () => {}),
        finishRestore: vi.fn(() => {}),
        endRestore: vi.fn(async () => {}),
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
    return mock;
});

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));

const SESSIONS = 'enhancementTracker_sessions_market123';
const TOMBSTONES = 'enhancementTracker_sessionTombstones_market123';
const settings = () => storageMock.storeFor('settings');
const stored = () => settings().get(SESSIONS);

/** A fresh copy of the storage module: one game tab */
async function openTab() {
    vi.resetModules();
    const tab = await import('./enhancement-storage.js');
    const sessions = await tab.loadSessions();
    return { ...tab, sessions };
}

const session = (id, at, attempts = 0) => ({ id, startTime: 1, lastUpdateTime: at, totalAttempts: attempts });

beforeEach(() => {
    storageMock.stores.clear();
    storageMock.deferCommits = false;
    storageMock.teardownListeners.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('two tabs saving the same sessions', () => {
    test('a deletion in one tab survives the other tab’s later save', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100), s2: session('s2', 200) });
        const a = await openTab();
        const b = await openTab();

        await a.deleteSession(a.sessions, 's1');
        await a.flushSessionWrites();
        expect(Object.keys(stored())).toEqual(['s2']);

        // Tab B still holds s1, and its next attempt saves the map
        b.sessions.s2.lastUpdateTime = 300;
        await b.saveSessions(b.sessions);
        await b.flushSessionWrites();

        expect(Object.keys(stored())).toEqual(['s2']);
        expect(stored().s2.lastUpdateTime).toBe(300);
        // And B's own list has caught up, so it does not show the deleted one
        expect(Object.keys(b.sessions)).toEqual(['s2']);
    });

    test('a merge in one tab survives the other tab’s later save', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100, 3), s2: session('s2', 200, 4) });
        const a = await openTab();
        const b = await openTab();

        // As mergeSessionsIntoOne does: the newest absorbs the others, which are deleted
        a.sessions.s2.totalAttempts = 7;
        delete a.sessions.s1;
        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();

        // B starts a run of its own and saves
        b.sessions.s3 = session('s3', 400, 1);
        const heldS2 = b.sessions.s2;
        await b.saveSessions(b.sessions);
        await b.flushSessionWrites();

        expect(Object.keys(stored())).toEqual(['s2', 's3']);
        expect(stored().s2.totalAttempts).toBe(7);
        // B took the merged copy without swapping the object it holds
        expect(b.sessions.s2).toBe(heldS2);
        expect(heldS2.totalAttempts).toBe(7);
    });

    test('a session started in one tab survives the other tab’s save', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100) });
        const a = await openTab();
        const b = await openTab();

        a.sessions.s2 = session('s2', 200, 1);
        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();

        b.sessions.s1.lastUpdateTime = 150;
        await b.saveSessions(b.sessions);
        await b.flushSessionWrites();

        expect(Object.keys(stored())).toEqual(['s1', 's2']);
        expect(stored().s1.lastUpdateTime).toBe(150);
        expect(Object.keys(b.sessions)).toEqual(['s1', 's2']);
    });

    test('concurrent updates to one session keep the newer copy, whichever tab saves last', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100, 1) });
        const a = await openTab();
        const b = await openTab();

        a.sessions.s1.lastUpdateTime = 300;
        a.sessions.s1.totalAttempts = 5;
        b.sessions.s1.lastUpdateTime = 200;
        b.sessions.s1.totalAttempts = 3;

        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();
        await b.saveSessions(b.sessions);
        await b.flushSessionWrites();
        expect(stored().s1).toMatchObject({ lastUpdateTime: 300, totalAttempts: 5 });

        // B moves past A, and its copy wins from then on
        b.sessions.s1.lastUpdateTime = 400;
        b.sessions.s1.totalAttempts = 6;
        await b.saveSessions(b.sessions);
        await b.flushSessionWrites();
        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();
        expect(stored().s1).toMatchObject({ lastUpdateTime: 400, totalAttempts: 6 });
    });

    test('a tab that removes nothing keeps its own unsaved changes over a stale stored copy', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100, 1) });
        const a = await openTab();

        // A cost tracked between attempts moves no stamp; the stored copy is older
        a.sessions.s1.coinCost = 50;
        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();

        expect(stored().s1.coinCost).toBe(50);
    });

    test('tombstones expire after the time to live', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
        settings().set(SESSIONS, { s1: session('s1', 100), s2: session('s2', 200) });
        const a = await openTab();

        await a.deleteSession(a.sessions, 's1');
        await a.flushSessionWrites();
        expect(Object.keys(settings().get(TOMBSTONES))).toEqual(['s1']);

        vi.setSystemTime(Date.now() + a.TOMBSTONE_TTL_MS + 1);
        await a.deleteSession(a.sessions, 's2');
        await a.flushSessionWrites();

        expect(Object.keys(settings().get(TOMBSTONES))).toEqual(['s2']);
    });
});

describe('two tabs whose saves overlap', () => {
    test('both tabs’ changes survive two saves asked for before either has landed', async () => {
        vi.useFakeTimers();
        storageMock.deferCommits = true;
        settings().set(SESSIONS, { s1: session('s1', 100, 1) });
        const a = await openTab();
        const b = await openTab();

        // A starts a session; B, still holding only s1, records an attempt on it.
        // Both ask to save before either write has reached the database.
        a.sessions.s2 = session('s2', 200, 1);
        await a.saveSessions(a.sessions);
        b.sessions.s1.lastUpdateTime = 300;
        b.sessions.s1.totalAttempts = 2;
        await b.saveSessions(b.sessions);
        await vi.advanceTimersByTimeAsync(10_000);
        await a.flushSessionWrites();
        await b.flushSessionWrites();
        await vi.advanceTimersByTimeAsync(10_000);

        expect(Object.keys(stored())).toEqual(['s1', 's2']);
        expect(stored().s1.totalAttempts).toBe(2);
    });

    test('a tab that closes before its save has run still lands it, through the page-close hook', async () => {
        vi.useFakeTimers();
        settings().set(SESSIONS, { s1: session('s1', 100, 1) });
        const a = await openTab();
        const b = await openTab();
        expect(storageMock.teardownListeners).toHaveLength(2);

        a.sessions.s2 = session('s2', 200, 1);
        await a.saveSessions(a.sessions);
        b.sessions.s1.lastUpdateTime = 300;
        await b.saveSessions(b.sessions);
        expect(stored().s2).toBeUndefined();

        // A's page closes inside its delay: its listener (registered first) writes now
        storageMock.teardownListeners[0]('pagehide');
        await vi.advanceTimersByTimeAsync(0);
        expect(Object.keys(stored())).toEqual(['s1', 's2']);

        await vi.advanceTimersByTimeAsync(10_000);
        await b.flushSessionWrites();
        expect(Object.keys(stored())).toEqual(['s1', 's2']);
        expect(stored().s1.lastUpdateTime).toBe(300);
    });
});

describe('a save that cannot read the tombstones', () => {
    test('writes nothing, rather than folding against a stale set of removals', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100) });
        const a = await openTab();
        const probe = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(async (key, store) => (key === TOMBSTONES ? null : probe(key, store)));
        try {
            a.sessions.s2 = session('s2', 200, 1);
            await a.saveSessions(a.sessions);
            await a.flushSessionWrites();

            expect(Object.keys(stored())).toEqual(['s1']);
            // Kept in memory for the next save that can read them
            expect(Object.keys(a.sessions)).toEqual(['s1', 's2']);
        } finally {
            storageMock.tryGet.mockImplementation(probe);
        }

        await a.saveSessions(a.sessions);
        await a.flushSessionWrites();
        expect(Object.keys(stored())).toEqual(['s1', 's2']);
    });
});

describe('restoring a backup', () => {
    /** A backup file of the settings store as it stands, minus the keys named */
    const backupOf = (...without) => {
        const entries = Object.fromEntries(settings());
        for (const key of without) delete entries[key];
        return {
            formatVersion: 1,
            exportedAt: '2026-10-01T00:00:00.000Z',
            stores: { settings: structuredClone(entries) },
        };
    };

    test('a backup from before a deletion, with no tombstones in it, brings the session back after a reload', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100), s2: session('s2', 200) });
        // Taken before tombstones existed: the sessions key and nothing else
        const backup = backupOf();
        const a = await openTab();
        await a.deleteSession(a.sessions, 's1');
        await a.flushSessionWrites();
        expect(Object.keys(settings().get(TOMBSTONES))).toEqual(['s1']);

        const { importEverything } = await import('../../utils/full-backup.js');
        expect((await importEverything(backup)).complete).toBe(true);

        const reloaded = await openTab();
        expect(Object.keys(reloaded.sessions)).toEqual(['s1', 's2']);
    });

    test('a restore keeps the tombstones of sessions it does not bring back', async () => {
        settings().set(SESSIONS, { s1: session('s1', 100), s2: session('s2', 200), s3: session('s3', 300) });
        const a = await openTab();
        await a.deleteSession(a.sessions, 's1');
        await a.flushSessionWrites();
        // The backup holds s1 again but never had s3
        const backup = backupOf(TOMBSTONES);
        backup.stores.settings[SESSIONS] = { s1: session('s1', 100), s2: session('s2', 200) };
        await a.deleteSession(a.sessions, 's3');
        await a.flushSessionWrites();

        const { importEverything } = await import('../../utils/full-backup.js');
        await importEverything(backup);

        expect(Object.keys(settings().get(TOMBSTONES))).toEqual(['s3']);
        const reloaded = await openTab();
        expect(Object.keys(reloaded.sessions)).toEqual(['s1', 's2']);
    });

    test('a backup that carries tombstones restores them, less any session it restores', async () => {
        settings().set(SESSIONS, { s2: session('s2', 200) });
        settings().set(TOMBSTONES, { s1: Date.now(), s4: Date.now() });
        const backup = backupOf();
        backup.stores.settings[SESSIONS] = { s1: session('s1', 100), s2: session('s2', 200) };
        settings().set(TOMBSTONES, { s9: Date.now() });

        const { importEverything } = await import('../../utils/full-backup.js');
        await importEverything(backup);

        expect(Object.keys(settings().get(TOMBSTONES))).toEqual(['s4']);
        const reloaded = await openTab();
        expect(Object.keys(reloaded.sessions)).toEqual(['s1', 's2']);
    });
});
