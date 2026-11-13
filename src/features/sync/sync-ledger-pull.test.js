/**
 * A sync pull of a trade-ledger day the over-recorded repair has already cut.
 *
 * The repair leaves no tombstone, so a gist that still holds the doubled rows hands them back. These run the
 * real store, the real registry and the real `applyPayload` end to end (only storage, the importer and the game
 * are stood in for) and look at what the pull would write: nothing, and no reload advice, when it only brings
 * back rows the repair cuts again.
 */

import { afterEach, describe, test, expect, beforeEach, vi } from 'vitest';

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
        // Sync reads whole stores through the checked read; this store's reads never come back short
        async getAllChecked(name) {
            return { ok: true, rows: await this.getAll(name) };
        },
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
const archive = vi.hoisted(() => ({ rows: [] }));
vi.mock('../market/listing-archive.js', () => ({
    ARCHIVE_PREFIX: 'marketListingArchiveRec',
    default: { read: async () => archive.rows },
}));
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
const { applyPayload, addsToRemote, exchangeBaseline, resetLeftOutLogForTests } = await import('./sync-payload.js');
const { registerSyncMerge } = await import('../../utils/sync-merge-registry.js');
const { mergeBoards, boardKey } = await import('../../utils/rank-badge-data.js');

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
    await tradeLedgerStore._repairChain;
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
    tradeLedgerStore._unsavedFills = new Map();
    tradeLedgerStore._fillWrites = new Set();
    tradeLedgerStore._statesOwed = false;
    tradeLedgerStore._repairChain = null;
    tradeLedgerStore._pullCaps = null;
    archive.rows = [];
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

describe('a pull that holds a real fill the caps did not know of', () => {
    const quantities = (rows, id) => rows.filter((row) => row.listingId === id).map((row) => row.quantity);

    test('a stale log count the archive contradicts: the fill is written, though the local total matched the log', async () => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        archive.rows = [logRow(5, 10)];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));

        await applyPayload(payloadOf({ [key]: [...structuredClone(rows), fill(5, T(10, 2000))] }));

        expect(quantities(importedPayloads[0].stores[STORE][key], 5)).toEqual([5, 5]);
    });

    test.each([
        ['ahead of', (day, log) => ({ [LOG_KEY]: log, ...day })],
        ['behind', (day, log) => ({ ...day, [LOG_KEY]: log })],
    ])('two devices: the log %s the day says more, in one download, and the fill is written', async (_name, build) => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));
        const day = { [key]: [...structuredClone(rows), fill(5, T(10, 2000))] };

        await applyPayload(payloadOf(build(day, [logRow(5, 10)])));

        expect(quantities(importedPayloads[0].stores[STORE][key], 5)).toEqual([5, 5]);
    });

    test('a retired row in the log of the download still counts, though the log fold prunes it first', async () => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));
        const old = { ...logRow(5, 10), timestamp: T(10) - 200 * 86400e3 };
        const recent = { ...logRow(99, 1), timestamp: T(10) };

        await applyPayload(
            payloadOf({ [LOG_KEY]: [old, recent], [key]: [...structuredClone(rows), fill(5, T(10, 2000))] })
        );

        expect(quantities(importedPayloads[0].stores[STORE][key], 5)).toEqual([5, 5]);
    });

    test('the same fold redone at write time keeps what the download proved', async () => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));

        await applyPayload(
            payloadOf({ [LOG_KEY]: [logRow(5, 10)], [key]: [...structuredClone(rows), fill(5, T(10, 2000))] })
        );
        const redo = importedOptions[0].folds[STORE][key];
        const landed = redo([...structuredClone(rows), fill(9, T(10, 3000))], 'the fold as first computed');

        expect(quantities(landed, 5)).toEqual([5, 5]);
        expect(quantities(landed, 9)).toEqual([5]);
    });

    test('the in-step comparison sees the same fill: a log that already landed here does not hide it', async () => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));
        // An earlier pull landed the higher log; the caps in memory have not heard
        const mine = { [key]: structuredClone(rows), [LOG_KEY]: [logRow(5, 10)] };
        const gist = { [key]: [...structuredClone(rows), fill(5, T(10, 2000))], [LOG_KEY]: [logRow(5, 10)] };

        expect(addsToRemote(payloadOf(gist), payloadOf(mine), { forUpload: false })).toBe(true);
    });

    test('nothing proves the row real: the comparison calls it no news', async () => {
        const rows = [fill(5, T(10)), fill(6, T(10, 1))];
        await repairedLedger(rows, [logRow(5, 5)]);
        const key = keyOf(T(10));
        const mine = { [key]: structuredClone(rows), [LOG_KEY]: [logRow(5, 5)] };
        const gist = { [key]: [...structuredClone(rows), fill(5, T(10, 2000))], [LOG_KEY]: [logRow(5, 5)] };

        expect(addsToRemote(payloadOf(gist), payloadOf(mine), { forUpload: false })).toBe(false);
    });
});

describe('a pull whose other days change what a listing has recorded', () => {
    const written = () => importedPayloads[0].stores[STORE];
    const unitsOf = (rows, id) => rows.filter((row) => row.listingId === id).reduce((sum, r) => sum + r.quantity, 0);
    const coinsOf = (disk, id) =>
        Object.keys(disk)
            .filter((key) => key.startsWith('tradeLedgerRec_'))
            .flatMap((key) => disk[key])
            .filter((row) => row.listingId === id)
            .reduce((sum, row) => sum + row.coins, 0);
    /** What the next page reads: the pull's write landed, and the repair ran on the whole ledger */
    const landAndReload = async () => {
        Object.assign(storeState.stores[STORE], structuredClone(written()));
        importedPayloads.length = 0;
        tradeLedgerStore.records = [];
        tradeLedgerStore.isLoaded = false;
        tradeLedgerStore._pullCaps = null;
        await tradeLedgerStore.load();
        await tradeLedgerStore._repairChain;
        await tradeLedgerStore._recordsChain;
    };
    const dayA = keyOf(T(10));
    const dayB = keyOf(T(11));
    const dayC = keyOf(T(12));
    const original = fill(5, T(10), { quantity: 10, coins: 950 });
    const trimmedCopy = { ...original, trimmed: true, quantity: 5, coins: 475 };
    const otherB = fill(6, T(11));
    const otherC = fill(7, T(12));
    const threeOnB = fill(5, T(11, 500), { quantity: 3, coins: 285 });
    const twoOnC = fill(5, T(12, 500), { quantity: 2, coins: 190 });
    const gist = () => ({
        [dayA]: [structuredClone(trimmedCopy)],
        [dayB]: [structuredClone(otherB), structuredClone(threeOnB)],
        [dayC]: [structuredClone(otherC), structuredClone(twoOnC)],
    });
    const inOrder = (keys) => Object.fromEntries(keys.map((key) => [key, gist()[key]]));

    test.each([
        ['the trimmed day first', [dayA, dayB, dayC]],
        ['the trimmed day last', [dayC, dayB, dayA]],
        ['the trimmed day between', [dayB, dayA, dayC]],
    ])('the original here, its trimmed copy and the rest of the listing there: %s', async (_name, order) => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);

        const result = await applyPayload(payloadOf(inOrder(order)));

        // The whole-ledger repair of this union keeps 5 + 3 + 2. Counting the original on other days cut both.
        // Whether the trim stands turns on rows this fold cannot promise will land, so day A keeps both copies
        expect(written()[dayA]).toEqual([original, trimmedCopy]);
        expect(written()[dayB]).toEqual([otherB, threeOnB]);
        expect(written()[dayC]).toEqual([otherC, twoOnC]);
        expect(result.merged.map((entry) => entry.key).sort()).toEqual([dayA, dayB, dayC].sort());

        // The reload's repair settles it on what landed, and the next pull of the same gist is quiet
        await landAndReload();
        expect(unitsOf(tradeLedgerStore.getRecords(), 5)).toBe(10);
        const disk = storeState.stores[STORE];
        expect(disk[dayA]).toEqual([trimmedCopy]);
        expect(disk[dayB]).toEqual([otherB, threeOnB]);
        expect(disk[dayC]).toEqual([otherC, twoOnC]);
        expect(coinsOf(disk, 5)).toBe(950);
        await applyPayload(payloadOf(gist()));
        expect(written()).toEqual({});
        await landAndReload();
        expect(disk[dayA]).toEqual([trimmedCopy]);
        expect(disk[dayB]).toEqual([otherB, threeOnB]);
    });

    test('the same the other way round: the trim here, the original and the rest of the listing there', async () => {
        await repairedLedger([trimmedCopy, otherB, otherC], [logRow(5, 10)]);
        const pulled = { ...gist(), [dayA]: [structuredClone(original)] };

        await applyPayload(payloadOf(pulled));
        expect(written()[dayA]).toEqual([trimmedCopy, original]);

        await landAndReload();
        const disk = storeState.stores[STORE];
        expect(disk[dayA]).toEqual([trimmedCopy]);
        expect(disk[dayB]).toEqual([otherB, threeOnB]);
        expect(disk[dayC]).toEqual([otherC, twoOnC]);
        await applyPayload(payloadOf(pulled));
        expect(written()).toEqual({});
    });

    test('other rows that do not make up the shortfall: the original stands and its day reads as unchanged', async () => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);

        await applyPayload(payloadOf({ [dayA]: [structuredClone(trimmedCopy)], [dayC]: [structuredClone(twoOnC)] }));

        // 5 + 2 is not 10, so the whole-ledger repair of this union keeps the original: day A reads as unchanged
        expect(Object.keys(written())).not.toContain(dayA);
    });

    test('no rows anywhere else: a trim from a low count never replaces its original', async () => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);

        await applyPayload(payloadOf({ [dayA]: [structuredClone(trimmedCopy)] }));

        expect(written()).toEqual({});
        expect(storeState.stores[STORE][dayA]).toEqual([original]);
    });

    test('a row memory and the download both hold counts once: it cannot make a low trim look justified', async () => {
        const five = fill(5, T(10));
        const twoOfIt = { ...five, trimmed: true, quantity: 2, coins: 190 };
        await repairedLedger([five, threeOnB], [logRow(5, 8)]);

        // 5 + 3 is the cap. The trim would count 2 + 3, and 2 + 3 + 3 only if the shared row were counted twice
        await applyPayload(payloadOf({ [dayA]: [twoOfIt], [dayB]: [structuredClone(threeOnB)] }));

        expect(written()).toEqual({});
    });

    test('the other days are settled by the last exchange and do not land: the fill stays whole', async () => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);
        const exchanged = payloadOf({
            [dayA]: [original],
            [dayB]: [otherB, threeOnB],
            [dayC]: [otherC, twoOnC],
        });

        await applyPayload(payloadOf(gist()), { mode: 'merge', baseline: exchangeBaseline(exchanged, exchanged) });
        expect(Object.keys(written())).not.toContain(dayB);
        expect(Object.keys(written())).not.toContain(dayC);

        await landAndReload();
        expect(unitsOf(tradeLedgerStore.getRecords(), 5)).toBe(10);
        expect(storeState.stores[STORE][dayA]).toEqual([original]);
    });

    test('the other days are below a floor and do not land: the fill stays whole', async () => {
        const last = fill(5, T(13), { quantity: 10, coins: 950 });
        const lastTrim = { ...last, trimmed: true, quantity: 5, coins: 475 };
        await repairedLedger([last], [logRow(5, 10)]);
        const floor = `tradeLedgerRecFloor_market123_${bucketOf({ t: T(13) })}`;

        await applyPayload(
            payloadOf({
                [floor]: { floor: bucketOf({ t: T(13) }) },
                [keyOf(T(13))]: [lastTrim],
                [dayB]: [structuredClone(threeOnB)],
                [dayC]: [structuredClone(twoOnC)],
            })
        );
        expect(Object.keys(written())).not.toContain(dayB);

        await landAndReload();
        expect(unitsOf(tradeLedgerStore.getRecords(), 5)).toBe(10);
        expect(storeState.stores[STORE][keyOf(T(13))]).toEqual([last]);
    });

    test('the in-step comparison sees the same: those rows are news', async () => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);
        const mine = { [dayA]: [original], [dayB]: [otherB], [dayC]: [otherC] };

        expect(addsToRemote(payloadOf(gist()), payloadOf(mine), { forUpload: false })).toBe(true);
    });

    test('the write-time redo of a fold keeps the same rows', async () => {
        await repairedLedger([original, otherB, otherC], [logRow(5, 10)]);

        await applyPayload(payloadOf(gist()));
        const redo = importedOptions[0].folds[STORE][dayB];
        const landed = redo([structuredClone(otherB), fill(9, T(11, 900))], 'the fold as first computed');

        expect(unitsOf(landed, 5)).toBe(3);
        expect(unitsOf(landed, 9)).toBe(5);
    });

    test('one listing doubled onto two days, the gist holding all of it: nothing written, nothing asked', async () => {
        const rows = [fill(5, T(10)), fill(5, T(11)), fill(5, T(12)), fill(5, T(13)), fill(6, T(13, 3))];
        await repairedLedger(rows, [logRow(5, 10)]);
        expect(storeState.stores[STORE][keyOf(T(12))]).toEqual([]);
        expect(storeState.stores[STORE][keyOf(T(13))].map((row) => row.listingId)).toEqual([6]);
        const all = {};
        for (const row of rows) (all[keyOf(row.t)] ||= []).push(structuredClone(row));

        const result = await applyPayload(payloadOf(all));

        expect(written()).toEqual({});
        expect(result.merged).toEqual([]);
    });

    test('a doubled fill back on one day, the others unchanged, is quiet with a trimmed row in the gist too', async () => {
        const row = (t) => fill(5, t, { quantity: 4, coins: 380 });
        await repairedLedger([row(T(10)), row(T(11)), row(T(12)), row(T(13))], [logRow(5, 10)]);
        const held = structuredClone(storeState.stores[STORE][keyOf(T(12))]);
        expect(held).toEqual([expect.objectContaining({ trimmed: true, quantity: 2 })]);
        expect(storeState.stores[STORE][keyOf(T(13))]).toEqual([]);

        // This device's own trim comes back beside the originals, as a gist of plain unions holds them
        const pulled = {
            [keyOf(T(10))]: [row(T(10))],
            [keyOf(T(11))]: [row(T(11))],
            [keyOf(T(12))]: [row(T(12)), ...structuredClone(held)],
            [keyOf(T(13))]: [row(T(13))],
        };
        await applyPayload(payloadOf(pulled));

        expect(written()).toEqual({});
    });

    test("a day the download lacks is still this device's: the rows held there go on counting", async () => {
        const rows = [fill(5, T(10)), fill(5, T(11)), fill(5, T(12))];
        await repairedLedger(rows, [logRow(5, 10)]);
        expect(storeState.stores[STORE][keyOf(T(12))]).toEqual([]);

        // Only the doubled day came down: read as "nothing on the other days", it would look like a real fill
        await applyPayload(payloadOf({ [keyOf(T(12))]: [structuredClone(rows[2])] }));

        expect(written()).toEqual({});
    });

    test('some days present: a listing whose trimmed copy did not come down is cut on what is held here', async () => {
        const rows = [original, otherB, otherC];
        await repairedLedger(rows, [logRow(5, 10)]);

        await applyPayload(payloadOf({ [dayB]: [structuredClone(otherB), structuredClone(threeOnB)] }));

        // The original lands nowhere new and stays 10 of 10, so this is the repair's own answer on the ledger held
        expect(written()).toEqual({});
    });

    test('a day the retention rule drops from the write is never counted against a day that lands', async () => {
        const held = [fill(5, T(11)), fill(5, T(12))];
        await repairedLedger(held, [logRow(5, 10)]);
        const stored = structuredClone(storeState.stores[STORE][keyOf(T(12))]);

        // Another device's cap evicted day 11's predecessors: day 10 is in the download and will not be written
        const floor = `tradeLedgerRecFloor_market123_${bucketOf({ t: T(11) })}`;
        await applyPayload(
            payloadOf({
                [floor]: { floor: bucketOf({ t: T(11) }) },
                [keyOf(T(10))]: [fill(5, T(10))],
                [keyOf(T(11))]: [structuredClone(held[0])],
                [keyOf(T(12))]: [structuredClone(held[1])],
            })
        );

        expect(Object.keys(written())).not.toContain(keyOf(T(10)));
        expect(written()[keyOf(T(12))] ?? stored).toEqual(stored);
        expect(stored).toHaveLength(1);
    });
});

describe('over reloads', () => {
    test('seven old days, clean on disk, stay quiet on the pull after every reload', async () => {
        const rows = [];
        for (let day = 10; day <= 16; day += 1) {
            rows.push(fill(100 + day, T(day)), fill(100 + day, T(day, 1)), fill(100 + day, T(day, 2)));
        }
        const gist = {};
        for (const row of rows) (gist[keyOf(row.t)] ||= []).push(structuredClone(row));
        // Some listings are past the log's 90 days and live only in the archive; one recorded fill each
        const inLog = [];
        const inArchive = [];
        for (let day = 10; day <= 16; day += 1) (day < 14 ? inArchive : inLog).push(logRow(100 + day, 5));
        archive.rows = inArchive;
        await repairedLedger(rows, inLog);

        for (let reload = 0; reload < 3; reload += 1) {
            importedPayloads.length = 0;
            tradeLedgerStore.records = [];
            tradeLedgerStore.isLoaded = false;
            tradeLedgerStore._pullCaps = null;
            await tradeLedgerStore.load();
            await tradeLedgerStore._repairChain;
            await tradeLedgerStore._recordsChain;

            const result = await applyPayload(payloadOf(structuredClone(gist)));

            expect(importedPayloads[0].stores[STORE]).toEqual({});
            expect(result.merged).toEqual([]);
        }
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

describe('the download goes to a registration of its own pull fold, and nowhere else', () => {
    const KEY = 'pullContextProbe';
    const local = { side: 'local' };
    const gist = { side: 'gist' };
    let remove = null;
    const registerProbe = (options) => {
        remove = registerSyncMerge({ store: STORE, key: KEY, label: 'probe', ...options });
    };
    const pull = async () => {
        storeState.stores[STORE][KEY] = structuredClone(local);
        return applyPayload(payloadOf({ [KEY]: structuredClone(gist) }));
    };
    const compare = () =>
        addsToRemote(payloadOf({ [KEY]: structuredClone(gist) }), payloadOf({ [KEY]: structuredClone(local) }), {
            forUpload: false,
        });

    afterEach(() => {
        remove?.();
        remove = null;
    });

    test.each([
        ['a pull', pull],
        ['the in-step comparison', compare],
    ])('%s hands a plain merge exactly its two arguments', async (_name, run) => {
        const merge = vi.fn((_mine, theirs) => theirs);
        registerProbe({ merge });

        await run();

        expect(merge).toHaveBeenCalled();
        for (const call of merge.mock.calls) expect(call).toHaveLength(2);
    });

    test.each([
        ['a pull', pull],
        ['the in-step comparison', compare],
    ])('%s hands a localWinsOnPull merge exactly its two arguments, turned round', async (_name, run) => {
        const merge = vi.fn((_theirs, mine) => mine);
        registerProbe({ merge, localWinsOnPull: true });

        await run();

        expect(merge).toHaveBeenCalled();
        for (const call of merge.mock.calls) expect(call).toHaveLength(2);
    });

    test('a pull hands an own pull fold the download, whole', async () => {
        const merge = vi.fn((_mine, theirs) => theirs);
        const own = vi.fn((_mine, theirs) => theirs);
        registerProbe({ merge, pull: own });

        await pull();

        expect(merge).not.toHaveBeenCalled();
        expect(own.mock.calls[0][2].download[KEY]).toEqual(gist);
    });

    test('the in-step comparison hands an own pull fold the download too', () => {
        const own = vi.fn((_mine, theirs) => theirs);
        registerProbe({ merge: vi.fn(), pull: own });

        compare();

        expect(own.mock.calls[0][2].download[KEY]).toEqual(gist);
    });

    test('the leaderboard cache survives a pull: a merge whose third parameter is `now` keeps its boards', async () => {
        const key = boardKey('standard', 'milking');
        const board = (at, name) => ({ at, source: 'local', rows: [[name, 1]] });
        registerProbe({ merge: mergeBoards });
        storeState.stores[STORE][KEY] = { [key]: board(1000, 'Mine') };

        await applyPayload(payloadOf({ [KEY]: { [key]: board(2000, 'Theirs') } }));

        const written = importedPayloads[0].stores[STORE][KEY];
        expect(written[key].at).toBe(2000);
        expect(written[key].rows).toEqual([['Theirs', 1]]);
    });
});
