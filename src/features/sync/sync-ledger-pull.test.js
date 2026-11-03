/**
 * A sync pull of a trade-ledger day the over-recorded repair has already cut.
 *
 * The repair leaves no tombstone, so a gist that still holds the doubled rows hands them back. These run the
 * real store, the real registry and the real `applyPayload` end to end (only storage, the importer and the game
 * are stood in for) and look at what the pull would write: nothing, and no reload advice, when it only brings
 * back rows the repair cuts again.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {}, pending: {} }));
const importedPayloads = vi.hoisted(() => []);
const importedOptions = vi.hoisted(() => []);

const storageMock = vi.hoisted(() => {
    const FOLD_DELETE = Symbol('fold-delete');
    const map = (name) => (storeState.stores[name] ||= {});
    const has = (name, key) => Object.prototype.hasOwnProperty.call(map(name), key);
    const read = (key, name) =>
        has(name, key) ? { found: true, value: structuredClone(map(name)[key]) } : { found: false, value: null };
    return {
        FOLD_DELETE,
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => structuredClone(map(name)),
        get: async (key, name, fallback = null) => (has(name, key) ? structuredClone(map(name)[key]) : fallback),
        tryGet: async (key, name) => read(key, name),
        tryGetMany: async (keys, name) => new Map(keys.map((key) => [key, read(key, name)])),
        tryGetAllKeys: async (name) => Object.keys(map(name)),
        getAllKeys: async (name) => Object.keys(map(name)),
        set: async (key, value, name, _immediate, options) => {
            const folded = options?.fold ? (options.fold(map(name)[key], value) ?? value) : value;
            if (folded === FOLD_DELETE) delete map(name)[key];
            else map(name)[key] = structuredClone(folded);
            return true;
        },
        delete: async (key, name) => {
            delete map(name)[key];
            return true;
        },
        putAll: async (name, entries) => {
            Object.assign(map(name), structuredClone(entries));
            return Object.keys(entries).length;
        },
        isQuotaExceeded: () => false,
        beginRestore: async () => {},
        endRestore: async () => {},
        pendingWriteCount: () => 0,
        flushAll: async () => {},
    };
});

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/settings-storage.js', () => ({ default: { reconcileKeyMigrationState: vi.fn(async () => {}) } }));
vi.mock('../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async (payload, options) => {
        importedPayloads.push(payload);
        importedOptions.push(options);
        return { restored: {}, failed: [], complete: true };
    },
    stripExcludedKeys: (_store, entries) => entries,
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../market/listing-archive.js', () => ({ default: { read: async () => [] } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: {},
        on: () => {},
        off: () => {},
        listings: [],
        getMarketListings: () => [],
        getCurrentCharacterId: () => 'market123',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => () => {} },
}));

const { default: tradeLedgerStore, recordKey, bucketOf } = await import('../market/trade-ledger-store.js');
const { applyPayload, resetLeftOutLogForTests } = await import('./sync-payload.js');

const STORE = 'marketListings';
const LOG_KEY = 'marketListingTimestamps_market123';
const DAY = (n) => Date.UTC(2026, 7, n);
const T = (n, ms = 0) => DAY(n) + 3600e3 + ms;
const keyOf = (t) => recordKey('market123', bucketOf({ t }));
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
const payloadOf = (entries) =>
    JSON.stringify({ formatVersion: 1, exportedAt: '2026-08-20T00:00:00.000Z', stores: { [STORE]: entries } });
const logRow = (id, filledQuantity) => ({
    id,
    timestamp: T(10),
    itemHrid: '/items/a',
    enhancementLevel: 0,
    price: 100,
    orderQuantity: filledQuantity,
    filledQuantity,
    isSell: true,
    status: 'filled',
});

/** Store a ledger, run the real repair on it, and return what the repair left in storage */
async function repairedLedger(rows, log) {
    const byKey = {};
    for (const row of rows) (byKey[keyOf(row.t)] ||= []).push(row);
    Object.assign(storeState.stores[STORE], byKey, {
        tradeLedgerRecordsSplit_market123: { at: 1, records: rows.length },
        [LOG_KEY]: log,
    });
    await tradeLedgerStore.load();
    await tradeLedgerStore._recordsChain;
}

beforeEach(() => {
    resetLeftOutLogForTests();
    importedPayloads.length = 0;
    importedOptions.length = 0;
    storeState.stores = { [STORE]: {}, settings: {} };
    tradeLedgerStore.records = [];
    tradeLedgerStore.states = {};
    tradeLedgerStore.isLoaded = false;
    tradeLedgerStore._legacy = false;
    tradeLedgerStore._recordsChain = null;
    tradeLedgerStore._pullCaps = null;
});

describe('a pull of ledger days the repair has cut', () => {
    test('doubled rows the gist still holds are neither written nor latched, and the real news still is', async () => {
        // Seven August days, each with a listing recorded three times over, and a stack of three on one listing
        const rows = [];
        for (let day = 10; day <= 16; day += 1) {
            rows.push(fill(100 + day, T(day), { quantity: 4 }), fill(100 + day, T(day, 1), { quantity: 4 }));
            rows.push(fill(100 + day, T(day, 2), { quantity: 4 }), fill(100 + day, T(day, 3), { quantity: 4 }));
        }
        await repairedLedger(
            rows,
            Array.from({ length: 7 }, (_, index) => logRow(110 + index, 8))
        );
        for (let day = 10; day <= 16; day += 1) {
            expect(storeState.stores[STORE][keyOf(T(day))]).toHaveLength(2);
        }
        // The gist still holds every row as first recorded, and one real fill the repair has no quarrel with
        const gist = {};
        for (const row of rows) (gist[keyOf(row.t)] ||= []).push(structuredClone(row));
        const fresh = fill(7, T(16, 9000), { quantity: 2, coins: 190 });
        gist[keyOf(fresh.t)].push(fresh);

        const result = await applyPayload(payloadOf(gist));

        // Six of the seven days brought nothing: left out of the write, not combined, not latched
        const written = importedPayloads[0].stores[STORE];
        expect(Object.keys(written)).toEqual([keyOf(T(16))]);
        expect(result.merged.map((entry) => entry.key)).toEqual([keyOf(T(16))]);
        expect(result.unchanged[STORE]).toBe(6);
        // The day that did get news holds it, and not the doubled rows
        expect(written[keyOf(T(16))].map((row) => [row.listingId, row.quantity])).toEqual([
            [116, 4],
            [116, 4],
            [7, 2],
        ]);
    });

    test('a pull of nothing but doubled rows leaves the whole store alone', async () => {
        const rows = [fill(5, T(10)), fill(5, T(11)), fill(5, T(12)), fill(6, T(12, 3))];
        await repairedLedger(rows, [logRow(5, 10)]);
        const gist = {};
        for (const row of rows) (gist[keyOf(row.t)] ||= []).push(structuredClone(row));

        const result = await applyPayload(payloadOf(gist));

        expect(importedPayloads[0].stores[STORE]).toEqual({});
        expect(result.merged).toEqual([]);
        expect(result.unchanged[STORE]).toBe(3);
    });

    test('a day the repair emptied is no change either', async () => {
        const rows = [fill(5, T(10)), fill(5, T(11)), fill(5, T(12))];
        await repairedLedger(rows, [logRow(5, 10)]);
        expect(storeState.stores[STORE][keyOf(T(12))]).toEqual([]);

        const result = await applyPayload(payloadOf({ [keyOf(T(12))]: [structuredClone(rows[2])] }));

        expect(importedPayloads[0].stores[STORE]).toEqual({});
        expect(result.merged).toEqual([]);
    });
});

describe('a pull whose write is redone against a newer stored copy', () => {
    test('the redo applies the same cut, so a save that brought the rows back does not survive the write', async () => {
        const rows = [fill(5, T(10)), fill(5, T(11)), fill(5, T(11, 1)), fill(6, T(11, 2))];
        await repairedLedger(rows, [logRow(5, 10)]);
        const key = keyOf(T(11));
        const fresh = fill(7, T(11, 9000), { quantity: 2, coins: 190 });

        await applyPayload(payloadOf({ [key]: [structuredClone(rows[1]), structuredClone(rows[3]), fresh] }));
        const redo = importedOptions[0].folds[STORE][key];
        expect(typeof redo).toBe('function');

        // Another tab saved this day, doubled rows included, between the fold's read and the write
        const newer = [rows[1], rows[2], rows[3]].map((row) => structuredClone(row));
        const landed = redo(newer, 'the fold as first computed');

        expect(landed.map((row) => [row.listingId, row.t])).toEqual([
            [5, T(11)],
            [6, T(11, 2)],
            [7, T(11, 9000)],
        ]);
    });
});
