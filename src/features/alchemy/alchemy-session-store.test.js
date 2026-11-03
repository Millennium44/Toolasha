/**
 * Where the alchemy trackers put their sessions.
 *
 * The three trackers used to write every session ever kept, immediately, on
 * every completed action — an unbounded array rewritten every couple of seconds
 * for as long as the account existed. What is worth asserting is that a saved
 * session now costs the one day's record it belongs to, that the sessions
 * recorded before login are still found, and that the split of the old array is
 * the same list read back.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        // Delegates to the listing above, so a test that changes how keys are
        // listed changes both. `chunked-history.js` reads through this one
        // because an unlistable store must not read as an empty history.
        tryGetAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
});

vi.mock('../../core/storage.js', () => ({ default: storageMock }));

const { createAlchemySessionStore, mergeSessionCopies, NO_CHARACTER } = await import('./alchemy-session-store.js');
const { mergeCosts, resolveInputCost } = await import('./alchemy-cost-record.js');

/** A session as the trackers build them */
const session = (startTime, id) => ({ id: id ?? `transmute_${startTime}`, startTime, totalAttempts: 1, results: {} });

const AUG_4 = Date.UTC(2026, 7, 4, 9);
const AUG_5 = Date.UTC(2026, 7, 5, 9);

let store;

beforeEach(() => {
    storageMock.store.clear();
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    // Implementations, not just calls: a test that makes a write fail must not
    // leave the next one failing too
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    storageMock.putAll.mockImplementation(async (storeName, entries) => {
        for (const [key, value] of Object.entries(entries)) storageMock.store.set(key, value);
        return Object.keys(entries).length;
    });
    store = createAlchemySessionStore('transmuteSessions', 'TransmuteHistoryTracker');
});

describe('key shape', () => {
    test('a session lands in the record for the day it started', async () => {
        await store.save('char-1', [session(AUG_4)]);

        expect([...storageMock.store.keys()]).toEqual(['transmuteSessionsRec_char-1_2026-08-04']);
    });

    test('a run that spilled into the next day is still filed by, and read back from, its start day', async () => {
        // `lastActivityTime` is the far end of the span the gold attribution
        // spreads a session over, so it has to survive the store — and it must
        // not move the record, which is keyed by the day the run began
        const spanning = { ...session(AUG_4), lastActivityTime: AUG_5 };
        await store.save('char-1', [spanning]);

        expect([...storageMock.store.keys()]).toEqual(['transmuteSessionsRec_char-1_2026-08-04']);
        expect(await store.load('char-1')).toEqual([spanning]);
    });

    test('the record prefix cannot be confused with the legacy key of any character', () => {
        // `transmuteSessionsRec_...` vs `transmuteSessions_<id>` — the character
        // after the base is `R`, never `_`, so no scan for the legacy shape
        // matches a record
        expect('transmuteSessionsRec_char-1_2026-08-04'.startsWith('transmuteSessions_')).toBe(false);
    });
});

describe('a completed action writes one day, not every session', () => {
    test('updating the active session leaves the earlier days untouched', async () => {
        const running = session(AUG_5);
        await store.save('char-1', [session(AUG_4), running]);
        storageMock.set.mockClear();

        running.totalAttempts = 2;
        await store.save('char-1', [session(AUG_4), running]);

        expect(storageMock.set.mock.calls.map(([key]) => key)).toEqual(['transmuteSessionsRec_char-1_2026-08-05']);
    });

    test('the write is immediate, because a session can be cut off by a closed tab', async () => {
        await store.save('char-1', [session(AUG_4)]);

        const [, , storeName, immediate] = storageMock.set.mock.calls[0];
        expect(storeName).toBe('alchemyHistory');
        expect(immediate).toBe(true);
    });

    test('deleting one row from the viewer removes the record its day is left empty', async () => {
        await store.save('char-1', [session(AUG_4), session(AUG_5)]);
        storageMock.delete.mockClear();

        await store.save('char-1', [session(AUG_5)]);

        expect(storageMock.delete).toHaveBeenCalledWith('transmuteSessionsRec_char-1_2026-08-04', 'alchemyHistory');
    });
});

describe('the split of the old array', () => {
    test('reads back as the same list, oldest first', async () => {
        const legacy = [session(AUG_4), session(AUG_5)];
        storageMock.store.set('transmuteSessions_char-1', legacy);

        const loaded = await store.load('char-1');

        expect(loaded).toEqual(legacy);
        expect(storageMock.store.has('transmuteSessions_char-1')).toBe(false);
        expect([...storageMock.store.keys()].sort()).toEqual([
            'transmuteSessionsRec_char-1_2026-08-04',
            'transmuteSessionsRec_char-1_2026-08-05',
        ]);
    });

    test('the bare pre-login key is claimed too, rather than orphaned', async () => {
        // What the trackers wrote before a character id was known
        storageMock.store.set('transmuteSessions', [session(AUG_4)]);

        const loaded = await store.load(NO_CHARACTER);

        expect(loaded).toHaveLength(1);
        expect(storageMock.store.has('transmuteSessions')).toBe(false);
        expect(storageMock.store.has('transmuteSessionsRec_default_2026-08-04')).toBe(true);
    });

    test('a split that will not fit leaves the array whole and readable', async () => {
        const legacy = [session(AUG_4), session(AUG_5)];
        storageMock.store.set('transmuteSessions_char-1', legacy);
        storageMock.putAll.mockImplementation(async () => 0);
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        expect(await store.load('char-1')).toEqual(legacy);
        expect(storageMock.store.get('transmuteSessions_char-1')).toEqual(legacy);
        expect(store.isLegacy()).toBe(true);
    });
});

describe('clearing the history', () => {
    test('takes every day record and the legacy key with it', async () => {
        storageMock.store.set('transmuteSessions_char-1', [session(AUG_4)]);
        await store.load('char-1');
        await store.save('char-1', [session(AUG_4), session(AUG_5)]);

        await store.clear('char-1');

        // The deletion record outlives the clear on purpose: it is what stops
        // the next sync pull handing the whole history back
        expect([...storageMock.store.keys()]).toEqual(['transmuteSessionsRecTomb_char-1']);
        expect(await store.load('char-1')).toEqual([]);
    });
});

describe('an older copy of a cleared session', () => {
    const copy = (attempts) => ({ ...session(AUG_4, 'transmute_live'), totalAttempts: attempts });

    test('does not come back from a peer after the clear, but a copy further along does', async () => {
        await store.load('char-1');
        await store.save('char-1', [copy(5)]);
        await store.clear('char-1');

        // The stone records how far along the cleared copy was
        expect(storageMock.store.get('transmuteSessionsRecTomb_char-1')['transmute_live']).toMatchObject({
            bulk: true,
            rev: 5,
        });

        await store.load('char-1');
        // Pushed before the clear, then pulled after it: an older snapshot, not news
        expect(store._union([], [copy(3)])).toEqual([]);
        expect(store._union([], [copy(5)])).toEqual([]);
        // A device that kept recording past the clear has outlived it
        expect(store._union([], [copy(8)])).toEqual([copy(8)]);
    });
});

describe('a hand-corrected import against a sync pull', () => {
    const copy = (attempts, extra = {}) => ({ ...session(AUG_4, 'transmute_live'), totalAttempts: attempts, ...extra });

    test('the later edit wins even when it lowers the attempts', () => {
        const corrected = copy(40, { editedAt: 2000 });
        const pulled = copy(50);
        expect(mergeSessionCopies(corrected, pulled)).toBe(corrected);
        expect(mergeSessionCopies(pulled, corrected)).toBe(corrected);
    });

    test('of two edits the newer stamp wins', () => {
        const older = copy(60, { editedAt: 1000 });
        const newer = copy(10, { editedAt: 2000 });
        expect(mergeSessionCopies(older, newer)).toBe(newer);
        expect(mergeSessionCopies(newer, older)).toBe(newer);
    });

    test('equal stamps, or none, fall back to more attempts', () => {
        expect(mergeSessionCopies(copy(3, { editedAt: 5 }), copy(9, { editedAt: 5 })).totalAttempts).toBe(9);
        expect(mergeSessionCopies(copy(3), copy(9)).totalAttempts).toBe(9);
        expect(mergeSessionCopies(copy(3, { editedAt: 'junk' }), copy(9)).totalAttempts).toBe(9);
    });

    test('a pull folds into the corrected copy rather than reverting it', async () => {
        await store.load('char-1');
        await store.save('char-1', [copy(40, { editedAt: 2000 })]);
        await store.load('char-1');
        const [kept] = store._union([copy(40, { editedAt: 2000 })], [copy(50)]);
        expect(kept.totalAttempts).toBe(40);
    });
});

describe('a correction against a live recorder, and against a clear', () => {
    const copy = (attempts, extra = {}) => ({ ...session(AUG_4, 'transmute_live'), totalAttempts: attempts, ...extra });

    test('the import after the other device’s last attempt wins', () => {
        const imported = copy(40, { editedAt: 2000, lastActivityTime: 1000 });
        const recorded = copy(50, { lastActivityTime: 1500 });
        expect(mergeSessionCopies(imported, recorded)).toBe(imported);
        expect(mergeSessionCopies(recorded, imported)).toBe(imported);
    });

    test('attempts recorded after the import win over it', () => {
        const imported = copy(40, { editedAt: 2000, lastActivityTime: 1000 });
        const recorded = copy(50, { lastActivityTime: 2500 });
        expect(mergeSessionCopies(imported, recorded)).toBe(recorded);
        expect(mergeSessionCopies(recorded, imported)).toBe(recorded);
    });

    test('a correction made after a clear survives the clear’s tombstone', async () => {
        await store.load('char-1');
        await store.save('char-1', [copy(100)]);
        await store.clear('char-1');
        await store.load('char-1');
        const stone = storageMock.store.get('transmuteSessionsRecTomb_char-1')['transmute_live'];

        const corrected = copy(90, { editedAt: stone.at + 1000 });
        expect(store._union([], [corrected])).toEqual([corrected]);
        // An unedited older snapshot is still covered
        expect(store._union([], [copy(90)])).toEqual([]);
        // An edit that predates the clear is not news either
        expect(store._union([], [copy(90, { editedAt: stone.at - 1000 })])).toEqual([]);
    });
});

describe('saved costs through a merge', () => {
    const costed = (attempts, cost, extra = {}) => ({
        ...session(AUG_4, 'transmute_live'),
        totalAttempts: attempts,
        costs: { input: { cost, units: attempts, bases: { ask: attempts } } },
        ...extra,
    });

    test('the copy kept for its edit keeps its own costs, so a later extension prices right', () => {
        const original = costed(10, 1000, { lastActivityTime: 1000 });
        const corrected = costed(5, 500, { editedAt: 2000, lastActivityTime: 1000 });
        const merged = mergeSessionCopies(original, corrected);
        expect(merged.totalAttempts).toBe(5);
        expect(merged.costs.input).toMatchObject({ cost: 500, units: 5 });
        expect(mergeSessionCopies(corrected, original).costs).toEqual(merged.costs);

        // Five more units costing 1,000 are recorded on top
        const extended = { ...merged, totalAttempts: 10, costs: mergeCosts(merged.costs, costed(5, 1000).costs) };
        expect(resolveInputCost(extended, 10, () => ({ price: 0, basis: null })).cost).toBe(1500);
    });

    test('replaying the merge changes nothing', () => {
        const original = costed(10, 1000);
        const corrected = costed(5, 500, { editedAt: 2000 });
        const once = mergeSessionCopies(original, corrected);
        expect(mergeSessionCopies(once, original)).toEqual(once);
        expect(mergeSessionCopies(once, corrected)).toEqual(once);
    });

    test('a copy that outlived the edit keeps its own costs', () => {
        const edited = costed(5, 500, { editedAt: 2000, lastActivityTime: 1000 });
        const recorded = costed(12, 1300, { lastActivityTime: 2500 });
        expect(mergeSessionCopies(edited, recorded).costs.input.cost).toBe(1300);
    });

    test('a kept copy with no costs borrows the other copy’s rather than none', () => {
        const edited = { ...costed(5, 500, { editedAt: 2000 }), costs: undefined };
        const original = costed(10, 1000);
        expect(mergeSessionCopies(edited, original).costs.input.cost).toBe(1000);
    });

    test('copies of the same edit revision, or none, still go by coverage', () => {
        const stamped = mergeSessionCopies(costed(9, 900, { editedAt: 5 }), costed(3, 300, { editedAt: 5 }));
        expect(stamped.costs.input.units).toBe(9);
        const bare = { ...costed(9, 900), costs: undefined };
        expect(mergeSessionCopies(bare, costed(3, 300)).costs.input.units).toBe(3);
        expect(mergeSessionCopies(costed(3, 300), costed(9, 900)).costs.input.units).toBe(9);
    });
});
