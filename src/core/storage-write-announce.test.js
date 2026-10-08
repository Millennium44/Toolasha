/**
 * `storage.onWrite`: every write reported, this tab's when asked for and on
 * commit, other tabs' after they commit — what lets the sync push know nothing
 * changed without building its payload (see `features/sync/sync-dirty.js`).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

/** A BroadcastChannel stand-in: records what is posted, and lets a test play another tab */
class FakeChannel {
    static instances = [];
    constructor(name) {
        this.name = name;
        this.posted = [];
        this.onmessage = null;
        FakeChannel.instances.push(this);
    }
    postMessage(data) {
        this.posted.push(data);
    }
    close() {
        this.closed = true;
    }
}

/**
 * A fake IDBDatabase whose readwrite transactions run their requests in a
 * microtask and then commit in another.
 * @returns {{db: object, data: Map<string, Map<string, *>>}} The fake and its backing data
 */
function createFakeDb() {
    const data = new Map();
    const storeOf = (name) => {
        if (!data.has(name)) data.set(name, new Map());
        return data.get(name);
    };
    const db = {
        objectStoreNames: ['settings', 'xpHistory'],
        transaction(names) {
            const backing = storeOf(names[0]);
            const runs = [];
            const txn = { oncomplete: null, onerror: null, onabort: null, objectStore: () => store };
            const request = (run) => {
                const req = { onsuccess: null, onerror: null, result: undefined };
                runs.push(() => {
                    req.result = run();
                    req.onsuccess?.();
                });
                return req;
            };
            const store = {
                get: (key) => request(() => backing.get(key)),
                put: (value, key) => request(() => backing.set(key, value)),
                delete: (key) => request(() => backing.delete(key)),
            };
            queueMicrotask(() => {
                // A request's handler can queue another (update's put after its get)
                while (runs.length) runs.shift()();
                queueMicrotask(() => txn.oncomplete?.());
            });
            return txn;
        },
    };
    return { db, data };
}

/** Let the fake transactions run and commit */
const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

let heard;
let stop;

beforeEach(() => {
    FakeChannel.instances = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    storage._writeChannel = undefined;
    storage.db = createFakeDb().db;
    heard = [];
    stop = storage.onWrite((write) => heard.push(write));
});

afterEach(() => {
    stop?.();
    storage._closingForTeardown = false;
    storage.cleanupPendingWrites();
    storage._writeChannel = undefined;
    vi.unstubAllGlobals();
});

describe('storage.onWrite', () => {
    test('a debounced set is reported when it is asked for, before it reaches IndexedDB', async () => {
        vi.useFakeTimers();
        try {
            const pending = storage.set('a', 1, 'xpHistory');
            await settle();
            expect(heard).toEqual([{ storeName: 'xpHistory', keys: ['a'], origin: 'local' }]);
            expect(FakeChannel.instances[0].posted).toEqual([]);
            // Three seconds later it lands, and only then is it announced
            await vi.advanceTimersByTimeAsync(3000);
            await pending;
            expect(FakeChannel.instances[0].posted).toEqual([{ storeName: 'xpHistory', keys: ['a'] }]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a committed write is reported again, and announced to other tabs', async () => {
        await storage.set('a', 1, 'xpHistory', true);
        await settle();
        expect(heard.map((write) => write.origin)).toEqual(['local', 'commit']);
        expect(FakeChannel.instances).toHaveLength(1);
        expect(FakeChannel.instances[0].name).toBe('toolasha-storage-writes');
        expect(FakeChannel.instances[0].posted).toEqual([{ storeName: 'xpHistory', keys: ['a'] }]);
    });

    test('update, delete and putAll announce their commits too', async () => {
        await storage.update('u', () => 2, 'xpHistory');
        await storage.delete('u', 'xpHistory');
        await settle();
        await storage.putAll('settings', { p: 1, q: 2 });
        await settle();
        expect(FakeChannel.instances[0].posted).toEqual([
            { storeName: 'xpHistory', keys: ['u'] },
            { storeName: 'xpHistory', keys: ['u'] },
            { storeName: 'settings', keys: ['p', 'q'] },
        ]);
    });

    test('a bulk write too large to list is announced with its keys unknown', async () => {
        const entries = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
        await storage.putAll('xpHistory', entries);
        await settle();
        expect(FakeChannel.instances[0].posted).toEqual([{ storeName: 'xpHistory', keys: null }]);
        expect(heard[0]).toEqual({ storeName: 'xpHistory', keys: null, origin: 'local' });
    });

    test("another tab's announced commit reaches this tab's listeners", () => {
        FakeChannel.instances[0].onmessage({ data: { storeName: 'xpHistory', keys: ['b'] } });
        expect(heard).toEqual([{ storeName: 'xpHistory', keys: ['b'], origin: 'remote' }]);
    });

    test('a page back from the bfcache reports that it may have missed writes', async () => {
        storage._closingForTeardown = true;
        const open = vi.spyOn(storage, 'openDatabase').mockResolvedValue(undefined);
        await storage.reopenAfterRestore();
        open.mockRestore();
        expect(heard).toContainEqual({ storeName: null, keys: null, origin: 'resumed' });
    });

    test('a tab with no listener still announces its commits, without listening', async () => {
        stop();
        storage._writeChannel?.close();
        storage._writeChannel = undefined;
        FakeChannel.instances = [];
        await storage.set('a', 1, 'xpHistory', true);
        await settle();
        expect(FakeChannel.instances).toHaveLength(1);
        expect(FakeChannel.instances[0].posted).toEqual([{ storeName: 'xpHistory', keys: ['a'] }]);
        expect(FakeChannel.instances[0].onmessage).toBeNull();
        expect(storage.crossTabWritesVisible()).toBe(false);
    });

    test('the page saying goodbye closes the channel, and coming back reopens it listening', async () => {
        const first = FakeChannel.instances[0];
        first.close = vi.fn();
        const live = storage.db;
        // A write the teardown flush lands, committing after the close
        storage._debouncedSave('t', 1, 'xpHistory');
        const flush = storage.closeForTeardown('pagehide');
        expect(first.close).toHaveBeenCalled();
        expect(storage.crossTabWritesVisible()).toBe(false);
        // The flush runs on the connection it snapshotted; let it commit
        storage.db = live;
        await flush;
        await settle();
        const oneShot = FakeChannel.instances.find((channel) => channel !== first && channel.posted.length);
        expect(oneShot?.posted).toEqual([{ storeName: 'xpHistory', keys: ['t'] }]);
        expect(oneShot.closed).toBe(true);

        const open = vi.spyOn(storage, 'openDatabase').mockResolvedValue(undefined);
        await storage.reopenAfterRestore();
        open.mockRestore();
        expect(heard).toContainEqual({ storeName: null, keys: null, origin: 'resumed' });
        const reopened = FakeChannel.instances.at(-1);
        expect(reopened).not.toBe(first);
        expect(typeof reopened.onmessage).toBe('function');
        expect(storage.crossTabWritesVisible()).toBe(true);
    });

    test('cross-tab writes are visible only where a channel could be opened', () => {
        expect(storage.crossTabWritesVisible()).toBe(true);
        storage._writeChannel = undefined;
        vi.stubGlobal('BroadcastChannel', undefined);
        expect(storage.crossTabWritesVisible()).toBe(false);
    });
});
