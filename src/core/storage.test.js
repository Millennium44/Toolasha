/**
 * Tests for Storage's listStores() and putAll() (fake-indexeddb is not set up,
 * so these drive the real Storage class against a hand-rolled fake IDBDatabase),
 * and for the quota path — the one failure where a write is refused and
 * everything upstream carries on believing it recorded.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage, STORE_KEY_BUDGETS } = await import('./storage.js');

/**
 * Build a minimal fake IDBDatabase supporting only what Storage's
 * listStores()/putAll() touch: objectStoreNames and a readwrite transaction
 * whose store exposes put(). Handlers are invoked via microtasks so they
 * behave like real IDB requests firing after handler assignment.
 * @param {Array<string>} storeNames - Store names the fake database exposes
 * @param {Record<string, Record<string, *>>} [initialData] - Seed data per store
 * @returns {{db: object, dataByStore: Map<string, Map<string, *>>}} Fake db and its backing data
 */
function createFakeDb(storeNames, initialData = {}) {
    const dataByStore = new Map(storeNames.map((name) => [name, new Map(Object.entries(initialData[name] || {}))]));

    const db = {
        objectStoreNames: storeNames,
        transaction(names) {
            const storeName = names[0];
            const storeData = dataByStore.get(storeName);
            const pendingPuts = [];
            const txn = { oncomplete: null, onerror: null };

            const store = {
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    pendingPuts.push(() => {
                        if (storeData) {
                            request.result = storeData.get(key);
                            request.onsuccess?.();
                        } else {
                            request.onerror?.();
                        }
                    });
                    return request;
                },
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    pendingPuts.push(() => {
                        if (storeData) {
                            storeData.set(key, value);
                            request.onsuccess?.();
                        } else {
                            request.onerror?.();
                        }
                    });
                    return request;
                },
            };

            queueMicrotask(() => {
                for (const run of pendingPuts) run();
                queueMicrotask(() => txn.oncomplete?.());
            });

            return {
                objectStore: () => store,
                get oncomplete() {
                    return txn.oncomplete;
                },
                set oncomplete(fn) {
                    txn.oncomplete = fn;
                },
                get onerror() {
                    return txn.onerror;
                },
                set onerror(fn) {
                    txn.onerror = fn;
                },
            };
        },
    };

    return { db, dataByStore };
}

describe('Storage.listStores', () => {
    beforeEach(() => {
        storage.db = null;
    });

    test('returns every object store name in the database', async () => {
        const { db } = createFakeDb(['settings', 'dungeonRuns', 'xpHistory']);
        storage.db = db;

        const stores = await storage.listStores();

        expect(stores).toEqual(['settings', 'dungeonRuns', 'xpHistory']);
    });

    test('returns an empty array when the database is unavailable', async () => {
        storage.db = null;

        const stores = await storage.listStores();

        expect(stores).toEqual([]);
    });
});

describe('Storage.putAll', () => {
    beforeEach(() => {
        storage.db = null;
    });

    test('writes every entry to the target store in one transaction', async () => {
        const { db, dataByStore } = createFakeDb(['xpHistory']);
        storage.db = db;

        const count = await storage.putAll('xpHistory', { a: 1, b: 2, c: 3 });

        expect(count).toBe(3);
        expect(Object.fromEntries(dataByStore.get('xpHistory'))).toEqual({ a: 1, b: 2, c: 3 });
    });

    test('returns 0 and writes nothing for an empty entries object', async () => {
        const { db, dataByStore } = createFakeDb(['xpHistory']);
        storage.db = db;

        const count = await storage.putAll('xpHistory', {});

        expect(count).toBe(0);
        expect(dataByStore.get('xpHistory').size).toBe(0);
    });

    test('returns 0 when the database is unavailable', async () => {
        storage.db = null;

        const count = await storage.putAll('xpHistory', { a: 1 });

        expect(count).toBe(0);
    });
});

describe('Storage.putAll when the transaction aborts', () => {
    beforeEach(() => {
        storage.db = null;
    });

    /**
     * A database whose write transaction aborts after `writesBeforeAbort` puts.
     *
     * This is what a quota rejection looks like: `abort` fires and neither
     * `complete` nor `error` ever does, so a putAll that listens only for
     * those two never settles.
     * @param {number} writesBeforeAbort - Puts that land before the abort
     * @param {Error} [error] - The transaction error the abort carries
     * @returns {object} Fake IDBDatabase
     */
    function createAbortingDb(writesBeforeAbort, error = new Error('aborted')) {
        return {
            objectStoreNames: ['xpHistory'],
            transaction() {
                const pending = [];
                const txn = { oncomplete: null, onerror: null, onabort: null, error };
                const store = {
                    put() {
                        const request = { onsuccess: null, onerror: null };
                        pending.push(() => request.onsuccess?.());
                        return request;
                    },
                };
                queueMicrotask(() => {
                    for (const run of pending.slice(0, writesBeforeAbort)) run();
                    queueMicrotask(() => txn.onabort?.());
                });
                return {
                    objectStore: () => store,
                    get error() {
                        return txn.error;
                    },
                    set oncomplete(fn) {
                        txn.oncomplete = fn;
                    },
                    set onerror(fn) {
                        txn.onerror = fn;
                    },
                    set onabort(fn) {
                        txn.onabort = fn;
                    },
                };
            },
        };
    }

    test('settles at nothing written instead of hanging for ever', async () => {
        storage.db = createAbortingDb(2);

        const count = await Promise.race([
            storage.putAll('xpHistory', { a: 1, b: 2, c: 3 }),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 50)),
        ]);

        // Per-request onsuccess fires before the commit, so the two "written" keys were
        // rolled back with the rest. Reporting them would tell flushAll they landed.
        expect(count).toBe(0);
    });

    test('flushAll keeps an aborted key queued and tells its caller the write failed', async () => {
        storage.db = createAbortingDb(1);
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage.pendingWrites.set('xpHistory:a', {
            value: 1,
            storeName: 'xpHistory',
            resolvers: [],
            generation: 1,
        });
        const outcome = new Promise((resolve) => storage.pendingWrites.get('xpHistory:a').resolvers.push(resolve));

        await storage.flushAll();

        expect(await outcome).toBe(false);
        // Left queued with no timer, which is the requeue contract: the next flush or
        // debounced write retries it rather than the value being dropped
        expect(storage.pendingWrites.has('xpHistory:a')).toBe(true);
        expect(storage.saveDebounceTimers.has('xpHistory:a')).toBe(false);
    });

    test('a confirmed flush drops the key generation, as the debounced write does', async () => {
        const { db } = createFakeDb(['xpHistory']);
        storage.db = db;
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage.pendingWrites.set('xpHistory:a', {
            value: 1,
            storeName: 'xpHistory',
            resolvers: [],
            generation: 1,
        });
        storage._writeGeneration.set('xpHistory:a', 1);

        await storage.flushAll();

        // visibilitychange fires over and over in a session; without this the map grows
        // one entry per key written for the life of the page
        expect(storage._writeGeneration.has('xpHistory:a')).toBe(false);
        expect(storage.pendingWrites.has('xpHistory:a')).toBe(false);
    });

    test('a quota abort is reported through the quota path', async () => {
        const quotaError = new Error('full');
        quotaError.name = 'QuotaExceededError';
        storage.db = createAbortingDb(0, quotaError);
        const handled = vi.spyOn(storage, '_handleQuotaExceeded').mockImplementation(() => {});

        await storage.putAll('xpHistory', { a: 1 });

        expect(handled).toHaveBeenCalled();
        handled.mockRestore();
    });
});

describe('Storage.getMany', () => {
    beforeEach(() => {
        storage.db = null;
    });

    test('reads every key from one transaction, null where nothing is stored', async () => {
        const { db } = createFakeDb(['settings'], { settings: { a: 1, b: 'two', c: null } });
        storage.db = db;
        const transactions = vi.spyOn(db, 'transaction');

        const read = await storage.getMany(['a', 'b', 'c', 'missing'], 'settings');

        expect(transactions).toHaveBeenCalledTimes(1);
        expect(transactions).toHaveBeenCalledWith(['settings'], 'readonly');
        expect([...read.entries()]).toEqual([
            ['a', 1],
            ['b', 'two'],
            ['c', null],
            ['missing', null],
        ]);
    });

    test('returns null for every key when the database is unavailable', async () => {
        storage.db = null;

        const read = await storage.getMany(['a', 'b'], 'settings');

        expect([...read.entries()]).toEqual([
            ['a', null],
            ['b', null],
        ]);
    });

    test('an empty key list opens no transaction', async () => {
        const { db } = createFakeDb(['settings']);
        storage.db = db;
        const transactions = vi.spyOn(db, 'transaction');

        const read = await storage.getMany([], 'settings');

        expect(read.size).toBe(0);
        expect(transactions).not.toHaveBeenCalled();
    });
});

/**
 * A database whose writes are refused for space, and whose deletes still work —
 * the shape of a full origin, where freeing something is the only way out.
 * @param {*} error - The error every put reports
 * @returns {object} Fake IDBDatabase
 */
function createFullDb(error) {
    return {
        objectStoreNames: ['networthHistory'],
        transaction() {
            const txn = { oncomplete: null, onerror: null, onabort: null, error };
            const requests = [];

            const store = {
                put() {
                    const request = { onsuccess: null, onerror: null, error };
                    requests.push(() => request.onerror?.());
                    return request;
                },
                delete() {
                    const request = { onsuccess: null, onerror: null };
                    requests.push(() => request.onsuccess?.());
                    return request;
                },
            };

            queueMicrotask(() => {
                for (const run of requests) run();
                queueMicrotask(() => txn.onabort?.());
            });

            return {
                objectStore: () => store,
                get error() {
                    return error;
                },
                set oncomplete(fn) {
                    txn.oncomplete = fn;
                },
                set onerror(fn) {
                    txn.onerror = fn;
                },
                set onabort(fn) {
                    txn.onabort = fn;
                },
            };
        },
    };
}

const QUOTA_ERROR = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

describe('Storage quota handling', () => {
    let errorSpy;

    beforeEach(() => {
        storage.db = null;
        storage.clearQuotaState();
        storage._quotaFailures = 0;
        storage._quotaListeners.clear();
        errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
        storage.clearQuotaState();
        storage._quotaListeners.clear();
        storage.db = null;
    });

    test('a refused write is reported as a failure, not as a success', async () => {
        storage.db = createFullDb(QUOTA_ERROR);

        const ok = await storage._saveToIndexedDB('networth_1', [1, 2, 3], 'networthHistory');

        expect(ok).toBe(false);
        expect(storage.isQuotaExceeded()).toBe(true);
        expect(storage.diagnostics().quotaExceeded).toBe(true);
        expect(storage.diagnostics().lastQuotaTarget).toEqual({ key: 'networth_1', storeName: 'networthHistory' });
    });

    test('the listener is told once, however many writes are refused after it', async () => {
        storage.db = createFullDb(QUOTA_ERROR);
        const listener = vi.fn();
        storage.onQuotaExceeded(listener);

        await storage._saveToIndexedDB('a', [1], 'networthHistory');
        await storage._saveToIndexedDB('b', [2], 'networthHistory');
        await storage._saveToIndexedDB('c', [3], 'networthHistory');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toMatchObject({ key: 'a', storeName: 'networthHistory' });
        // Every failure is still counted, even though only the first is announced
        expect(storage.diagnostics().quotaFailures).toBe(3);
    });

    test('a write refused for some other reason is not mistaken for a full disk', async () => {
        storage.db = createFullDb(Object.assign(new Error('nope'), { name: 'ConstraintError' }));

        const ok = await storage._saveToIndexedDB('a', [1], 'networthHistory');

        expect(ok).toBe(false);
        expect(storage.isQuotaExceeded()).toBe(false);
    });

    test('deleting something lets recording resume', async () => {
        storage.db = createFullDb(QUOTA_ERROR);
        await storage._saveToIndexedDB('a', [1], 'networthHistory');
        expect(storage.isQuotaExceeded()).toBe(true);

        await storage.delete('a', 'networthHistory');

        expect(storage.isQuotaExceeded()).toBe(false);
    });

    test('the promise settles once, though both the request and the transaction fail', async () => {
        storage.db = createFullDb(QUOTA_ERROR);
        const listener = vi.fn();
        storage.onQuotaExceeded(listener);

        await storage._saveToIndexedDB('a', [1], 'networthHistory');
        // Let the transaction's abort land after the request's error
        await new Promise((r) => setTimeout(r, 0));

        expect(storage.diagnostics().quotaFailures).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

describe('Storage.estimate', () => {
    // Node only grew a global `navigator` in v21 — CI's Node 20 has none, so
    // the suite provides one rather than assuming the runtime's
    const runtimeNavigator = typeof globalThis.navigator !== 'undefined';

    beforeEach(() => {
        if (!runtimeNavigator) {
            Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
        }
    });

    afterEach(() => {
        if (runtimeNavigator) {
            delete globalThis.navigator.storage;
        } else {
            delete globalThis.navigator;
        }
        storage._lastEstimate = null;
    });

    test('reports usage, quota and the percentage between them', async () => {
        Object.defineProperty(globalThis.navigator, 'storage', {
            value: { estimate: async () => ({ usage: 25_000_000, quota: 100_000_000 }) },
            configurable: true,
        });

        const estimate = await storage.estimate();

        expect(estimate.usage).toBe(25_000_000);
        expect(estimate.quota).toBe(100_000_000);
        expect(estimate.percent).toBeCloseTo(25);
        expect(storage.lastEstimate()).toBe(estimate);
        expect(storage.diagnostics().estimate).toBe(estimate);
    });

    test('a browser that does not report is null rather than a throw', async () => {
        Object.defineProperty(globalThis.navigator, 'storage', { value: {}, configurable: true });
        expect(await storage.estimate()).toBeNull();
    });
});

describe('Storage.budgetReport', () => {
    beforeEach(() => {
        storage.db = null;
    });

    afterEach(() => {
        storage.db = null;
    });

    test('counts keys per store and flags the ones past their soft budget', async () => {
        const budget = STORE_KEY_BUDGETS.lootLogHistory;
        const keysByStore = {
            lootLogHistory: Array.from({ length: budget + 1 }, (_, i) => `k${i}`),
            settings: ['a', 'b'],
            somethingUnbudgeted: ['x'],
        };
        storage.db = { objectStoreNames: Object.keys(keysByStore) };
        vi.spyOn(storage, 'getAllKeys').mockImplementation(async (name) => keysByStore[name] || []);

        const rows = await storage.budgetReport();

        // Over-budget first, so a report that is skimmed still says the thing
        expect(rows[0]).toEqual({ storeName: 'lootLogHistory', keys: budget + 1, budget, over: true });
        const unbudgeted = rows.find((row) => row.storeName === 'somethingUnbudgeted');
        expect(unbudgeted).toEqual({ storeName: 'somethingUnbudgeted', keys: 1, budget: null, over: false });
        expect(rows.every((row) => row.storeName === 'lootLogHistory' || !row.over)).toBe(true);

        storage.getAllKeys.mockRestore();
    });
});

/**
 * The debounced write queue, tested at its one dangerous moment: the gap between
 * "the timer fired" and "IndexedDB confirmed". A write that is dropped from the
 * queue before it lands is a write that is silently lost, with no retry path.
 */
describe('Storage debounced write durability', () => {
    let saves;

    beforeEach(() => {
        vi.useFakeTimers();
        storage.db = {}; // set() only checks for truthiness before debouncing
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        saves = [];
    });

    afterEach(() => {
        vi.useRealTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        storage._saveToIndexedDB.mockRestore?.();
        storage._putAllWritten.mockRestore?.();
        storage.db = null;
    });

    /**
     * Stand in for IndexedDB, recording each attempt and answering as told.
     * @param {boolean|Function} outcome - Fixed result, or a function of the attempt
     */
    function stubSaves(outcome) {
        const answer = (attempt) => (typeof outcome === 'function' ? outcome(attempt) : outcome);

        vi.spyOn(storage, '_saveToIndexedDB').mockImplementation(async (key, value, storeName) => {
            const attempt = { key, value, storeName };
            saves.push(attempt);
            return answer(attempt);
        });

        // flushAll groups its pending writes into one bulk transaction per
        // store rather than one `set` per key, so the bulk path needs standing
        // in for too — and it reports *which* keys landed, not how many.
        vi.spyOn(storage, '_putAllWritten').mockImplementation(async (storeName, entries) => {
            const written = [];
            for (const [key, value] of Object.entries(entries)) {
                const attempt = { key, value, storeName };
                saves.push(attempt);
                if (answer(attempt)) written.push(key);
            }
            return written;
        });
    }

    /** Let the debounce timer fire and its async body settle */
    const runDebounce = () => vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 1);

    test('a write that fails stays queued instead of being dropped', async () => {
        stubSaves(false);
        storage.set('loot', [1, 2, 3], 'settings');

        await runDebounce();

        expect(saves).toHaveLength(1);
        expect(storage.pendingWrites.get('settings:loot')).toMatchObject({
            value: [1, 2, 3],
            storeName: 'settings',
        });
    });

    test('a write that succeeds leaves nothing queued behind it', async () => {
        stubSaves(true);
        const done = storage.set('loot', [1], 'settings');

        await runDebounce();

        expect(await done).toBe(true);
        expect(storage.pendingWrites.size).toBe(0);
    });

    test('a failed write tells its caller so, rather than leaving it awaiting forever', async () => {
        // Two dozen callers `await storage.set(...)`; a promise held open until some later
        // flush would hang them for the session.
        stubSaves(false);

        const done = storage.set('loot', [1], 'settings');
        await runDebounce();

        expect(await done).toBe(false);
        expect(storage.pendingWrites.has('settings:loot')).toBe(true);
    });

    test('flushAll retries the value a failed write left queued', async () => {
        stubSaves(false);
        const done = storage.set('loot', [1, 2, 3], 'settings');
        await runDebounce();
        expect(await done).toBe(false);
        expect(storage.pendingWrites.size).toBe(1);

        // The database comes back; the queued value is what gets written.
        // flushAll goes through the bulk path, so that is what comes back here.
        storage._putAllWritten.mockImplementation(async (storeName, entries) => {
            const written = [];
            for (const [key, value] of Object.entries(entries)) {
                saves.push({ key, value, storeName });
                written.push(key);
            }
            return written;
        });
        await storage.flushAll();

        expect(saves[1]).toEqual({ key: 'loot', value: [1, 2, 3], storeName: 'settings' });
        expect(storage.pendingWrites.size).toBe(0);
    });

    test('flushAll leaves a still-failing write queued rather than clearing it', async () => {
        stubSaves(false);
        const done = storage.set('loot', [1], 'settings');
        await runDebounce();

        await storage.flushAll();

        expect(await done).toBe(false);
        expect(storage.pendingWrites.has('settings:loot')).toBe(true);
    });

    test('the newest write to a key wins and the superseded timer writes nothing', async () => {
        stubSaves(true);
        const first = storage.set('loot', 'old', 'settings');
        vi.advanceTimersByTime(1000); // not yet fired
        const second = storage.set('loot', 'new', 'settings');

        await runDebounce();

        expect(saves).toEqual([{ key: 'loot', value: 'new', storeName: 'settings' }]);
        expect(await first).toBe(true);
        expect(await second).toBe(true);
    });

    test('a write to a different store is queued separately', async () => {
        stubSaves(false);
        storage.set('loot', [1], 'settings');
        storage.set('loot', [2], 'networthHistory');

        await runDebounce();

        expect(storage.pendingWrites.size).toBe(2);
        expect(storage.pendingWrites.get('networthHistory:loot')).toMatchObject({ value: [2] });
    });

    test('cleanupPendingWrites drops the queue and its generation counters', async () => {
        stubSaves(false);
        const done = storage.set('loot', [1], 'settings');
        await runDebounce();
        expect(storage._writeGeneration.size).toBe(1);

        storage.cleanupPendingWrites();

        expect(await done).toBe(false);
        expect(storage.pendingWrites.size).toBe(0);
        expect(storage._writeGeneration.size).toBe(0);
    });
});

describe('Storage waits out a lost connection instead of answering with defaults', () => {
    afterEach(() => {
        storage.db = null;
        storage._dbNulledReason = null;
        storage._reconnecting = false;
        storage._lastReconnectFailureAt = 0;
        storage._reconnect.mockRestore?.();
        vi.useRealTimers();
    });

    /** A get-capable fake: `get(key)` answers from the seeded data */
    function readableDb(seed) {
        return {
            transaction() {
                return {
                    objectStore: () => ({
                        get(key) {
                            const request = { onsuccess: null, onerror: null, result: seed[key] };
                            queueMicrotask(() => request.onsuccess?.());
                            return request;
                        },
                    }),
                };
            },
        };
    }

    test('a read during a reconnect gap waits for the connection and then answers for real', async () => {
        vi.useFakeTimers();
        storage.db = null;
        storage._dbNulledReason = 'onclose';
        // The reconnect in progress lands 800ms later, as Chromium's do
        storage._reconnecting = true;
        setTimeout(() => {
            storage.db = readableDb({ history: [1, 2, 3] });
            storage._reconnecting = false;
        }, 800);

        const read = storage.get('history', 'settings', []);
        await vi.advanceTimersByTimeAsync(1000);

        // Before: [] — the stored history had silently become "empty"
        expect(await read).toEqual([1, 2, 3]);
    });

    test('tryGet says the read could not be made, rather than pretending the key is absent', async () => {
        vi.useFakeTimers();
        storage.db = null;
        storage._dbNulledReason = 'onclose';
        vi.spyOn(storage, '_reconnect').mockImplementation(async () => {
            storage._lastReconnectFailureAt = Date.now();
        });

        const read = storage.tryGet('history', 'settings');
        await vi.advanceTimersByTimeAsync(6000);

        expect(await read).toBeNull();
    });

    test('before the database was ever opened nothing is waited for', async () => {
        storage.db = null;
        storage._dbNulledReason = null;
        storage._reconnecting = false;
        const started = Date.now();

        expect(await storage.get('anything', 'settings', 'fallback')).toBe('fallback');
        expect(Date.now() - started).toBeLessThan(500);
    });

    test('a write during the gap is held and then lands, instead of being refused', async () => {
        vi.useFakeTimers();
        storage.db = null;
        storage._dbNulledReason = 'onclose';
        storage._reconnecting = true;
        const written = [];
        setTimeout(() => {
            storage.db = {
                transaction() {
                    return {
                        objectStore: () => ({
                            put(value, key) {
                                const request = { onsuccess: null, onerror: null };
                                written.push([key, value]);
                                queueMicrotask(() => request.onsuccess?.());
                                return request;
                            },
                        }),
                        onabort: null,
                    };
                },
            };
            storage._reconnecting = false;
        }, 500);

        const write = storage.set('history', [1], 'settings', true);
        await vi.advanceTimersByTimeAsync(1000);

        expect(await write).toBe(true);
        expect(written).toEqual([['history', [1]]]);
    });
});

describe('read transactions that abort', () => {
    /**
     * A database whose read transactions abort without ever firing the
     * request's own success or error handlers — a version-change abort, a
     * frozen tab, a quota abort mid-cursor. This is the shape that used to
     * leave the promise pending for the life of the page.
     * @param {Array<string>} storeNames - Stores the fake exposes
     * @returns {object} Fake IDBDatabase
     */
    function createAbortingReadDb(storeNames = ['settings']) {
        return {
            objectStoreNames: storeNames,
            transaction() {
                const txn = { onabort: null, onerror: null, error: new Error('read aborted') };
                const store = {
                    get: () => ({ onsuccess: null, onerror: null }),
                    getAllKeys: () => ({ onsuccess: null, onerror: null }),
                    openCursor: () => ({ onsuccess: null, onerror: null }),
                };
                // Nothing settles the requests; only the transaction aborts
                queueMicrotask(() => queueMicrotask(() => txn.onabort?.()));
                return {
                    objectStore: () => store,
                    get error() {
                        return txn.error;
                    },
                    set onabort(fn) {
                        txn.onabort = fn;
                    },
                    set onerror(fn) {
                        txn.onerror = fn;
                    },
                };
            },
        };
    }

    /** Resolve to 'hung' if the operation has not settled shortly. */
    const orHang = (promise) =>
        Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('hung'), 50))]);

    beforeEach(() => {
        storage.db = createAbortingReadDb();
    });

    afterEach(() => {
        storage.db = null;
    });

    test('get falls back to its default instead of hanging for ever', async () => {
        await expect(orHang(storage.get('anything', 'settings', 'fallback'))).resolves.toBe('fallback');
    });

    test('tryGet reports the read as untrustworthy rather than hanging', async () => {
        // null is the "could not be read" answer a read-merge-write caller
        // needs so it declines to write back over the record
        await expect(orHang(storage.tryGet('anything', 'settings'))).resolves.toBeNull();
    });

    test('delete reports failure instead of hanging for ever', async () => {
        await expect(orHang(storage.delete('anything', 'settings'))).resolves.toBe(false);
    });

    test('getAllKeys returns an empty list instead of hanging for ever', async () => {
        await expect(orHang(storage.getAllKeys('settings'))).resolves.toEqual([]);
    });

    test('getAll returns what the cursor read instead of hanging for ever', async () => {
        await expect(orHang(storage.getAll('settings'))).resolves.toEqual({});
    });
});
