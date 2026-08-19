/**
 * Trade Ledger Store — persistence of fill records and listing baselines.
 *
 * The diffing itself is covered in `src/utils/trade-ledger.test.js`; this is
 * about the store not losing what it has recorded: a failed read must not
 * blank the ledger, a save must not overwrite another writer's rows, and a
 * save that cannot read first must not write at all.
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
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
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

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'market123',
    characterData: null,
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
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));

const { default: tradeLedgerStore, fillKey, mergeRecords, mergeStates } = await import('./trade-ledger-store.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');
const { LEDGER_RECORD_CAP } = await import('../../utils/trade-ledger.js');

const RECORDS_KEY = 'tradeLedgerRecords_market123';
const STATE_KEY = 'tradeLedgerState_market123';
const LEDGER = () => storageMock.storeFor('marketListings');

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

/** Set the in-memory ledger directly. */
const memory = (records, states) => {
    tradeLedgerStore.records = records;
    tradeLedgerStore.states = states;
    tradeLedgerStore.isLoaded = true;
};

const awaitSaves = async () => {
    await tradeLedgerStore._recordsChain;
    await tradeLedgerStore._statesChain;
};

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    tradeLedgerStore.records = [];
    tradeLedgerStore.states = {};
    tradeLedgerStore.isLoaded = false;
    tradeLedgerStore._recordsChain = null;
    tradeLedgerStore._statesChain = null;
    for (const fn of [storageMock.get, storageMock.set, storageMock.getJSON, storageMock.setJSON, storageMock.tryGet])
        fn.mockClear();
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
});

describe('the ledger cannot be wiped by a failed read or a stale copy', () => {
    test('a load while storage is unavailable keeps the in-memory ledger rather than blanking it', async () => {
        memory([fill(1, 1000)], { 1: { filledQuantity: 5 } });
        storageMock.unavailable = true;

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 } });
        expect(tradeLedgerStore.isLoaded).toBe(true);
    });

    test('a load folds what is stored under what is in memory', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, 1000)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 }, 2: { filledQuantity: 1 } });
        memory([fill(2, 2000)], { 2: { filledQuantity: 3 } });

        await tradeLedgerStore.load();

        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2]);
        expect(tradeLedgerStore.states).toEqual({ 1: { filledQuantity: 5 }, 2: { filledQuantity: 3 } });
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored ledger', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, 1000), fill(2, 2000)]);
        LEDGER().set(STATE_KEY, { 1: { filledQuantity: 5 } });
        // The failure mode that used to wipe ledgers: memory emptied by a
        // failed load, then a fill saves that emptiness back
        memory([], { 3: { filledQuantity: 0, itemHrid: '/items/a', enhancementLevel: 0, price: 100, isSell: true } });
        storageMock.unavailable = true;

        tradeLedgerStore.processListings([listing(3, 4)], false);
        await awaitSaves();

        expect(tradeLedgerStore.records).toHaveLength(1);
        expect(
            LEDGER()
                .get(RECORDS_KEY)
                .map((r) => r.listingId)
        ).toEqual([1, 2]);
        expect(LEDGER().get(STATE_KEY)).toEqual({ 1: { filledQuantity: 5 } });
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('a save merges what is stored under what is in memory, so rows from another writer survive', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, 1000), fill(2, 2000, { price: 1 })]);
        LEDGER().set(STATE_KEY, { 9: { filledQuantity: 2 } });
        memory([fill(2, 2000, { price: 2 })], {
            3: { filledQuantity: 0, itemHrid: '/items/a', enhancementLevel: 0, price: 100, isSell: true },
        });

        tradeLedgerStore.processListings([listing(3, 4)], false);
        await awaitSaves();

        const stored = LEDGER().get(RECORDS_KEY);
        expect(stored.map((r) => r.listingId)).toEqual([1, 2, 3]);
        // Memory's copy wins on the clash
        expect(stored.find((r) => r.listingId === 2).price).toBe(2);
        expect(tradeLedgerStore.records.map((r) => r.listingId)).toEqual([1, 2, 3]);
        expect(Object.keys(LEDGER().get(STATE_KEY)).sort()).toEqual(['3', '9']);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(4);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        LEDGER().set(RECORDS_KEY, [fill(1, 1000)]);
        memory([], {
            3: { filledQuantity: 0, itemHrid: '/items/a', enhancementLevel: 0, price: 100, isSell: true },
        });
        storageMock.unavailable = true;
        tradeLedgerStore.processListings([listing(3, 4)], false);
        await awaitSaves();
        expect(
            LEDGER()
                .get(RECORDS_KEY)
                .map((r) => r.listingId)
        ).toEqual([1]);

        storageMock.unavailable = false;
        tradeLedgerStore.processListings([listing(3, 6)], false);
        await awaitSaves();

        const stored = LEDGER().get(RECORDS_KEY);
        expect(stored.map((r) => r.listingId)).toEqual([1, 3, 3]);
        expect(stored.filter((r) => r.listingId === 3).map((r) => r.quantity)).toEqual([4, 2]);
        expect(LEDGER().get(STATE_KEY)[3].filledQuantity).toBe(6);
    });

    test('getRecords hands out copies', () => {
        memory([fill(1, 1000)], {});
        const copy = tradeLedgerStore.getRecords();
        copy[0].price = 0;
        expect(tradeLedgerStore.records[0].price).toBe(100);
    });
});
