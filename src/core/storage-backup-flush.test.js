/**
 * A full backup against the real Storage and a hand-rolled fake IDBDatabase: what its flush may and may not
 * do to a queued value (spend the give-up budget, overwrite a restore) and what a backup with no connection
 * reports.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'A',
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Main',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'A',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: storage } = await import('./storage.js');
const { exportEverythingJSON } = await import('../utils/full-backup.js');
const { createCuratedRecord } = await import('../utils/persisted-record.js');

function fakeDb(initial) {
    const stores = new Map();
    const s = (n) => {
        if (!stores.has(n)) stores.set(n, new Map());
        return stores.get(n);
    };
    for (const [n, kv] of Object.entries(initial))
        for (const [k, v] of Object.entries(kv)) s(n).set(k, structuredClone(v));
    const ctl = { wedgeWrites: false, writeTxns: 0 };
    const names = Object.keys(initial);
    const db = {
        objectStoreNames: Object.assign(names, { contains: (n) => names.includes(n) }),
        close() {},
        transaction(_names, mode) {
            const queue = [];
            const txn = {};
            const objectStore = (name) => {
                const data = s(name);
                return {
                    get(key) {
                        const r = {};
                        queue.push(() => {
                            r.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
                            r.onsuccess?.({ target: r });
                        });
                        return r;
                    },
                    put(v, key) {
                        const r = {};
                        queue.push(() => {
                            data.set(key, structuredClone(v));
                            r.onsuccess?.({ target: r });
                        });
                        return r;
                    },
                    delete(key) {
                        const r = {};
                        queue.push(() => {
                            data.delete(key);
                            r.onsuccess?.({ target: r });
                        });
                        return r;
                    },
                    openCursor() {
                        const r = {};
                        const keys = [...data.keys()];
                        let i = 0;
                        const step = () => {
                            const has = i < keys.length;
                            r.result = has
                                ? {
                                      key: keys[i],
                                      value: structuredClone(data.get(keys[i])),
                                      continue() {
                                          i++;
                                          queue.push(step);
                                      },
                                  }
                                : null;
                            r.onsuccess?.({ target: r });
                        };
                        queue.push(step);
                        return r;
                    },
                    getAllKeys() {
                        const r = {};
                        queue.push(() => {
                            r.result = [...data.keys()];
                            r.onsuccess?.({ target: r });
                        });
                        return r;
                    },
                };
            };
            const run = () => {
                while (queue.length) queue.shift()();
                queueMicrotask(() => txn.oncomplete?.());
            };
            if (mode === 'readwrite') ctl.writeTxns++;
            if (!(mode === 'readwrite' && ctl.wedgeWrites)) queueMicrotask(run);
            return {
                objectStore,
                set oncomplete(f) {
                    txn.oncomplete = f;
                },
                set onerror(f) {},
                set onabort(f) {},
                abort() {},
            };
        },
    };
    return {
        db,
        ctl,
        get: (n, k) => {
            const v = s(n).get(k);
            return v === undefined ? undefined : structuredClone(v);
        },
        set: (n, k, v) => s(n).set(k, structuredClone(v)),
    };
}

const clean = () => {
    for (const timer of storage.saveDebounceTimers.values()) clearTimeout(timer);
    storage.saveDebounceTimers.clear();
    storage.pendingWrites.clear();
    storage._writeGeneration.clear();
    storage._flushFailures.clear();
    storage._restorePendingStores.clear();
    storage._restorePendingKeys.clear();
    storage._restoreInProgress = false;
    storage._restoreDepth = 0;
};

/**
 * Drive a promise to its end under fake timers.
 * @param {Promise<*>} promise - What to wait for
 * @returns {Promise<*>} Its value
 */
async function run(promise) {
    let done = false;
    let value;
    let failure;
    promise.then(
        (v) => {
            done = true;
            value = v;
        },
        (e) => {
            done = true;
            failure = e;
        }
    );
    for (let i = 0; i < 300 && !done; i += 1) await vi.advanceTimersByTimeAsync(500);
    if (!done) throw new Error('did not settle');
    if (failure) throw failure;
    return value;
}

describe('a full backup against real storage', () => {
    let fake;
    const writeTimeoutMs = storage.writeTimeoutMs;

    beforeEach(() => {
        vi.useFakeTimers();
        clean();
        fake = fakeDb({ settings: { k: 'old', other: 1 }, xp: { x: 1 } });
        storage.db = fake.db;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        clean();
        storage.writeTimeoutMs = writeTimeoutMs;
        storage.db = null;
        storage._dbNulledReason = null;
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    test('a pending plain write is in the file', async () => {
        storage.set('k', 'new', 'settings');
        const parsed = JSON.parse(await run(exportEverythingJSON()));
        expect(parsed.stores.settings.k).toBe('new');
    });

    test.each([false, true])(
        'pressing Back Up over wedged writes never drops the value (record handoff: %s)',
        async (handoff) => {
            storage.writeTimeoutMs = 1000;
            fake.ctl.wedgeWrites = true;
            storage.set('k', 'unsaved', 'settings');
            const record = createCuratedRecord({ base: 'r', scoped: false, empty: () => ({}) });

            for (let press = 1; press <= 6; press += 1) {
                if (handoff) {
                    record.set({ a: press });
                    record.save();
                }
                await run(exportEverythingJSON());
            }

            expect(storage.pendingWrites.has('settings:k')).toBe(true);
            expect(storage.pendingWrites.get('settings:k').value).toBe('unsaved');
            expect(storage._flushFailures.get('settings:k')).toBeUndefined();
        }
    );

    test('a flush that is not a backup still gives up on a value after three failed attempts', async () => {
        storage.writeTimeoutMs = 1000;
        fake.ctl.wedgeWrites = true;
        storage.set('k', 'unsaved', 'settings');
        for (let i = 0; i < 3; i += 1) await run(storage.flushAll());
        expect(storage.pendingWrites.has('settings:k')).toBe(false);
    });

    test('a backup in the middle of a restore does not write the pre-restore value over it', async () => {
        await storage.beginRestore();
        storage.set('k', 'local', 'settings');
        await vi.advanceTimersByTimeAsync(4000);
        await storage.putAll('settings', { k: 'restored' }, { bypassRestoreLatch: true });

        const parsed = JSON.parse(await run(exportEverythingJSON()));
        storage.finishRestore(new Map([['settings', new Set(['k'])]]));
        await storage.endRestore();
        await vi.advanceTimersByTimeAsync(4000);

        expect(parsed.stores.settings.k).toBe('restored');
        expect(fake.get('settings', 'k')).toBe('restored');
    });

    test('a backup with no database connection fails rather than saving a file with no stores', async () => {
        storage.set('k', 'unsaved', 'settings');
        storage.db = null;
        storage._dbNulledReason = 'test';
        storage._lastReconnectFailureAt = Date.now();

        await expect(run(exportEverythingJSON())).rejects.toThrow('not connected');
        expect(storage.pendingWrites.has('settings:k')).toBe(true);
    });
});
