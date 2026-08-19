/**
 * persisted-record: the load/save discipline that keeps a stored history from
 * being wiped by a read that could not be made, or by a stale second tab.
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
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => 'standard',
    getCurrentCharacterName: () => 'Main',
}));

vi.mock('../core/storage.js', () => ({ default: storageMock }));
vi.mock('../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { createPersistedRecord, mergeById, mergeMaps, mergeSeriesMaps } = await import('./persisted-record.js');

const LOG = 'log_char1';
const stored = () => storageMock.storeFor('settings').get(LOG);
const byId = () =>
    createPersistedRecord({
        base: 'log',
        empty: () => [],
        merge: mergeById(
            (e) => e.id,
            (a, b) => a.id - b.id
        ),
        label: 'Test',
    });

beforeEach(() => {
    storageMock.reset();
    dataManagerMock.characterId = 'char1';
    for (const fn of [storageMock.get, storageMock.tryGet, storageMock.set, storageMock.delete]) fn.mockClear();
});

describe('merges', () => {
    test('mergeById unions by id, memory winning on a clash, sorted when asked', () => {
        const merge = mergeById(
            (e) => e.id,
            (a, b) => a.id - b.id
        );
        expect(
            merge(
                [
                    { id: 3, v: 's' },
                    { id: 1, v: 's' },
                ],
                [
                    { id: 2, v: 'm' },
                    { id: 3, v: 'm' },
                ]
            )
        ).toEqual([
            { id: 1, v: 's' },
            { id: 2, v: 'm' },
            { id: 3, v: 'm' },
        ]);
    });

    test('mergeById tolerates non-arrays and entries without an id', () => {
        const merge = mergeById((e) => e.id);
        expect(merge(null, [{ id: 1 }, { nope: true }])).toEqual([{ id: 1 }]);
        expect(merge({ junk: 1 }, undefined)).toEqual([]);
    });

    test('mergeMaps keeps stored keys memory lacks and lets memory win', () => {
        expect(mergeMaps()({ a: 1, b: 1 }, { b: 2, c: 2 })).toEqual({ a: 1, b: 2, c: 2 });
        expect(mergeMaps()(null, { x: 1 })).toEqual({ x: 1 });
    });

    test('mergeSeriesMaps unions each series by sample key', () => {
        const merge = mergeSeriesMaps(
            (s) => s.t,
            (a, b) => a.t - b.t
        );
        expect(
            merge(
                { alice: [{ t: 1, xp: 10 }], bob: [{ t: 1, xp: 5 }] },
                { alice: [{ t: 2, xp: 20 }], carol: [{ t: 1, xp: 1 }] }
            )
        ).toEqual({
            alice: [
                { t: 1, xp: 10 },
                { t: 2, xp: 20 },
            ],
            bob: [{ t: 1, xp: 5 }],
            carol: [{ t: 1, xp: 1 }],
        });
    });
});

describe('load', () => {
    test('reads the stored record and folds it under anything already in memory', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }, { id: 2 }]);
        const record = byId();
        record.set([{ id: 3 }]);

        expect(await record.load()).toBe(true);
        expect(record.get().map((e) => e.id)).toEqual([1, 2, 3]);
        expect(record.isLoaded()).toBe(true);
    });

    test('an unreadable probe keeps memory rather than blanking it', async () => {
        const record = byId();
        record.set([{ id: 1 }, { id: 2 }]);
        storageMock.unavailable = true;

        expect(await record.load()).toBe(false);
        expect(record.get().map((e) => e.id)).toEqual([1, 2]);
        expect(record.isLoaded()).toBe(false);
    });

    test('a trustworthy absent key goes through legacy adoption', async () => {
        // The bare key from before per-character scoping; readScoped moves it
        storageMock.storeFor('settings').set('log', [{ id: 7 }]);
        const record = byId();

        expect(await record.load()).toBe(true);
        expect(record.get().map((e) => e.id)).toEqual([7]);
        expect(stored().map((e) => e.id)).toEqual([7]);
        expect(storageMock.storeFor('settings').has('log')).toBe(false);
    });

    test('an unscoped record uses the bare key and no adoption', async () => {
        storageMock.storeFor('settings').set('global', { a: 1 });
        const record = createPersistedRecord({
            base: 'global',
            empty: () => ({}),
            merge: mergeMaps(),
            scoped: false,
        });

        await record.load();
        expect(record.get()).toEqual({ a: 1 });
    });
});

describe('save', () => {
    test('folds what is stored under memory, so rows from another writer survive', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }, { id: 2, v: 'old' }]);
        const record = byId();
        record.set([{ id: 2, v: 'new' }, { id: 3 }]);

        expect(await record.save()).toBe(true);
        expect(stored()).toEqual([{ id: 1 }, { id: 2, v: 'new' }, { id: 3 }]);
        expect(record.get().map((e) => e.id)).toEqual([1, 2, 3]);
    });

    test('is skipped when storage cannot be read first, leaving the stored record untouched', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }, { id: 2 }, { id: 3 }]);
        const record = byId();
        // The failure that used to wipe histories: memory empty after a failed
        // load, then one event saved back
        record.set([{ id: 4 }]);
        storageMock.unavailable = true;

        expect(await record.save()).toBe(false);
        expect(stored().map((e) => e.id)).toEqual([1, 2, 3]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }]);
        const record = byId();
        storageMock.unavailable = true;
        await record.update((log) => log.push({ id: 2 }));
        expect(stored().map((e) => e.id)).toEqual([1]);

        storageMock.unavailable = false;
        await record.update((log) => log.push({ id: 3 }));
        expect(stored().map((e) => e.id)).toEqual([1, 2, 3]);
    });

    test('saves are serialized in order', async () => {
        const record = byId();
        const order = [];
        storageMock.tryGet.mockImplementation(async (key, store) => {
            order.push('probe');
            await new Promise((r) => setTimeout(r, 5));
            const map = storageMock.storeFor(store);
            return map.has(key) ? { found: true, value: structuredClone(map.get(key)) } : { found: false };
        });
        storageMock.set.mockImplementation(async (key, value, store) => {
            order.push('write');
            storageMock.storeFor(store).set(key, structuredClone(value));
            return true;
        });

        record.set([{ id: 1 }]);
        const first = record.save();
        record.get().push({ id: 2 });
        const second = record.save();
        await Promise.all([first, second]);

        expect(order).toEqual(['probe', 'write', 'probe', 'write']);
        expect(stored().map((e) => e.id)).toEqual([1, 2]);
    });

    test('clear is the one write allowed to lose entries, and stays cleared', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }, { id: 2 }]);
        const record = byId();
        await record.load();

        await record.clear();
        expect(stored()).toEqual([]);

        await record.update((log) => log.push({ id: 3 }));
        expect(stored().map((e) => e.id)).toEqual([3]);
    });

    test('overwrite writes memory as-is, for intentional removals after a fresh load', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }, { id: 2 }]);
        const record = byId();
        await record.load();
        record.set(record.get().filter((e) => e.id !== 1));

        await record.save({ overwrite: true });
        expect(stored().map((e) => e.id)).toEqual([2]);
    });

    test('reset forgets memory without writing, for a character switch', async () => {
        storageMock.storeFor('settings').set(LOG, [{ id: 1 }]);
        const record = byId();
        await record.load();
        record.reset();

        expect(record.get()).toEqual([]);
        expect(record.isLoaded()).toBe(false);
        expect(stored().map((e) => e.id)).toEqual([1]);
    });

    test('a map record merges stored keys under memory', async () => {
        storageMock.storeFor('settings').set('tally_char1', { gold: 1, silver: 1 });
        const record = createPersistedRecord({ base: 'tally', empty: () => ({}), merge: mergeMaps() });
        record.set({ silver: 5, bronze: 2 });

        await record.save();
        expect(storageMock.storeFor('settings').get('tally_char1')).toEqual({ gold: 1, silver: 5, bronze: 2 });
    });
});
