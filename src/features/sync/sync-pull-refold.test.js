import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

/**
 * A key the pull read as absent, and something else stored it before the pull's write. The real `applyPayload`, the
 * real importer and the real core/storage.js over a small fake IndexedDB, with the real ledger store for the fill.
 * The worst outcome is a real fill gone for good: its baseline moved, its row under the download.
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
vi.mock('../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => () => {} },
}));
vi.mock('../market/listing-archive.js', () => ({
    ARCHIVE_PREFIX: 'marketListingArchiveRec',
    default: { read: async () => [] },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'c1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

function fakeDb(names) {
    const data = new Map(names.map((name) => [name, new Map()]));
    const db = {
        objectStoreNames: Object.assign([...names], { contains: (name) => names.includes(name) }),
        version: 99,
        data,
        close() {},
        transaction(wanted, mode = 'readonly') {
            const name = Array.isArray(wanted) ? wanted[0] : wanted;
            const backing = data.get(name);
            const map = mode === 'readwrite' ? new Map(backing) : backing;
            let aborted = false;
            const txn = {
                oncomplete: null,
                onerror: null,
                onabort: null,
                error: null,
                abort() {
                    if (aborted) return;
                    aborted = true;
                    setTimeout(() => txn.onabort?.(), 0);
                },
            };
            let open = 0;
            let scheduled = false;
            const done = () => {
                if (open === 0 && !scheduled) {
                    scheduled = true;
                    setTimeout(() => {
                        if (aborted) return;
                        if (open === 0) {
                            if (mode === 'readwrite') {
                                if (db.abortWrite === name) {
                                    db.abortWrite = null;
                                    txn.abort();
                                    return;
                                }
                                backing.clear();
                                for (const [key, value] of map) backing.set(key, value);
                            }
                            txn.oncomplete?.();
                        } else scheduled = false;
                    }, 0);
                }
            };
            const req = (fn) => {
                const r = { onsuccess: null, onerror: null, result: undefined, error: null };
                open++;
                setTimeout(() => {
                    if (aborted) return;
                    r.result = fn();
                    r.onsuccess?.({ target: r });
                    open--;
                    done();
                }, 0);
                return r;
            };
            txn.objectStore = () => ({
                get: (k) =>
                    req(() => {
                        if (mode === 'readwrite' && db.failRead === k) {
                            db.failRead = null;
                            txn.abort();
                            return undefined;
                        }
                        return map.has(k) ? structuredClone(map.get(k)) : undefined;
                    }),
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
                openCursor: () => {
                    const entries = [...map.entries()];
                    const r = { onsuccess: null, onerror: null };
                    let at = 0;
                    const step = () => {
                        open++;
                        setTimeout(() => {
                            const hit = at < entries.length;
                            const result = hit
                                ? { key: entries[at][0], value: structuredClone(entries[at][1]), continue: step }
                                : null;
                            at += 1;
                            r.onsuccess?.({ target: { result } });
                            open--;
                            done();
                        }, 0);
                    };
                    step();
                    return r;
                },
            });
            return txn;
        },
    };
    return db;
}

const { default: storage } = await import('../../core/storage.js');
const { default: store, recordKey, bucketOf } = await import('../market/trade-ledger-store.js');
const { applyPayload } = await import('./sync-payload.js');
const { importEverything } = await import('../../utils/full-backup.js');
const { registerSyncMerge } = await import('../../utils/sync-merge-registry.js');

// Waits on the real database opening, which this fake stands in for
storage.ready = Promise.resolve(true);
const STORE = 'marketListings';
const STATE_KEY = 'tradeLedgerState_c1';
const hrid = '/items/x';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const wire = (id, filled) => ({
    id,
    itemHrid: hrid,
    enhancementLevel: 0,
    filledQuantity: filled,
    orderQuantity: 10,
    price: 10,
    isSell: true,
    status: '/market_listing_status/active',
    createdTimestamp: new Date().toISOString(),
});
const baseline = (filled) => ({ filledQuantity: filled, itemHrid: hrid, enhancementLevel: 0, price: 10, isSell: true });
const qty = (rows, id) => (rows || []).filter((r) => r.listingId === id).reduce((s, r) => s + r.quantity, 0);
const pull = (entries) =>
    applyPayload(
        JSON.stringify({ formatVersion: 1, exportedAt: '2026-11-04T00:00:00.000Z', stores: { [STORE]: entries } })
    );
const REAL_PUT_ALL = storage.putAll;

let db;
let disk;
const removers = [];
const register = (options) => removers.push(registerSyncMerge({ store: STORE, ...options }));
/** Runs `act` once, between the pull's reads and its write of the store */
function beforeThePullWrites(act) {
    let ran = false;
    storage.putAll = async function (name, entries, options) {
        if (!ran && name === STORE && options?.bypassRestoreLatch) {
            ran = true;
            await act();
        }
        return REAL_PUT_ALL.call(storage, name, entries, options);
    };
}
beforeEach(() => {
    store.disable();
    store._generation += 1;
    store.records = [];
    store.states = {};
    store.isLoaded = false;
    store._loadedFor = null;
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
    db = fakeDb([STORE, 'settings']);
    storage.db = db;
    storage.available = true;
    disk = db.data.get(STORE);
    dm.listings = [];
});
afterEach(() => {
    storage.putAll = REAL_PUT_ALL;
    while (removers.length) removers.pop()?.();
});

describe('a key the pull read as absent', () => {
    test('another tab landed the day first fill and its baseline: the fill survives the pull and a reload', async () => {
        disk.set('tradeLedgerRecordsSplit_c1', { at: 1, records: 0 });
        disk.set(STATE_KEY, { 100: baseline(0) });
        dm.listings = [wire(100, 0)];
        await store.initialize();
        await sleep(80);
        await storage.flushAll();
        storage.finishRestore(new Map([[STORE, [STATE_KEY]]]));
        const day = recordKey('c1', bucketOf({ t: Date.now() }));
        expect(disk.has(day)).toBe(false);

        // The fill is this tab's, the pull another's: this tab sees no restore running
        beforeThePullWrites(async () => {
            storage._restoreInProgress = false;
            dm.listings = [wire(100, 3)];
            dm.emit('market_listings_updated', { myMarketListings: dm.listings, endMarketListings: dm.listings });
            await sleep(80);
            storage._restoreInProgress = true;
            expect(qty(disk.get(day), 100)).toBe(3);
            expect(disk.get(STATE_KEY)[100].filledQuantity).toBe(3);
        });
        await pull({ [day]: [row(301, Date.now() - 5000, 2)] });

        expect(qty(disk.get(day), 100)).toBe(3);
        expect(qty(disk.get(day), 301)).toBe(2);

        await storage.closeForTeardown('pagehide');
        await sleep(80);
        storage.cleanupPendingWrites();
        storage._restorePendingKeys.clear();
        storage._restorePendingStores.clear();
        storage._closingForTeardown = false;
        storage.db = db;
        storage.available = true;
        await store.handleCharacterSwitch();
        await sleep(80);
        expect(qty(store.getRecords(), 100)).toBe(3);
        expect(qty(store.getRecords(), 301)).toBe(2);
    });

    test('still absent at the write: the plain write it was, counted as written whole and not as a fold', async () => {
        const key = 'tradeLedgerState_c2';
        const download = { 5: baseline(2), 6: baseline(1) };

        const result = await pull({ [key]: download });

        expect(disk.get(key)).toEqual(download);
        expect(result.restored[STORE]).toBe(1);
        expect(result.merged).toEqual([]);
        expect(result.writtenWholeKeys).toEqual([{ store: STORE, key }]);
    });

    test('a plain registered merge takes what appeared, and the write still counts once', async () => {
        const key = 'tradeLedgerState_c2';
        beforeThePullWrites(() => disk.set(key, { 5: baseline(4), 7: baseline(9) }));

        const result = await pull({ [key]: { 5: baseline(2), 6: baseline(1) } });

        expect(disk.get(key)).toEqual({ 5: baseline(4), 6: baseline(1), 7: baseline(9) });
        expect(result.restored[STORE]).toBe(1);
        expect(result.complete).toBe(true);
    });

    test('a record with a pull fold gets that fold, with the download beside it', async () => {
        const pulled = vi.fn((local, incoming, context) => ({
            local,
            incoming,
            sawDownload: Object.keys(context.download),
        }));
        register({ key: 'refoldTestPull', merge: (a) => a, pull: pulled, label: 'test' });
        beforeThePullWrites(() => disk.set('refoldTestPull', { mine: 1 }));

        await pull({ refoldTestPull: { theirs: 2 } });

        expect(pulled).toHaveBeenCalledTimes(1);
        expect(disk.get('refoldTestPull')).toEqual({
            local: { mine: 1 },
            incoming: { theirs: 2 },
            sawDownload: ['refoldTestPull'],
        });
    });

    test('a deletion recorded by what appeared stays deleted', async () => {
        register({
            key: 'refoldTestGraves',
            merge: (local, incoming) => {
                const gone = new Set([...(local.gone || []), ...(incoming.gone || [])]);
                const rows = [...new Set([...local.rows, ...incoming.rows])].filter((id) => !gone.has(id));
                return { rows, gone: [...gone] };
            },
            label: 'test',
        });
        beforeThePullWrites(() => disk.set('refoldTestGraves', { rows: [1], gone: [7] }));

        await pull({ refoldTestGraves: { rows: [7, 8], gone: [] } });

        expect(disk.get('refoldTestGraves')).toEqual({ rows: [1, 8], gone: [7] });
    });

    test('a merge that throws on what appeared holds the local copy and reports an incomplete pull', async () => {
        register({
            key: 'refoldTestThrows',
            merge: () => {
                throw new Error('cannot combine');
            },
            label: 'test',
        });
        beforeThePullWrites(() => disk.set('refoldTestThrows', { mine: 1 }));

        const result = await pull({ refoldTestThrows: { theirs: 2 } });

        expect(disk.get('refoldTestThrows')).toEqual({ mine: 1 });
        expect(result.complete).toBe(false);
        expect(result.mergeFailed).toEqual([{ store: STORE, key: 'refoldTestThrows', label: 'test' }]);
        expect(result.mergeHeld).toEqual(result.mergeFailed);
        expect(result.writtenWholeKeys).toEqual([]);
        expect(result.latchedKeys).toEqual([]);
    });

    test('a key with no registered merge keeps the whole-key write', async () => {
        beforeThePullWrites(() => disk.set('refoldTestPlain', { mine: 1 }));

        await pull({ refoldTestPlain: { theirs: 2 } });

        expect(disk.get('refoldTestPlain')).toEqual({ theirs: 2 });
    });

    test('a backup restore still replaces a registered key: it means to, and it never merges', async () => {
        const key = 'tradeLedgerState_c2';
        disk.set(key, { 5: baseline(4) });

        const { complete } = await importEverything({
            formatVersion: 1,
            exportedAt: '2026-11-04T00:00:00.000Z',
            stores: { [STORE]: { [key]: { 6: baseline(1) } } },
        });

        expect(complete).toBe(true);
        expect(disk.get(key)).toEqual({ 6: baseline(1) });
    });
});

const { wholeKeyHashes, exchangeBaseline, RESTORED_BASELINE } = await import('./sync-payload.js');
const { buildPullSummary } = await import('./pull-summary.js');
await import('../combat-sim/sim-sync-keys.js');
const labKey = 'labSimUpgradeDimensions_c1';
const pack = (value) => JSON.stringify({ formatVersion: 1, stores: { settings: { [labKey]: value } } });
const oldDownload = ['equipment'];
const nextTabEdit = ['equipment', 'ability_level'];
function beforeSettingsWrite(value) {
    let ran = false;
    storage.putAll = async function (name, entries, options) {
        if (!ran && name === 'settings' && options?.bypassRestoreLatch) {
            ran = true;
            if (value === undefined) db.data.get('settings').delete(labKey);
            else db.data.get('settings').set(labKey, structuredClone(value));
        }
        return REAL_PUT_ALL.call(storage, name, entries, options);
    };
}

describe('#792 baseline policy at the write transaction', () => {
    test.each(
        ['absent', 'null', 'present'].flatMap((initial) => ['settled', 'asymmetric'].map((base) => ({ initial, base })))
    )(
        '$base: $initial at the probe keeps a changed local choice recreated before the write',
        async ({ initial, base }) => {
            const settings = db.data.get('settings');
            if (initial !== 'absent') settings.set(labKey, initial === 'null' ? null : ['ability_swap']);
            beforeSettingsWrite(nextTabEdit);
            const baseline =
                base === 'settled'
                    ? wholeKeyHashes(pack(oldDownload))
                    : exchangeBaseline(pack(oldDownload), pack(['ability_swap']));
            const result = await applyPayload(pack(oldDownload), { mode: 'merge', baseline });
            expect(settings.get(labKey)).toEqual(nextTabEdit);
            expect(result.complete).toBe(true);
            if (initial !== 'present' || base !== 'settled')
                expect(JSON.parse(result.applied).stores.settings[labKey]).toEqual(nextTabEdit);
        }
    );
    test.each(['absent', 'null', 'present'])(
        '%s: a changed download wins the ordinary registered tie',
        async (initial) => {
            if (initial !== 'absent') db.data.get('settings').set(labKey, initial === 'null' ? null : ['old']);
            beforeSettingsWrite(nextTabEdit);
            await applyPayload(pack(['ability_swap']), { mode: 'merge', baseline: wholeKeyHashes(pack(oldDownload)) });
            expect(db.data.get('settings').get(labKey)).toEqual(['ability_swap']);
        }
    );

    test.each([undefined, null])(
        'a settled key still absent at the transaction takes the download (%s)',
        async (value) => {
            beforeSettingsWrite(value);
            const result = await applyPayload(pack(oldDownload), {
                mode: 'merge',
                baseline: wholeKeyHashes(pack(oldDownload)),
            });
            expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
            expect(result.merged).toEqual([]);
            expect(result.writtenWholeKeys).toContainEqual({ store: 'settings', key: labKey });
        }
    );
    test('the asymmetric local half unchanged at write time takes the gist side', async () => {
        beforeSettingsWrite(['ability_swap']);
        await applyPayload(pack(oldDownload), {
            mode: 'merge',
            baseline: exchangeBaseline(pack(oldDownload), pack(['ability_swap'])),
        });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('an explicit pull still chooses the downloaded choice', async () => {
        beforeSettingsWrite(nextTabEdit);
        await applyPayload(pack(oldDownload), { baseline: wholeKeyHashes(pack(oldDownload)) });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('a held-key retry keeps its plain pull policy', async () => {
        beforeSettingsWrite(nextTabEdit);
        await applyPayload(pack(oldDownload), {
            mode: 'merge',
            baseline: wholeKeyHashes(pack(oldDownload)),
            retryHeld: true,
            heldKeys: [{ store: 'settings', key: labKey }],
        });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('a restored key still uses the ordinary fold after it is recreated', async () => {
        beforeSettingsWrite(nextTabEdit);
        await applyPayload(pack(oldDownload), {
            mode: 'merge',
            baseline: {
                ...wholeKeyHashes(pack(oldDownload)),
                [RESTORED_BASELINE]: { at: 1, keys: { settings: [labKey] } },
            },
        });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('an unknown local baseline half does not claim the recreated edit is newer', async () => {
        beforeSettingsWrite(nextTabEdit);
        const baseline = Object.fromEntries(
            Object.entries(wholeKeyHashes(pack(oldDownload))).map(([id, gist]) => [id, { gist, local: null }])
        );
        await applyPayload(pack(oldDownload), { mode: 'merge', baseline });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('a held retry without named keys still uses its plain fold', async () => {
        beforeSettingsWrite(nextTabEdit);
        await applyPayload(pack(oldDownload), {
            mode: 'merge',
            baseline: wholeKeyHashes(pack(oldDownload)),
            retryHeld: true,
        });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
    });
    test('a custom pull fold retains its context and direction under an asymmetric baseline', async () => {
        const key = 'refoldCustomBaseline';
        const wrap = (value) => JSON.stringify({ formatVersion: 1, stores: { [STORE]: { [key]: value } } });
        const custom = vi.fn((local, incoming, context) => ({ local, incoming, download: context.download[key] }));
        register({ key, merge: (_a, b) => b, pull: custom });
        beforeThePullWrites(() => disk.set(key, { edited: true }));
        await applyPayload(wrap({ remote: true }), {
            mode: 'merge',
            baseline: exchangeBaseline(wrap({ remote: true }), wrap({ old: true })),
        });
        expect(custom).toHaveBeenCalledTimes(1);
        expect(disk.get(key)).toEqual({
            local: { edited: true },
            incoming: { remote: true },
            download: { remote: true },
        });
    });
    test('an existing local-wins registration still wins after an absent probe', async () => {
        const key = 'refoldLocalWins';
        register({ key, merge: (_a, b) => b, localWinsOnPull: true });
        beforeThePullWrites(() => disk.set(key, { edited: true }));
        await pull({ [key]: { remote: true } });
        expect(disk.get(key)).toEqual({ edited: true });
    });
});

describe('strict refolds and committed pull reports', () => {
    test.each(['throws', 'undefined'])(
        'an initially successful fold that later %s rolls back its whole store',
        async (failure) => {
            const key = 'refoldLateFailure';
            register({
                key,
                merge: (local, incoming) => {
                    if (local.bad) {
                        if (failure === 'throws') throw new Error('cannot merge the new copy');
                        return undefined;
                    }
                    return { ...local, ...incoming };
                },
            });
            disk.set(key, { mine: 1 });
            disk.set('refoldCompanion', { keep: 1 });
            beforeThePullWrites(() => disk.set(key, { mine: 2, bad: true }));
            const result = await applyPayload(
                JSON.stringify({
                    formatVersion: 1,
                    stores: {
                        [STORE]: { refoldCompanion: { replace: 2 }, [key]: { theirs: 3 } },
                        settings: { [labKey]: oldDownload },
                    },
                })
            );
            expect(disk.get(key)).toEqual({ mine: 2, bad: true });
            expect(disk.get('refoldCompanion')).toEqual({ keep: 1 });
            expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
            expect(result.complete).toBe(false);
            expect(result.restored).toEqual({ [STORE]: 0, settings: 1 });
            expect(result.mergeFailed).toContainEqual(expect.objectContaining({ key }));
            expect(result.mergeHeld).toContainEqual(expect.objectContaining({ key }));
            expect(result.merged).toEqual([]);
            expect(result.writtenWholeKeys).toEqual([{ store: 'settings', key: labKey }]);
            expect(result.latchedKeys.some((entry) => entry.store === STORE)).toBe(false);
            const summary = buildPullSummary(result);
            expect(summary.overwritten).toBe(0);
            expect(summary.writtenWhole).toBe(1);
        }
    );
    test.each([false, true])(
        'a failed refold stays safe when retried after reload (retry marker: %s)',
        async (withMarker) => {
            const key = 'refoldRetryFailure';
            register({
                key,
                merge: (local, incoming) => {
                    if (local.bad) throw new Error('cannot merge this copy');
                    return { ...local, ...incoming };
                },
            });
            disk.set(key, { mine: 1 });
            disk.set('refoldCompanion', { keep: 1 });
            beforeThePullWrites(() => disk.set(key, { mine: 2, bad: true }));
            const downloaded = JSON.stringify({
                formatVersion: 1,
                stores: {
                    [STORE]: { [key]: { theirs: 3 }, refoldCompanion: { deleted: true } },
                },
            });
            const first = await applyPayload(downloaded);
            expect(first.complete).toBe(false);
            storage.putAll = REAL_PUT_ALL;
            storage._restorePendingKeys.clear();
            storage._restorePendingStores.clear();
            const second = await applyPayload(
                downloaded,
                withMarker
                    ? {
                          mode: 'merge',
                          retryHeld: true,
                          heldKeys: first.mergeHeld,
                      }
                    : {}
            );
            expect(disk.get(key)).toEqual({ mine: 2, bad: true });
            expect(disk.get('refoldCompanion')).toEqual({ keep: 1 });
            expect(second.complete).toBe(false);
            expect(second.mergeHeld).toContainEqual(expect.objectContaining({ key }));
            expect(second.restored[STORE]).toBe(0);
            expect(second.expected[STORE]).toBe(2);
            expect(second.merged).toEqual([]);
            expect(second.writtenWholeKeys).toEqual([]);
            expect(second.latchedKeys).toEqual([]);
        }
    );
    test('an initial merge failure holds same-store companion tombstones and permits another store', async () => {
        const key = 'refoldInitialFailure';
        register({
            key,
            merge: () => {
                throw new Error('unreadable record');
            },
        });
        disk.set(key, { mine: true });
        disk.set('refoldCompanion', { keep: true });
        const result = await applyPayload(
            JSON.stringify({
                formatVersion: 1,
                stores: {
                    [STORE]: { [key]: { remote: true }, refoldCompanion: { deleted: true } },
                    settings: { [labKey]: oldDownload },
                },
            })
        );
        expect(disk.get(key)).toEqual({ mine: true });
        expect(disk.get('refoldCompanion')).toEqual({ keep: true });
        expect(db.data.get('settings').get(labKey)).toEqual(oldDownload);
        expect(result.complete).toBe(false);
        expect(result.restored).toEqual({ [STORE]: 0, settings: 1 });
        expect(result.writtenWholeKeys).toEqual([{ store: 'settings', key: labKey }]);
    });
    test('a successful write-time union is reported as combined with committed counts and applied text', async () => {
        const key = 'tradeLedgerState_c2';
        beforeThePullWrites(() => disk.set(key, { 5: baseline(4), 7: baseline(9) }));
        const result = await pull({ [key]: { 5: baseline(2), 6: baseline(1) } });
        expect(result.merged).toContainEqual(
            expect.objectContaining({ key, counts: { local: 2, pulled: 2, merged: 3 } })
        );
        expect(result.writtenWholeKeys).not.toContainEqual({ store: STORE, key });
        expect(JSON.parse(result.applied).stores[STORE][key]).toEqual(disk.get(key));
    });
    test('a present value changed after the probe reports the transaction copy, not the stale fold', async () => {
        const key = 'tradeLedgerState_c2';
        disk.set(key, { 5: baseline(1) });
        beforeThePullWrites(() => disk.set(key, { 5: baseline(4), 7: baseline(9) }));
        const result = await pull({ [key]: { 5: baseline(2), 6: baseline(1) } });
        expect(result.merged[0].counts).toEqual({ local: 2, pulled: 2, merged: 3 });
        expect(JSON.parse(result.applied).stores[STORE][key]).toEqual(disk.get(key));
    });
    test.each(['abort', 'read'])('a transaction %s publishes no committed keys or merged outcomes', async (failure) => {
        const key = 'tradeLedgerState_c2';
        disk.set(key, { 5: baseline(1) });
        beforeThePullWrites(() => {
            if (failure === 'abort') db.abortWrite = STORE;
            else db.failRead = key;
        });
        const result = await pull({ [key]: { 5: baseline(2), 6: baseline(1) } });
        expect(disk.get(key)).toEqual({ 5: baseline(1) });
        expect(result.complete).toBe(false);
        expect(result.merged).toEqual([]);
        expect(result.writtenWholeKeys).toEqual([]);
        expect(result.latchedKeys).toEqual([]);
    });
    test('an unrelated bulk writer retains its existing fold-failure fallback', async () => {
        disk.set('plain', { local: true });
        const count = await storage.putAll(
            STORE,
            { plain: { incoming: true } },
            {
                folds: {
                    plain: () => {
                        throw new Error('ordinary writer');
                    },
                },
            }
        );
        expect(count).toBe(1);
        expect(disk.get('plain')).toEqual({ incoming: true });
    });
});
