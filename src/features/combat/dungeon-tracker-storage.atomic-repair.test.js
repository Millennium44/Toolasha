/**
 * Actual run storage and actual core storage over an atomic, serialized IDB double.
 * Request success only stages writes; abort rolls every one back, and commit may
 * be held after the puts succeed to exercise the distinction from durable data.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'A',
        getCurrentCharacterName: () => 'Cow',
        on: () => {},
    },
}));

const { default: storage } = await import('../../core/storage.js');
const {
    default: history,
    RUNS_KEY,
    RUNS_STORE,
    RUNS_DELETED_KEY,
    RUNS_CLEARED_KEY,
    RUNS_DATE_REPAIR_KEY,
    RUNS_DATE_REPAIR_BACKUPS_KEY,
    mergeRunRepairBackups,
    rederiveSwappedRun,
    runIdentity,
    tombstoneFor,
} = await import('./dungeon-tracker-storage.js');

const KEYS = [RUNS_KEY, RUNS_DELETED_KEY, RUNS_CLEARED_KEY, RUNS_DATE_REPAIR_KEY, RUNS_DATE_REPAIR_BACKUPS_KEY];
const CLEAR_MS = 14 * 60_000 + 13_000;
const broken = () => {
    const start = new Date(2026, 0, 3, 23, 56, 0);
    const end = new Date(2026, 1, 3, 0, 10, 13);
    return {
        timestamp: start.toISOString(),
        duration: end - start,
        dungeonName: 'Chimerical Den',
        teamKey: 'A,B',
        tier: 2,
        recordedBy: 'A',
    };
};
const normal = (teamKey = 'C,D') => ({
    timestamp: new Date(2026, 9, 10, 10).toISOString(),
    duration: CLEAR_MS,
    dungeonName: 'Pirate Cove',
    teamKey,
});
const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
};

/**
 * @param {object} seed - Initial values in unifiedRuns
 * @returns {object} Database, durable values, and one-shot transaction hooks
 */
function createAtomicDb(seed) {
    const data = new Map(Object.entries(structuredClone(seed)));
    const hooks = { fault: null, beforeStart: null, beforeCommit: null, abortCommit: false };
    const transactions = [];
    let busy = false;
    let closed = false;
    const drain = async () => {
        if (busy || transactions.length === 0) return;
        busy = true;
        const next = transactions.shift();
        await next();
        busy = false;
        queueMicrotask(drain);
    };
    const db = {
        objectStoreNames: [RUNS_STORE],
        close() {
            closed = true;
        },
        transaction(names, mode) {
            if (closed) throw new Error('The connection is closed');
            expect(names).toEqual([RUNS_STORE]);
            const queue = [];
            let staged;
            let aborted = false;
            const transaction = {
                oncomplete: null,
                onabort: null,
                onerror: null,
                error: null,
                abort() {
                    if (aborted) return;
                    aborted = true;
                    queueMicrotask(() => transaction.onabort?.());
                },
                objectStore: () => store,
            };
            const request = (operation, key, value) => {
                const fault = hooks.fault;
                if (fault?.operation === operation && fault?.key === key && fault.throw) {
                    hooks.fault = null;
                    throw new Error(`Injected ${operation} exception for ${key}`);
                }
                const req = { result: undefined, error: null, onsuccess: null, onerror: null };
                queue.push(() => {
                    const fault = hooks.fault;
                    if (fault?.operation === operation && fault?.key === key) {
                        hooks.fault = null;
                        req.error = new Error(`Injected ${operation} failure for ${key}`);
                        transaction.error = req.error;
                        req.onerror?.();
                        transaction.abort();
                        return;
                    }
                    if (operation === 'get') req.result = structuredClone(staged.get(key));
                    else if (operation === 'put') staged.set(key, structuredClone(value));
                    else staged.delete(key);
                    req.onsuccess?.();
                });
                return req;
            };
            const store = {
                get: (key) => request('get', key),
                put: (value, key) => request('put', key, value),
                delete: (key) => request('delete', key),
            };
            transactions.push(async () => {
                const beforeStart = hooks.beforeStart;
                hooks.beforeStart = null;
                if (beforeStart) await beforeStart(mode);
                staged = structuredClone(data);
                while (queue.length && !aborted) queue.shift()();
                if (mode === 'readwrite') {
                    const beforeCommit = hooks.beforeCommit;
                    hooks.beforeCommit = null;
                    if (beforeCommit) await beforeCommit();
                    if (hooks.abortCommit) {
                        hooks.abortCommit = false;
                        transaction.abort();
                    }
                }
                if (aborted) return;
                if (mode === 'readwrite') {
                    data.clear();
                    for (const [key, value] of staged) data.set(key, value);
                }
                transaction.oncomplete?.();
            });
            queueMicrotask(drain);
            return transaction;
        },
    };
    return { db, data, hooks, reopen: () => (closed = false) };
}

let fake;
let timeout;
beforeEach(() => {
    history._resetCache();
    storage.cleanupPendingWrites();
    storage._closingForTeardown = false;
    fake = createAtomicDb({ [RUNS_KEY]: [broken()] });
    storage.db = fake.db;
    timeout = storage.writeTimeoutMs;
});
afterEach(() => {
    history._resetCache();
    storage.cleanupPendingWrites();
    storage.db = null;
    storage.writeTimeoutMs = timeout;
    vi.restoreAllMocks();
});

async function reload() {
    history._resetCache();
    return history.getAllRuns();
}

async function assertRepaired() {
    expect(await reload()).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
    expect(fake.data.get(RUNS_DATE_REPAIR_KEY)).toBeGreaterThan(0);
    expect(fake.data.get(RUNS_DELETED_KEY)).toEqual([tombstoneFor(broken())]);
}

describe('atomic date repair failure boundaries', () => {
    test.each(KEYS)('unreadable %s leaves the original and all markers unchanged, then retries', async (key) => {
        // Warm memory too: a failed transaction must not mutate this original.
        await history.getAllRuns();
        const before = structuredClone(fake.data);
        fake.hooks.fault = { operation: 'get', key };
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(fake.data).toEqual(before);
        expect(history._runs).toEqual([broken()]);
        expect(await reload()).toEqual([broken()]);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        await assertRepaired();
    });

    test.each([RUNS_KEY, RUNS_DELETED_KEY, RUNS_DATE_REPAIR_KEY, RUNS_DATE_REPAIR_BACKUPS_KEY])(
        'failed %s put rolls back every successful request; reload and retry preserve the run',
        async (key) => {
            await history.getAllRuns();
            const before = structuredClone(fake.data);
            fake.hooks.fault = { operation: 'put', key };
            expect(await history.repairSwappedDateRuns()).toBeNull();
            expect(fake.data).toEqual(before);
            expect(history._runs).toEqual([broken()]);
            expect(history._deleted.size).toBe(0);
            expect(await reload()).toEqual([broken()]);
            expect(await history.repairSwappedDateRuns()).toBe(1);
            await assertRepaired();
        }
    );

    test.each([RUNS_KEY, RUNS_DELETED_KEY, RUNS_DATE_REPAIR_KEY, RUNS_DATE_REPAIR_BACKUPS_KEY])(
        'synchronous %s put exception also aborts earlier queued writes',
        async (key) => {
            const before = structuredClone(fake.data);
            fake.hooks.fault = { operation: 'put', key, throw: true };
            expect(await history.repairSwappedDateRuns()).toBeNull();
            expect(fake.data).toEqual(before);
            expect(await reload()).toEqual([broken()]);
            expect(await history.repairSwappedDateRuns()).toBe(1);
            await assertRepaired();
        }
    );

    test('abort after every put succeeds leaves all state untouched and is retryable without reload', async () => {
        await history.getAllRuns();
        const before = structuredClone(fake.data);
        fake.hooks.abortCommit = true;
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(fake.data).toEqual(before);
        expect(history._runs).toEqual([broken()]);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        await assertRepaired();
    });

    test('neither memory nor the one-time marker is published before commit', async () => {
        await history.getAllRuns();
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        const repairing = history.repairSwappedDateRuns();
        await entered.promise;
        expect(history._runs).toEqual([broken()]);
        expect(history._deleted.size).toBe(0);
        expect(fake.data.get(RUNS_KEY)).toEqual([broken()]);
        expect(fake.data.has(RUNS_DATE_REPAIR_KEY)).toBe(false);
        release.resolve();
        expect(await repairing).toBe(1);
        await assertRepaired();
    });

    test('a timed-out transaction can commit late without making either representation disappear', async () => {
        storage.writeTimeoutMs = 5;
        vi.spyOn(storage, '_recordTimeout').mockResolvedValue();
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        const repairing = history.repairSwappedDateRuns();
        await entered.promise;
        expect(await repairing).toBeNull();
        expect(fake.data.get(RUNS_KEY)).toEqual([broken()]);
        expect(fake.data.has(RUNS_DATE_REPAIR_KEY)).toBe(false);
        release.resolve();
        await assertRepaired();
        expect(await history.repairSwappedDateRuns()).toBe(0);
    });
});

describe('atomic repair concurrency and repeat behavior', () => {
    test('a second tab append immediately before the transaction survives the repair and reload', async () => {
        await history.getAllRuns();
        fake.hooks.beforeStart = () => fake.data.set(RUNS_KEY, [normal(), broken()]);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect(await reload()).toEqual([normal(), { ...broken(), ...rederiveSwappedRun(broken()) }]);
    });

    test('a second tab removal cannot be revived from stale memory as a repaired copy', async () => {
        await history.getAllRuns();
        fake.hooks.beforeStart = () => {
            fake.data.set(RUNS_KEY, [normal()]);
            fake.data.set(RUNS_DELETED_KEY, [tombstoneFor(broken())]);
        };
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(await history.getAllRuns()).toEqual([normal()]);
        expect(await reload()).toEqual([normal()]);
        expect(fake.data.get(RUNS_DELETED_KEY)).toEqual([tombstoneFor(broken())]);
    });

    test('a concurrent clear is read with the runs and cannot be undone by repair', async () => {
        await history.getAllRuns();
        fake.hooks.beforeStart = () => {
            fake.data.set(RUNS_CLEARED_KEY, Date.now());
            fake.data.set(RUNS_KEY, []);
        };
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(await history.getAllRuns()).toEqual([]);
        expect(await reload()).toEqual([]);
    });

    test('a second tab completing the repair first suppresses another pass', async () => {
        await history.getAllRuns();
        fake.hooks.beforeStart = () => {
            fake.data.set(RUNS_KEY, [{ ...broken(), ...rederiveSwappedRun(broken()) }]);
            fake.data.set(RUNS_DELETED_KEY, [tombstoneFor(broken())]);
            fake.data.set(RUNS_DATE_REPAIR_KEY, Date.now());
        };
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(await history.getAllRuns()).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
        await assertRepaired();
    });

    test('a stale writer committing after repair cannot replace the corrected run with the old identity', async () => {
        const other = new history.constructor();
        await other.getAllRuns();
        await history.getAllRuns();
        other._index([normal(), ...other._runs]);
        const entered = deferred();
        const release = deferred();
        let holdOther = true;
        const tryGet = storage.tryGet.bind(storage);
        vi.spyOn(storage, 'tryGet').mockImplementation(async (...args) => {
            const result = await tryGet(...args);
            if (holdOther && args[0] === RUNS_KEY) {
                entered.resolve();
                await release.promise;
            }
            return result;
        });
        // The fixed writer waits before opening its atomic transaction. The old
        // writer above instead waits after reading a snapshot outside its put.
        if (storage.updateMany) {
            const updateMany = storage.updateMany.bind(storage);
            vi.spyOn(storage, 'updateMany').mockImplementation(async (...args) => {
                if (holdOther) {
                    entered.resolve();
                    await release.promise;
                }
                return updateMany(...args);
            });
        }
        const saving = other._persistNow(true);
        await entered.promise;
        holdOther = false;
        expect(await history.repairSwappedDateRuns()).toBe(1);
        release.resolve();
        expect(await saving).toBe(true);
        expect(await reload()).toEqual([normal(), { ...broken(), ...rederiveSwappedRun(broken()) }]);
        other._resetCache();
    });

    test('another tab cold-loading old runs and new tombstones cannot prune away the replacement', async () => {
        await history.getAllRuns();
        const other = new history.constructor();
        const entered = deferred();
        const release = deferred();
        let hold = true;
        const tryGet = storage.tryGet.bind(storage);
        vi.spyOn(storage, 'tryGet').mockImplementation(async (...args) => {
            const result = await tryGet(...args);
            if (hold && args[0] === RUNS_KEY) {
                hold = false;
                entered.resolve();
                await release.promise;
            }
            return result;
        });
        const reading = other.getAllRuns();
        await entered.promise;
        expect(await history.repairSwappedDateRuns()).toBe(1);
        release.resolve();
        expect(await reading).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
        await assertRepaired();
        other._resetCache();
    });

    test('preexisting tombstones survive and a corrected identity already deleted stays deleted', async () => {
        const repaired = { ...broken(), ...rederiveSwappedRun(broken()) };
        const tombstones = [tombstoneFor(repaired), tombstoneFor(normal())];
        fake.data.set(RUNS_DELETED_KEY, tombstones);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect(await reload()).toEqual([]);
        expect(fake.data.get(RUNS_DELETED_KEY)).toEqual(expect.arrayContaining(tombstones));
    });

    test('duplicate originals and an already recorded corrected copy collapse without losing fields', async () => {
        const repaired = { ...broken(), ...rederiveSwappedRun(broken()), waveTimes: [300, 400] };
        fake.data.set(RUNS_KEY, [broken(), broken(), repaired]);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect(await reload()).toEqual([repaired]);
    });

    test('unrepairable and already plausible runs remain untouched; empty history is marked once', async () => {
        const unrepairable = { ...broken(), timestamp: new Date(2026, 0, 20).toISOString() };
        fake.data.set(RUNS_KEY, [normal(), unrepairable]);
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(fake.data.get(RUNS_KEY)).toEqual([normal(), unrepairable]);
        fake.data.clear();
        history._resetCache();
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(fake.data.has(RUNS_KEY)).toBe(false);
        const marker = fake.data.get(RUNS_DATE_REPAIR_KEY);
        expect(marker).toBeGreaterThan(0);
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(fake.data.get(RUNS_DATE_REPAIR_KEY)).toBe(marker);
    });

    test('repeated callers share one repair and a cold reader never mixes old runs with new tombstones', async () => {
        const repairing = history.repairSwappedDateRuns();
        const repeated = history.repairSwappedDateRuns();
        const reading = history.getAllRuns();
        expect(await repairing).toBe(1);
        expect(await repeated).toBe(1);
        expect(await reading).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
        await assertRepaired();
    });

    test('a cold read already in flight finishes before repair without deadlocking its prune', async () => {
        fake.data.set(RUNS_KEY, [broken(), normal()]);
        fake.data.set(RUNS_DELETED_KEY, [tombstoneFor(normal())]);
        const reading = history.getAllRuns();
        const repairing = history.repairSwappedDateRuns();
        expect(await reading).toEqual([broken()]);
        expect(await repairing).toBe(1);
        expect(await reload()).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
    });

    test('an append during commit keeps both the new run and the repaired history', async () => {
        await history.getAllRuns();
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        const repairing = history.repairSwappedDateRuns();
        await entered.promise;
        // Recorders use _loadRuns and wait for the atomic repair, so their new
        // observation is applied afterwards rather than to a stale identity.
        const saving = history.saveTeamRun('C,D', normal());
        release.resolve();
        expect(await repairing).toBe(1);
        expect(await saving).toBe(true);
        await history.flushPendingSave();
        expect((await reload()).map((run) => run.teamKey)).toEqual(['C,D', 'A,B']);
    });

    test('a cache reset during commit does not publish into the new cache', async () => {
        await history.getAllRuns();
        fake.hooks.beforeCommit = () => history._resetCache();
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(history._runs).toBeNull();
        await assertRepaired();
    });
});

describe('durable recovery from older tabs', () => {
    test.each(['stale history', 'empty prune', 'stale tombstones'])(
        'a legacy %s whole-array overwrite cannot permanently lose the repaired run',
        async (kind) => {
            expect(await history.repairSwappedDateRuns()).toBe(1);
            const repaired = { ...broken(), ...rederiveSwappedRun(broken()) };
            expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([
                { original: tombstoneFor(broken()), replacement: repaired },
            ]);
            // These are the pre-fix owner's actual persistence operations,
            // performed after the new tab's repair transaction has committed.
            if (kind === 'stale tombstones') await storage.setJSON(RUNS_DELETED_KEY, [], RUNS_STORE, true);
            await storage.setJSON(RUNS_KEY, kind === 'empty prune' ? [] : [broken(), normal()], RUNS_STORE, true);
            expect(await reload()).toEqual(kind === 'empty prune' ? [repaired] : [normal(), repaired]);
            expect(fake.data.get(RUNS_KEY)).toEqual(kind === 'empty prune' ? [repaired] : [normal(), repaired]);
            expect(fake.data.get(RUNS_DELETED_KEY)).toEqual([tombstoneFor(broken())]);
        }
    );

    test('a completed marker repairs a missing replacement from backup before the next consumer reads', async () => {
        await history.repairSwappedDateRuns();
        await storage.setJSON(RUNS_KEY, [], RUNS_STORE, true);
        history._resetCache();
        expect(await history.repairSwappedDateRuns()).toBe(0);
        await assertRepaired();
    });

    test.each(['delete', 'clear'])('explicit %s retires the backup and cannot be undone by reload', async (action) => {
        await history.repairSwappedDateRuns();
        const replacement = fake.data.get(RUNS_KEY)[0];
        const result =
            action === 'delete' ? await history.deleteRun(runIdentity(replacement)) : await history.clearAllRuns();
        expect(result).toBe(true);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
        expect(await reload()).toEqual([]);
    });

    test('a recovered run remains recoverable when its restoration write fails', async () => {
        await history.repairSwappedDateRuns();
        await storage.setJSON(RUNS_KEY, [], RUNS_STORE, true);
        fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
        expect(await reload()).toEqual([{ ...broken(), ...rederiveSwappedRun(broken()) }]);
        expect(fake.data.get(RUNS_KEY)).toEqual([]);
        await assertRepaired();
    });

    test('unreadable backup evidence cannot be treated as no backup', async () => {
        await history.repairSwappedDateRuns();
        await storage.setJSON(RUNS_KEY, [], RUNS_STORE, true);
        fake.hooks.fault = { operation: 'get', key: RUNS_DATE_REPAIR_BACKUPS_KEY };
        history._resetCache();
        expect(await history.getAllRunsOrNull()).toBeNull();
        await assertRepaired();
    });

    test('later tier and wave enrichment survives recovery after a legacy overwrite', async () => {
        const source = broken();
        delete source.tier;
        fake.data.set(RUNS_KEY, [source]);
        await history.repairSwappedDateRuns();
        const corrected = fake.data.get(RUNS_KEY)[0];
        const fields = {
            tier: 2,
            dungeonHrid: '/actions/combat/chimerical_den',
            waveTimes: [500, 800],
            avgWaveTime: 650,
        };
        await history.saveTeamRun('A,B', { ...corrected, ...fields });
        expect(await history.flushPendingSave()).toBe(true);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)[0].replacement).toMatchObject(fields);
        await storage.setJSON(RUNS_KEY, [], RUNS_STORE, true);
        expect(await reload()).toEqual([{ ...corrected, ...fields }]);
    });

    test('the backup sync fold preserves replacements and fields without inventing malformed records', async () => {
        await history.repairSwappedDateRuns();
        const backups = fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY);
        const incoming = structuredClone(backups);
        incoming[0].replacement.waveTimes = [500, 800];
        incoming[0].replacement.avgWaveTime = 650;
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        const registration = mergeForKey(RUNS_STORE, RUNS_DATE_REPAIR_BACKUPS_KEY);
        expect(registration.merge(backups, incoming)).toEqual(incoming);
        expect(mergeRunRepairBackups(backups, [null, {}, { original: {}, replacement: null }])).toEqual(backups);
        // The original schemas remain arrays/epoch numbers for an older reader.
        expect(Array.isArray(fake.data.get(RUNS_KEY))).toBe(true);
        expect(Array.isArray(fake.data.get(RUNS_DELETED_KEY))).toBe(true);
        expect(typeof fake.data.get(RUNS_DATE_REPAIR_KEY)).toBe('number');
    });
});

describe('atomic history flush at lifecycle boundaries', () => {
    test('a failed append stays dirty and retries on the next owner flush', async () => {
        await history.saveTeamRun('C,D', normal());
        fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
        expect(await history.flushPendingSave()).toBe(false);
        expect(history._runsDirty).toBe(true);
        expect(fake.data.get(RUNS_KEY)).toEqual([broken()]);
        expect(await history.flushPendingSave()).toBe(true);
        expect(history._runsDirty).toBe(false);
        expect((await reload()).map((run) => run.teamKey)).toEqual(['C,D', 'A,B']);
    });

    test.each([false, true])(
        'real storage teardown drains a buffered run, previous failure = %s',
        async (failFirst) => {
            await history.saveTeamRun('C,D', normal());
            if (failFirst) {
                fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
                expect(await history.flushPendingSave()).toBe(false);
            }
            await storage.closeForTeardown();
            expect(storage.db).toBeNull();
            await history._persistChain;
            expect(fake.data.get(RUNS_KEY).map((run) => run.teamKey)).toEqual(['C,D', 'A,B']);
            storage._closingForTeardown = false;
            fake.reopen();
            storage.db = fake.db;
            expect((await reload()).map((run) => run.teamKey)).toEqual(['C,D', 'A,B']);
        }
    );

    test('teardown opens the next transaction before closing even when an earlier write is still in flight', async () => {
        await history.saveTeamRun('C,D', normal());
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        const first = history.flushPendingSave();
        await entered.promise;
        await history.saveTeamRun('E,F', { ...normal('E,F'), timestamp: new Date(2026, 10, 1).toISOString() });
        await storage.closeForTeardown();
        const last = history._persistChain;
        release.resolve();
        expect(await first).toBe(true);
        expect(await last).toBe(true);
        expect(fake.data.get(RUNS_KEY).map((run) => run.teamKey)).toEqual(['E,F', 'C,D', 'A,B']);
    });
});

describe('strict multi-key storage contract', () => {
    test('a failed callback, async callback or undeclared key never commits a fallback', async () => {
        for (const mutate of [
            () => {
                throw new Error('failure');
            },
            async () => ({ [RUNS_KEY]: [] }),
            () => ({ unknown: [] }),
        ]) {
            expect(await storage.updateMany(RUNS_STORE, KEYS, mutate)).toBeNull();
            expect(fake.data).toEqual(new Map([[RUNS_KEY, [broken()]]]));
        }
    });

    test('a queued debounced value is neither overwritten nor dropped; repair retries after it lands', async () => {
        const saving = storage.setJSON(RUNS_KEY, [broken(), normal()], RUNS_STORE);
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(storage.pendingWrites.has(`${RUNS_STORE}:${RUNS_KEY}`)).toBe(true);
        expect(fake.data.get(RUNS_KEY)).toEqual([broken()]);
        await storage.flushAll();
        expect(await saving).toBe(true);
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect((await reload()).map((run) => run.teamKey)).toEqual(['C,D', 'A,B']);
    });

    test('restore latch and teardown refuse the entire repair', async () => {
        const before = structuredClone(fake.data);
        const latch = vi.spyOn(storage, '_refuseDuringRestore').mockImplementation((key) => key === RUNS_DELETED_KEY);
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(fake.data).toEqual(before);
        latch.mockRestore();
        storage._closingForTeardown = true;
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(fake.data).toEqual(before);
    });

    test.each(['delete', 'clear'])(
        'a failed ordinary %s keeps its intent dirty and commits no partial state',
        async (action) => {
            await history.getAllRuns();
            const before = structuredClone(fake.data);
            fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
            const saved =
                action === 'delete' ? await history.deleteRun(runIdentity(broken())) : await history.clearAllRuns();
            expect(saved).toBe(false);
            expect(fake.data).toEqual(before);
            expect(history._deletedDirty).toBe(true);
            expect(await history._persist(true)).toBe(true);
            expect(history._deletedDirty).toBe(false);
            expect(await reload()).toEqual([]);
        }
    );

    test('only committed changes announce commit; abort does not advance sync observers', async () => {
        const announce = vi.spyOn(storage, '_announceCommit');
        fake.hooks.abortCommit = true;
        expect(await history.repairSwappedDateRuns()).toBeNull();
        expect(announce).not.toHaveBeenCalled();
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect(announce).toHaveBeenCalledExactlyOnceWith(
            RUNS_STORE,
            expect.arrayContaining([RUNS_KEY, RUNS_DELETED_KEY, RUNS_DATE_REPAIR_KEY])
        );
        expect(runIdentity((await reload())[0])).not.toBe(runIdentity(broken()));
    });
});

describe('manual deletion across repaired identities', () => {
    test.each([false, true])(
        'a manual removal follows the durable replacement when the displayed old identity is stale, refreshed cache = %s',
        async (refresh) => {
            const other = new history.constructor();
            try {
                await other.getAllRuns();
                expect(await history.repairSwappedDateRuns()).toBe(1);
                if (refresh) other._resetCache();
                expect(await other.deleteRun(runIdentity(broken()))).toBe(true);
                expect(await reload()).toEqual([]);
                expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
                expect(fake.data.get(RUNS_DELETED_KEY)).toContainEqual(
                    tombstoneFor({ ...broken(), ...rederiveSwappedRun(broken()) })
                );
            } finally {
                other._resetCache();
            }
        }
    );

    test.each([RUNS_KEY, RUNS_DELETED_KEY, RUNS_DATE_REPAIR_BACKUPS_KEY])(
        'a failed %s write retains explicit deletion intent for retry without partially removing recovery evidence',
        async (key) => {
            const other = new history.constructor();
            try {
                await other.getAllRuns();
                await history.repairSwappedDateRuns();
                const before = structuredClone(fake.data);
                fake.hooks.fault = { operation: 'put', key };
                expect(await other.deleteRun(runIdentity(broken()))).toBe(false);
                expect(fake.data).toEqual(before);
                expect(await other.flushPendingSave()).toBe(true);
                expect(await reload()).toEqual([]);
                expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
            } finally {
                other._resetCache();
            }
        }
    );

    test('an automatic stale-tab outlier scrub does not turn the repair tombstone into deletion of the good replacement', async () => {
        const healthy = Array.from({ length: 5 }, (_, index) => ({
            ...normal('A,B'),
            dungeonName: broken().dungeonName,
            timestamp: new Date(2026, 9, 10 + index, 10).toISOString(),
        }));
        fake.data.set(RUNS_KEY, [broken(), ...healthy]);
        const other = new history.constructor();
        try {
            await other.getAllRuns();
            expect(await history.repairSwappedDateRuns()).toBe(1);
            expect(await other.scrubOutlierRuns()).toBe(1);
            const repaired = { ...broken(), ...rederiveSwappedRun(broken()) };
            expect(await reload()).toEqual(expect.arrayContaining([...healthy, repaired]));
            expect(fake.data.get(RUNS_KEY)).toHaveLength(6);
            expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([
                { original: tombstoneFor(broken()), replacement: repaired },
            ]);
        } finally {
            other._resetCache();
        }
    });

    test('a later manual deletion during commit remains pending if its own write fails', async () => {
        const second = { ...broken(), teamKey: 'E,F' };
        fake.data.set(RUNS_KEY, [broken(), second]);
        const other = new history.constructor();
        try {
            await other.getAllRuns();
            expect(await history.repairSwappedDateRuns()).toBe(2);
            const entered = deferred();
            const release = deferred();
            fake.hooks.beforeCommit = async () => {
                entered.resolve();
                await release.promise;
            };
            const first = other.deleteRun(runIdentity(broken()));
            await entered.promise;
            const later = other.deleteRun(runIdentity(second));
            // Give deleteRun's load continuation time to record the newer intent.
            await Promise.resolve();
            fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
            release.resolve();
            expect(await first).toBe(true);
            expect(await later).toBe(false);
            expect(await other.flushPendingSave()).toBe(true);
            expect(await reload()).toEqual([]);
            expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
        } finally {
            other._resetCache();
        }
    });

    test('an unrelated manual identity does not remove repaired runs', async () => {
        expect(await history.repairSwappedDateRuns()).toBe(1);
        expect(await history.deleteRun(runIdentity(normal()))).toBe(true);
        await assertRepaired();
    });
});

describe('manual repair deletion and revival ordering', () => {
    async function reviveAfterFailedDelete() {
        await history.repairSwappedDateRuns();
        const replacement = fake.data.get(RUNS_KEY)[0];
        fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
        expect(await history.deleteRun(runIdentity(replacement))).toBe(false);
        expect(await history.saveTeamRun('A,B', replacement)).toBe(true);
        expect(history._revived.has(runIdentity(replacement))).toBe(true);
        return replacement;
    }

    test('a manual old-identity removal supersedes an earlier replacement revival without resurrecting on flush', async () => {
        await reviveAfterFailedDelete();
        expect(await history.deleteRun(runIdentity(broken()))).toBe(true);
        expect(await history.getAllRuns()).toEqual([]);
        expect(await history.flushPendingSave()).toBe(false);
        expect(await reload()).toEqual([]);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
    });

    test('a failed translated removal retains its resolved intent over an earlier revival for retry', async () => {
        await reviveAfterFailedDelete();
        fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
        expect(await history.deleteRun(runIdentity(broken()))).toBe(false);
        expect(await history.flushPendingSave()).toBe(true);
        expect(await history.getAllRuns()).toEqual([]);
        expect(await reload()).toEqual([]);
    });

    test('a timed-out translated removal remains effective when its late commit retires the backup before retry', async () => {
        await reviveAfterFailedDelete();
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        storage.writeTimeoutMs = 5;
        const deleting = history.deleteRun(runIdentity(broken()));
        await entered.promise;
        expect(await deleting).toBe(false);
        release.resolve();
        await storage.tryGet(RUNS_KEY, RUNS_STORE);
        expect(fake.data.get(RUNS_KEY)).toEqual([]);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
        storage.writeTimeoutMs = timeout;
        expect(await history.flushPendingSave()).toBe(true);
        expect(await history.getAllRuns()).toEqual([]);
        expect(await reload()).toEqual([]);
    });

    test('repair re-entry resolves pending manual intent after its earlier write failed before the callback', async () => {
        await reviveAfterFailedDelete();
        fake.hooks.fault = { operation: 'get', key: RUNS_DATE_REPAIR_BACKUPS_KEY };
        expect(await history.deleteRun(runIdentity(broken()))).toBe(false);
        expect(await history.repairSwappedDateRuns()).toBe(0);
        expect(await history.getAllRuns()).toEqual([]);
        await history.flushPendingSave();
        expect(await reload()).toEqual([]);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
    });

    test('a timed-out repair re-entry retains resolved manual intent after its late commit retires the mapping', async () => {
        await reviveAfterFailedDelete();
        fake.hooks.fault = { operation: 'get', key: RUNS_DATE_REPAIR_BACKUPS_KEY };
        expect(await history.deleteRun(runIdentity(broken()))).toBe(false);
        const entered = deferred();
        const release = deferred();
        fake.hooks.beforeCommit = async () => {
            entered.resolve();
            await release.promise;
        };
        storage.writeTimeoutMs = 5;
        const repairing = history.repairSwappedDateRuns();
        await entered.promise;
        expect(await repairing).toBeNull();
        release.resolve();
        await storage.tryGet(RUNS_KEY, RUNS_STORE);
        expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
        storage.writeTimeoutMs = timeout;
        expect(await history.flushPendingSave()).toBe(true);
        expect(await history.getAllRuns()).toEqual([]);
        expect(await reload()).toEqual([]);
    });

    test.each(['beforeStart', 'beforeCommit'])(
        'a genuinely later revival at %s is not erased by an earlier translated removal',
        async (boundary) => {
            await history.repairSwappedDateRuns();
            const replacement = fake.data.get(RUNS_KEY)[0];
            const entered = deferred();
            const release = deferred();
            fake.hooks[boundary] = async () => {
                entered.resolve();
                await release.promise;
            };
            const staleDeleting = history.deleteRun(runIdentity(broken()));
            await entered.promise;
            const directDeleting = history.deleteRun(runIdentity(replacement));
            await Promise.resolve();
            expect(await history.saveTeamRun('A,B', replacement)).toBe(true);
            release.resolve();
            expect(await staleDeleting).toBe(true);
            expect(await directDeleting).toBe(true);
            await history.flushPendingSave();
            expect((await reload()).map(runIdentity)).toEqual([runIdentity(replacement)]);
        }
    );
});

describe('translated manual deletion failure boundaries', () => {
    test.each(['read', 'abort'])(
        'a failed %s leaves durable recovery state unchanged and retries the stale manual removal',
        async (boundary) => {
            const other = new history.constructor();
            try {
                await other.getAllRuns();
                await history.repairSwappedDateRuns();
                const before = structuredClone(fake.data);
                if (boundary === 'read') fake.hooks.fault = { operation: 'get', key: RUNS_DATE_REPAIR_BACKUPS_KEY };
                else fake.hooks.abortCommit = true;
                expect(await other.deleteRun(runIdentity(broken()))).toBe(false);
                expect(fake.data).toEqual(before);
                expect(await other.flushPendingSave()).toBe(true);
                expect(await reload()).toEqual([]);
                expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
            } finally {
                other._resetCache();
            }
        }
    );

    test('real teardown retries a failed stale manual removal before closing storage', async () => {
        const other = new history.constructor();
        try {
            await other.getAllRuns();
            await history.repairSwappedDateRuns();
            fake.hooks.fault = { operation: 'put', key: RUNS_KEY };
            expect(await other.deleteRun(runIdentity(broken()))).toBe(false);
            await storage.closeForTeardown();
            await other._persistChain;
            expect(fake.data.get(RUNS_KEY)).toEqual([]);
            expect(fake.data.get(RUNS_DATE_REPAIR_BACKUPS_KEY)).toEqual([]);
        } finally {
            other._resetCache();
        }
    });
});
