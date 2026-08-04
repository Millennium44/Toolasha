/**
 * Tests for Storage's listStores() and putAll() (fake-indexeddb is not set up,
 * so these drive the real Storage class against a hand-rolled fake IDBDatabase),
 * and for the quota path — the one failure where a write is refused and
 * everything upstream carries on believing it recorded.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

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
    afterEach(() => {
        delete globalThis.navigator.storage;
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
        const keysByStore = {
            lootLogHistory: Array.from({ length: 41 }, (_, i) => `k${i}`), // budget 40
            settings: ['a', 'b'],
            somethingUnbudgeted: ['x'],
        };
        storage.db = { objectStoreNames: Object.keys(keysByStore) };
        vi.spyOn(storage, 'getAllKeys').mockImplementation(async (name) => keysByStore[name] || []);

        const rows = await storage.budgetReport();

        // Over-budget first, so a report that is skimmed still says the thing
        expect(rows[0]).toEqual({ storeName: 'lootLogHistory', keys: 41, budget: 40, over: true });
        const unbudgeted = rows.find((row) => row.storeName === 'somethingUnbudgeted');
        expect(unbudgeted).toEqual({ storeName: 'somethingUnbudgeted', keys: 1, budget: null, over: false });
        expect(rows.every((row) => row.storeName === 'lootLogHistory' || !row.over)).toBe(true);

        storage.getAllKeys.mockRestore();
    });
});
