/**
 * @vitest-environment happy-dom
 *
 * The archive's permanent deletion record.
 *
 * The archive is permanent and the player deletes from it on purpose, but the chunked history's own
 * tombstones age out after thirty days and are capped at five hundred, while the gist never loses a row: a
 * Clear History on a few thousand archived listings brought most of them back with the next pull, and every
 * deleted row came back within a month. These tests run the real sync folds (the registry's merges, the
 * upload merge) against a little two-device store, since a stub that answered every key alike would hide the
 * very thing under test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const defaults = {
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? structuredClone(map.get(key)) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings', _immediate, options) => {
            const map = storeFor(store);
            const folded = options?.fold ? (options.fold(map.get(key), value) ?? value) : value;
            map.set(key, structuredClone(folded));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
        tryGetAllKeys: async (store = 'settings') =>
            storageMock.unavailable ? null : Array.from(storeFor(store).keys()),
        getMany: async (keys, store = 'settings') => {
            const map = storeFor(store);
            const result = new Map();
            for (const key of keys) result.set(key, map.has(key) ? structuredClone(map.get(key)) : null);
            return result;
        },
    };
    const mock = {
        stores,
        storeFor,
        unavailable: false,
        defaults,
        reset() {
            stores.clear();
        },
        get: vi.fn(defaults.get),
        tryGet: vi.fn(defaults.tryGet),
        set: vi.fn(defaults.set),
        delete: vi.fn(defaults.delete),
        getAllKeys: vi.fn(defaults.getAllKeys),
        tryGetAllKeys: vi.fn(defaults.tryGetAllKeys),
        getMany: vi.fn(defaults.getMany),
        putAll: vi.fn(async () => 0),
        isQuotaExceeded: vi.fn(() => false),
    };
    return mock;
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'market123',
    on: () => {},
    off: () => {},
    getMarketListings: () => [],
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => 'standard',
}));

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn(), updatePrices: vi.fn() } }));

const { default: estimatedListingAge } = await import('./estimated-listing-age.js');
const {
    default: listingArchive,
    ListingArchive,
    goneKey,
    mergeArchiveGone,
    isGone,
    mergeListingCopies,
} = await import('./listing-archive.js');
const { MAX_TOMBSTONES, TOMBSTONE_MAX_AGE_MS } = await import('../../utils/chunked-history.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { mergeForUpload } = await import('../sync/sync-payload.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const CHAR = 'market123';
const STORE = 'marketListings';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 31, 12);

/** An archived-age listing: Nov 2025 to Mar 2026, a hundred a month or so, in the game's own shape */
const oldRow = (index, extra = {}) => {
    const timestamp = Date.UTC(2025, 10, 1) + (index % 150) * DAY + index * 1000;
    return {
        id: 100000000 + index,
        timestamp,
        createdTimestamp: new Date(timestamp).toISOString(),
        itemHrid: '/items/holy_sword',
        enhancementLevel: index % 4,
        price: 1000 + index,
        orderQuantity: 2,
        filledQuantity: 2,
        isSell: index % 2 === 0,
        status: 'filled',
        ...extra,
    };
};
const rowsOf = (count) => Array.from({ length: count }, (_, index) => oldRow(index));
const idsOf = (rows) => rows.map((row) => row.id);

const snapshotStore = () =>
    Object.fromEntries([...storageMock.storeFor(STORE)].map(([k, v]) => [k, structuredClone(v)]));
const loadStore = (snapshot) => {
    const map = storageMock.storeFor(STORE);
    map.clear();
    for (const [key, value] of Object.entries(snapshot)) map.set(key, structuredClone(value));
    listingArchive.reset();
};

/**
 * A sync pull of a gist snapshot, through the registry's real pull folds: a key this device does not hold is
 * written whole, a key it holds is folded.
 */
const pull = (gist) => {
    const map = storageMock.storeFor(STORE);
    for (const [key, incoming] of Object.entries(gist)) {
        const registration = mergeForKey(STORE, key);
        const local = map.get(key);
        const next = local === undefined || !registration ? incoming : registration.mergeForPull(local, incoming);
        map.set(key, structuredClone(next));
    }
    listingArchive.reset();
};

/** The same snapshot as an upload merge folds it: this device's keys over the gist's */
const uploadOver = (gist) => {
    const text = (stores) =>
        JSON.stringify({ formatVersion: 1, exportedAt: 'x', syncScope: 'everything', stores: { [STORE]: stores } });
    const merged = mergeForUpload(text(snapshotStore()), text(gist), null);
    return JSON.parse(merged.text).stores[STORE];
};

const readIds = async () => idsOf((await listingArchive.read(CHAR)) || []);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    storageMock.reset();
    storageMock.unavailable = false;
    for (const name of ['get', 'tryGet', 'set', 'delete', 'getAllKeys', 'tryGetAllKeys', 'getMany']) {
        storageMock[name].mockReset();
        storageMock[name].mockImplementation(storageMock.defaults[name]);
    }
    _resetAdoptionCache();
    dataManagerMock.characterId = CHAR;
    listingArchive.reset();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('Clear History on a large archive survives sync', () => {
    test('600 archived rows cleared on one device do not come back from the gist, now or 31 days on', async () => {
        const rows = rowsOf(600);
        expect((await listingArchive.add(CHAR, rows)).ok).toBe(true);
        // The gist holds every month: it never loses a row
        const gist = snapshotStore();
        expect(await readIds()).toHaveLength(600);

        vi.setSystemTime(T0 + DAY);
        expect(await listingArchive.clear(CHAR)).toBe(true);
        expect(await readIds()).toEqual([]);
        // The premise: the chunked tombstones cap out well short of the clear
        const tombs = storageMock.storeFor(STORE).get(`marketListingArchiveRecTomb_${CHAR}`);
        expect(Object.keys(tombs).length).toBeLessThanOrEqual(MAX_TOMBSTONES);
        expect(Object.keys(tombs).length).toBeLessThan(600);

        pull(gist);
        expect(await readIds()).toEqual([]);

        // The thirty days the tombstones are remembered for are over; the gist still holds every row
        vi.setSystemTime(T0 + DAY + TOMBSTONE_MAX_AGE_MS + DAY);
        pull(gist);
        expect(await readIds()).toEqual([]);
        // Nor does the physical copy the pull wrote make a reader see it
        const stored = [...storageMock.storeFor(STORE).keys()].filter((key) => key.includes('ArchiveRec_'));
        expect(stored.length).toBeGreaterThan(0);
    });

    test('the cleared device pushes, and another device holding every month hides them on its pull', async () => {
        await listingArchive.add(CHAR, rowsOf(600));
        const deviceB = snapshotStore();
        const gist = snapshotStore();

        vi.setSystemTime(T0 + DAY);
        await listingArchive.clear(CHAR);
        const uploaded = uploadOver(gist);
        // The upload kept the months (the gist never loses a row) and carries the record
        expect(Object.keys(uploaded).some((key) => key.includes('ArchiveRec_'))).toBe(true);
        expect(uploaded[goneKey(CHAR)].clearedAt).toBe(T0 + DAY);

        loadStore(deviceB);
        expect(await readIds()).toHaveLength(600);
        vi.setSystemTime(T0 + 40 * DAY);
        pull(uploaded);
        expect(await readIds()).toEqual([]);
    });

    test('a single deleted row stays deleted when a gist copy holding it is pulled, now and 31 days on', async () => {
        const rows = rowsOf(5);
        await listingArchive.add(CHAR, rows);
        const gist = snapshotStore();

        vi.setSystemTime(T0 + DAY);
        expect(await listingArchive.remove(CHAR, [rows[2].id])).toBe(true);
        expect(await readIds()).toEqual(idsOf([rows[0], rows[1], rows[3], rows[4]]));

        pull(gist);
        expect(await readIds()).not.toContain(rows[2].id);

        vi.setSystemTime(T0 + DAY + TOMBSTONE_MAX_AGE_MS + DAY);
        pull(gist);
        expect(await readIds()).toEqual(idsOf([rows[0], rows[1], rows[3], rows[4]]));
    });

    test('importing the cleared rows again after the clear brings them back, and the rest stay gone', async () => {
        const rows = rowsOf(8);
        await listingArchive.add(CHAR, rows);
        const gist = snapshotStore();
        vi.setSystemTime(T0 + DAY);
        await listingArchive.clear(CHAR);

        vi.setSystemTime(T0 + 2 * DAY);
        const back = rows.slice(0, 3);
        expect(await listingArchive.add(CHAR, back, { importedAt: Date.now() })).toEqual({ ok: true, added: 3 });
        expect(await readIds()).toEqual(idsOf(back));

        // A pull of the pre-clear gist neither hides them again nor brings the others back
        pull(gist);
        expect(await readIds()).toEqual(idsOf(back));
    });

    test('a deleted row imported again after the deletion comes back even though the gist holds the old copy', async () => {
        const rows = rowsOf(4);
        await listingArchive.add(CHAR, rows);
        const gist = snapshotStore();
        vi.setSystemTime(T0 + DAY);
        await listingArchive.remove(CHAR, [rows[1].id]);

        vi.setSystemTime(T0 + 2 * DAY);
        await listingArchive.add(CHAR, [rows[1]], { importedAt: Date.now() });
        pull(gist);

        expect(await readIds()).toContain(rows[1].id);
    });
});

describe('a deletion reaches an archive that this device does not hold the row in', () => {
    test('a row deleted where it was never archived is hidden where it is', async () => {
        const rows = rowsOf(3);
        // Device B holds the months
        await listingArchive.add(CHAR, rows);
        const deviceB = snapshotStore();

        // Device A: an empty archive, the row still in its 90-day log. The delete records the id anyway
        storageMock.storeFor(STORE).clear();
        listingArchive.reset();
        vi.setSystemTime(T0 + DAY);
        expect(await listingArchive.remove(CHAR, [rows[1].id])).toBe(true);
        const gone = storageMock.storeFor(STORE).get(goneKey(CHAR));
        expect(Object.keys(gone.removed)).toEqual([String(rows[1].id)]);

        loadStore(deviceB);
        pull({ [goneKey(CHAR)]: gone });
        expect(await readIds()).toEqual(idsOf([rows[0], rows[2]]));
    });

    test('a clear is a watermark: it hides rows this device never held either', async () => {
        const rows = rowsOf(3);
        await listingArchive.add(CHAR, rows);
        const deviceB = snapshotStore();
        storageMock.storeFor(STORE).clear();
        listingArchive.reset();
        vi.setSystemTime(T0 + DAY);
        await listingArchive.clear(CHAR);
        const gone = storageMock.storeFor(STORE).get(goneKey(CHAR));

        loadStore(deviceB);
        pull({ [goneKey(CHAR)]: gone });
        expect(await readIds()).toEqual([]);
    });

    test('a stale log row retired after the deletion or the clear is not archived', async () => {
        const [deleted, cleared, fresh] = rowsOf(3);
        vi.setSystemTime(T0 + DAY);
        await listingArchive.remove(CHAR, [deleted.id]);
        await listingArchive.clear(CHAR);

        // A row made after the clear is a new listing; the other two are stale copies of cleared ones
        const madeAfter = oldRow(7, {
            timestamp: Date.now() + 1000,
            createdTimestamp: new Date(Date.now()).toISOString(),
        });
        vi.setSystemTime(T0 + 2 * DAY);
        expect(await listingArchive.add(CHAR, [deleted, cleared, fresh, madeAfter])).toEqual({ ok: true, added: 1 });
        expect(await readIds()).toEqual([madeAfter.id]);
    });

    test('a row imported into the log after a clear is archived when it is retired, not mistaken for a stale one', async () => {
        const [row] = rowsOf(1);
        await listingArchive.clear(CHAR);
        vi.setSystemTime(T0 + DAY);
        // The log stamps what an import hands it
        const imported = { ...row, importedAt: Date.now() };
        vi.setSystemTime(T0 + 90 * DAY);

        expect(await listingArchive.add(CHAR, [imported])).toEqual({ ok: true, added: 1 });
        expect(await readIds()).toEqual([row.id]);
    });
});

describe('the deletion record itself', () => {
    test('folds to the later clear and the later time per id, and drops ids a clear already covers', () => {
        const a = { clearedAt: 100, removed: { 1: 50, 2: 150, 3: 300 } };
        const b = { clearedAt: 200, removed: { 2: 120, 3: 250, 4: 400 } };

        expect(mergeArchiveGone(a, b)).toEqual({ clearedAt: 200, removed: { 3: 300, 4: 400 } });
        expect(mergeArchiveGone(b, a)).toEqual(mergeArchiveGone(a, b));
        expect(mergeArchiveGone(undefined, b)).toEqual({ clearedAt: 200, removed: { 3: 250, 4: 400 } });
        expect(mergeArchiveGone('junk', null)).toEqual({ clearedAt: 0, removed: {} });
    });

    test('hides by the row’s stamp: a row stamped after the deletion is shown', () => {
        const gone = { clearedAt: 100, removed: { 7: 500 } };
        expect(isGone({ id: 1, archivedAt: 100 }, gone)).toBe(true);
        expect(isGone({ id: 1, archivedAt: 101 }, gone)).toBe(false);
        expect(isGone({ id: 1, importedAt: 90 }, gone)).toBe(true);
        expect(isGone({ id: 7, archivedAt: 500 }, gone)).toBe(true);
        expect(isGone({ id: 7, importedAt: 501 }, gone)).toBe(false);
        // With nothing cleared, an unstamped row is not hidden by the zero watermark
        expect(isGone({ id: 1 }, { clearedAt: 0, removed: {} })).toBe(false);
    });

    test('a copy of a row keeps the later stamp whichever copy wins', () => {
        const stale = { id: 1, status: 'filled', filledQuantity: 5, archivedAt: 10 };
        const reimport = { id: 1, status: 'active', filledQuantity: 0, importedAt: 900, archivedAt: 900 };

        expect(mergeListingCopies(stale, reimport).status).toBe('filled');
        expect(mergeListingCopies(stale, reimport).archivedAt).toBe(900);
        expect(mergeListingCopies(reimport, stale)).toEqual(mergeListingCopies(stale, reimport));
    });

    test('is claimed by one sync registration, apart from the months and their tombstones', () => {
        const key = goneKey(CHAR);
        expect(mergeForKey(STORE, key)?.label).toBe('ListingArchive permanent deletions');
        expect(mergeForKey(STORE, `marketListingArchiveRec_${CHAR}_2026-03`)?.label).toBe('ListingArchive records');
        expect(mergeForKey(STORE, `marketListingArchiveRecTomb_${CHAR}`)?.label).toBe('ListingArchive deletions');
    });
});

describe('a second tab’s archive memory is not trusted', () => {
    test('a tab that loaded before another tab cleared does not write the cleared months back', async () => {
        const tabB = new ListingArchive();
        await listingArchive.add(CHAR, rowsOf(6));
        // Tab B has the archive in memory
        expect(((await tabB.read(CHAR)) || []).length).toBe(6);

        vi.setSystemTime(T0 + DAY);
        await listingArchive.clear(CHAR);
        // Tab B imports one row into a month the cleared rows were in, on its stale memory
        vi.setSystemTime(T0 + 2 * DAY);
        const stamp = Date.UTC(2025, 10, 3);
        const added = oldRow(50, { timestamp: stamp, createdTimestamp: new Date(stamp).toISOString(), id: 777000001 });
        expect((await tabB.add(CHAR, [added], { importedAt: Date.now() })).ok).toBe(true);

        // What is on disk, not only what a reader shows: the cleared rows are not written back under the new one
        const month = storageMock.storeFor(STORE).get(`marketListingArchiveRec_${CHAR}_2025-11`);
        expect(month.map((row) => row.id)).toEqual([added.id]);
    });

    test('a tab that loaded before another tab deleted a row does not resurrect it by deleting another', async () => {
        const tabB = new ListingArchive();
        const rows = rowsOf(4);
        await listingArchive.add(CHAR, rows);
        await tabB.read(CHAR);

        vi.setSystemTime(T0 + DAY);
        await listingArchive.remove(CHAR, [rows[0].id]);
        await tabB.remove(CHAR, [rows[1].id]);

        expect(await readIds()).toEqual(idsOf([rows[2], rows[3]]));
        const gone = storageMock.storeFor(STORE).get(goneKey(CHAR));
        expect(Object.keys(gone.removed).sort()).toEqual([String(rows[0].id), String(rows[1].id)].sort());
    });
});

describe('an archive that cannot be read is not an empty one', () => {
    test('read answers null, and so does the deletion record failing to read', async () => {
        await listingArchive.add(CHAR, rowsOf(2));
        storageMock.tryGetAllKeys.mockImplementation(async () => null);
        expect(await listingArchive.read(CHAR)).toBeNull();

        storageMock.tryGetAllKeys.mockImplementation(storageMock.defaults.tryGetAllKeys);
        expect(await listingArchive.read(CHAR)).toHaveLength(2);
        const original = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(async (key, ...rest) =>
            key === goneKey(CHAR) ? null : original(key, ...rest)
        );
        expect(await listingArchive.read(CHAR)).toBeNull();
    });

    test('add and remove refuse rather than write over what they could not read', async () => {
        const rows = rowsOf(2);
        await listingArchive.add(CHAR, rows);
        storageMock.tryGetAllKeys.mockImplementation(async () => null);

        expect((await listingArchive.add(CHAR, [oldRow(9)])).ok).toBe(false);
        storageMock.tryGetAllKeys.mockImplementation(storageMock.defaults.tryGetAllKeys);
        expect(await readIds()).toEqual(idsOf(rows));
    });

    test('allPersonalListingsDetailed says the archive was unreadable, and keeps the log', async () => {
        estimatedListingAge.knownListings = [
            oldRow(1, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() }),
        ];
        const spy = vi.spyOn(listingArchive, 'read').mockResolvedValue(null);
        const result = await estimatedListingAge.allPersonalListingsDetailed();
        spy.mockRestore();

        expect(result.archiveReadable).toBe(false);
        expect(result.listings.map((l) => l.id)).toEqual([100000001]);
    });
});

describe('a character switch while the viewer’s read is out', () => {
    test('returns nothing rather than a mix of two characters', async () => {
        estimatedListingAge.knownListings = [
            oldRow(1, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() }),
        ];
        const spy = vi.spyOn(listingArchive, 'read').mockImplementation(async () => {
            // disable() lands while the archive is being read
            estimatedListingAge._generation += 1;
            return [oldRow(2)];
        });
        const generation = estimatedListingAge._generation;
        const result = await estimatedListingAge.allPersonalListingsDetailed();
        spy.mockRestore();
        estimatedListingAge._generation = generation;

        expect(result.listings).toEqual([]);
    });
});

describe('retiring a row that turns active while the archive is written', () => {
    test('the log keeps it: marking a row active mutates the very object that was archived', async () => {
        const old = oldRow(1);
        const recent = oldRow(2, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() });
        const logRows = [old, recent];
        estimatedListingAge.knownListings = logRows;
        const original = listingArchive.add.bind(listingArchive);
        const spy = vi.spyOn(listingArchive, 'add').mockImplementation(async (...args) => {
            const result = await original(...args);
            // markActiveListings / _reconcileActiveListings change the row in place
            old.status = 'active';
            return result;
        });

        const kept = await estimatedListingAge._retire(logRows, estimatedListingAge._owner());
        spy.mockRestore();

        expect(kept.map((row) => row.id)).toEqual([old.id, recent.id]);
        expect(kept[0].status).toBe('active');
    });

    test('a row that stays settled is still moved', async () => {
        const old = oldRow(1);
        const recent = oldRow(2, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() });
        estimatedListingAge.knownListings = [old, recent];

        const kept = await estimatedListingAge._retire([old, recent], estimatedListingAge._owner());

        expect(kept.map((row) => row.id)).toEqual([recent.id]);
        expect(await readIds()).toEqual([old.id]);
    });
});

describe('an import whose log write fails after the archive took rows', () => {
    test('reports how many went to the archive instead of zero', async () => {
        const recent = oldRow(2, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() });
        const old = oldRow(1);
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key.startsWith('marketListingTimestamps_') ? false : original(key, ...rest)
        );

        const result = await estimatedListingAge.importListingsDetailed([old, recent]);

        expect(result).toMatchObject({ ok: false, toLog: 0, toArchive: 1 });
        expect(await readIds()).toEqual([old.id]);
    });
});

describe('deleting a listing through the log’s owner', () => {
    test('records the id permanently even when this device’s archive never held the row', async () => {
        const recent = oldRow(2, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() });
        storageMock.storeFor(STORE).set(`marketListingTimestamps_${CHAR}`, [recent]);
        await estimatedListingAge.loadHistoricalData();

        expect(await estimatedListingAge.deleteListing(recent.id)).toBe(true);

        const gone = storageMock.storeFor(STORE).get(goneKey(CHAR));
        expect(Object.keys(gone.removed)).toEqual([String(recent.id)]);
        expect(estimatedListingAge.knownListings).toEqual([]);
    });

    test('says false and changes nothing when the permanent record cannot be written', async () => {
        const recent = oldRow(2, { timestamp: T0, createdTimestamp: new Date(T0).toISOString() });
        storageMock.storeFor(STORE).set(`marketListingTimestamps_${CHAR}`, [recent]);
        await estimatedListingAge.loadHistoricalData();
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key === goneKey(CHAR) ? false : original(key, ...rest)
        );

        expect(await estimatedListingAge.deleteListing(recent.id)).toBe(false);

        expect(estimatedListingAge.knownListings.map((row) => row.id)).toEqual([recent.id]);
        expect(storageMock.storeFor(STORE).get(`marketListingTimestamps_${CHAR}`)).toHaveLength(1);
    });
});
