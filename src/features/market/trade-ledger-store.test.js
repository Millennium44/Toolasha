/**
 * Trade Ledger Store — persistence of fill records and listing baselines.
 *
 * The diffing itself is covered in `src/utils/trade-ledger.test.js`; this is
 * about the store not losing what it has recorded: a failed read must not
 * blank the ledger, a save must not overwrite another writer's rows, a save
 * that cannot read first must not write at all — and, since the fills moved
 * from one array to one record per day, a fill must write only its own day,
 * and the single key must be split once and folded back in if it reappears.
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
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? structuredClone(map.get(key)) : fallback;
        }),
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        FOLD_DELETE: Symbol('fold-delete'),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        /** Runs once, just before the next write lands: a sync pull storing a value in the meantime */
        beforeSet: null,
        // A folding write is handed what is stored when it lands, as the real one is
        set: vi.fn(async (key, value, store = 'settings', _immediate, options) => {
            if (storageMock.unavailable) return false;
            const intervening = storageMock.beforeSet;
            storageMock.beforeSet = null;
            intervening?.();
            const map = storeFor(store);
            const folded = options?.fold ? (options.fold(map.get(key), value) ?? value) : value;
            if (folded === storageMock.FOLD_DELETE) {
                map.delete(key);
                return true;
            }
            map.set(key, structuredClone(folded));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        tryGetAllKeys: vi.fn(async (store = 'settings') => {
            if (storageMock.unavailable) return null;
            return Array.from(storeFor(store).keys());
        }),
        putAll: vi.fn(async (store, entries) => {
            if (storageMock.unavailable) return 0;
            for (const [key, value] of Object.entries(entries)) storeFor(store).set(key, structuredClone(value));
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

const dataManagerMock = vi.hoisted(() => {
    const handlers = {};
    return {
        characterId: 'market123',
        characterData: null,
        on: (event, handler) => {
            (handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            handlers[event] = (handlers[event] || []).filter((h) => h !== handler);
        },
        // Fires the module-level 'character_switched' subscription registered
        // when trade-ledger-store.js first loaded — not a re-subscription.
        // Returns a promise so a test can await the (fire-and-forget in
        // production) async handler settling.
        _emit: (event, data) => Promise.all((handlers[event] || []).map((handler) => handler(data))),
        listings: [],
        getMarketListings: () => dataManagerMock.listings,
        getCurrentCharacterId: () => dataManagerMock.characterId,
        getCurrentCharacterGameMode: () => 'standard',
    };
});

const configMock = vi.hoisted(() => ({
    tradeLedgerEnabled: true,
    /** Subscribers registered through config.onSettingsLoaded() */
    loadedCallbacks: [],
    /** Stand in for loadSettings() finishing: the map is populated and the channel fires. */
    fireSettingsLoaded() {
        for (const cb of configMock.loadedCallbacks) cb();
    },
}));

vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
const archiveMock = vi.hoisted(() => ({ rows: [], reads: 0, hang: false, gate: null }));
vi.mock('./listing-archive.js', () => ({
    ARCHIVE_PREFIX: 'marketListingArchiveRec',
    default: {
        read: async () => {
            archiveMock.reads += 1;
            if (archiveMock.hang) return new Promise(() => {});
            if (archiveMock.gate) await archiveMock.gate;
            return archiveMock.rows;
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => configMock.tradeLedgerEnabled,
        onSettingChange: () => {},
        onSettingsLoaded: (cb) => {
            configMock.loadedCallbacks.push(cb);
            return () => {};
        },
    },
}));

const {
    default: tradeLedgerStore,
    fillKey,
    mergeRecords,
    mergeStates,
    bucketOf,
    recordKey,
    MIGRATION_TIMEOUT_MS,
} = await import('./trade-ledger-store.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
const { LEDGER_RECORD_CAP } = await import('../../utils/trade-ledger.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');

const RECORDS_KEY = 'tradeLedgerRecords_market123';
const MARKER_KEY = 'tradeLedgerRecordsSplit_market123';
const STATE_KEY = 'tradeLedgerState_market123';
const LEDGER = () => storageMock.storeFor('marketListings');
/** The cap's floor marker key, spelled out */
const floorKey = (charId, bucket) => `tradeLedgerRecFloor_${charId}_${bucket}`;
/** The day record a fill at `t` lives in */
const REC = (t) => recordKey('market123', bucketOf({ t }));
/** Every day-record key in the store, sorted */
const recordKeys = () => [...LEDGER().keys()].filter((key) => key.startsWith('tradeLedgerRec_')).sort();

/** Midnight UTC of three distinct days, so fills fall in three day records */
const DAY1 = Date.UTC(2026, 0, 1);
const DAY2 = Date.UTC(2026, 0, 2);
const DAY3 = Date.UTC(2026, 0, 3);

/**
 * A fill record of listing `listingId` at time `t`.
 * @param {number} listingId - Listing id
 * @param {number} t - Timestamp
 * @param {Object} extra - Overrides
 * @returns {Object} Fill record
 */
const fill = (listingId, t, extra = {}) => ({
    t,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    side: 'sell',
    quantity: 5,
    price: 100,
    coins: 475,
    listingId,
    ...extra,
});

/**
 * A wire listing.
 * @param {number} id - Listing id
 * @param {number} filledQuantity - Cumulative fill count
 * @param {Object} extra - Overrides
 * @returns {Object} Listing
 */
const listing = (id, filledQuantity, extra = {}) => ({
    id,
    itemHrid: '/items/a',
    enhancementLevel: 0,
    filledQuantity,
    price: 100,
    isSell: true,
    status: '/market_listing_status/active',
    ...extra,
});

/** A baseline for listing 3 at zero filled, so its next update is a fill */
const baseline3 = () => ({
    3: { filledQuantity: 0, itemHrid: '/items/a', enhancementLevel: 0, price: 100, isSell: true },
});

/** Set the in-memory ledger directly. */
const memory = (records, states) => {
    tradeLedgerStore.records = records;
    tradeLedgerStore.states = states;
    tradeLedgerStore.isLoaded = true;
};

/** Seed the store as it looks after the split: day records plus the marker */
const seedSplit = (records) => {
    const byKey = new Map();
    for (const record of records) {
        const key = REC(record.t);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(record);
    }
    for (const [key, bucket] of byKey) LEDGER().set(key, bucket);
    LEDGER().set(MARKER_KEY, { at: 1, records: records.length });
};

const awaitSaves = async () => {
    await tradeLedgerStore._repairChain;
    await tradeLedgerStore._recordsChain;
    await tradeLedgerStore._statesChain;
};

/** A fill of listing 3 by `quantity` at `now`, through the wire path */
const fillNow = (now, filledQuantity = 4) => {
    vi.setSystemTime(now);
    tradeLedgerStore.processListings([listing(3, filledQuantity)], false);
};

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    dataManagerMock.characterData = null;
    dataManagerMock.listings = [];
    configMock.tradeLedgerEnabled = true;
    tradeLedgerStore.records = [];
    tradeLedgerStore.states = {};
    tradeLedgerStore.isLoaded = false;
    tradeLedgerStore.isInitialized = false;
    tradeLedgerStore._legacy = false;
    tradeLedgerStore._recordsChain = null;
    tradeLedgerStore._statesChain = null;
    tradeLedgerStore._repairChain = null;
    tradeLedgerStore._writtenDays = new Map();
    tradeLedgerStore._repairStats = new Map();
    tradeLedgerStore._pullCaps = null;
    archiveMock.rows = [];
    archiveMock.reads = 0;
    archiveMock.hang = false;
    archiveMock.gate = null;
    for (const fn of [
        storageMock.get,
        storageMock.set,
        storageMock.getJSON,
        storageMock.setJSON,
        storageMock.tryGet,
        storageMock.putAll,
        storageMock.delete,
    ])
        fn.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(DAY3);
});

describe('a listing placed and partly filled inside one event', () => {
    test('records the part that crossed the book', () => {
        memory([], {});
        vi.setSystemTime(Date.UTC(2026, 8, 29, 12));
        const placed = listing(9, 300, { orderQuantity: 1000 });

        // The merged book already holds the new listing; the event's own copy is what says it just changed
        tradeLedgerStore.handleMarketUpdate({ endMarketListings: [placed], myMarketListings: [placed] });

        expect(tradeLedgerStore.getRecords()).toHaveLength(1);
        expect(tradeLedgerStore.getRecords()[0]).toMatchObject({ listingId: 9, side: 'sell', quantity: 300 });
    });

    test('an open listing only the merged book mentions is not taken for a new one', () => {
        memory([], {});
        const other = listing(8, 50, { orderQuantity: 100 });

        tradeLedgerStore.handleMarketUpdate({ endMarketListings: [listing(9, 0)], myMarketListings: [other] });

        expect(tradeLedgerStore.getRecords()).toEqual([]);
    });
});

describe('fill record identity', () => {
    test('fillKey is listing, time and quantity', () => {
        expect(fillKey(fill(7, 1000, { quantity: 3 }))).toBe('7|1000|3');
    });

    test('mergeRecords keeps rows only one side has, lets the fresh side win a clash, and caps', () => {
        const merged = mergeRecords(
            [fill(1, 1000), fill(2, 2000, { price: 1 })],
            [fill(2, 2000, { price: 2 }), fill(3, 500)]
        );
        expect(merged.map((r) => r.listingId)).toEqual([3, 1, 2]);
        expect(merged.find((r) => r.listingId === 2).price).toBe(2);

        const many = Array.from({ length: LEDGER_RECORD_CAP + 5 }, (_, i) => fill(i, i));
        expect(mergeRecords(many, [fill(999999, LEDGER_RECORD_CAP + 10)])).toHaveLength(LEDGER_RECORD_CAP);
    });

    test('mergeStates folds by listing id with memory winning', () => {
        expect(
            mergeStates({ 1: { filledQuantity: 1 }, 2: { filledQuantity: 5 } }, { 2: { filledQuantity: 9 } })
        ).toEqual({ 1: { filledQuantity: 1 }, 2: { filledQuantity: 9 } });
        expect(mergeStates(null, undefined)).toEqual({});
    });

    test('a fill belongs to its UTC day', () => {
        expect(bucketOf(fill(1, DAY2 + 5 * 60 * 60 * 1000))).toBe('2026-01-02');
        expect(recordKey('market123', '2026-01-02')).toBe('tradeLedgerRec_market123_2026-01-02');
    });

    test('both the single key and the day records are registered as merges for a sync pull', () => {
        const mine = [fill(1, DAY1)];
        const theirs = [fill(2, DAY2 + 1000), fill(3, DAY2 + 2000)];
        const expected = mergeRecords(mine, theirs);
        expect(expected).toHaveLength(3);
        expect(mergeForKey('marketListings', RECORDS_KEY)?.merge(mine, theirs)).toEqual(expected);
        expect(mergeForKey('marketListings', REC(DAY1))?.merge(mine, theirs)).toEqual(expected);
    });
});

describe('splitting the single key into day records', () => {
    test('the first load splits the single key by day, writes the marker and removes the key', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1), fill(2, DAY2 + 1000), fill(3, DAY2 + 2000)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2, 3]);
        expect(recordKeys()).toEqual([REC(DAY1), REC(DAY2)]);
        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([2, 3]);
        expect(LEDGER().get(MARKER_KEY)).toMatchObject({ records: 3 });
        expect(LEDGER().has(RECORDS_KEY)).toBe(false);
    });

    test('a character with nothing stored gets the marker and no records', async () => {
        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toEqual([]);
        expect(LEDGER().has(MARKER_KEY)).toBe(true);
        expect(recordKeys()).toEqual([]);
    });

    test('a split that cannot be written leaves the single key as the record', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        storageMock.putAll.mockImplementationOnce(async () => 0);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(true);
        expect(LEDGER().has(MARKER_KEY)).toBe(false);

        // Saves keep going to the single key, read-merge-written as before
        memory(tradeLedgerStore.records, baseline3());
        fillNow(DAY3);
        await awaitSaves();
        expect(
            LEDGER()
                .get(RECORDS_KEY)
                .map((r) => r.listingId)
        ).toEqual([1, 3]);
        expect(recordKeys()).toEqual([]);
    });

    test('a split whose write never settles gives up and keeps the single key', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        // A write that neither resolves nor rejects: the quota-abort hang this
        // load used to inherit, which stalls every feature initialized after it
        storageMock.putAll.mockImplementationOnce(() => new Promise(() => {}));

        const loading = tradeLedgerStore.load();
        await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 10);
        await loading;

        expect(tradeLedgerStore._legacy).toBe(true);
        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(true);
        expect(LEDGER().has(MARKER_KEY)).toBe(false);
    });

    test('absorbing a returned single key that never settles does not stall the load', async () => {
        seedSplit([fill(1, DAY1)]);
        LEDGER().set(RECORDS_KEY, [fill(2, DAY2)]);
        storageMock.putAll.mockImplementationOnce(() => new Promise(() => {}));

        const loading = tradeLedgerStore.load();
        await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 10);
        await loading;

        // The load finished and the returned key's fills are in memory either way
        expect(tradeLedgerStore.records.map((r) => r.listingId).sort()).toEqual([1, 2]);
        expect(tradeLedgerStore.isLoaded).toBe(true);
    });

    test('a later load reads the day records and does not look for a legacy value to adopt', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        // The pre-scoping bare key: without the marker this would be offered for adoption
        LEDGER().set('tradeLedgerRecords', [fill(9, DAY1)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2]);
        expect(LEDGER().has('tradeLedgerRecords')).toBe(true);
    });

    test('the single key, while it is the record, folds a value a pull stores before the write lands', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        tradeLedgerStore._legacy = true;
        memory([fill(3, DAY3)], {});
        // The pull lands after the save has probed storage and before its debounced write does
        storageMock.beforeSet = () => LEDGER().set(RECORDS_KEY, [fill(1, DAY1), fill(9, DAY2)]);

        await tradeLedgerStore.saveRecords(new Set());

        expect(
            LEDGER()
                .get(RECORDS_KEY)
                .map((r) => r.listingId)
                .sort()
        ).toEqual([1, 3, 9]);
    });

    test('the baselines fold a value a pull stores before the write lands', async () => {
        const state = (filledQuantity) => ({ filledQuantity, itemHrid: '/items/a', enhancementLevel: 0 });
        LEDGER().set(STATE_KEY, { 1: state(1) });
        memory([], { 3: state(0) });
        // The pull lands after the save has probed storage and before its write does
        storageMock.beforeSet = () => LEDGER().set(STATE_KEY, { 1: state(1), 9: state(4) });

        await tradeLedgerStore.saveStates();

        expect(Object.keys(LEDGER().get(STATE_KEY)).sort()).toEqual(['1', '3', '9']);
    });

    test('a single key that comes back after the split is folded into the day records and removed', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        // An older tab, or a sync pull from a device on the old layout, wrote it again
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1), fill(5, DAY2 + 500)]);

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2, 5]);
        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([2, 5]);
        expect(LEDGER().has(RECORDS_KEY)).toBe(false);
    });
});

describe('a fill writes its own day and nothing else', () => {
    test("a fill today writes today's record only", async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();
        storageMock.set.mockClear();

        fillNow(DAY3);
        await awaitSaves();

        const written = storageMock.set.mock.calls
            .map(([key]) => key)
            .filter((key) => key.startsWith('tradeLedgerRec_'));
        expect(written).toEqual([REC(DAY3)]);
        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([3]);
        expect(LEDGER().get(REC(DAY1))).toHaveLength(1);
        // Not immediate: the debounce is what coalesces a burst of fills
        expect(storageMock.set.mock.calls.find(([key]) => key === REC(DAY3))[3]).not.toBe(true);
    });

    test('the cap keeps the floor day whole on disk, then removes it and records the floor', async () => {
        const older = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP - 2 }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...older, ...day2]);
        await tradeLedgerStore.load();
        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        tradeLedgerStore.states = baseline3();

        fillNow(DAY3, 4);
        await awaitSaves();
        // Memory holds exactly the cap; storage keeps the floor day as a whole
        // day record, the unit sync can see
        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        expect(tradeLedgerStore.records.some((r) => r.listingId === 1)).toBe(false);
        expect(
            LEDGER()
                .get(REC(DAY1))
                .map((r) => r.listingId)
        ).toEqual([1, 2]);
        expect(LEDGER().has(floorKey('market123', bucketOf({ t: DAY1 })))).toBe(true);

        fillNow(DAY3 + 1000, 6);
        await awaitSaves();
        expect(LEDGER().has(REC(DAY1))).toBe(false);
        expect(LEDGER().get(REC(DAY3))).toHaveLength(2);
        // The floor moved on, and the superseded marker went with the day it cut
        expect(LEDGER().has(floorKey('market123', bucketOf({ t: DAY2 })))).toBe(true);
        expect(LEDGER().has(floorKey('market123', bucketOf({ t: DAY1 })))).toBe(false);
        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
    });

    test('a ledger loaded at its cap evicts and records its floor without waiting for a fill', async () => {
        const day1 = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...day1, ...day2]);
        await tradeLedgerStore.load();
        await awaitSaves();

        expect(LEDGER().has(REC(DAY1))).toBe(false);
        expect(LEDGER().has(REC(DAY2))).toBe(true);
        expect(LEDGER().has(floorKey('market123', bucketOf({ t: DAY2 })))).toBe(true);
    });

    test('a floor marker that does not land deletes nothing, so sync cannot hand the days back', async () => {
        const day1 = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...day1, ...day2]);
        const plainSet = storageMock.set.getMockImplementation();
        storageMock.set.mockImplementation(async (key, ...rest) =>
            key.startsWith('tradeLedgerRecFloor_') ? false : plainSet(key, ...rest)
        );
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await tradeLedgerStore.load();
            await awaitSaves();
        } finally {
            storageMock.set.mockImplementation(plainSet);
        }

        expect(LEDGER().has(floorKey('market123', bucketOf({ t: DAY2 })))).toBe(false);
        expect(LEDGER().has(REC(DAY1))).toBe(true);
    });

    test('day records the cap dropped before this save are deleted, not left behind', async () => {
        // DAY1 falls off the cap entirely on load, so no later save ever names
        // it — only a sweep by key can remove it
        const day1 = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...day1, ...day2]);
        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toHaveLength(LEDGER_RECORD_CAP);
        expect(tradeLedgerStore.records.some((r) => r.listingId === 1)).toBe(false);
        expect(LEDGER().has(REC(DAY1))).toBe(true);

        tradeLedgerStore.states = baseline3();
        fillNow(DAY3, 4);
        await awaitSaves();

        expect(LEDGER().has(REC(DAY1))).toBe(false);
        expect(LEDGER().has(REC(DAY2))).toBe(true);
    });

    test('no sweep happens while the ledger is below the cap', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY2)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();
        storageMock.tryGetAllKeys.mockClear();

        fillNow(DAY3, 4);
        await awaitSaves();

        expect(storageMock.tryGetAllKeys).not.toHaveBeenCalled();
        expect(LEDGER().has(REC(DAY1))).toBe(true);
    });

    test('a sweep that cannot list the store deletes nothing', async () => {
        // DAY1 falls off the cap entirely on load, so only the sweep (keyed by
        // `tryGetAllKeys`) could remove it — a failed listing must leave it be
        // rather than reading the failure as "nothing to sweep".
        const day1 = [fill(1, DAY1 + 1000), fill(2, DAY1 + 2000)];
        const day2 = Array.from({ length: LEDGER_RECORD_CAP }, (_, i) => fill(100 + i, DAY2 + i));
        seedSplit([...day1, ...day2]);
        // Every listing fails: the load's own sweep as well as the fill's
        storageMock.tryGetAllKeys.mockResolvedValue(null);
        storageMock.delete.mockClear();
        try {
            await tradeLedgerStore.load();

            tradeLedgerStore.states = baseline3();

            fillNow(DAY3, 4);
            await awaitSaves();
        } finally {
            storageMock.tryGetAllKeys.mockImplementation(async (store = 'settings') =>
                storageMock.unavailable ? null : Array.from(storageMock.storeFor(store).keys())
            );
        }

        expect(LEDGER().has(REC(DAY1))).toBe(true);
        expect(storageMock.delete).not.toHaveBeenCalledWith(REC(DAY1), 'marketListings');
    });
});

describe('the ledger cannot be wiped by a failed read or a stale copy', () => {
    test('a load while storage is unavailable keeps the in-memory ledger rather than blanking it', async () => {
        memory([fill(1, DAY1)], { 1: { filledQuantity: 5 } });
        storageMock.unavailable = true;

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 } });
        expect(tradeLedgerStore.isLoaded).toBe(true);
    });

    test('a load folds what is stored under what is in memory', async () => {
        seedSplit([fill(1, DAY1)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 }, 2: { filledQuantity: 1 } });
        memory([fill(2, DAY2)], { 2: { filledQuantity: 3 } });

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 }, 2: { filledQuantity: 3 } });
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored ledger', async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY3)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 } });
        // The failure mode that used to wipe ledgers: memory emptied by a
        // failed load, then a fill saves that emptiness back
        memory([], baseline3());
        storageMock.unavailable = true;

        fillNow(DAY3 + 1000);
        await awaitSaves();

        expect(tradeLedgerStore.records).toHaveLength(1);
        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([2]);
        expect(LEDGER().get(STATE_KEY)).toEqual({ 1: { filledQuantity: 5 } });
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test("a save merges what is stored under what is in memory, so another writer's rows in that day survive", async () => {
        seedSplit([fill(1, DAY1), fill(2, DAY3, { price: 1 })]);
        LEDGER().set(STATE_KEY, { 9: { filledQuantity: 2 } });
        memory([fill(2, DAY3, { price: 2 })], baseline3());

        fillNow(DAY3 + 1000);
        await awaitSaves();

        const stored = LEDGER().get(REC(DAY3));
        expect(stored.map((r) => r.listingId)).toEqual([2, 3]);
        // Memory's copy wins on the clash
        expect(stored.find((r) => r.listingId === 2).price).toBe(2);
        // A row this tab never loaded is still only on the other day's record; it is not touched
        expect(LEDGER().get(REC(DAY1))).toHaveLength(1);
        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([2, 3]);
        expect(Object.keys(LEDGER().get(STATE_KEY)).sort()).toEqual(['3', '9']);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(4);
    });

    test('rows only storage knew in the day written come into memory', async () => {
        seedSplit([fill(7, DAY3 + 10)]);
        memory([], baseline3());

        fillNow(DAY3 + 1000);
        await awaitSaves();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([7, 3]);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        seedSplit([fill(1, DAY1)]);
        memory([], baseline3());
        storageMock.unavailable = true;
        fillNow(DAY3 + 1000, 4);
        await awaitSaves();
        expect(LEDGER().has(REC(DAY3))).toBe(false);

        storageMock.unavailable = false;
        fillNow(DAY3 + 2000, 6);
        await awaitSaves();

        const stored = LEDGER().get(REC(DAY3));
        expect(stored.map((r) => r.listingId)).toEqual([3, 3]);
        expect(stored.map((r) => r.quantity)).toEqual([4, 2]);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(6);
    });

    test('getRecords hands out copies', () => {
        memory([fill(1, 1000)], {});
        const copy = tradeLedgerStore.getRecords();
        copy[0].price = 0;
        expect(tradeLedgerStore.records[0].price).toBe(100);
    });
});

describe('a fill another writer wrote over comes back on the next fill', () => {
    test('a day record a pull replaced without this tab’s fill is re-folded when another day fills', async () => {
        seedSplit([fill(1, DAY1)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();

        fillNow(DAY2 + 1000, 4);
        await awaitSaves();
        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([3]);

        // A sync pull lands its merged copy of that day, built from a read taken
        // before this tab's fill committed: another device's fill, not this one's
        LEDGER().set(REC(DAY2), [fill(8, DAY2 + 500)]);

        // Nothing fills on that day again; the next fill is the next day's
        fillNow(DAY3 + 1000, 6);
        await awaitSaves();

        expect(
            LEDGER()
                .get(REC(DAY2))
                .map((r) => r.listingId)
        ).toEqual([8, 3]);
        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([3]);
    });

    test('a day already holding everything is read, not written again', async () => {
        seedSplit([fill(1, DAY1)]);
        await tradeLedgerStore.load();
        tradeLedgerStore.states = baseline3();
        fillNow(DAY2 + 1000, 4);
        await awaitSaves();
        storageMock.set.mockClear();

        fillNow(DAY3 + 1000, 6);
        await awaitSaves();

        const written = storageMock.set.mock.calls
            .map(([key]) => key)
            .filter((key) => key.startsWith('tradeLedgerRec_'));
        expect(written).toEqual([REC(DAY3)]);
    });

    test('the day write folds into what is stored when it lands', async () => {
        seedSplit([fill(1, DAY1)]);
        await tradeLedgerStore.load();
        await awaitSaves();
        tradeLedgerStore.states = baseline3();
        // Another tab's fill lands between this save's read and its write
        storageMock.tryGet.mockImplementationOnce(async (key, store) => {
            const probe = { found: false, value: null };
            storageMock.storeFor(store).set(key, [fill(9, DAY3 + 10)]);
            return probe;
        });

        fillNow(DAY3 + 1000, 4);
        await awaitSaves();

        expect(
            LEDGER()
                .get(REC(DAY3))
                .map((r) => r.listingId)
        ).toEqual([9, 3]);
    });
});

describe('a character switch resets in-memory state even while the feature is off', () => {
    test('toggling off, switching character, then back on does not merge the old character under the new one', async () => {
        // Character A has a fill in memory (as if the feature had been on for them).
        memory([fill(1, DAY3)], {});

        // The player disables the setting, still on character A.
        configMock.tradeLedgerEnabled = false;
        tradeLedgerStore.disable();
        expect(tradeLedgerStore.records).toHaveLength(1);

        // They switch to character B while the feature is off. Before the fix,
        // the module's character_switched listener skipped handleCharacterSwitch()
        // whenever the setting was off, so nothing here was cleared.
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');

        // Re-enabling now must not let character A's fill survive into B's ledger.
        configMock.tradeLedgerEnabled = true;
        await tradeLedgerStore.initialize();

        expect(tradeLedgerStore.records.some((r) => r.listingId === 1)).toBe(false);
    });
});

describe('a character who has the ledger off stays off across a switch', () => {
    test('the schema default read inside the settings-reload window is corrected once settings load', async () => {
        // The switch sequence: feature-registry clears the settings cache on
        // `character_switching`, then `character_switched` fans out to this
        // module's import-time listener — all before feature-registry's own
        // step calls config.loadSettings(). Inside that window getSetting()
        // answers from SCHEMA_DEFAULTS, which is `true` for the ledger, so
        // initialize() runs for a character who has it switched off.
        dataManagerMock.characterId = 'iron456';
        configMock.tradeLedgerEnabled = true; // the schema default standing in for the empty map
        await dataManagerMock._emit('character_switched');
        expect(tradeLedgerStore.isInitialized).toBe(true);

        // Settings finish loading and this character's real value is `false`.
        // loadSettings() fires no per-key change callback on a switch (the
        // previous map was empty), and initialize()'s isInitialized
        // short-circuit means a later re-init corrects nothing either — the
        // settings-loaded channel is the only signal that arrives.
        configMock.tradeLedgerEnabled = false;
        configMock.fireSettingsLoaded();

        expect(tradeLedgerStore.isInitialized).toBe(false);

        // …and with the handlers gone, a market update records nothing.
        await dataManagerMock._emit('market_listings_updated', { myMarketListings: [listing(3, 4)] });
        expect(tradeLedgerStore.getRecords()).toEqual([]);
    });

    test('a character who has it on is left initialized', async () => {
        dataManagerMock.characterId = 'iron456';
        await dataManagerMock._emit('character_switched');
        configMock.fireSettingsLoaded();
        expect(tradeLedgerStore.isInitialized).toBe(true);
    });
});

describe('a character switch landing inside a load or a save', () => {
    // Every key in load()/saveStates() used to be rebuilt by characterKey() at
    // the moment it was needed, so a switch arriving between two reads gave the
    // marker, the day records, the single key and the baselines different
    // owners. The keys are built from a character captured before the first
    // read now, and the work stands down when that character has moved on.
    const IRON = 'iron456';

    test('the split marks the character it read, not the one who arrived mid-write', async () => {
        // Both characters are still on the pre-split single key.
        LEDGER().set(RECORDS_KEY, [fill(1, DAY1)]);
        LEDGER().set(`tradeLedgerRecords_${IRON}`, [fill(2, DAY2)]);

        const putAll = storageMock.putAll.getMockImplementation();
        storageMock.putAll.mockImplementationOnce(async (store, entries) => {
            dataManagerMock.characterId = IRON;
            return putAll(store, entries);
        });

        await tradeLedgerStore.load();

        // The iron cow's un-migrated ledger must still be there, and unmarked:
        // a marker over an empty set of day records loses it for good.
        expect(LEDGER().get(`tradeLedgerRecords_${IRON}`)).toEqual([fill(2, DAY2)]);
        expect(LEDGER().has(`tradeLedgerRecordsSplit_${IRON}`)).toBe(false);
        expect(LEDGER().has(MARKER_KEY)).toBe(true);
    });

    test('a load that began under one character does not adopt their fills into the arriving one', async () => {
        seedSplit([fill(1, DAY1)]);

        const getAllKeys = storageMock.getAllKeys.getMockImplementation();
        storageMock.getAllKeys.mockImplementationOnce(async (store) => {
            dataManagerMock.characterId = IRON;
            return getAllKeys(store);
        });

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records).toEqual([]);
        expect(tradeLedgerStore.isLoaded).toBe(false);
    });

    test('a save that began under one character does not write their baselines under another', async () => {
        memory([], baseline3());

        const tryGet = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementationOnce(async (key, store) => {
            const probe = await tryGet(key, store);
            dataManagerMock.characterId = IRON;
            return probe;
        });

        await tradeLedgerStore.saveStates();

        expect(LEDGER().has(`tradeLedgerState_${IRON}`)).toBe(false);
    });
});

/**
 * The day records share `marketListings` with account-wide market caches, so
 * the store's flat 2,000-key budget is not theirs: a four-character account
 * would trip it while no single character was near its own. Registering the
 * prefix is what lets the health panel count them per character and check them
 * against `CHARACTER_FAMILY_BUDGETS`.
 */
describe('the day records are counted per character', () => {
    test('the record prefix is registered as character-scoped', async () => {
        const { maxRecordsPerCharacter } = await import('../../utils/chunked-history.js');

        const keys = [
            'tradeLedgerRec_char-1_2026-09-01',
            'tradeLedgerRec_char-1_2026-09-02',
            'tradeLedgerRec_char-1_2026-09-03',
            'tradeLedgerRec_char-2_2026-09-01',
            // Not a day record: the pre-split single key and the split marker
            'tradeLedgerRecords_char-1',
            'tradeLedgerRecordsSplit_char-1',
            // Account-wide, and no character's to carry
            'orderBooksCache',
        ];

        expect(maxRecordsPerCharacter('marketListings', keys)).toBe(3);
    });
});

describe('the baselines fold to the copy further along, whichever side meets first', () => {
    const open = (filledQuantity) => ({ filledQuantity, itemHrid: '/items/a', enhancementLevel: 0, price: 100 });

    test('a finished listing beats a stale baseline, both ways round', () => {
        const done = { 7: { done: true } };
        const stale = { 7: open(0) };
        expect(mergeStates(done, stale)).toEqual(done);
        expect(mergeStates(stale, done)).toEqual(done);
    });

    test('the higher fill count wins, both ways round, and a repeat changes nothing', () => {
        const a = { 7: open(3), 8: open(1) };
        const b = { 7: open(9), 9: open(2) };
        const merged = mergeStates(a, b);
        expect(merged).toEqual({ 7: open(9), 8: open(1), 9: open(2) });
        expect(mergeStates(b, a)).toEqual(merged);
        expect(mergeStates(merged, b)).toEqual(merged);
        expect(mergeStates(merged, merged)).toEqual(merged);
    });

    test('entries that are not baselines settle the same way on either side', () => {
        for (const [x, y] of [
            [null, 'x'],
            [[1], 'y'],
            [5, 7],
        ]) {
            expect(mergeStates({ 7: x }, { 7: y })).toEqual(mergeStates({ 7: y }, { 7: x }));
        }
    });

    test('equal counts with differing content settle the same way on either side', () => {
        const a = { 7: { ...open(3), price: 100 } };
        const b = { 7: { ...open(3), price: 200 } };
        expect(mergeStates(a, b)).toEqual(mergeStates(b, a));
    });
});

describe('fills recorded past what a finished listing filled are cut back', () => {
    const LOG_KEY = 'marketListingTimestamps_market123';
    const T1 = DAY1 + 3600e3;
    const T2 = DAY2 + 3600e3;
    const T3 = DAY3 + 3600e3;
    const logRow = (id, filledQuantity, status = 'filled', extra = {}) => ({
        id,
        timestamp: T1,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: filledQuantity,
        filledQuantity,
        isSell: true,
        status,
        ...extra,
    });
    const quantities = (id) =>
        tradeLedgerStore
            .getRecords()
            .filter((r) => r.listingId === id)
            .map((r) => r.quantity);
    const stored = () => [...LEDGER().entries()].filter(([k]) => k.startsWith('tradeLedgerRec_market123'));
    const storedQuantity = (id) =>
        stored()
            .flatMap(([, rows]) => rows)
            .filter((r) => r.listingId === id)
            .reduce((sum, r) => sum + r.quantity, 0);
    const loadAndRepair = async () => {
        // The character's data has arrived, with no open listings
        dataManagerMock.characterData ||= {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
    };

    test('over-recorded: the earliest fills stay, the excess goes from memory and from storage', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(storedQuantity(5)).toBe(10);
        // The neighbouring listing, in the same day record as a removed row, is untouched
        expect(storedQuantity(6)).toBe(5);
        expect(quantities(6)).toEqual([5]);
    });

    test('a day left with nothing stays as an empty record, which every reader reads as no fills', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);

        await loadAndRepair();

        expect(LEDGER().get(REC(T3))).toEqual([]);
        expect(quantities(5)).toEqual([5, 5]);
        // A reload reads the empty day without complaint and writes nothing for it
        tradeLedgerStore.records = [];
        tradeLedgerStore.isLoaded = false;
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
        expect(quantities(5)).toEqual([5, 5]);
        expect(LEDGER().get(REC(T3))).toEqual([]);
        expect(LEDGER().has(REC(T2))).toBe(true);
    });

    test('the fill the cap falls inside is trimmed, coins in proportion, price unchanged', async () => {
        const row = (t) => fill(5, t, { quantity: 4, price: 100, coins: 380 });
        seedSplit([row(T1), row(T2), row(T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);

        await loadAndRepair();

        const rows = tradeLedgerStore.getRecords().filter((r) => r.listingId === 5);
        expect(rows.map((r) => [r.quantity, r.coins, r.price])).toEqual([
            [4, 380, 100],
            [4, 380, 100],
            [2, 190, 100],
        ]);
        expect(storedQuantity(5)).toBe(10);
    });

    test('exact and under-recorded listings are left alone and nothing is written', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(6, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10), logRow(6, 50)]);
        storageMock.set.mockClear();

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(quantities(6)).toEqual([5]);
        expect(storageMock.set.mock.calls.filter(([k]) => k.startsWith('tradeLedgerRec_'))).toEqual([]);
    });

    test('a listing with no log row, or a log that is not an array, is not touched', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        await loadAndRepair();
        expect(quantities(5)).toEqual([5, 5, 5]);

        LEDGER().set(LOG_KEY, [logRow(99, 1)]);
        await tradeLedgerStore._repairOverRecorded();
        expect(quantities(5)).toEqual([5, 5, 5]);

        LEDGER().set(LOG_KEY, { not: 'an array' });
        await tradeLedgerStore._repairOverRecorded();
        expect(quantities(5)).toEqual([5, 5, 5]);
    });

    test('a listing the log still has open, or with no recorded count, is not touched', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(6, T1), fill(6, T2)]);
        LEDGER().set(LOG_KEY, [
            logRow(5, 1, 'unknown', { orderQuantity: 100 }),
            logRow(6, 0, 'canceled', { orderQuantity: 100 }),
        ]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(quantities(6)).toEqual([5, 5]);
    });

    test('a cancel after a partial fill is capped at what it filled, not at what was ordered', async () => {
        seedSplit([fill(5, T1, { quantity: 3, coins: 285 }), fill(5, T2, { quantity: 3, coins: 285 })]);
        LEDGER().set(LOG_KEY, [logRow(5, 3, 'filled', { orderQuantity: 3 })]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([3]);
    });

    test('a listing only the archive remembers is capped by the archive', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        archiveMock.rows = [logRow(5, 5, 'filled')];

        await loadAndRepair();

        expect(quantities(5)).toEqual([5]);
    });

    test('running it again changes nothing, and writes nothing', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        await loadAndRepair();
        const after = JSON.stringify(stored());
        storageMock.set.mockClear();

        expect(await tradeLedgerStore._repairOverRecorded()).toBe(0);

        expect(JSON.stringify(stored())).toBe(after);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('rows that return from another device are cut again, and the trimmed row is not doubled', async () => {
        const row = (t) => fill(5, t, { quantity: 4, coins: 380 });
        seedSplit([row(T1), row(T2), row(T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();

        // A pull of the old device's day records: the untrimmed rows are back beside the trimmed one
        LEDGER().set(REC(T3), [row(T3)]);
        LEDGER().set(REC(T2), [...LEDGER().get(REC(T2)), row(T2)]);
        tradeLedgerStore.records = mergeRecords(tradeLedgerStore.records, [row(T2), row(T3)]);
        await tradeLedgerStore._repairOverRecorded();

        expect(quantities(5)).toEqual([4, 4, 2]);
        expect(storedQuantity(5)).toBe(10);
    });

    test("another character's rows and log are not read or written", async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set('tradeLedgerRec_other77_2026-01-01', [fill(5, T1), fill(5, T2)]);
        LEDGER().set('marketListingTimestamps_other77', [logRow(5, 5)]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(LEDGER().get('tradeLedgerRec_other77_2026-01-01')).toHaveLength(2);
    });

    test('a character switch while the log is being read applies nothing', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        await loadAndRepair();
        const rowsBefore = storedQuantity(5);
        tradeLedgerStore.records = [fill(5, T1), fill(5, T2)];
        const pending = tradeLedgerStore._repairOverRecorded();
        tradeLedgerStore._generation += 1;
        tradeLedgerStore.records = [fill(77, T3)];
        await pending;

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([77]);
        expect(storedQuantity(5)).toBe(rowsBefore);
    });

    test('a day record that cannot be read is left for the next load, memory is already right', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        await loadAndRepair();
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        const real = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(async (key, store) =>
            key.startsWith('tradeLedgerRec_market123') ? null : real(key, store)
        );
        try {
            await tradeLedgerStore._repairOverRecorded();
        } finally {
            storageMock.tryGet.mockImplementation(real);
        }

        expect(quantities(5)).toEqual([5]);
        // Storage still holds the over-recorded rows; the next load cuts them
        expect(storedQuantity(5)).toBe(10);
        tradeLedgerStore.records = [];
        await loadAndRepair();
        expect(storedQuantity(5)).toBe(5);
    });
    test('an expired log row is not trusted: a stale low count cuts nothing', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5, 'expired')]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5, 5]);
        expect(storedQuantity(5)).toBe(15);
    });

    test('a listing that is still open on the book is not cut, whatever the log says', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5, 'filled')]);
        dataManagerMock.characterData = {};
        dataManagerMock.listings = [{ id: 5, status: '/market_listing_status/active' }];

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
    });

    test('before character data arrives nothing is cut, and the arriving listings run the repair', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        dataManagerMock.characterData = null;
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
        expect(quantities(5)).toEqual([5, 5]);

        // The same listing arriving as open stands down; arriving ended, it is cut
        await tradeLedgerStore._repairOverRecorded([{ id: 5, status: '/market_listing_status/active' }]);
        expect(quantities(5)).toEqual([5, 5]);
        await tradeLedgerStore._repairOverRecorded([{ id: 5, status: '/market_listing_status/filled' }]);
        expect(quantities(5)).toEqual([5]);
    });

    test('a baseline above the log count raises the cap, so a counted fill is never cut', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        tradeLedgerStore.states = { 5: { filledQuantity: 10, itemHrid: '/items/a', price: 100 } };

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
    });

    test('the archive is read once for a load, then only when a listing is over its log count or missing', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(6, T1)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10), logRow(6, 5)]);
        await loadAndRepair();
        // The one read that checks the caps the sync pull fold holds
        expect(archiveMock.reads).toBe(1);

        // Startup runs the repair again after the snapshot and on character_initialized: no more reads
        await tradeLedgerStore._repairOverRecorded();
        await tradeLedgerStore._repairOverRecorded([]);
        expect(archiveMock.reads).toBe(1);

        LEDGER().set(LOG_KEY, [logRow(5, 5), logRow(6, 5)]);
        await tradeLedgerStore._repairOverRecorded();
        expect(archiveMock.reads).toBe(2);
        expect(quantities(5)).toEqual([5]);
    });

    test('a ledger with nothing to check never reads the archive', async () => {
        seedSplit([]);
        await loadAndRepair();
        expect(archiveMock.reads).toBe(0);
        expect(tradeLedgerStore._pullCaps).toBeNull();
    });

    test('an archive read that never settles counts as unreadable, so later writes do not wait for ever', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        archiveMock.hang = true;
        vi.useFakeTimers();
        try {
            dataManagerMock.characterData ||= {};
            await tradeLedgerStore.load();
            await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 1);
            await tradeLedgerStore._repairChain;
            await tradeLedgerStore._recordsChain;
        } finally {
            vi.useRealTimers();
            archiveMock.hang = false;
        }
        expect(quantities(5)).toEqual([5, 5]);
        expect(tradeLedgerStore._pullCaps).toBeNull();
    });

    test('two real partial fills in one millisecond are both kept', async () => {
        const row = (t) => fill(5, t, { quantity: 3, coins: 285 });
        seedSplit([row(T1), row(T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 6)]);
        // In memory only: a stored pair would merge under one fillKey
        tradeLedgerStore.records = [row(T1), row(T1), row(T2)];
        tradeLedgerStore.isLoaded = true;
        dataManagerMock.characterData = {};

        await tradeLedgerStore._repairOverRecorded();

        expect(tradeLedgerStore.records.map((r) => [r.t, r.quantity])).toEqual([
            [T1, 3],
            [T1, 3],
        ]);
    });
    test('a fill another tab stores in an emptied day after the read survives', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        // Re-open the case: day 3 holds only the doomed row, in memory and in storage
        LEDGER().set(REC(T3), [fill(5, T3)]);
        tradeLedgerStore.records = [fill(5, T1), fill(5, T2), fill(5, T3)];
        const real = storageMock.tryGet.getMockImplementation();
        let fired = false;
        storageMock.tryGet.mockImplementation(async (key, store) => {
            const result = await real(key, store);
            if (key === REC(T3) && !fired) {
                fired = true;
                storageMock.storeFor(store).set(key, [fill(5, T3), fill(9, T3 + 10)]);
            }
            return result;
        });
        try {
            await tradeLedgerStore._repairOverRecorded();
        } finally {
            storageMock.tryGet.mockImplementation(real);
        }

        expect(
            LEDGER()
                .get(REC(T3))
                ?.map((r) => r.listingId)
        ).toEqual([9]);
    });

    test('a single recorded fill over a stale log count asks the archive before being trimmed', async () => {
        seedSplit([fill(5, T1, { quantity: 10, coins: 1000 })]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        archiveMock.rows = [logRow(5, 10)];
        await loadAndRepair();
        expect(archiveMock.reads).toBeGreaterThan(0);
        expect(quantities(5)).toEqual([10]);
    });

    test('an unreadable archive defers the repair; an empty one does not', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        archiveMock.rows = null;
        await loadAndRepair();
        expect(quantities(5)).toEqual([5, 5]);
        expect(storedQuantity(5)).toBe(10);

        // The archive comes back holding a higher count than the stale log: nothing to cut
        archiveMock.rows = [logRow(5, 10)];
        await tradeLedgerStore._repairOverRecorded();
        expect(quantities(5)).toEqual([5, 5]);

        // An archive that is readable and empty is an archive with nothing in it
        archiveMock.rows = [];
        await tradeLedgerStore._repairOverRecorded();
        expect(quantities(5)).toEqual([5]);
    });
});

describe('the repair count the sync pull report prints', () => {
    const LOG_KEY = 'marketListingTimestamps_market123';
    const T1 = DAY1 + 3600e3;
    const T2 = DAY2 + 3600e3;
    const T3 = DAY3 + 3600e3;
    const logRow = (id, filledQuantity) => ({
        id,
        timestamp: T1,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: filledQuantity,
        filledQuantity,
        isSell: true,
        status: 'filled',
    });
    const loadAndRepair = async () => {
        dataManagerMock.characterData ||= {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
    };

    test('says it has not run before the repair has', () => {
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 0, cut: 0 });
    });

    test('counts the listings a run cut, and a second run that finds nothing adds a run and no cuts', async () => {
        // Two listings over their final count, with stacks of three
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T1), fill(6, T2), fill(6, T3), fill(7, T1)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10), logRow(6, 5), logRow(7, 5)]);

        await loadAndRepair();
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 1, cut: 2 });

        await tradeLedgerStore._repairOverRecorded();
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 2, cut: 2 });
    });

    test('a run that finds nothing over-recorded is a run that cut zero, not "not run"', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);

        await loadAndRepair();

        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 1, cut: 0 });
    });

    test('a log naming nothing it may cut still counts as a run', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        await loadAndRepair();
        expect(tradeLedgerStore.repairStats().runs).toBe(1);
        expect(tradeLedgerStore.repairStats().cut).toBe(0);
    });

    test('a repair that was skipped is not counted: no open listings known, archive unreadable, legacy store', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);

        // The character's data has not arrived and the caller has no listings: "not loaded", not an empty book
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
        expect(tradeLedgerStore.repairStats().runs).toBe(0);

        // The archive cannot be read, so the whole repair waits
        dataManagerMock.characterData = {};
        archiveMock.rows = null;
        await tradeLedgerStore._repairOverRecorded();
        expect(tradeLedgerStore.repairStats().runs).toBe(0);

        // The single key is still the record
        archiveMock.rows = [];
        tradeLedgerStore._legacy = true;
        await tradeLedgerStore._repairOverRecorded();
        expect(tradeLedgerStore.repairStats().runs).toBe(0);
    });

    test("a character switch never shows one character's count against another", async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 1, cut: 1 });

        dataManagerMock.characterId = 'other77';
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'other77', runs: 0, cut: 0 });

        // ...and the first character's count is still theirs on the way back
        dataManagerMock.characterId = 'market123';
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 1, cut: 1 });
    });

    test('a run stood down by a switch landing inside it is not counted', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        tradeLedgerStore.isLoaded = true;
        dataManagerMock.characterData = {};
        tradeLedgerStore.records = [fill(5, T1), fill(5, T2)];
        // The switch lands while the log is being read
        const real = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(async (key, store) => {
            if (key === LOG_KEY) tradeLedgerStore._generation += 1;
            return real(key, store);
        });
        try {
            await tradeLedgerStore._repairOverRecorded();
        } finally {
            storageMock.tryGet.mockImplementation(real);
        }
        expect(tradeLedgerStore.repairStats().runs).toBe(0);
    });

    test('says whether the ledger is recording, so "not run yet" can be told from "switched off"', () => {
        expect(tradeLedgerStore.repairStats().recording).toBe(false);
        tradeLedgerStore.isInitialized = true;
        expect(tradeLedgerStore.repairStats().recording).toBe(true);
    });

    test('the answer is a copy: reading it cannot change the count', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const stats = tradeLedgerStore.repairStats();
        stats.cut = 99;
        stats.runs = 99;
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'market123', runs: 1, cut: 1 });
    });
});

/**
 * The repair leaves no tombstone, so a gist that still holds the doubled rows hands them back on a pull. The pull
 * folds a day record through the registration's `mergeForPull`; these run that real fold against a day the repair
 * has just cut, and against the same day with the cut rows brought back.
 */
describe('a sync pull that only brings back rows the repair cuts reads as unchanged', () => {
    const LOG_KEY = 'marketListingTimestamps_market123';
    const T1 = DAY1 + 3600e3;
    const T2 = DAY2 + 3600e3;
    const T3 = DAY3 + 3600e3;
    const logRow = (id, filledQuantity, status = 'filled') => ({
        id,
        timestamp: T1,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: filledQuantity,
        filledQuantity,
        isSell: true,
        status,
    });
    const registration = (t) => mergeForKey('marketListings', REC(t));
    /** The day record as storage holds it, the way the pull reads it */
    const stored = (t) => structuredClone(LEDGER().get(REC(t)));
    const pull = (t, incoming) => {
        const local = stored(t);
        return { local, result: registration(t).mergeForPull(local, incoming, { download: { [REC(t)]: incoming } }) };
    };
    const loadAndRepair = async () => {
        dataManagerMock.characterData ||= {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
    };
    const listingsOf = (rows, id) => rows.filter((r) => r.listingId === id);

    test('the registration folds a pull through the store and an upload through the plain union', () => {
        expect(registration(T1).mergeForPull).not.toBe(registration(T1).merge);
        const one = [fill(1, T1)];
        const other = [fill(2, T1)];
        expect(registration(T1).merge(one, other)).toEqual(mergeRecords(one, other));
        expect(registration(T1).merge(one, other)).toHaveLength(2);
    });

    test("doubled rows the gist still holds: the pulled day is this device's own copy, not a change", async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(5, T3 + 1), fill(5, T3 + 2), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const gist = [fill(5, T3), fill(5, T3 + 1), fill(5, T3 + 2), fill(6, T3 + 3)];

        const { local, result } = pull(T3, gist);

        // Identity, not equality: the pull judges "unchanged" on the very array it passed in
        expect(local.map((r) => r.listingId)).toEqual([6]);
        expect(result).toBe(local);
        // Folding again, as the write-time refold does, gives the same answer
        expect(registration(T3).mergeForPull(local, gist, { download: { [REC(T3)]: gist } })).toBe(local);
    });

    test.each([
        ['no context', undefined],
        ['no download', {}],
        ['a null download', { download: null }],
        ['a download that is not a keyed object', { download: [] }],
    ])('%s: the fold cannot see the other days, so it is the plain union', async (_name, context) => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();

        const result = registration(T3).mergeForPull(stored(T3), [fill(5, T3), fill(6, T3 + 3)], context);

        expect(listingsOf(result, 5)).toHaveLength(1);
    });

    test('another day of the download that is not a list changes nothing: what is held there stands', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const gist = [fill(5, T3), fill(6, T3 + 3)];
        const local = stored(T3);

        const result = registration(T3).mergeForPull(local, gist, { download: { [REC(T1)]: 'junk', [REC(T3)]: gist } });

        expect(result).toBe(local);
    });

    test("another character's trimmed copy of the same listing and time is no reason to keep a row", async () => {
        seedSplit([fill(5, T1, { quantity: 10, coins: 950 }), fill(6, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const gist = [fill(6, T2), fill(5, T2 + 5)];
        const local = stored(T2);
        const download = {
            [recordKey('other456', bucketOf({ t: T1 }))]: [fill(5, T1, { quantity: 5, trimmed: true })],
            [REC(T2)]: gist,
        };

        expect(registration(T2).mergeForPull(local, gist, { download })).toBe(local);
    });

    test('a row memory already holds trimmed, another device trimming it differently: the fold still cuts', async () => {
        const row = (t) => fill(5, t, { quantity: 4, coins: 380 });
        seedSplit([row(T1), row(T2), row(T3)]);
        LEDGER().set(REC(T3 + 86400e3), [fill(6, T3 + 86400e3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        expect(stored(T3)).toEqual([expect.objectContaining({ trimmed: true, quantity: 2 })]);
        const T4 = T3 + 86400e3;
        const gist = [fill(6, T4), fill(5, T4 + 5)];
        const local = stored(T4);
        const download = { [REC(T3)]: [{ ...row(T3), trimmed: true, quantity: 3 }], [REC(T4)]: gist };

        expect(registration(T4).mergeForPull(local, gist, { download })).toBe(local);
    });

    test('only the listing a trimmed copy touches is kept: another listing in the same fold is still cut', async () => {
        const big = fill(5, T1, { quantity: 10, coins: 950 });
        seedSplit([big, fill(8, T1 + 1), fill(8, T1 + 2), fill(6, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10), logRow(8, 10)]);
        await loadAndRepair();
        const gist = [fill(6, T2), fill(5, T2 + 5), fill(8, T2 + 6)];
        const download = { [REC(T1)]: [{ ...big, trimmed: true, quantity: 5, coins: 475 }], [REC(T2)]: gist };

        const result = registration(T2).mergeForPull(stored(T2), gist, { download });

        expect(listingsOf(result, 5).map((r) => r.quantity)).toEqual([5]);
        expect(listingsOf(result, 8)).toHaveLength(0);
    });

    test('the same pull through the plain union (an upload) does bring them back', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();

        const folded = registration(T3).merge(stored(T3), [fill(5, T3), fill(6, T3 + 3)]);

        expect(listingsOf(folded, 5)).toHaveLength(1);
    });

    test('a day the repair emptied stays a record, so the pull folds it instead of writing it back whole', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();

        expect(LEDGER().get(REC(T3))).toEqual([]);
        const { local, result } = pull(T3, [fill(5, T3)]);
        expect(result).toBe(local);
    });

    test('a listing spanning two days is cut by the whole ledger, not by the day alone', async () => {
        // Day 2 alone holds 10 of a 10-unit listing, so a day-only cut would keep both rows
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T2 + 1000)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        expect(stored(T2).map((r) => r.t)).toEqual([T2]);

        const { local, result } = pull(T2, [fill(5, T2), fill(5, T2 + 1000)]);

        expect(result).toBe(local);
    });

    test('a real new fill arriving with the doubled rows survives, and they still go', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const fresh = fill(7, T3 + 5000, { quantity: 2, coins: 190 });

        const { local, result } = pull(T3, [fill(5, T3), fill(6, T3 + 3), fresh]);

        expect(result).not.toBe(local);
        expect(result.map((r) => [r.listingId, r.t])).toEqual([
            [6, T3 + 3],
            [7, T3 + 5000],
        ]);
    });

    test('the trimmed row beside its untrimmed original is one row, and a pull of the original is unchanged', async () => {
        const row = (t) => fill(5, t, { quantity: 4, coins: 380 });
        seedSplit([row(T1), row(T2), row(T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        expect(stored(T3)).toEqual([expect.objectContaining({ trimmed: true, quantity: 2 })]);

        const { local, result } = pull(T3, [row(T3)]);

        expect(result).toBe(local);
    });

    test('a listing not known as ended is never cut: open on the book, or logged as expired', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(8, T1), fill(9, T1)]);
        // Listing 9 is open on the book and has a log row that would otherwise cap it
        LEDGER().set(LOG_KEY, [logRow(5, 10), logRow(8, 5, 'expired'), logRow(9, 5)]);
        dataManagerMock.listings = [{ id: 9, status: '/market_listing_status/active' }];
        await loadAndRepair();

        const incoming = [fill(5, T3), fill(8, T3 + 1), fill(9, T3 + 2), fill(9, T3 + 3)];
        const { result } = pull(T3, incoming);

        expect(listingsOf(result, 5)).toHaveLength(0);
        expect(listingsOf(result, 8)).toHaveLength(1);
        expect(listingsOf(result, 9)).toHaveLength(2);
    });

    test('before any repair has run the pull is the plain union, as it was', () => {
        LEDGER().set(REC(T3), [fill(6, T3 + 3)]);
        tradeLedgerStore.records = [fill(5, T1), fill(5, T2), fill(6, T3 + 3)];
        tradeLedgerStore.isLoaded = true;

        const { local, result } = pull(T3, [fill(5, T3), fill(6, T3 + 3)]);

        expect(result).not.toBe(local);
        expect(listingsOf(result, 5)).toHaveLength(1);
    });

    test("another character's caps, a ledger switched off, and a store still on the single key cut nothing", async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        const incoming = [fill(5, T3), fill(6, T3 + 3)];
        const doubled = (r) => listingsOf(r, 5).length;

        expect(doubled(pull(T3, incoming).result)).toBe(0);

        dataManagerMock.characterId = 'someoneElse';
        expect(doubled(pull(T3, incoming).result)).toBe(1);
        dataManagerMock.characterId = 'market123';

        tradeLedgerStore._legacy = true;
        expect(doubled(pull(T3, incoming).result)).toBe(1);
        tradeLedgerStore._legacy = false;

        tradeLedgerStore.isLoaded = false;
        expect(doubled(pull(T3, incoming).result)).toBe(1);
        tradeLedgerStore.isLoaded = true;

        tradeLedgerStore.disable();
        expect(doubled(pull(T3, incoming).result)).toBe(1);
    });

    test('a character switch forgets the caps', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(5, T3)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        await loadAndRepair();
        expect(tradeLedgerStore._pullCaps?.caps.get(5)).toBe(10);

        dataManagerMock.characterId = 'other456';
        await tradeLedgerStore.handleCharacterSwitch();

        // Nothing of the departing character's caps is held for the arriving one
        expect(tradeLedgerStore._pullCaps?.caps.has(5) ?? false).toBe(false);
        expect(tradeLedgerStore._pullCaps?.charId ?? 'other456').toBe('other456');
    });

    test("a day whose rows differ only in order is this device's own copy", () => {
        // The repair rewrites a day with its repaired listings last, so a stored day is not always in time order
        const a = fill(8, T1 + 2000);
        const b = fill(9, T1 + 1000);
        LEDGER().set(REC(T1), [a, b]);

        const { local, result } = pull(T1, [b, a]);

        expect(result).toBe(local);
    });

    test('a pull of rows this device lacks is still a union', () => {
        LEDGER().set(REC(T1), [fill(8, T1)]);

        const { local, result } = pull(T1, [fill(8, T1), fill(9, T1 + 5)]);

        expect(result).not.toBe(local);
        expect(result.map((r) => r.listingId)).toEqual([8, 9]);
    });

    describe('the fold cuts only with what the repair would have read', () => {
        const sumOf = (rows, id) => listingsOf(rows, id).reduce((sum, r) => sum + r.quantity, 0);
        const foldWith = (t, incoming, download) => {
            const local = stored(t);
            return { local, result: registration(t).mergeForPull(local, incoming, { download }) };
        };
        /** A new page on the same storage */
        const reopen = async () => {
            tradeLedgerStore.records = [];
            tradeLedgerStore.states = {};
            tradeLedgerStore.isLoaded = false;
            tradeLedgerStore._pullCaps = null;
            await loadAndRepair();
        };

        test('a real second fill over a stale log count is kept: local total equal to the log still asks the archive', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            archiveMock.rows = [logRow(5, 10)];
            await loadAndRepair();
            expect(archiveMock.reads).toBeGreaterThan(0);
            expect(tradeLedgerStore._pullCaps.caps.get(5)).toBe(10);

            const { local, result } = pull(T1, [fill(5, T1), fill(6, T1 + 1), fill(5, T1 + 2000)]);

            expect(result).not.toBe(local);
            expect(listingsOf(result, 5).map((r) => r.quantity)).toEqual([5, 5]);
            expect(sumOf(result, 6)).toBe(5);
        });

        test('nothing higher anywhere: the same rows are cut, as the repair would cut them', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();

            const { local, result } = pull(T1, [fill(5, T1), fill(6, T1 + 1), fill(5, T1 + 2000)]);

            expect(result).toBe(local);
        });

        test('a listing past the log, known only to the archive, is capped with one recorded fill', async () => {
            seedSplit([fill(5, T1)]);
            archiveMock.rows = [logRow(5, 5)];
            await loadAndRepair();

            const { local, result } = pull(T1, [fill(5, T1), fill(5, T1 + 1), fill(5, T1 + 2)]);

            expect(result).toBe(local);
        });

        test('the loop stays stopped over reloads: a clean day reads the archive once per load and stays unchanged', async () => {
            seedSplit([fill(5, T1), fill(5, T2), fill(5, T3), fill(6, T3 + 3)]);
            LEDGER().set(LOG_KEY, [logRow(5, 10)]);
            const gist = [fill(5, T3), fill(6, T3 + 3)];
            for (let load = 1; load <= 3; load += 1) {
                await reopen();
                expect(archiveMock.reads).toBe(load);
                const { local, result } = pull(T3, gist);
                expect(result).toBe(local);
            }
        });

        test('an unreadable archive holds no caps: the pull is a plain union until a read succeeds', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            archiveMock.rows = null;
            await loadAndRepair();
            expect(tradeLedgerStore._pullCaps).toBeNull();
            const incoming = [fill(5, T1), fill(6, T1 + 1), fill(5, T1 + 2000)];
            expect(sumOf(pull(T1, incoming).result, 5)).toBe(10);

            archiveMock.rows = [];
            await tradeLedgerStore._repairOverRecorded();

            expect(sumOf(pull(T1, incoming).result, 5)).toBe(5);
        });

        test('an unreadable log holds no caps and does not count as the read', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            const real = storageMock.tryGet.getMockImplementation();
            storageMock.tryGet.mockImplementation(async (key, store) => (key === LOG_KEY ? null : real(key, store)));
            try {
                await loadAndRepair();
            } finally {
                storageMock.tryGet.mockImplementation(real);
            }
            expect(archiveMock.reads).toBe(0);
            expect(tradeLedgerStore._pullCaps).toBeNull();
            expect(sumOf(pull(T1, [fill(5, T1), fill(5, T1 + 2000)]).result, 5)).toBe(10);
        });

        test('a listing the log learned after the read has no cap until a run reads the archive again', async () => {
            seedSplit([fill(5, T1), fill(9, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();
            LEDGER().set(LOG_KEY, [logRow(5, 5), logRow(9, 5)]);
            await tradeLedgerStore._repairOverRecorded();
            expect(archiveMock.reads).toBe(1);
            expect(tradeLedgerStore._pullCaps.caps.has(9)).toBe(false);

            const { result } = pull(T1, [fill(5, T1), fill(9, T1 + 1), fill(9, T1 + 2000)]);

            expect(sumOf(result, 9)).toBe(10);
        });

        test('caps only rise: a later higher count raises a held cap and a later lower one does not lower it', async () => {
            seedSplit([fill(5, T1), fill(5, T2)]);
            LEDGER().set(LOG_KEY, [logRow(5, 10)]);
            await loadAndRepair();

            LEDGER().set(LOG_KEY, [logRow(5, 20)]);
            await tradeLedgerStore._repairOverRecorded();
            expect(tradeLedgerStore._pullCaps.caps.get(5)).toBe(20);

            LEDGER().set(LOG_KEY, [logRow(5, 15)]);
            await tradeLedgerStore._repairOverRecorded();
            expect(tradeLedgerStore._pullCaps.caps.get(5)).toBe(20);
        });

        test('a listing found open has no cap, whether a later run or the fold itself finds it', async () => {
            seedSplit([fill(5, T1), fill(8, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5), logRow(8, 5)]);
            await loadAndRepair();
            expect(tradeLedgerStore._pullCaps.caps.get(5)).toBe(5);

            await tradeLedgerStore._repairOverRecorded([{ id: 5, status: '/market_listing_status/active' }]);
            expect(tradeLedgerStore._pullCaps.caps.has(5)).toBe(false);

            dataManagerMock.listings = [{ id: 8, status: '/market_listing_status/active' }];
            const { result } = pull(T1, [fill(5, T1), fill(5, T1 + 2), fill(8, T1 + 1), fill(8, T1 + 3)]);
            expect(sumOf(result, 5)).toBe(10);
            expect(sumOf(result, 8)).toBe(10);
        });

        test('this tab having counted more than the cap keeps the rows', async () => {
            seedSplit([fill(5, T1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();
            tradeLedgerStore.states = { 5: { filledQuantity: 10 } };

            expect(sumOf(pull(T1, [fill(5, T1), fill(5, T1 + 2)]).result, 5)).toBe(10);
        });

        test.each([
            ['log', LOG_KEY, [logRow(5, 10)]],
            ['log, at a status the repair does not trust', LOG_KEY, [logRow(5, 10, 'expired')]],
            ['archive month', 'marketListingArchiveRec_market123_2026-08', [logRow(5, 10)]],
            ['baselines', 'tradeLedgerState_market123', { 5: { filledQuantity: 10 } }],
        ])('another device, its %s in the same download saying more: the fill is kept', async (_name, key, value) => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();
            const incoming = [fill(5, T1), fill(6, T1 + 1), fill(5, T1 + 2000)];

            const { local, result } = foldWith(T1, incoming, { [REC(T1)]: incoming, [key]: value });

            expect(result).not.toBe(local);
            expect(sumOf(result, 5)).toBe(10);
        });

        test("the download's count for someone else's listing or another character's key is not evidence", async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();
            const incoming = [fill(5, T1), fill(6, T1 + 1), fill(5, T1 + 2000)];

            const { local, result } = foldWith(T1, incoming, {
                [LOG_KEY]: [logRow(7, 10)],
                marketListingTimestamps_other456: [logRow(5, 10)],
                'marketListingArchiveRec_other456_2026-08': [logRow(5, 10)],
                marketListingArchiveRecTomb_market123: [logRow(5, 10)],
            });

            expect(result).toBe(local);
        });

        test('a raised cap still cuts what is past it, and a real fill of another listing stays', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            await loadAndRepair();
            const incoming = [fill(5, T1), fill(5, T1 + 2), fill(5, T1 + 3), fill(7, T1 + 4), fill(6, T1 + 1)];

            const { result } = foldWith(T1, incoming, { [LOG_KEY]: [logRow(5, 10)] });

            expect(sumOf(result, 5)).toBe(10);
            expect(sumOf(result, 7)).toBe(5);
            expect(sumOf(result, 6)).toBe(5);
        });

        test('a repair still out when the ledger is switched off holds nothing for the fold', async () => {
            seedSplit([fill(5, T1), fill(6, T1 + 1)]);
            LEDGER().set(LOG_KEY, [logRow(5, 5)]);
            tradeLedgerStore.records = [fill(5, T1), fill(6, T1 + 1)];
            tradeLedgerStore.isLoaded = true;
            dataManagerMock.characterData = {};

            const pending = tradeLedgerStore._repairOverRecorded();
            tradeLedgerStore.disable();
            await pending;

            expect(tradeLedgerStore._pullCaps).toBeNull();
        });
    });
});

/**
 * The worst failure this store can have: a fill whose baseline is stored and whose row is not. The next load diffs
 * to zero, so it is gone for good. The archive read can take 15 s, so nothing a fill's save needs may wait on it.
 */
describe('a fill is not held up by the archive read, and its baseline never lands ahead of it', () => {
    const LOG_KEY = 'marketListingTimestamps_market123';
    const T1 = DAY1 + 3600e3;
    const T2 = DAY2 + 3600e3;
    const logRow = (id, filledQuantity, extra = {}) => ({
        id,
        timestamp: T1,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: filledQuantity,
        filledQuantity,
        isSell: true,
        status: 'filled',
        ...extra,
    });
    const quantities = (id) =>
        tradeLedgerStore
            .getRecords()
            .filter((r) => r.listingId === id)
            .map((r) => r.quantity);
    const storedRows = (id) =>
        [...LEDGER().entries()]
            .filter(([key]) => key.startsWith('tradeLedgerRec_market123'))
            .flatMap(([, rows]) => rows)
            .filter((r) => r.listingId === id);
    const storedBaseline = (id) => LEDGER().get(STATE_KEY)?.[id]?.filledQuantity;
    const settle = () => vi.advanceTimersByTimeAsync(10);
    /** The switch to another character, then back to this one: a new load over what storage holds */
    const switchAwayAndBack = async () => {
        dataManagerMock.characterId = 'other77';
        await tradeLedgerStore.handleCharacterSwitch();
        await settle();
        dataManagerMock.characterId = 'market123';
        await tradeLedgerStore.handleCharacterSwitch();
        await settle();
        await tradeLedgerStore._repairChain;
        await awaitSaves();
    };

    test('load, an offline fill, the archive slow, a switch: the fill was stored and is there after', async () => {
        seedSplit([fill(6, T1)]);
        LEDGER().set(STATE_KEY, baseline3());
        dataManagerMock.characterData = {};
        dataManagerMock.listings = [listing(3, 4)];
        archiveMock.hang = true;

        await tradeLedgerStore.initialize();
        await vi.advanceTimersByTimeAsync(3100);

        // The read is still out, well inside its 15 s, and the baseline has landed
        expect(archiveMock.reads).toBe(1);
        expect(storedBaseline(3)).toBe(4);
        expect(storedRows(3).map((r) => r.quantity)).toEqual([4]);

        archiveMock.hang = false;
        await switchAwayAndBack();

        expect(quantities(3)).toEqual([4]);
        expect(storedRows(3).map((r) => r.quantity)).toEqual([4]);
        tradeLedgerStore.disable();
    });

    test('the same sequence ending in a closed page: a new load finds the row, not a diff of zero', async () => {
        seedSplit([fill(6, T1)]);
        LEDGER().set(STATE_KEY, baseline3());
        dataManagerMock.characterData = {};
        dataManagerMock.listings = [listing(3, 4)];
        archiveMock.hang = true;
        await tradeLedgerStore.initialize();
        await vi.advanceTimersByTimeAsync(3100);
        tradeLedgerStore.disable();

        // The page is gone: a new one starts from storage alone
        archiveMock.hang = false;
        tradeLedgerStore._generation += 1;
        tradeLedgerStore.records = [];
        tradeLedgerStore.states = {};
        tradeLedgerStore.isLoaded = false;
        tradeLedgerStore._pullCaps = null;
        tradeLedgerStore._recordsChain = null;
        tradeLedgerStore._statesChain = null;
        tradeLedgerStore._repairChain = null;
        await tradeLedgerStore.initialize();
        await tradeLedgerStore._repairChain;
        await awaitSaves();

        expect(quantities(3)).toEqual([4]);
        tradeLedgerStore.disable();
    });

    test('a baseline waits for the save of its fill: with that save held up and a switch, neither lands', async () => {
        LEDGER().set(STATE_KEY, baseline3());
        memory([], baseline3());
        let release;
        tradeLedgerStore._recordsChain = new Promise((resolve) => {
            release = resolve;
        });

        tradeLedgerStore.processListings([listing(3, 4)], false);
        await settle();
        expect(storedBaseline(3)).toBe(0);

        dataManagerMock.characterId = 'other77';
        await tradeLedgerStore.handleCharacterSwitch();
        release();
        await settle();
        await awaitSaves();

        // Nothing stored for this character moved, so the next load finds the same fill again
        expect(storedBaseline(3)).toBe(0);
        expect(storedRows(3)).toEqual([]);
        dataManagerMock.characterId = 'market123';
        dataManagerMock.characterData = {};
        dataManagerMock.listings = [listing(3, 4)];
        await tradeLedgerStore.handleCharacterSwitch();
        await tradeLedgerStore._repairChain;
        await awaitSaves();
        expect(quantities(3)).toEqual([4]);
        expect(storedRows(3).map((r) => r.quantity)).toEqual([4]);
        tradeLedgerStore.disable();
    });

    test('a fill save refused for an unreadable day stores no baseline for it', async () => {
        LEDGER().set(STATE_KEY, baseline3());
        memory([], baseline3());
        vi.setSystemTime(DAY3);
        const real = storageMock.tryGet.getMockImplementation();
        storageMock.tryGet.mockImplementation(async (key, store) =>
            key.startsWith('tradeLedgerRec_') ? null : real(key, store)
        );
        try {
            tradeLedgerStore.processListings([listing(3, 4)], false);
            await awaitSaves();
        } finally {
            storageMock.tryGet.mockImplementation(real);
        }
        expect(storedRows(3)).toEqual([]);
        expect(storedBaseline(3)).toBe(0);
    });

    test('a change that carries no fill does not wait on anything', async () => {
        memory([], baseline3());
        let release;
        tradeLedgerStore._recordsChain = new Promise((resolve) => {
            release = resolve;
        });

        tradeLedgerStore.processListings([listing(3, 0, { status: '/market_listing_status/filled' })], false);
        await settle();

        expect(LEDGER().get(STATE_KEY)?.[3]).toEqual({ done: true });
        release();
        await awaitSaves();
    });

    test('a fill landing during the read is counted by its baseline when the cut runs', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 10)]);
        LEDGER().set(STATE_KEY, { 5: { filledQuantity: 10, itemHrid: '/items/a', price: 100, isSell: true } });
        dataManagerMock.characterData = {};
        dataManagerMock.listings = [listing(5, 10)];
        let open;
        archiveMock.gate = new Promise((resolve) => {
            open = resolve;
        });
        await tradeLedgerStore.load();
        await settle();
        expect(archiveMock.reads).toBe(1);

        // Fills mid-read, then ends: the log still says 10
        tradeLedgerStore.processListings(
            [listing(5, 15, { status: '/market_listing_status/active' })],
            false,
            new Set([5])
        );
        await settle();
        dataManagerMock.listings = [];
        open();
        await tradeLedgerStore._repairChain;
        await awaitSaves();

        expect(quantities(5)).toEqual([5, 5, 5]);
    });

    test('a row going over its log count after the reads sends the run back to the archive first', async () => {
        seedSplit([fill(5, T1)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        archiveMock.rows = [logRow(5, 10)];
        dataManagerMock.characterData = {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        expect(archiveMock.reads).toBe(1);

        let release;
        tradeLedgerStore._recordsChain = new Promise((resolve) => {
            release = resolve;
        });
        const pending = tradeLedgerStore._repairOverRecorded();
        await settle();
        // Nothing was over at the read, so this run has not asked
        expect(archiveMock.reads).toBe(1);
        tradeLedgerStore.records = [...tradeLedgerStore.records, fill(5, T2)];
        release();
        await pending;

        expect(archiveMock.reads).toBe(2);
        expect(quantities(5)).toEqual([5, 5]);
    });

    test('with the archive still unreadable on that second ask, nothing is cut', async () => {
        seedSplit([fill(5, T1)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        dataManagerMock.characterData = {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;

        let release;
        tradeLedgerStore._recordsChain = new Promise((resolve) => {
            release = resolve;
        });
        const pending = tradeLedgerStore._repairOverRecorded();
        await settle();
        tradeLedgerStore.records = [...tradeLedgerStore.records, fill(5, T2)];
        archiveMock.rows = null;
        release();
        expect(await pending).toBe(0);

        expect(quantities(5)).toEqual([5, 5]);
    });

    test('a switch during the read: the arriving character does not wait, and the read then does nothing', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        dataManagerMock.characterData = {};
        let open;
        archiveMock.gate = new Promise((resolve) => {
            open = resolve;
        });
        await tradeLedgerStore.load();
        const departing = tradeLedgerStore._repairChain;
        await settle();
        expect(archiveMock.reads).toBe(1);

        archiveMock.gate = null;
        LEDGER().set('marketListingTimestamps_other77', [logRow(77, 5)]);
        dataManagerMock.characterId = 'other77';
        await tradeLedgerStore.handleCharacterSwitch();
        await tradeLedgerStore._repairChain;
        expect(tradeLedgerStore.repairStats()).toMatchObject({ charId: 'other77', runs: 2 });

        open();
        await departing;
        await awaitSaves();

        expect(storedRows(5)).toHaveLength(2);
        expect(tradeLedgerStore._pullCaps?.charId).toBe('other77');
        tradeLedgerStore.disable();
        dataManagerMock.characterId = 'market123';
        expect(tradeLedgerStore.repairStats().runs).toBe(0);
    });

    test('an archive that never answers gives up at the timeout, and the repair is left for a later run', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        LEDGER().set(LOG_KEY, [logRow(5, 5)]);
        dataManagerMock.characterData = {};
        archiveMock.hang = true;
        await tradeLedgerStore.load();
        await vi.advanceTimersByTimeAsync(MIGRATION_TIMEOUT_MS + 1);
        await tradeLedgerStore._repairChain;
        expect(quantities(5)).toEqual([5, 5]);
        expect(tradeLedgerStore.repairStats().runs).toBe(0);

        archiveMock.hang = false;
        await tradeLedgerStore._repairOverRecorded();
        expect(quantities(5)).toEqual([5]);
    });
});

/**
 * A doubling always has two rows. A listing no trusted log row gives a count for is cut only with two or more, so a
 * low archive count (an old retired row, an imported file) cannot take a real single fill down.
 */
describe('a listing the log has no count for is cut only with two or more rows', () => {
    const LOG_KEY = 'marketListingTimestamps_market123';
    const T1 = DAY1 + 3600e3;
    const T2 = DAY2 + 3600e3;
    const archiveRow = (id, filledQuantity, extra = {}) => ({
        id,
        timestamp: T1,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: filledQuantity,
        filledQuantity,
        isSell: true,
        status: 'filled',
        ...extra,
    });
    /** What the importer stores (`market-history-viewer.js` builds it, `estimated-listing-age.js` stamps it) */
    const importedRow = (id, filledQuantity) => archiveRow(id, filledQuantity, { importedAt: DAY2, orderQuantity: 50 });
    const big = (t) => fill(5, t, { quantity: 10, coins: 950 });
    const quantities = (id) =>
        tradeLedgerStore
            .getRecords()
            .filter((r) => r.listingId === id)
            .map((r) => r.quantity);
    const stored = (t) => structuredClone(LEDGER().get(REC(t)));
    const registration = (t) => mergeForKey('marketListings', REC(t));
    const pull = (t, incoming) => {
        const local = stored(t);
        return { local, result: registration(t).mergeForPull(local, incoming, { download: { [REC(t)]: incoming } }) };
    };
    const loadAndRepair = async () => {
        dataManagerMock.characterData ||= {};
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
    };
    const reopen = async () => {
        tradeLedgerStore.records = [];
        tradeLedgerStore.states = {};
        tradeLedgerStore.isLoaded = false;
        tradeLedgerStore._pullCaps = null;
        await loadAndRepair();
    };

    test.each([
        ['a low archive row', () => archiveRow(5, 5)],
        ['an imported low archive row', () => importedRow(5, 5)],
    ])('one row over %s stays whole, on every load, in memory and on disk', async (_name, row) => {
        seedSplit([big(T1)]);
        archiveMock.rows = [row()];

        for (let load = 0; load < 3; load += 1) {
            await reopen();
            expect(archiveMock.reads).toBe(load + 1);
            expect(quantities(5)).toEqual([10]);
            expect(stored(T1).map((r) => r.quantity)).toEqual([10]);
        }
    });

    test.each([
        ['a low archive row', () => archiveRow(5, 5)],
        ['an imported low archive row', () => importedRow(5, 5)],
    ])('one row over %s stays whole through the fold of a pull of itself', async (_name, row) => {
        seedSplit([big(T1)]);
        archiveMock.rows = [row()];
        await loadAndRepair();

        const { local, result } = pull(T1, [big(T1)]);

        expect(result).toBe(local);
        expect(result.map((r) => r.quantity)).toEqual([10]);
    });

    test('two rows over an archive count are cut, on load', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        archiveMock.rows = [archiveRow(5, 5)];

        await loadAndRepair();

        expect(quantities(5)).toEqual([5]);
    });

    test('two rows over an imported archive row stay: an imported count names nothing to cut to', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        archiveMock.rows = [importedRow(5, 5)];

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(stored(T1).map((r) => r.quantity)).toEqual([5]);
        expect(stored(T2).map((r) => r.quantity)).toEqual([5]);
    });

    test('a pull bringing a second row is cut in the fold, to what the archive says', async () => {
        seedSplit([fill(5, T1)]);
        archiveMock.rows = [archiveRow(5, 5)];
        await loadAndRepair();

        const { local, result } = pull(T1, [fill(5, T1), fill(5, T1 + 1000)]);

        expect(result).toBe(local);
    });

    test('a second row on another day counts: the fold reads the listing, not the day', async () => {
        seedSplit([fill(5, T1), fill(5, T2)]);
        archiveMock.rows = [archiveRow(5, 5)];
        await loadAndRepair();
        expect(stored(T2)).toEqual([]);

        const { local, result } = pull(T2, [fill(5, T2)]);

        expect(result).toBe(local);
    });

    test('a lone trimmed row and its untrimmed original are two rows, and the original goes', async () => {
        seedSplit([fill(5, T1, { quantity: 4, coins: 380 }), fill(5, T2, { quantity: 4, coins: 380 })]);
        archiveMock.rows = [archiveRow(5, 2)];
        await loadAndRepair();
        expect(stored(T1)).toEqual([expect.objectContaining({ trimmed: true, quantity: 2 })]);

        const { local, result } = pull(T1, [fill(5, T1, { quantity: 4, coins: 380 })]);

        expect(result).toBe(local);
    });

    test('a pull with a real fill of another listing beside the lone row keeps all of it', async () => {
        seedSplit([big(T1)]);
        archiveMock.rows = [archiveRow(5, 5)];
        await loadAndRepair();
        const fresh = fill(8, T1 + 500, { quantity: 2, coins: 190 });

        const { result } = pull(T1, [big(T1), fresh]);

        expect(result.map((r) => [r.listingId, r.quantity])).toEqual([
            [5, 10],
            [8, 2],
        ]);
    });

    test('a later run that read the archive for another listing still leaves the lone row whole', async () => {
        seedSplit([big(T1)]);
        archiveMock.rows = [archiveRow(5, 5)];
        await loadAndRepair();
        LEDGER().set(REC(T2), [fill(6, T2), fill(6, T2 + 1)]);
        tradeLedgerStore.records = [...tradeLedgerStore.records, fill(6, T2), fill(6, T2 + 1)];

        await tradeLedgerStore._repairOverRecorded();

        expect(archiveMock.reads).toBe(2);
        expect(quantities(5)).toEqual([10]);
    });

    test('a lone row whose log row is not trusted, over a low archive count, stays whole', async () => {
        seedSplit([big(T1)]);
        LEDGER().set(LOG_KEY, [archiveRow(5, 5, { status: 'expired' })]);
        archiveMock.rows = [archiveRow(5, 5)];

        await loadAndRepair();

        expect(quantities(5)).toEqual([10]);
    });

    test('a lone row over a trusted log count, nothing higher anywhere, is still trimmed: that row was asked about', async () => {
        seedSplit([big(T1)]);
        LEDGER().set(LOG_KEY, [archiveRow(5, 5)]);

        await loadAndRepair();

        expect(archiveMock.reads).toBe(1);
        expect(quantities(5)).toEqual([5]);
    });

    test('a log count arriving later lifts the rule for that listing, in the caps the fold holds', async () => {
        seedSplit([big(T1)]);
        archiveMock.rows = [archiveRow(5, 5)];
        await loadAndRepair();
        expect(tradeLedgerStore._pullCaps.archiveOnly.has(5)).toBe(true);

        LEDGER().set(LOG_KEY, [archiveRow(5, 10)]);
        await tradeLedgerStore._repairOverRecorded();

        expect(tradeLedgerStore._pullCaps.archiveOnly.has(5)).toBe(false);
        expect(tradeLedgerStore._pullCaps.caps.get(5)).toBe(10);
    });

    test('with no archive row at all a listing absent from the log has no cap, whatever its rows', async () => {
        seedSplit([fill(5, T1), fill(5, T2), fill(9, T1 + 1)]);

        await loadAndRepair();

        expect(quantities(5)).toEqual([5, 5]);
        expect(quantities(9)).toEqual([5]);
    });
});
