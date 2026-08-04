/**
 * Tests for Storage's listStores() and putAll() (fake-indexeddb is not set up,
 * so these drive the real Storage class against a hand-rolled fake IDBDatabase).
 */

import { describe, test, expect, beforeEach } from 'vitest';

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
