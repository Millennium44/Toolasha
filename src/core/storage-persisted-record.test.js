/**
 * A threeWay curated record run through the real Storage: the probe, the debounce and the fold that
 * lands the write, against a hand-rolled fake IDBDatabase (fake-indexeddb is not set up here). The
 * record's own suite uses a storage double whose `set` folds at once; this one holds the write for
 * the real debounce window, which is where another tab's commit can land in between.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');
const { createCuratedRecord } = await import('../utils/persisted-record.js');

/**
 * A fake IDBDatabase over one object store. Values are copied on the way in and out, as IndexedDB
 * does, so a record's live memory is never what "storage" holds.
 * @param {Record<string, *>} initial - Seed values by key
 * @returns {{db: object, data: Map<string, *>}} The fake and its backing data
 */
function createFakeDb(initial) {
    const data = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
    const db = {
        objectStoreNames: ['settings'],
        transaction() {
            const queue = [];
            const txn = { oncomplete: null, onerror: null, onabort: null };
            const store = {
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    queue.push(() => {
                        request.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
                        request.onsuccess?.();
                    });
                    return request;
                },
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    queue.push(() => {
                        data.set(key, structuredClone(value));
                        request.onsuccess?.();
                    });
                    return request;
                },
                delete(key) {
                    const request = { onsuccess: null, onerror: null };
                    queue.push(() => {
                        data.delete(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
            };
            queueMicrotask(() => {
                // A request may queue another (a fold's put follows its get), so drain until empty
                while (queue.length > 0) queue.shift()();
                queueMicrotask(() => txn.oncomplete?.());
            });
            return {
                ...txn,
                objectStore: () => store,
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
    return { db, data };
}

const KEY = 'fav';
const tab = () => createCuratedRecord({ base: KEY, scoped: false, empty: () => ({}), threeWay: true, label: 'Test' });

/**
 * Run a save through the debounce window and the write that ends it.
 * @param {Promise<boolean>} pending - The record's save
 * @returns {Promise<boolean>} Whether it landed
 */
async function landed(pending) {
    await vi.advanceTimersByTimeAsync(storage.SAVE_DEBOUNCE_DELAY + 10);
    return pending;
}

describe('a threeWay record through the real debounced fold', () => {
    let data;

    beforeEach(() => {
        vi.useFakeTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        const fake = createFakeDb({ [KEY]: { milk: true } });
        storage.db = fake.db;
        data = fake.data;
    });

    afterEach(() => {
        vi.useRealTimers();
        storage.saveDebounceTimers.clear();
        storage.pendingWrites.clear();
        storage._writeGeneration.clear();
        storage.db = null;
    });

    test('what another tab commits inside the debounce window is kept, and so is its later removal', async () => {
        const a = tab();
        const b = tab();
        await a.load();
        await b.load();

        // a's save is held for the debounce; another tab commits meanwhile
        a.get().eggs = true;
        const first = a.save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });

        // The other tab removes butter; a's next, unrelated edit must not bring it back
        data.set(KEY, { milk: true, eggs: true });
        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, eggs: true, jam: true });
    });

    test('what another tab commits inside the debounce window survives every later save of this tab', async () => {
        const a = tab();
        await a.load();

        a.get().eggs = true;
        const first = a.save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });

        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true });
    });

    test('an owner holding its own state: the same, committed before the save or inside its window', async () => {
        const record = tab();
        await record.load();
        const state = { ...record.get() };
        const save = () => {
            record.set({ ...state });
            return record.save();
        };
        data.set(KEY, { milk: true, butter: true });

        state.eggs = true;
        const first = save();
        await vi.advanceTimersByTimeAsync(10);
        data.set(KEY, { milk: true, butter: true, tea: true });
        expect(await landed(first)).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, tea: true, eggs: true });

        state.jam = true;
        expect(await landed(save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, tea: true, eggs: true, jam: true });

        // Its own removal still goes through, and leaves the other tab's items alone
        delete state.milk;
        expect(await landed(save())).toBe(true);
        expect(data.get(KEY)).toEqual({ butter: true, tea: true, eggs: true, jam: true });
    });

    test('a write that fails keeps the edit, and the next save still keeps what the other tab added', async () => {
        const a = tab();
        await a.load();
        data.set(KEY, { milk: true, butter: true });

        // The probe's transaction runs; the write's is refused
        const transaction = storage.db.transaction;
        let opened = 0;
        storage.db.transaction = function (...args) {
            opened += 1;
            if (opened === 2) throw new Error('refused');
            return transaction.apply(this, args);
        };
        a.get().eggs = true;
        expect(await landed(a.save())).toBe(false);
        storage.db.transaction = transaction;
        expect(data.get(KEY)).toEqual({ milk: true, butter: true });

        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true });

        a.get().tea = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true, jam: true, tea: true });
    });

    test('an item the other tab added and later removed is not revived by this tab, which never held it', async () => {
        const a = tab();
        const b = tab();
        await a.load();
        await b.load();

        b.get().butter = true;
        expect(await landed(b.save())).toBe(true);
        a.get().eggs = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, butter: true, eggs: true });
        expect(a.get()).toEqual({ milk: true, eggs: true });

        await b.load({ authoritative: true });
        delete b.get().butter;
        expect(await landed(b.save())).toBe(true);
        a.get().jam = true;
        expect(await landed(a.save())).toBe(true);
        expect(data.get(KEY)).toEqual({ milk: true, eggs: true, jam: true });
    });
});
