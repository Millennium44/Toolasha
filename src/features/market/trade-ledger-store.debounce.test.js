import { vi, test, expect, beforeEach } from 'vitest';

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
        transaction(names) {
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
                        if (open === 0) txn.oncomplete?.();
                        else scheduled = false;
                    }, 0);
                }
            };
            const req = (fn) => {
                const r = { onsuccess: null, onerror: null, result: undefined };
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
                        map.set(k, structuredClone(v));
                        return k;
                    }),
                delete: (k) =>
                    req(() => {
                        map.delete(k);
                    }),
                getAllKeys: () => req(() => [...map.keys()]),
            });
            return txn;
        },
    };
    return db;
}

const { default: storage } = await import('../../core/storage.js');
const { default: store, recordKey, bucketOf } = await import('./trade-ledger-store.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
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
    store._legacy = false;
    store._pullCaps = null;
    store._writtenDays = new Map();
    store._repairChain = null;
    store._recordsChain = null;
    store._statesChain = null;
    storage.cleanupPendingWrites?.();
    storage.pendingWrites?.clear();
    storage._restorePendingKeys?.clear();
    storage._restorePendingStores?.clear();
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
