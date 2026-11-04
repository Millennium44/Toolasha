import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

/**
 * The over-recorded repair against the real core/storage.js (its debounce queue and its immediate-write
 * supersede) over a small fake IndexedDB, with the real ledger store and a mocked game and listing archive.
 * The store's own tests mock storage, which has no debounce queue, so they cannot see a queued write dropped.
 */
const dm = vi.hoisted(() => {
    const handlers = {};
    const o = {
        characterId: 'c1',
        characterData: {},
        listings: [],
        on: (e, h) => {
            (handlers[e] ||= []).push(h);
        },
        off: (e, h) => {
            handlers[e] = (handlers[e] || []).filter((x) => x !== h);
        },
        emit: (e, d) => (handlers[e] || []).map((h) => h(d)),
        getMarketListings: () => o.listings,
        getCurrentCharacterId: () => o.characterId,
        getCurrentCharacterGameMode: () => 'standard',
    };
    return o;
});
const arch = vi.hoisted(() => ({ rows: [], gate: null }));
vi.mock('../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => () => {} },
}));
vi.mock('./listing-archive.js', () => ({
    ARCHIVE_PREFIX: 'marketListingArchiveRec',
    default: {
        read: async () => {
            if (arch.gate) await arch.gate;
            return arch.rows;
        },
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'c1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

function fakeDb() {
    const data = new Map();
    const db = {
        objectStoreNames: { contains: () => true },
        version: 99,
        data,
        close() {},
        /** Stands in for storage in trouble: every transaction refused, reads and writes alike */
        broken: false,
        /** Stands in for a transaction that aborts: reads answer, no write sticks, `abort` fires instead of `complete` */
        aborting: false,
        transaction(names) {
            if (db.broken) throw new Error('the database refused the transaction');
            const name = Array.isArray(names) ? names[0] : names;
            if (!data.has(name)) data.set(name, new Map());
            const map = data.get(name);
            const txn = { oncomplete: null, onerror: null, onabort: null, error: null };
            let open = 0;
            let scheduled = false;
            const done = () => {
                if (open === 0 && !scheduled) {
                    scheduled = true;
                    setTimeout(() => {
                        if (open !== 0) scheduled = false;
                        else if (db.aborting) txn.onabort?.();
                        else txn.oncomplete?.();
                    }, 0);
                }
            };
            const req = (fn) => {
                const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                open++;
                setTimeout(() => {
                    r.result = fn();
                    r.onsuccess?.({ target: r });
                    open--;
                    done();
                }, 0);
                return r;
            };
            txn.objectStore = () => ({
                get: (k) => req(() => (map.has(k) ? structuredClone(map.get(k)) : undefined)),
                put: (v, k) =>
                    req(() => {
                        if (!db.aborting) map.set(k, structuredClone(v));
                        return k;
                    }),
                delete: (k) =>
                    req(() => {
                        if (!db.aborting) map.delete(k);
                    }),
                getAllKeys: () => req(() => [...map.keys()]),
            });
            return txn;
        },
    };
    return db;
}

const { default: storage } = await import('../../core/storage.js');
const { default: store, recordKey, bucketOf, advanceStoredBaselines } = await import('./trade-ledger-store.js');
const { mergeForKey, announceSyncPullApplied } = await import('../../utils/sync-merge-registry.js');
const STORE = 'marketListings';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hrid = '/items/x';
const row = (id, t, q) => ({
    t,
    itemHrid: hrid,
    enhancementLevel: 0,
    side: 'sell',
    quantity: q,
    price: 10,
    coins: q * 10,
    listingId: id,
});
const wire = (id, filled, status = '/market_listing_status/active', order = 10) => ({
    id,
    itemHrid: hrid,
    enhancementLevel: 0,
    filledQuantity: filled,
    orderQuantity: order,
    price: 10,
    isSell: true,
    status,
    createdTimestamp: new Date().toISOString(),
});
let db;
let disk;
const today = Date.now() - 1000;
const dayKey = (t) => recordKey('c1', bucketOf({ t }));
const qty = (rows, id) => (rows || []).filter((r) => r.listingId === id).reduce((s, r) => s + r.quantity, 0);
function seed({ day = [], log = null, states = {} } = {}) {
    disk.set('tradeLedgerRecordsSplit_c1', { at: 1, records: 0 });
    if (day.length) disk.set(dayKey(today), day);
    if (log) disk.set('marketListingTimestamps_c1', log);
    disk.set('tradeLedgerState_c1', states);
}
const baseline = (filled) => ({ filledQuantity: filled, itemHrid: hrid, enhancementLevel: 0, price: 10, isSell: true });
async function reload() {
    storage._restorePendingKeys?.clear();
    storage._restorePendingStores?.clear();
    await store.handleCharacterSwitch();
    await sleep(80);
}
beforeEach(async () => {
    store.disable();
    store._generation += 1;
    store.records = [];
    store.states = {};
    store.isLoaded = false;
    store._loadedFor = null;
    dm.characterId = 'c1';
    store._legacy = false;
    store._pullCaps = null;
    store._writtenDays = new Map();
    store._repairChain = null;
    store._recordsChain = null;
    store._statesChain = null;
    store._unsavedFills = new Map();
    store._fillWrites = new Set();
    store._statesOwed = false;
    storage.cleanupPendingWrites?.();
    storage.pendingWrites?.clear();
    storage._restorePendingKeys?.clear();
    storage._restorePendingStores?.clear();
    storage._restoreDepth = 0;
    storage._restoreInProgress = false;
    storage._closingForTeardown = false;
    db = fakeDb();
    storage.db = db;
    storage.available = true;
    db.data.set(STORE, new Map());
    disk = db.data.get(STORE);
    arch.rows = [];
    arch.gate = null;
    dm.listings = [];
    dm.characterData = {};
});

const sameDayRepair = (extra = {}) => ({
    // Listing 200 is doubled (5 + 5, the log says it filled 5) and so is repaired. Listing 100 filled 3 while the
    // page was closed: the load's snapshot records it, and its day write is still queued when the cut runs
    day: [row(200, today, 5), row(200, today + 100, 5)],
    log: [{ id: 200, status: 'filled', filledQuantity: 5 }],
    states: { 100: baseline(0) },
    ...extra,
});

test('an offline fill found at load survives a repair that cuts another listing of the same day', async () => {
    seed(sameDayRepair());
    dm.listings = [wire(100, 3)];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    const rows = disk.get(dayKey(today));
    expect(qty(rows, 100)).toBe(3);
    // The repaired listing is cut, and the cut stays cut
    expect(qty(rows, 200)).toBe(5);
    expect(qty(store.records, 200)).toBe(5);
    expect(disk.get('tradeLedgerState_c1')?.[100]?.filledQuantity).toBe(3);
    await reload();
    await storage.flushAll();
    expect(qty(store.getRecords(), 100)).toBe(3);
    expect(qty(store.getRecords(), 200)).toBe(5);
});

test('the same on a reconnect: the fill character_initialized finds is kept beside the cut', async () => {
    seed({ day: [row(200, today, 5), row(200, today + 100, 5)], states: { 100: baseline(0) } });
    dm.listings = [wire(100, 0)];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    // The log arrives after the load, so the reconnect's repair is the one that cuts
    disk.set('marketListingTimestamps_c1', [{ id: 200, status: 'filled', filledQuantity: 5 }]);
    dm.listings = [wire(100, 3)];
    dm.emit('character_initialized', { myMarketListings: dm.listings });
    await sleep(80);
    await storage.flushAll();
    const rows = disk.get(dayKey(today));
    expect(qty(rows, 100)).toBe(3);
    expect(qty(rows, 200)).toBe(5);
    await reload();
    await storage.flushAll();
    expect(qty(store.getRecords(), 100)).toBe(3);
    expect(qty(store.getRecords(), 200)).toBe(5);
});

test('a row another tab stored for the repaired day is kept too', async () => {
    seed(sameDayRepair());
    dm.listings = [wire(100, 3)];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    const other = row(300, today + 200, 2);
    disk.set(dayKey(today), [...disk.get(dayKey(today)), other]);
    await reload();
    await storage.flushAll();
    expect(qty(store.getRecords(), 300)).toBe(2);
    expect(qty(store.getRecords(), 100)).toBe(3);
});

test('an imported log row with a low count does not cut a lone real row', async () => {
    seed({
        day: [row(400, today, 500)],
        log: [{ id: 400, status: 'filled', filledQuantity: 1, importedAt: Date.now() }],
    });
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    expect(qty(disk.get(dayKey(today)), 400)).toBe(500);
    expect(qty(store.records, 400)).toBe(500);
});

test('an imported archive row with a low count does not cut two real partial fills', async () => {
    seed({ day: [row(500, today, 3), row(500, today + 100, 2)], log: [] });
    arch.rows = [{ id: 500, status: 'filled', filledQuantity: 3, importedAt: Date.now() }];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    expect(qty(disk.get(dayKey(today)), 500)).toBe(5);
    expect(qty(store.records, 500)).toBe(5);
});

test('an imported log row does not hide a real archive row: a doubling is still cut to the real count', async () => {
    seed({
        day: [row(600, today, 5), row(600, today + 100, 5)],
        log: [{ id: 600, status: 'filled', filledQuantity: 99, importedAt: Date.now() }],
    });
    arch.rows = [{ id: 600, status: 'filled', filledQuantity: 5 }];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
    expect(qty(disk.get(dayKey(today)), 600)).toBe(5);
});

test('the pull fold does not cut a lone row on an imported count either', async () => {
    seed({
        day: [row(401, today, 500)],
        log: [{ id: 401, status: 'filled', filledQuantity: 1, importedAt: Date.now() }],
    });
    await store.initialize();
    await sleep(80);
    const registration = mergeForKey(STORE, dayKey(today));
    const fold = registration.foldPull || registration.mergeForPull;
    const out = fold([], [row(401, today, 500)], { download: {} });
    expect(qty(out, 401)).toBe(500);
});

/*
 * Every way a fill can end while the page is waiting on a reload or on storage. The worst outcome is a real fill that
 * is never saved or disappears; a duplicate row is mild, since the repair cuts it once the listing ends.
 */
const REAL_PUT_ALL = storage.putAll.bind(storage);
const REAL_TRY_GET = storage.tryGet.bind(storage);
const REAL_SET = storage.set.bind(storage);
const STATE_KEY = 'tradeLedgerState_c1';
const FILLED = '/market_listing_status/filled';
const diskBaseline = (id) => disk.get(STATE_KEY)?.[id]?.filledQuantity;
const event = (listings, changed) =>
    dm.emit('market_listings_updated', { myMarketListings: listings, endMarketListings: changed });
/** The book as a fill leaves it: listing 100 at `filled`, 300 untouched, 100 gone from the book once ended */
function fillEvent(filled, status = '/market_listing_status/active') {
    const moved = wire(100, filled, status);
    dm.listings = status === FILLED ? [wire(300, 1)] : [moved, wire(300, 1)];
    event(dm.listings, [moved]);
}
async function openBook() {
    seed({ day: [row(300, today, 1)], states: { 100: baseline(0), 300: baseline(1) } });
    dm.listings = [wire(100, 0), wire(300, 1)];
    await store.initialize();
    await sleep(80);
    await storage.flushAll();
}
/** The real page close, then a new page: everything the store held in memory, and the latch, is gone */
async function closeAndOpenNewPage() {
    await storage.closeForTeardown('pagehide');
    await sleep(80);
    storage.cleanupPendingWrites();
    storage._restorePendingKeys.clear();
    storage._restorePendingStores.clear();
    storage._closingForTeardown = false;
    storage.db = db;
    storage.available = true;
    store._unsavedFills = new Map();
    store._fillWrites = new Set();
    store._statesOwed = false;
    await store.handleCharacterSwitch();
    await sleep(80);
    await storage.flushAll();
}
/** Storage answering everything except the ledger's day records: their reads and their writes both fail */
function refuseDayRecords() {
    const dayRecord = (key) => key.startsWith('tradeLedgerRec_');
    storage.tryGet = async (key, name) => (dayRecord(key) ? null : REAL_TRY_GET(key, name));
    storage.putAll = async (name, entries, options) =>
        Object.keys(entries).some(dayRecord) ? 0 : REAL_PUT_ALL(name, entries, options);
    storage.set = async (key, value, name, immediate, options) =>
        dayRecord(key) ? false : REAL_SET(key, value, name, immediate, options);
}
function allowDayRecords() {
    storage.tryGet = REAL_TRY_GET;
    storage.putAll = REAL_PUT_ALL;
    storage.set = REAL_SET;
}

describe('a fill while the reload prompt is up', () => {
    afterEach(allowDayRecords);

    test('prompt accepted: the fill is on disk before the reload and counted once after it', async () => {
        await openBook();
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));

        fillEvent(3);
        await sleep(80);

        // Not waiting on any debounce, flush or reload
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(storage.isRestorePending(STORE, dayKey(today))).toBe(true);
        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
        // What the pull put there is still there
        expect(qty(disk.get(dayKey(today)), 300)).toBe(1);
    });

    test('the listing ending during the prompt: no later snapshot could find it, and it is kept', async () => {
        await openBook();
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));

        fillEvent(10, FILLED);
        await sleep(80);
        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(10);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(10);
    });

    test('prompt dismissed, fills keep coming: each is on disk as it lands, up to the listing ending', async () => {
        await openBook();
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));

        for (const filled of [2, 3, 7]) {
            fillEvent(filled);
            await sleep(80);
            expect(qty(disk.get(dayKey(today)), 100)).toBe(filled);
        }
        fillEvent(10, FILLED);
        await sleep(80);
        await storage.flushAll();

        expect(qty(disk.get(dayKey(today)), 100)).toBe(10);
        expect(store._unsavedFills.size).toBe(0);
        expect(storage.isRestorePending(STORE, dayKey(today))).toBe(true);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(10);
    });

    test('a fill goes past the latch and nothing else does: memory from before the pull stays out', async () => {
        await openBook();
        // The pull replaced the day with another device's copy; memory still holds what it held
        store.records = [...store.records, row(555, today + 5, 4)];
        disk.set(dayKey(today), [row(301, today, 2)]);
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        const rows = disk.get(dayKey(today));
        expect(qty(rows, 100)).toBe(3);
        expect(qty(rows, 301)).toBe(2);
        expect(qty(rows, 555)).toBe(0);
        expect(qty(rows, 300)).toBe(0);
    });

    test('a latch on the whole store: the fill and its baseline land together, and it is counted once', async () => {
        await openBook();
        storage.finishRestore([STORE]);

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('with the single key still the record, the fill reaches it past a latch and the next load folds it in', async () => {
        await openBook();
        store._legacy = true;
        const single = 'tradeLedgerRecords_c1';
        disk.set(single, [row(300, today, 1)]);
        storage.finishRestore(new Map([[STORE, [single]]]));

        fillEvent(3);
        await sleep(80);
        expect(qty(disk.get(single), 100)).toBe(3);
        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(disk.has(single)).toBe(false);
    });

    test('a fill during the pull itself: a whole-key write over it, and a latch, do not take it', async () => {
        seed({ states: { 100: baseline(0) } });
        dm.listings = [wire(100, 0)];
        await store.initialize();
        await sleep(80);
        await storage.flushAll();

        await storage.beginRestore();
        dm.listings = [wire(100, 3)];
        event(dm.listings, [wire(100, 3)]);
        await sleep(80);
        // This device held no copy of the day when the pull read, so the pull's copy goes down whole
        await storage.putAll(STORE, { [dayKey(today)]: [row(301, today, 2)] }, { bypassRestoreLatch: true });
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));
        await storage.endRestore();
        expect(diskBaseline(100)).toBe(0);
        announceSyncPullApplied({ [STORE]: [dayKey(today)] });
        await sleep(80);
        await storage.flushAll();

        const rows = disk.get(dayKey(today));
        expect(qty(rows, 100)).toBe(3);
        expect(qty(rows, 301)).toBe(2);
        expect(diskBaseline(100)).toBe(3);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
    });
});

describe('a fill while storage is in trouble', () => {
    afterEach(allowDayRecords);

    test('a failed read holds nothing back, and leaves what is stored alone', async () => {
        await openBook();
        storage.tryGet = async (key, name) => (key.startsWith('tradeLedgerRec_') ? null : REAL_TRY_GET(key, name));

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 300)).toBe(1);
        expect(diskBaseline(100)).toBe(3);
    });

    test('a refused save keeps its baseline off disk through a later change that carries no fill', async () => {
        await openBook();
        refuseDayRecords();

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(0);
        expect(diskBaseline(100)).toBe(0);

        // Placing a listing: a change, and no fill
        dm.listings = [wire(100, 3), wire(300, 1), wire(101, 0)];
        event(dm.listings, [wire(101, 0)]);
        await sleep(80);
        await storage.flushAll();
        expect(diskBaseline(100)).toBe(0);

        // The page closing with the listing open and storage still refusing: the next load finds the fill again
        await storage.closeForTeardown('pagehide');
        await sleep(80);
        allowDayRecords();
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('the retry succeeding: the rows land once, then the baseline they held back, on any later event', async () => {
        await openBook();
        refuseDayRecords();
        fillEvent(3);
        await sleep(80);
        fillEvent(5);
        await sleep(80);
        expect(store._unsavedFills.get('c1').size).toBe(2);
        expect(diskBaseline(100)).toBe(0);

        allowDayRecords();
        // Nothing in this event changes a baseline: it still has to bring the two along
        event(dm.listings, []);
        await sleep(80);
        await storage.flushAll();

        const quantities = disk
            .get(dayKey(today))
            .filter((r) => r.listingId === 100)
            .map((r) => r.quantity);
        expect(quantities).toEqual([3, 2]);
        expect(diskBaseline(100)).toBe(5);
        expect(store._unsavedFills.size).toBe(0);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(5);
    });

    test('rows held across midnight land in their own days', async () => {
        await openBook();
        refuseDayRecords();
        const now = vi.spyOn(Date, 'now');
        try {
            const first = Date.UTC(2031, 0, 1, 23, 59);
            const second = Date.UTC(2031, 0, 2, 0, 1);
            now.mockReturnValue(first);
            fillEvent(3);
            await sleep(80);
            now.mockReturnValue(second);
            fillEvent(5);
            await sleep(80);
            allowDayRecords();
            event(dm.listings, []);
            await sleep(80);
            expect(qty(disk.get(dayKey(first)), 100)).toBe(3);
            expect(qty(disk.get(dayKey(second)), 100)).toBe(2);
        } finally {
            now.mockRestore();
        }
    });

    test('page closed with a row held, storage answering by then: the last write saves an ended listing', async () => {
        await openBook();
        refuseDayRecords();
        fillEvent(10, FILLED);
        await sleep(80);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(0);
        allowDayRecords();

        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(10);
    });

    test('page closed with a row held and storage still refusing: an open listing is found again', async () => {
        await openBook();
        db.broken = true;
        fillEvent(3);
        await sleep(80);
        expect(diskBaseline(100)).toBe(0);

        await storage.closeForTeardown('pagehide');
        await sleep(80);
        db.broken = false;
        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('a switch with a row held: it lands under its own character, and the arriving one gets none of it', async () => {
        await openBook();
        refuseDayRecords();
        fillEvent(10, FILLED);
        await sleep(80);

        dm.characterId = 'c2';
        disk.set('tradeLedgerRecordsSplit_c2', { at: 1, records: 0 });
        dm.listings = [wire(900, 0)];
        await store.handleCharacterSwitch();
        await sleep(80);
        expect(store.getRecords()).toEqual([]);
        expect(store._unsavedFills.get('c1').size).toBe(1);

        allowDayRecords();
        dm.listings = [wire(900, 2)];
        event(dm.listings, [wire(900, 2)]);
        await sleep(80);
        await storage.flushAll();

        const arrivingDay = recordKey('c2', bucketOf({ t: today }));
        expect(qty(disk.get(dayKey(today)), 100)).toBe(10);
        expect(qty(disk.get(arrivingDay), 100)).toBe(0);
        expect(qty(disk.get(arrivingDay), 900)).toBe(2);

        dm.characterId = 'c1';
        dm.listings = [wire(300, 1)];
        await store.handleCharacterSwitch();
        await sleep(80);
        await storage.flushAll();
        expect(qty(store.getRecords(), 100)).toBe(10);
    });

    test('back on a character whose row is still held: the ledger on screen shows it', async () => {
        await openBook();
        refuseDayRecords();
        fillEvent(10, FILLED);
        await sleep(80);

        dm.characterId = 'c2';
        dm.listings = [];
        await store.handleCharacterSwitch();
        await sleep(80);
        dm.characterId = 'c1';
        dm.listings = [wire(300, 1)];
        await store.handleCharacterSwitch();
        await sleep(80);

        expect(qty(store.getRecords(), 100)).toBe(10);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(0);
    });

    test('the ledger switched off with a row held still tries to save it', async () => {
        await openBook();
        refuseDayRecords();
        fillEvent(10, FILLED);
        await sleep(80);
        allowDayRecords();

        store.disable();
        await sleep(80);

        expect(qty(disk.get(dayKey(today)), 100)).toBe(10);
        expect(store._unsavedFills.size).toBe(0);
    });

    test('a fill found while a baseline save is reading keeps that save off disk', async () => {
        await openBook();
        let open;
        const gate = new Promise((resolve) => {
            open = resolve;
        });
        // A change with no fill starts a baseline save, and its read is held
        storage.tryGet = async (key, name) => {
            if (key === STATE_KEY) await gate;
            return REAL_TRY_GET(key, name);
        };
        dm.listings = [wire(100, 0), wire(300, 1), wire(101, 0)];
        event(dm.listings, [wire(101, 0)]);
        await sleep(80);
        // The fill arrives meanwhile, and its row cannot be written
        refuseDayRecords();
        fillEvent(3);
        await sleep(80);
        open();
        await sleep(80);
        await storage.flushAll();

        expect(diskBaseline(100)).toBe(0);
        allowDayRecords();
        event(dm.listings, []);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
    });
});

/*
 * The data manager moves its current id one macrotask before `character_switched` reaches the store, so an event
 * queued for the departing character can arrive while the id is already the arriving one's. Memory is still the
 * departing character's then. The worst outcome is a real fill that is never saved, vanishes, or lands on another
 * character; a duplicate row is mild.
 */
const { buildPlacedListing } = await import('../../__fixtures__/wire/market.js');
const c2Rows = () => [...disk.keys()].filter((key) => key.startsWith(recordKey('c2', '')));
/** A listing as the game sends it, carrying the character it belongs to */
const owned = (characterID, id, filled, status = '/market_listing_status/active') =>
    buildPlacedListing({
        id,
        characterID,
        itemHrid: hrid,
        filledQuantity: filled,
        orderQuantity: 10,
        price: 10,
        isSell: true,
        status,
        createdTimestamp: new Date().toISOString(),
    });
/** The data manager's id has moved to `next`; the event arrives before `character_switched` does */
async function eventInTheGap(next, emitEvent) {
    dm.characterId = next;
    dm.characterData = null;
    emitEvent();
    await sleep(0);
    disk.set(`tradeLedgerRecordsSplit_${next}`, { at: 1, records: 0 });
    dm.characterData = {};
    dm.listings = [];
    await store.handleCharacterSwitch();
    await sleep(80);
    await storage.flushAll();
}
async function backToC1(listings) {
    dm.characterId = 'c1';
    dm.listings = listings;
    await store.handleCharacterSwitch();
    await sleep(80);
    await storage.flushAll();
}

describe('a market event in the gap before character_switched', () => {
    test('the departing open listing fill is stored under them, once, and not under the arriving one', async () => {
        await openBook();
        await eventInTheGap('c2', () => {
            const moved = owned('c1', 100, 3);
            event([moved, owned('c1', 300, 1)], [moved]);
        });

        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(c2Rows()).toEqual([]);
        expect(diskBaseline(100)).toBe(3);
        await backToC1([wire(100, 3), wire(300, 1)]);
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('the departing listing that ended in the gap is kept: nothing could find it again', async () => {
        await openBook();
        await eventInTheGap('c2', () => {
            const ended = owned('c1', 100, 10, FILLED);
            event([owned('c1', 300, 1)], [ended]);
        });

        expect(qty(disk.get(dayKey(today)), 100)).toBe(10);
        expect(c2Rows()).toEqual([]);
        await backToC1([wire(300, 1)]);
        expect(qty(store.getRecords(), 100)).toBe(10);
    });

    test('numeric ids as the game sends them: the listing names its character by number', async () => {
        const mine = 900001;
        dm.characterId = mine;
        disk.set(`tradeLedgerRecordsSplit_${mine}`, { at: 1, records: 0 });
        disk.set(`tradeLedgerState_${mine}`, { 100: baseline(0) });
        dm.listings = [wire(100, 0)];
        await store.initialize();
        await sleep(80);
        await storage.flushAll();
        await eventInTheGap('900002', () => {
            const ended = owned(mine, 100, 4, FILLED);
            event([], [ended]);
        });
        expect(qty(disk.get(recordKey(mine, bucketOf({ t: Date.now() }))), 100)).toBe(4);
        expect(c2Rows()).toEqual([]);
        expect([...disk.keys()].filter((key) => key.includes('900002_'))).toEqual([]);
    });

    test('the arriving listing with no baseline yet is not counted from zero on anyone', async () => {
        await openBook();
        await eventInTheGap('c2', () => {
            const placed = owned('c2', 900, 40);
            event([placed], [placed]);
        });

        expect(c2Rows()).toEqual([]);
        expect(qty(disk.get(dayKey(today)), 900)).toBe(0);
        expect(qty(store.getRecords(), 900)).toBe(0);
    });

    test('a listing that names no character in the gap is not provably theirs: dropped, found again on return', async () => {
        await openBook();
        await eventInTheGap('c2', () => {
            const moved = wire(100, 3);
            event([moved], [moved]);
        });

        expect(c2Rows()).toEqual([]);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(0);
        // Still an open listing with its old baseline: their next load finds the fill
        await backToC1([wire(100, 3), wire(300, 1)]);
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('a snapshot in the gap is the arriving one and does not sweep the departing baselines', async () => {
        await openBook();
        dm.characterId = 'c2';
        store.processListings([owned('c2', 900, 0)], true);
        await sleep(80);
        await storage.flushAll();
        expect(diskBaseline(100)).toBe(0);
        expect(diskBaseline(300)).toBe(1);
        expect(store.states[100]).toBeTruthy();
        expect(c2Rows()).toEqual([]);
    });

    test('a baseline save queued before the gap runs in it: it is stored under its own character', async () => {
        await openBook();
        dm.characterId = 'c2';
        store.states = { ...store.states, 101: baseline(0) };
        await store.saveStates();
        await storage.flushAll();
        expect(disk.get(STATE_KEY)?.[101]).toBeTruthy();
        expect(disk.has('tradeLedgerState_c2')).toBe(false);
    });

    test('a records save queued before the gap stands down rather than filing their rows under the arriving one', async () => {
        await openBook();
        dm.characterId = 'c2';
        await store.saveRecords();
        await storage.flushAll();
        expect(c2Rows()).toEqual([]);
    });
});

describe('the departing-character guard never refuses a fill for good', () => {
    test('a ledger loaded before the id existed follows the id when it appears, as it always did', async () => {
        dm.characterId = null;
        disk.set('tradeLedgerRecordsSplit_default', { at: 1, records: 0 });
        disk.set('tradeLedgerState_default', { 100: baseline(0) });
        dm.listings = [];
        await store.initialize();
        await sleep(80);
        expect(store.isLoaded).toBe(true);
        dm.characterId = 'c1';
        disk.set('tradeLedgerRecordsSplit_c1', { at: 1, records: 0 });
        fillEvent(3);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
    });

    test('storage failing through the whole load still leaves the ledger recording', async () => {
        seed({ states: { 100: baseline(0) } });
        db.broken = true;
        await store.initialize();
        await sleep(80);
        db.broken = false;
        expect(store.isLoaded).toBe(true);
        fillEvent(3);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
    });

    test('a reconnect for the same character (character_initialized, no switch) records what it finds', async () => {
        await openBook();
        dm.listings = [wire(100, 3), wire(300, 1)];
        dm.emit('character_initialized', { myMarketListings: dm.listings });
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('a switch landing during the first load: the arriving character records from their own load', async () => {
        seed({ states: { 100: baseline(0) } });
        disk.set('tradeLedgerRecordsSplit_c2', { at: 1, records: 0 });
        disk.set('tradeLedgerState_c2', { 700: baseline(0) });
        const started = store.initialize();
        dm.characterId = 'c2';
        dm.characterData = {};
        dm.listings = [];
        await store.handleCharacterSwitch();
        await started;
        await sleep(80);
        expect(store.isLoaded).toBe(true);
        const moved = { ...wire(700, 5), characterID: 'c2' };
        dm.listings = [moved];
        event(dm.listings, [moved]);
        await sleep(80);
        await storage.flushAll();
        expect(qty(disk.get(recordKey('c2', bucketOf({ t: Date.now() }))), 700)).toBe(5);
        expect(qty(disk.get(dayKey(today)), 700)).toBe(0);
    });
});

/*
 * The baseline record latched as well as the day. The worst outcome is a baseline ahead of its row, which loses the fill
 * for good, and the next worst is writing over what a pull or a restore stored. A row counted twice is the mild one.
 */
describe('a fill with the baseline record latched', () => {
    afterEach(allowDayRecords);
    const latchBoth = () => storage.finishRestore(new Map([[STORE, [dayKey(today), STATE_KEY]]]));
    const latchBaseline = () => storage.finishRestore(new Map([[STORE, [STATE_KEY]]]));

    test('prompt accepted: row and entry land in one write, the rest stays as pulled, counted once', async () => {
        await openBook();
        const pulled = { 100: baseline(0), 300: { ...baseline(1), price: 77 }, 400: baseline(7) };
        disk.set(STATE_KEY, pulled);
        latchBoth();
        const batches = [];
        storage.putAll = async (name, entries, options) => {
            batches.push(Object.keys(entries));
            return REAL_PUT_ALL(name, entries, options);
        };

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        expect(batches).toEqual([[dayKey(today), STATE_KEY]]);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(disk.get(STATE_KEY)).toEqual({ ...pulled, 100: baseline(3) });
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
    });

    test('prompt dismissed for hours: each compare starts from the last move, none stalls or skips', async () => {
        await openBook();
        latchBoth();
        let total = 0;
        for (const filled of [2, 3, 7]) {
            fillEvent(filled);
            await sleep(80);
            total = filled;
            expect(diskBaseline(100)).toBe(total);
            expect(qty(disk.get(dayKey(today)), 100)).toBe(total);
        }
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(7);
    });

    test('reloaded with the listing open, and it then ends unseen: no doubled row is left behind', async () => {
        await openBook();
        latchBoth();
        fillEvent(3);
        await sleep(80);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);

        dm.listings = [wire(300, 1)];
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
    });

    test('the listing ending during the prompt, unclaimed in the book at reload: counted once', async () => {
        await openBook();
        latchBoth();
        fillEvent(4);
        await sleep(80);
        fillEvent(10, FILLED);
        await sleep(80);
        expect(disk.get(STATE_KEY)[100]).toEqual({ done: true });

        dm.listings = [wire(100, 10, FILLED), wire(300, 1)];
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(10);
    });

    test.each([
        ['higher', baseline(5)],
        ['finished', { done: true }],
    ])('a pull stored a %s entry: it stays exactly as stored and the row still lands', async (_label, stored) => {
        await openBook();
        disk.set(STATE_KEY, { 100: stored, 300: baseline(1) });
        latchBoth();

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        expect(disk.get(STATE_KEY)[100]).toEqual(stored);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(store._unsavedFills.size).toBe(0);
    });

    test('a restore older than memory: no silent advance past its rows; a duplicate is the worst of it', async () => {
        await openBook();
        fillEvent(3);
        await sleep(80);
        await storage.flushAll();
        expect(diskBaseline(100)).toBe(3);

        // Rolled back to a point where this listing had filled one
        disk.set(dayKey(today), [row(100, today, 1)]);
        disk.set(STATE_KEY, { 100: baseline(1), 300: baseline(1) });
        latchBoth();
        fillEvent(5);
        await sleep(80);
        await storage.flushAll();
        expect(diskBaseline(100)).toBe(1);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);

        await closeAndOpenNewPage();
        // 1 restored + 2 from the fill + 4 found again from the restored baseline: over, never under, the real 5
        expect(qty(store.getRecords(), 100)).toBe(7);
    });

    test('a restore older than memory, then the listing ends: the repair cuts the duplicate to the log', async () => {
        await openBook();
        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        disk.set(dayKey(today), [row(100, today, 1)]);
        disk.set(STATE_KEY, { 100: baseline(1), 300: baseline(1) });
        latchBoth();
        fillEvent(5);
        await sleep(80);
        await storage.flushAll();
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(7);

        disk.set('marketListingTimestamps_c1', [{ id: 100, status: 'filled', filledQuantity: 5 }]);
        dm.listings = [wire(300, 1)];
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(5);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(5);
    });

    test('a restore matching memory: the move is exactly the row beside it, and the sum stays right', async () => {
        await openBook();
        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        disk.set(dayKey(today), [row(100, today, 3)]);
        disk.set(STATE_KEY, { 100: baseline(3), 300: baseline(1) });
        latchBoth();
        fillEvent(5);
        await sleep(80);

        expect(diskBaseline(100)).toBe(5);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(5);
    });

    test('no baseline record stored: none is created, so a load still falls back to the old key', async () => {
        await openBook();
        disk.delete(STATE_KEY);
        storage.finishRestore([STORE]);

        fillEvent(3);
        await sleep(80);
        await storage.flushAll();

        expect(disk.has(STATE_KEY)).toBe(false);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(store._unsavedFills.size).toBe(0);
    });

    test('a listing placed and filled during the prompt moves its entry; a placement alone stays out', async () => {
        await openBook();
        latchBoth();
        dm.listings = [wire(100, 0), wire(300, 1), wire(101, 2), wire(102, 0)];
        event(dm.listings, [wire(101, 2), wire(102, 0)]);
        await sleep(80);
        await storage.flushAll();

        expect(diskBaseline(101)).toBe(2);
        expect(disk.get(STATE_KEY)[102]).toBeUndefined();
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 101)).toBe(2);
    });

    test('a transaction that aborts: neither moves, and the retry brings both, chained, in one write', async () => {
        await openBook();
        latchBoth();
        db.aborting = true;
        fillEvent(3);
        await sleep(80);
        fillEvent(5);
        await sleep(80);
        expect(disk.get(dayKey(today)).some((r) => r.listingId === 100)).toBe(false);
        expect(diskBaseline(100)).toBe(0);
        expect(store._unsavedFills.get('c1').size).toBe(2);

        db.aborting = false;
        event(dm.listings, []);
        await sleep(80);
        await storage.flushAll();

        expect(qty(disk.get(dayKey(today)), 100)).toBe(5);
        expect(diskBaseline(100)).toBe(5);
        expect(store._unsavedFills.size).toBe(0);
    });

    test('a later fill landing while an earlier one is refused: the baseline waits behind the unsaved row', async () => {
        await openBook();
        latchBaseline();
        const now = vi.spyOn(Date, 'now');
        const first = Date.UTC(2031, 0, 1, 23, 59);
        const second = Date.UTC(2031, 0, 2, 0, 1);
        storage.putAll = async (name, entries, options) =>
            dayKey(first) in entries ? 0 : REAL_PUT_ALL(name, entries, options);
        try {
            now.mockReturnValue(first);
            fillEvent(3);
            await sleep(80);
            now.mockReturnValue(second);
            fillEvent(5);
            await sleep(80);
            expect(qty(disk.get(dayKey(second)), 100)).toBe(2);
            expect(diskBaseline(100)).toBe(0);

            storage.putAll = REAL_PUT_ALL;
            event(dm.listings, []);
            await sleep(80);
            expect(qty(disk.get(dayKey(first)), 100)).toBe(3);
            // Caught up to its own row and no further: the next load finds the rest again, over and never under
            expect(diskBaseline(100)).toBe(3);
        } finally {
            now.mockRestore();
        }
    });

    test('a switch with the row held: its entry moves under its own character, not the arriving one', async () => {
        await openBook();
        disk.set('tradeLedgerState_c2', { 900: baseline(0) });
        latchBoth();
        refuseDayRecords();
        fillEvent(3);
        await sleep(80);

        dm.characterId = 'c2';
        disk.set('tradeLedgerRecordsSplit_c2', { at: 1, records: 0 });
        dm.listings = [wire(900, 0)];
        await store.handleCharacterSwitch();
        await sleep(80);
        allowDayRecords();
        event(dm.listings, []);
        store._retryUnsaved();
        await sleep(80);
        await storage.flushAll();

        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
        expect(disk.get('tradeLedgerState_c2')[100]).toBeUndefined();

        await backToC1([wire(100, 3), wire(300, 1)]);
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('the switch gap: a departing save would be refused, and the entry still moves with the row', async () => {
        await openBook();
        latchBoth();
        await eventInTheGap('c2', () => {
            const moved = owned('c1', 100, 3);
            event([moved, owned('c1', 300, 1)], [moved]);
        });

        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
        expect(c2Rows()).toEqual([]);
        await backToC1([wire(100, 3), wire(300, 1)]);
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('page close with the row held: the last write takes the entry with it, counted once', async () => {
        await openBook();
        latchBoth();
        refuseDayRecords();
        fillEvent(3);
        await sleep(80);
        allowDayRecords();

        await closeAndOpenNewPage();

        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
    });

    test('page close with storage refusing: nothing moved, and an open listing is found again', async () => {
        await openBook();
        latchBoth();
        db.broken = true;
        fillEvent(3);
        await sleep(80);
        await storage.closeForTeardown('pagehide');
        await sleep(80);
        db.broken = false;
        expect(diskBaseline(100)).toBe(0);

        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('the ledger switched off with the row held: row and entry still land together', async () => {
        await openBook();
        latchBoth();
        refuseDayRecords();
        fillEvent(3);
        await sleep(80);
        allowDayRecords();

        store.disable();
        await sleep(80);

        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(3);
        expect(store._unsavedFills.size).toBe(0);
    });

    test('a second pull running: nothing moves until it has landed, whose copy could take the row', async () => {
        await openBook();
        latchBoth();

        await storage.beginRestore();
        dm.listings = [wire(100, 3), wire(300, 1)];
        event(dm.listings, [wire(100, 3)]);
        await sleep(80);
        expect(qty(disk.get(dayKey(today)), 100)).toBe(3);
        expect(diskBaseline(100)).toBe(0);

        // This pull's copy of the day goes down whole, without the row
        await storage.putAll(STORE, { [dayKey(today)]: [row(301, today, 2)] }, { bypassRestoreLatch: true });
        latchBoth();
        await storage.endRestore();
        expect(diskBaseline(100)).toBe(0);
        announceSyncPullApplied({ [STORE]: [dayKey(today)] });
        await sleep(80);
        await storage.flushAll();

        const rows = disk.get(dayKey(today));
        expect(qty(rows, 100)).toBe(3);
        expect(qty(rows, 301)).toBe(2);
        expect(diskBaseline(100)).toBe(3);
        await closeAndOpenNewPage();
        expect(qty(store.getRecords(), 100)).toBe(3);
    });

    test('sync: the moved entry beats the old copy either way round and is a plain baseline', async () => {
        await openBook();
        latchBoth();
        fillEvent(3);
        await sleep(80);

        const { merge } = mergeForKey(STORE, STATE_KEY);
        const gist = { 100: baseline(0), 400: baseline(7) };
        for (const merged of [merge(gist, disk.get(STATE_KEY)), merge(disk.get(STATE_KEY), gist)]) {
            expect(merged[100]).toEqual(baseline(3));
            expect(merged[400]).toEqual(baseline(7));
            expect(merged[300]).toEqual(baseline(1));
        }
    });

    test('a latch on the day alone: the write stays one key, and the baseline takes its usual road', async () => {
        await openBook();
        storage.finishRestore(new Map([[STORE, [dayKey(today)]]]));
        const batches = [];
        storage.putAll = async (name, entries, options) => {
            batches.push(Object.keys(entries));
            return REAL_PUT_ALL(name, entries, options);
        };

        fillEvent(3);
        await sleep(80);

        expect(batches[0]).toEqual([dayKey(today)]);
        await storage.flushAll();
        expect(diskBaseline(100)).toBe(3);
    });
});

describe('advanceStoredBaselines', () => {
    const LEAVE = Symbol('leave');
    const move = { id: '100', from: baseline(0), to: baseline(3) };

    test.each([
        ['an array', [1]],
        ['a string', 'x'],
        ['a number', 0],
    ])('a stored %s is handed back as it is, never undefined', (_label, stored) => {
        expect(advanceStoredBaselines(stored, [move], LEAVE)).toBe(stored);
    });

    test('nothing stored answers the sentinel, and a move with an empty list changes nothing', () => {
        expect(advanceStoredBaselines(undefined, [move], LEAVE)).toBe(LEAVE);
        expect(advanceStoredBaselines(null, [move], LEAVE)).toBe(LEAVE);
        expect(advanceStoredBaselines({ 100: baseline(0) }, [], LEAVE)).toEqual({ 100: baseline(0) });
    });

    test('three moves on one listing chain, and a gap in the chain stops it behind the missing fill', () => {
        const three = [
            move,
            { id: '100', from: baseline(3), to: baseline(5) },
            { id: '100', from: baseline(5), to: { done: true } },
        ];
        expect(advanceStoredBaselines({ 100: baseline(0) }, three, LEAVE)[100]).toEqual({ done: true });
        expect(advanceStoredBaselines({ 100: baseline(0) }, three.slice(1), LEAVE)[100]).toEqual(baseline(0));
    });
});
