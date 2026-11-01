/**
 * @vitest-environment happy-dom
 *
 * The listing archive: where the 90-day log's retention moves rows instead of dropping them.
 *
 * `applyListingRetention` used to discard every non-active listing older than 90 days before the newest
 * one, so 3,260 listings imported from an older install were gone by the next load. The rows now go to
 * `listing-archive.js` first, and the log lets go of them only once that write has landed. Every ending of
 * that move, of an import, of a deletion and of a clear is exercised here against a real little store (the
 * chunked history underneath folds into what is stored, so a stub that answers every key alike would hide
 * the very thing under test).
 *
 * The rows are trimmed samples of a real export (Millennium44, Feb to Jun 2026): the game's own field
 * shapes, enhancement levels above zero, and all three statuses.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

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
        // A folding write is handed what is stored when it lands, as the real one is
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
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings', _immediate, options) => {
            const map = storeFor(store);
            const folded = options?.fold ? (options.fold(map.get(key), value) ?? value) : value;
            map.set(key, structuredClone(folded));
            return true;
        }),
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

const { default: estimatedListingAge, mergeListingLogsForSync } = await import('./estimated-listing-age.js');
const { default: listingArchive, mergeListingCopies, ARCHIVE_PREFIX } = await import('./listing-archive.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

const CHAR = 'market123';
const LOG_KEY = `marketListingTimestamps_${CHAR}`;
const store = () => storageMock.storeFor('marketListings');
const DAY = 24 * 60 * 60 * 1000;

/** Trimmed from a real export: Feb to Jun 2026, every status, nonzero enhancement levels, both sides */
const SAMPLE = [
    {
        id: 124101352,
        timestamp: 1770827699991,
        createdTimestamp: '2026-02-11T16:34:59.991Z',
        itemHrid: '/items/efficiency_tea',
        enhancementLevel: 0,
        price: 2050,
        orderQuantity: 100,
        filledQuantity: 100,
        isSell: false,
        status: 'unknown',
    },
    {
        id: 126848436,
        timestamp: 1772117973465,
        createdTimestamp: '2026-02-26T14:59:33.465Z',
        itemHrid: '/items/sighted_bracers',
        enhancementLevel: 5,
        price: 4000000,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: false,
        status: 'filled',
    },
    {
        id: 128291634,
        timestamp: 1772729734206,
        createdTimestamp: '2026-03-05T16:55:34.206Z',
        itemHrid: '/items/chrono_gloves',
        enhancementLevel: 5,
        price: 10000000,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: false,
        status: 'filled',
    },
    {
        id: 129636647,
        timestamp: 1773331700188,
        createdTimestamp: '2026-03-12T16:08:20.188Z',
        itemHrid: '/items/rough_hood',
        enhancementLevel: 0,
        price: 7400,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
    },
    {
        id: 130182519,
        timestamp: 1773588824873,
        createdTimestamp: '2026-03-15T15:33:44.873Z',
        itemHrid: '/items/cotton_robe_bottoms',
        enhancementLevel: 0,
        price: 8400,
        orderQuantity: 4,
        filledQuantity: 4,
        isSell: false,
        status: 'filled',
    },
    {
        id: 130257600,
        timestamp: 1773628818074,
        createdTimestamp: '2026-03-16T02:40:18.074Z',
        itemHrid: '/items/cocoon',
        enhancementLevel: 0,
        price: 390,
        orderQuantity: 8605,
        filledQuantity: 8605,
        isSell: true,
        status: 'filled',
    },
    {
        id: 133448645,
        timestamp: 1775157820564,
        createdTimestamp: '2026-04-02T19:23:40.564Z',
        itemHrid: '/items/melee_coffee',
        enhancementLevel: 0,
        price: 1700,
        orderQuantity: 4773,
        filledQuantity: 4773,
        isSell: true,
        status: 'filled',
    },
    {
        id: 134957373,
        timestamp: 1775916958598,
        createdTimestamp: '2026-04-11T14:15:58.598Z',
        itemHrid: '/items/crimson_sword',
        enhancementLevel: 2,
        price: 350000,
        orderQuantity: 1,
        filledQuantity: 0,
        isSell: true,
        status: 'canceled',
    },
    {
        id: 137481659,
        timestamp: 1777213680293,
        createdTimestamp: '2026-04-26T14:28:00.293Z',
        itemHrid: '/items/pathbreaker_boots',
        enhancementLevel: 10,
        price: 450000000,
        orderQuantity: 1,
        filledQuantity: 0,
        isSell: false,
        status: 'canceled',
    },
    {
        id: 139341246,
        timestamp: 1778270443611,
        createdTimestamp: '2026-05-08T20:00:43.611Z',
        itemHrid: '/items/holy_sword',
        enhancementLevel: 5,
        price: 3500000,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
    },
    {
        id: 142919198,
        timestamp: 1780409323562,
        createdTimestamp: '2026-06-02T14:08:43.562Z',
        itemHrid: '/items/goggles',
        enhancementLevel: 0,
        price: 640000,
        orderQuantity: 10,
        filledQuantity: 0,
        isSell: true,
        status: 'canceled',
    },
    {
        id: 144780977,
        timestamp: 1781626162431,
        createdTimestamp: '2026-06-16T16:09:22.431Z',
        itemHrid: '/items/manticore_shield',
        enhancementLevel: 5,
        price: 26000000,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
    },
    {
        id: 146019132,
        timestamp: 1782480763685,
        createdTimestamp: '2026-06-26T13:32:43.685042305Z',
        itemHrid: '/items/black_bear_shoes',
        enhancementLevel: 0,
        price: 760000,
        orderQuantity: 144,
        filledQuantity: 0,
        isSell: true,
        status: 'unknown',
    },
];

/** A listing from the last days of October 2026: well inside the window, and the newest thing in the log */
const recentRow = (id, daysBack = 0, extra = {}) => {
    const timestamp = Date.UTC(2026, 9, 30, 12) - daysBack * DAY;
    return {
        id,
        timestamp,
        createdTimestamp: new Date(timestamp).toISOString(),
        itemHrid: '/items/holy_sword',
        enhancementLevel: 3,
        price: 5000000,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
        ...extra,
    };
};
const RECENT = recentRow(190000001);
const copies = (rows) => rows.map((row) => ({ ...row }));
const ids = (rows) => rows.map((row) => row.id);
const sampleIds = ids(SAMPLE);
const archivedNow = async () => ids(await listingArchive.read(CHAR));

/** Seed the stored log, then load it the way a page start does */
const seedLog = async (rows) => {
    store().set(LOG_KEY, copies(rows));
    await estimatedListingAge.loadHistoricalData();
};

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    for (const name of ['get', 'tryGet', 'set', 'delete', 'getAllKeys', 'tryGetAllKeys', 'getMany']) {
        storageMock[name].mockReset();
        storageMock[name].mockImplementation(storageMock.defaults[name]);
    }
    _resetAdoptionCache();
    dataManagerMock.characterId = CHAR;
    listingArchive.reset();
    estimatedListingAge.knownListings = [];
    estimatedListingAge.anchors = [];
    estimatedListingAge.estimationPoints = [];
    estimatedListingAge.anchorsLoaded = false;
    estimatedListingAge.listingGraves = { removed: {}, clearedThrough: 0 };
    estimatedListingAge._saveChain = null;
    clearTimeout(estimatedListingAge._saveTimer);
    estimatedListingAge._saveTimer = null;
    estimatedListingAge._pendingSave = null;
    estimatedListingAge._resolvePendingSave = null;
    estimatedListingAge._recordedSinceRetention = 0;
});

describe('retention moves rows into the archive instead of dropping them', () => {
    test('a load moves what the window lets go of; active rows and recent rows stay in the log', async () => {
        const oldActive = { ...SAMPLE[3], status: 'active' };
        await seedLog([SAMPLE[0], SAMPLE[1], oldActive, RECENT]);

        expect(ids(estimatedListingAge.knownListings)).toEqual([oldActive.id, RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([oldActive.id, RECENT.id]);
        expect(await archivedNow()).toEqual([SAMPLE[0].id, SAMPLE[1].id]);
        // One record per month of the listing's own time, in the log's store
        expect(store().has(`${ARCHIVE_PREFIX}_${CHAR}_2026-02`)).toBe(true);
        // The active row was not touched, and is not in the archive
        expect(estimatedListingAge.knownListings[0]).toMatchObject({ id: oldActive.id, status: 'active' });
    });

    test('a failed archive write leaves every row in the log, in memory and as stored', async () => {
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key.startsWith(`${ARCHIVE_PREFIX}_`) ? false : original(key, ...rest)
        );

        await seedLog([SAMPLE[0], SAMPLE[1], RECENT]);

        expect(ids(estimatedListingAge.knownListings)).toEqual([SAMPLE[0].id, SAMPLE[1].id, RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([SAMPLE[0].id, SAMPLE[1].id, RECENT.id]);
        expect(await archivedNow()).toEqual([]);
    });

    test('after a failed write the next pass writes the rows rather than finding them already archived', async () => {
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key.startsWith(`${ARCHIVE_PREFIX}_`) ? false : original(key, ...rest)
        );
        await seedLog([SAMPLE[0], SAMPLE[1], RECENT]);
        storageMock.set.mockImplementation(original);

        await estimatedListingAge.loadHistoricalData();

        expect(ids(estimatedListingAge.knownListings)).toEqual([RECENT.id]);
        expect(await archivedNow()).toEqual([SAMPLE[0].id, SAMPLE[1].id]);
        // And it is on disk, not just in the store's memory
        listingArchive.reset();
        expect(await archivedNow()).toEqual([SAMPLE[0].id, SAMPLE[1].id]);
    });

    test('an archive that cannot be read stops the move and costs the log nothing', async () => {
        storageMock.tryGetAllKeys.mockImplementation(async () => null);

        await seedLog([SAMPLE[0], RECENT]);

        expect(ids(estimatedListingAge.knownListings)).toEqual([SAMPLE[0].id, RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([SAMPLE[0].id, RECENT.id]);
    });

    test('a save that moves rows still leaves out a row the tombstones bury, though memory holds it', async () => {
        const buried = recentRow(190000005, 2);
        store().set(LOG_KEY, copies([SAMPLE[0], RECENT]));
        // Memory holds a row another tab or a pull deleted; the tombstone for it has arrived
        estimatedListingAge.knownListings = copies([SAMPLE[0], RECENT, buried]);
        estimatedListingAge.listingGraves = { removed: { [buried.id]: Date.now() }, clearedThrough: 0 };

        await estimatedListingAge.saveHistoricalData();

        expect(ids(store().get(LOG_KEY))).toEqual([RECENT.id]);
        expect(ids(estimatedListingAge.knownListings)).toEqual([RECENT.id]);
        expect(await archivedNow()).toEqual([SAMPLE[0].id]);
    });

    test('the save that follows a listing batch moves the rows its fold retires', async () => {
        await seedLog([SAMPLE[0], SAMPLE[1]]);
        // Both are still in the log: nothing newer yet
        expect(ids(estimatedListingAge.knownListings)).toEqual([SAMPLE[0].id, SAMPLE[1].id]);

        estimatedListingAge.recordListings([RECENT]);
        await estimatedListingAge.flushPendingSave();

        expect(ids(estimatedListingAge.knownListings)).toEqual([RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([RECENT.id]);
        expect(await archivedNow()).toEqual([SAMPLE[0].id, SAMPLE[1].id]);
    });

    test('rows moved are the rows as they were: a status that changed during the write is kept for the next pass', async () => {
        await seedLog([SAMPLE[0], RECENT]);
        // The archive write parks; a status update lands in memory meanwhile
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key.startsWith(`${ARCHIVE_PREFIX}_`)) await gate;
            return original(key, ...rest);
        });
        estimatedListingAge.knownListings.push({ ...SAMPLE[1] });
        estimatedListingAge.knownListings.sort((a, b) => a.id - b.id);

        const pass = estimatedListingAge._applyRetention();
        await vi.waitFor(() =>
            expect(storageMock.set.mock.calls.some(([key]) => key.startsWith(ARCHIVE_PREFIX))).toBe(true)
        );
        // Replaced by a fresh object, as recordListings does for a status update
        const index = estimatedListingAge.knownListings.findIndex((row) => row.id === SAMPLE[1].id);
        estimatedListingAge.knownListings[index] = { ...SAMPLE[1], status: 'canceled' };
        release();
        await pass;

        // The updated copy of SAMPLE[1] stays; the untouched SAMPLE[0] left
        expect(ids(estimatedListingAge.knownListings)).toEqual([SAMPLE[1].id, RECENT.id]);
        expect(estimatedListingAge.knownListings[0].status).toBe('canceled');
    });

    test('a listing recorded while a failing archive write is out is kept', async () => {
        store().set(LOG_KEY, copies([SAMPLE[0], RECENT]));
        estimatedListingAge.knownListings = copies([SAMPLE[0], RECENT]);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockClear();
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (!key.startsWith(`${ARCHIVE_PREFIX}_`)) return original(key, ...rest);
            await gate;
            return false;
        });

        const save = estimatedListingAge.saveHistoricalData();
        await vi.waitFor(() =>
            expect(storageMock.set.mock.calls.some(([key]) => key.startsWith(ARCHIVE_PREFIX))).toBe(true)
        );
        const arrived = recentRow(190000009, 1);
        estimatedListingAge.knownListings = [...estimatedListingAge.knownListings, { ...arrived }].sort(
            (a, b) => a.id - b.id
        );
        release();
        await save;

        // The failed move keeps the old row, and the listing that arrived meanwhile is not lost with it
        expect(ids(estimatedListingAge.knownListings)).toEqual([SAMPLE[0].id, RECENT.id, arrived.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([SAMPLE[0].id, RECENT.id, arrived.id]);
    });
});

describe('importing into the archive', () => {
    test('rows all older than the window go straight to the archive, and the counts say so', async () => {
        await seedLog([RECENT]);

        const result = await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        expect(result).toEqual({ ok: true, toLog: 0, toArchive: SAMPLE.length });
        expect(ids(estimatedListingAge.knownListings)).toEqual([RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([RECENT.id]);
        expect(await archivedNow()).toEqual(sampleIds);
        // Months it covers: Feb to Jun
        for (const month of ['02', '03', '04', '05', '06']) {
            expect(store().has(`${ARCHIVE_PREFIX}_${CHAR}_2026-${month}`)).toBe(true);
        }
    });

    test('the status survives, and the enhancement levels', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        const archived = await listingArchive.read(CHAR);
        const byId = new Map(archived.map((row) => [row.id, row]));
        expect(byId.get(126848436)).toMatchObject({ status: 'filled', enhancementLevel: 5, filledQuantity: 1 });
        expect(byId.get(137481659)).toMatchObject({ status: 'canceled', enhancementLevel: 10 });
        expect(byId.get(124101352).status).toBe('unknown');
    });

    test('importing the same file twice adds nothing the second time', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        const again = await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        expect(again).toEqual({ ok: true, toLog: 0, toArchive: 0 });
        expect(await archivedNow()).toEqual(sampleIds);
        listingArchive.reset();
        expect(await archivedNow()).toEqual(sampleIds);
    });

    test('a mixed file: the recent rows go to the log, the old ones to the archive', async () => {
        await seedLog([RECENT]);
        const fresh = [recentRow(190000010, 3), recentRow(190000020, 30)];

        const result = await estimatedListingAge.importListingsDetailed(copies([...SAMPLE.slice(0, 3), ...fresh]));

        expect(result).toEqual({ ok: true, toLog: 2, toArchive: 3 });
        expect(ids(estimatedListingAge.knownListings)).toEqual([190000001, 190000010, 190000020]);
        expect(ids(store().get(LOG_KEY))).toEqual([190000001, 190000010, 190000020]);
        expect(await archivedNow()).toEqual(ids(SAMPLE.slice(0, 3)));
    });

    test('importListings keeps its boolean answer', async () => {
        await seedLog([RECENT]);
        expect(await estimatedListingAge.importListings(copies(SAMPLE.slice(0, 2)))).toBe(true);
        expect(await archivedNow()).toEqual(ids(SAMPLE.slice(0, 2)));
    });

    test('an archive write that fails refuses the import and puts nothing anywhere', async () => {
        await seedLog([RECENT]);
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key.startsWith(`${ARCHIVE_PREFIX}_`) ? false : original(key, ...rest)
        );

        const result = await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        expect(result).toEqual({ ok: false, toLog: 0, toArchive: 0 });
        expect(ids(estimatedListingAge.knownListings)).toEqual([RECENT.id]);
        expect(ids(store().get(LOG_KEY))).toEqual([RECENT.id]);
        expect(await archivedNow()).toEqual([]);
    });

    test('a character switch while the archive is being written files the rows under the importing character', async () => {
        await seedLog([RECENT]);
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const original = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) => {
            if (key.startsWith(`${ARCHIVE_PREFIX}_`)) await gate;
            return original(key, ...rest);
        });
        estimatedListingAge.isInitialized = true;

        const importing = estimatedListingAge.importListingsDetailed(copies(SAMPLE));
        await vi.waitFor(() =>
            expect(storageMock.set.mock.calls.some(([key]) => key.startsWith(ARCHIVE_PREFIX))).toBe(true)
        );
        dataManagerMock.characterId = 'alt456';
        const tearingDown = estimatedListingAge.disable();
        release();
        const [result] = await Promise.all([importing, tearingDown]);

        // The import stood down once the log was no longer the one it began with
        expect(result.ok).toBe(false);
        // Its rows are the importing character's, under the importing character's keys
        expect(storageMock.storeFor('marketListings').has(`${ARCHIVE_PREFIX}_alt456_2026-02`)).toBe(false);
        expect(await archivedNow()).toEqual(sampleIds);
        expect(await listingArchive.read('alt456')).toEqual([]);
        // And nothing leaked into the arriving character's log
        expect(estimatedListingAge.knownListings).toEqual([]);
        expect(store().has('marketListingTimestamps_alt456')).toBe(false);
    });
});

describe('what the viewer reads', () => {
    test('allPersonalListings is the log and the archive, one row per id, the log winning', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));
        // The same id in both: the log's copy is the live one
        await listingArchive.add(CHAR, [{ ...RECENT, status: 'unknown', filledQuantity: 0 }]);

        const all = await estimatedListingAge.allPersonalListings();

        expect(ids(all)).toEqual([...sampleIds, RECENT.id]);
        expect(all.at(-1)).toMatchObject({ status: 'filled', filledQuantity: 1 });
        expect(all).toHaveLength(SAMPLE.length + 1);
    });

    test('personalListings, which the order book and the age estimate read, stays the log alone', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));

        expect(ids(await estimatedListingAge.personalListings())).toEqual([RECENT.id]);
        // Nor does the archive feed the estimation points (the seed anchors are all older than the log's row)
        const points = estimatedListingAge.estimationPoints.map((point) => point.id);
        expect(points).toContain(RECENT.id);
        for (const id of sampleIds) expect(points).not.toContain(id);
    });
});

describe('deleting an archived listing', () => {
    const setUp = async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));
    };

    test('removes it from the archive and the table, whatever its place in the order', async () => {
        await setUp();

        // The oldest and the newest rows are the ones a window sliding would also take, so the store's
        // interior-only rule records no tombstone for them unless it is told the removal was deliberate
        await estimatedListingAge.deleteListing(SAMPLE[0].id);
        await estimatedListingAge.deleteListing(SAMPLE.at(-1).id);
        await estimatedListingAge.deleteListing(SAMPLE[5].id);

        const expected = ids(SAMPLE).filter((id) => ![SAMPLE[0].id, SAMPLE.at(-1).id, SAMPLE[5].id].includes(id));
        expect(await archivedNow()).toEqual(expected);
        expect(ids(await estimatedListingAge.allPersonalListings())).toEqual([...expected, RECENT.id]);
    });

    test('a sync pull that carries the row back from a peer does not revive it', async () => {
        await setUp();
        const chunkKey = `${ARCHIVE_PREFIX}_${CHAR}_2026-02`;
        const marchKey = `${ARCHIVE_PREFIX}_${CHAR}_2026-03`;
        // What the peer holds: the months as they were before the deletions, stamped as the archive stamped them
        const peerFeb = copies(store().get(chunkKey));
        const peerMar = copies(store().get(marchKey));
        await estimatedListingAge.deleteListing(SAMPLE[0].id);
        await estimatedListingAge.deleteListing(SAMPLE[5].id);

        const pulled = mergeForKey('marketListings', chunkKey).mergeForPull(store().get(chunkKey), peerFeb);
        expect(ids(pulled)).not.toContain(SAMPLE[0].id);
        expect(ids(pulled)).toContain(SAMPLE[1].id);

        const marchPulled = mergeForKey('marketListings', marchKey).mergeForPull(store().get(marchKey), peerMar);
        expect(ids(marchPulled)).not.toContain(SAMPLE[5].id);
        expect(ids(marchPulled)).toContain(SAMPLE[4].id);
    });

    test('a peer copy of the same row, imported separately so stamped differently, stays deleted too', async () => {
        await setUp();
        const chunkKey = `${ARCHIVE_PREFIX}_${CHAR}_2026-02`;
        const peer = copies(store().get(chunkKey)).map((row) => ({ ...row, importedAt: row.importedAt - 5000 }));
        const unstamped = copies(SAMPLE.slice(0, 2));
        await estimatedListingAge.deleteListing(SAMPLE[0].id);

        const registration = mergeForKey('marketListings', chunkKey);
        expect(ids(registration.mergeForPull(store().get(chunkKey), peer))).not.toContain(SAMPLE[0].id);
        expect(ids(registration.mergeForPull(store().get(chunkKey), unstamped))).not.toContain(SAMPLE[0].id);
    });

    test('a pull that already wrote the row back to disk is undone by the next read', async () => {
        await setUp();
        await estimatedListingAge.deleteListing(SAMPLE[0].id);
        const chunkKey = `${ARCHIVE_PREFIX}_${CHAR}_2026-02`;
        // What importEverything does on a pull: the peer's chunk, written whole
        store().set(chunkKey, copies(SAMPLE.slice(0, 2)));
        listingArchive.reset();

        expect(await archivedNow()).not.toContain(SAMPLE[0].id);
        expect(ids(await estimatedListingAge.allPersonalListings())).not.toContain(SAMPLE[0].id);
    });

    test('importing the row again brings it back', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
            await setUp();
            vi.setSystemTime(new Date('2026-11-01T10:05:00Z'));
            await estimatedListingAge.deleteListing(SAMPLE[1].id);
            expect(await archivedNow()).not.toContain(SAMPLE[1].id);

            vi.setSystemTime(new Date('2026-11-01T10:10:00Z'));
            const result = await estimatedListingAge.importListingsDetailed([{ ...SAMPLE[1] }]);

            expect(result).toMatchObject({ ok: true, toArchive: 1 });
            listingArchive.reset();
            expect(await archivedNow()).toContain(SAMPLE[1].id);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('Clear History', () => {
    test('empties the log and the archive, and leaves the anonymous anchors', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE));
        await estimatedListingAge.addAnchors([{ id: 5, timestamp: 1000 }]);
        const anchorsBefore = estimatedListingAge.anchors.length;

        const cleared = await estimatedListingAge.clearPersonalListings();

        expect(cleared).toBe(true);
        expect(estimatedListingAge.knownListings).toEqual([]);
        expect(store().get(LOG_KEY)).toEqual([]);
        listingArchive.reset();
        expect(await archivedNow()).toEqual([]);
        expect([...store().keys()].filter((key) => key.startsWith(`${ARCHIVE_PREFIX}_`))).toEqual([]);
        expect(estimatedListingAge.anchors.length).toBe(anchorsBefore);
        expect(estimatedListingAge.anchors.some((anchor) => anchor.id === 5)).toBe(true);
        expect(ids(await estimatedListingAge.allPersonalListings())).toEqual([]);
    });

    test('reports a failure when the archive could not be emptied', async () => {
        await seedLog([RECENT]);
        await estimatedListingAge.importListingsDetailed(copies(SAMPLE.slice(0, 2)));
        const original = storageMock.delete.getMockImplementation();
        storageMock.delete.mockImplementation(async (key, ...rest) =>
            key.startsWith(`${ARCHIVE_PREFIX}_`) ? false : original(key, ...rest)
        );

        expect(await estimatedListingAge.clearPersonalListings()).toBe(false);
    });

    test("another character's archive is not touched", async () => {
        await seedLog([RECENT]);
        await listingArchive.add('alt456', [SAMPLE[0]]);
        await estimatedListingAge.clearPersonalListings();

        expect(ids(await listingArchive.read('alt456'))).toEqual([SAMPLE[0].id]);
    });
});

describe('the sync fold no longer drops a row this device has not archived', () => {
    const stored = (rows) => copies(rows);

    test("a pull keeps this device's old rows even when the gist carries newer listings", () => {
        const registration = mergeForKey('marketListings', LOG_KEY);
        const local = stored([SAMPLE[11], SAMPLE[12]]);
        const gist = stored([RECENT]);

        const pulled = registration.mergeForPull(local, gist);

        // Judged by the union's newest listing these two would be gone before this device archived them
        expect(ids(pulled)).toEqual([SAMPLE[11].id, SAMPLE[12].id, RECENT.id]);
    });

    test("a pull still declines what the gist holds outside the gist's own window", () => {
        const registration = mergeForKey('marketListings', LOG_KEY);
        const local = stored([RECENT]);
        const gist = stored([SAMPLE[0], RECENT]);

        expect(ids(registration.mergeForPull(local, gist))).toEqual([RECENT.id]);
    });

    test('an upload sheds both sides, so the gist stops carrying what every device has retired', () => {
        const registration = mergeForKey('marketListings', LOG_KEY);
        const local = stored([SAMPLE[0], RECENT]);
        const gist = stored([SAMPLE[1], RECENT]);

        expect(ids(registration.merge(gist, local, { forUpload: true }))).toEqual([RECENT.id]);
    });

    test('an old but active row is carried both ways', () => {
        const active = { ...SAMPLE[3], status: 'active' };
        expect(ids(mergeListingLogsForSync([active, RECENT], [RECENT], { forUpload: true }))).toEqual([
            active.id,
            RECENT.id,
        ]);
    });
});

describe('two copies of one archived listing', () => {
    const open = { ...SAMPLE[1], status: 'unknown', filledQuantity: 0 };
    const done = { ...SAMPLE[1], status: 'filled', filledQuantity: 1 };
    const canceled = { ...SAMPLE[1], status: 'canceled', filledQuantity: 0 };

    test('the more final status wins, whichever side it is on', () => {
        expect(mergeListingCopies(open, done)).toBe(done);
        expect(mergeListingCopies(done, open)).toBe(done);
        expect(mergeListingCopies(open, canceled)).toBe(canceled);
        expect(mergeListingCopies({ ...open, status: 'active' }, open).status).toBe('active');
    });

    test('equally final: the higher filled quantity wins', () => {
        const partial = { ...canceled, filledQuantity: 3, orderQuantity: 5 };
        expect(mergeListingCopies(canceled, partial)).toBe(partial);
        expect(mergeListingCopies(partial, canceled)).toBe(partial);
    });

    test('a full tie is decided the same way from either side', () => {
        const a = { ...done, price: 1 };
        const b = { ...done, price: 2 };
        expect(mergeListingCopies(a, b)).toBe(mergeListingCopies(b, a));
    });
});
