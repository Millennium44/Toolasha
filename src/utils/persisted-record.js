/**
 * A record that lives in IndexedDB and cannot be wiped by a bad read.
 *
 * Most of this codebase keeps its history the same way: load the whole record
 * into memory at start-up, mutate it on events, write the whole thing back.
 * That shape has one failure that looks like nothing until the data is gone —
 * a read that could not be made (connection dropped, transaction failed) comes
 * back as the default value, the module takes that for an empty record, and
 * the next event writes the emptiness over everything that was stored. Two
 * tabs on the same character do a slower version of the same thing to each
 * other, each overwriting with its own memory.
 *
 * This helper owns the load/save discipline so a feature need not rediscover
 * it:
 *
 * - **Load** probes with `storage.tryGet`, which tells "absent" from "could
 *   not read". On an unreadable probe the in-memory record stands untouched;
 *   on a readable one the stored record is folded under memory (memory wins
 *   per key), so anything recorded before the load finished is kept.
 * - **Save** re-probes, folds stored under memory, writes the fold — and is
 *   skipped outright when the probe is unreadable. No blind overwrites.
 * - **Saves are serialized**, so two interleaved probe-merge-writes cannot
 *   each miss the other's entries — and coalesced: while one save is running
 *   and another already waits, further saves join the waiting one, which
 *   reads memory when it runs. A record written on every game event cannot
 *   build a backlog behind debounced writes.
 * - **Clear** is the one write allowed to lose entries, and says so.
 *
 * The merge is the record's own business: arrays of entries with ids, maps of
 * scalars, maps of sample series all fold differently. Three are provided
 * below and cover nearly every record in the codebase.
 *
 * Scoping: `scoped: true` (the default) keys the record per character through
 * `character-key.js`, including the one-time legacy adoption `readScoped`
 * performs; `scoped: false` uses the bare key for global records.
 *
 * `atomic: true` is for a record several tabs write. The probe-merge-write
 * above is two transactions: two tabs that both probe before either write
 * commits each write a fold that lacks the other's entries, and the later
 * write wins. An atomic record folds and writes inside one readwrite
 * transaction (`storage.update`), which IndexedDB serializes across every tab,
 * so each fold sees whatever the other tab committed. The coalescing window
 * `storage.set`'s debounce gave is kept by delaying the save itself
 * ({@link ATOMIC_DEFER_MS}): the fold runs when the write does, not when it
 * was asked for. Storage's flushes cannot see a delay that is not theirs, so a
 * hidden tab, a closing page, a sync flush and a character switch each land
 * the waiting save from here. A write that does not commit leaves the record
 * dirty and arms the delayed save again, backing off to
 * {@link ATOMIC_RETRY_MAX_MS} while the database keeps refusing.
 */

import storage from '../core/storage.js';
import { characterKey, readScoped } from './character-key.js';

/**
 * Record → handoff of its newest requested save, until that save has handed
 * its value to `storage.set()` (or given up). A handoff, not the whole save:
 * a debounced `set` settles only when its 3 s timer fires, and waiting on that
 * would hold every sync push for it — or indefinitely, while a restore holds
 * the timer.
 */
const pendingHandoffs = new Map();
/** Record → handoff of the save currently running, which waits on nothing else. */
const runningHandoffs = new Map();

/** How long an `atomic` record waits before it writes: the window `storage.set` debounces over */
const ATOMIC_DEFER_MS = 3000;
/** The longest an `atomic` record waits between retries of a write that did not commit */
const ATOMIC_RETRY_MAX_MS = 60_000;
/** How many times a departing character's failed write is tried again before it is given up */
const ATOMIC_DEPARTING_RETRIES = 5;

/**
 * Every `atomic` record. Their delay is their own rather than storage's, so
 * `storage.flushAll()` cannot see a save still waiting; the flushes that must
 * land one reach it through here.
 */
const atomicRecords = new Set();
let atomicLifecycleHooked = false;

/**
 * Land the waiting atomic saves when the tab is hidden (the last event a
 * discarded tab reliably gets, which is why the entrypoint flushes storage
 * then too) and when the page closes. The close is synchronous on purpose:
 * `storage.onBeforeTeardown` listeners run before the connection closes, and
 * only a transaction opened before their first `await` lands.
 */
function hookAtomicLifecycle() {
    if (atomicLifecycleHooked) return;
    atomicLifecycleHooked = true;
    if (typeof storage.onBeforeTeardown === 'function') {
        storage.onBeforeTeardown(() => {
            for (const record of atomicRecords) record._writeBeforeTeardown();
        });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'hidden') return;
            for (const record of atomicRecords) record._releaseDeferred();
        });
    }
}

/**
 * Wait until every persisted-record save requested so far has handed its
 * value to storage, so a following `storage.flushAll()` writes it.
 *
 * `storage.flushAll()` can only see a value after a record's read/merge step
 * has reached `storage.set()`. A sync fingerprint taken while that step is
 * still reading would omit the newest event entirely. Sync calls this first,
 * then drains storage's own debounce queue.
 *
 * A save queued behind another starts its read only once the one ahead has
 * written — it must see that write, or a clear followed by an add would read
 * the cleared rows back. So: wait for the running saves to hand off, land
 * them, then wait for the queued ones.
 *
 * @returns {Promise<void>}
 */
export async function flushPersistedRecords() {
    // An atomic record's delayed save has not asked storage for anything yet
    for (const record of atomicRecords) record._releaseDeferred();
    if (pendingHandoffs.size === 0) return;
    await Promise.allSettled(Array.from(runningHandoffs.values()));
    await storage.flushAll?.();
    await Promise.allSettled(Array.from(pendingHandoffs.values()));
}

/** @returns {number} Pending record count; test-only diagnostic. */
export function _pendingRecordCountForTests() {
    return pendingHandoffs.size;
}

/**
 * Merge for arrays of entries that carry an identity: the union, keyed by
 * `idOf`, with memory's copy winning for an id both sides have. Order follows
 * `sort` when given, else stored-then-new.
 *
 * A caller that caps the merged pool by age — `slice(-N)` for oldest-first,
 * `slice(0, N)` for newest-first — MUST pass `sort`. Stored-then-new looks
 * age-ordered on one device and is not one across two: a device that has been
 * offline contributes entries older than everything stored, on the new side,
 * and an untimed cap then keeps those and evicts newer ones.
 * @param {(entry: *) => *} idOf - Identity of an entry; entries whose id is null/undefined are dropped
 * @param {(a: *, b: *) => number} [sort] - Final ordering; required when the caller caps by age
 * @returns {(stored: Array, memory: Array) => Array}
 */
export function mergeById(idOf, sort = null) {
    return (stored, memory) => {
        const byId = new Map();
        for (const entry of Array.isArray(stored) ? stored : []) {
            const id = entry == null ? null : idOf(entry);
            if (id !== null && id !== undefined) byId.set(id, entry);
        }
        for (const entry of Array.isArray(memory) ? memory : []) {
            const id = entry == null ? null : idOf(entry);
            if (id !== null && id !== undefined) byId.set(id, entry);
        }
        const merged = [...byId.values()];
        return sort ? merged.sort(sort) : merged;
    };
}

/**
 * Merge for a plain object of values: stored keys memory does not have are
 * kept, memory's value wins wherever both have the key.
 * @returns {(stored: Object, memory: Object) => Object}
 */
export function mergeMaps() {
    return (stored, memory) => ({
        ...(stored && typeof stored === 'object' ? stored : {}),
        ...(memory && typeof memory === 'object' ? memory : {}),
    });
}

/**
 * Merge for a map of sample series (`name → [sample, …]`): per name, the union
 * of samples keyed by `keyOf` (typically the timestamp), memory winning on a
 * clash, ordered by `sort` when given.
 * @param {(sample: *) => *} keyOf - Identity of one sample within a series
 * @param {(a: *, b: *) => number} [sort] - Ordering within a series
 * @returns {(stored: Object, memory: Object) => Object}
 */
export function mergeSeriesMaps(keyOf, sort = null) {
    const mergeSeries = mergeById(keyOf, sort);
    return (stored, memory) => {
        const out = {};
        const names = new Set([
            ...Object.keys(stored && typeof stored === 'object' ? stored : {}),
            ...Object.keys(memory && typeof memory === 'object' ? memory : {}),
        ]);
        for (const name of names) out[name] = mergeSeries(stored?.[name], memory?.[name]);
        return out;
    };
}

/**
 * Create a persisted record.
 *
 * @param {Object} options
 * @param {string} options.base - The storage key (scoped) or bare key (unscoped)
 * @param {string} [options.store='settings'] - Object store name
 * @param {() => *} options.empty - Produces a fresh empty record (`() => []`, `() => ({})`)
 * @param {(stored: *, memory: *) => *} options.merge - Folds the stored record under memory
 * @param {boolean} [options.scoped=true] - Per-character key via character-key.js
 * @param {'adopt'|'discard'} [options.migrate='adopt'] - Legacy-adoption mode for scoped reads
 * @param {boolean} [options.immediate=false] - Write without debouncing
 * @param {string} [options.label='PersistedRecord'] - Log prefix
 * @param {() => Promise<*>} [options.prepare] - Run after every readable probe and before the
 *   merge it feeds, for a merge that needs something else read fresh first (another key's
 *   tombstones, say). Resolving `false` says that read could not be made, and stands the load
 *   or save down exactly as an unreadable probe does; a reset during it does the same.
 * @param {boolean} [options.atomic=false] - Fold and write in one `storage.update` transaction,
 *   delayed by {@link ATOMIC_DEFER_MS} unless `immediate` (see the module header)
 * @param {(stored: *, memory: *) => *} [options.mergeAfterReset] - The fold for an atomic write a
 *   `reset()` overtook: it lands the departing record under the departing key, so it must not
 *   touch state the arriving record owns. Defaults to `merge`
 * @returns {Object} The record handle — see methods below
 */
export function createPersistedRecord({
    base,
    store = 'settings',
    empty,
    merge,
    scoped = true,
    migrate = 'adopt',
    immediate = false,
    label = 'PersistedRecord',
    prepare = null,
    atomic = false,
    mergeAfterReset = null,
}) {
    if (typeof empty !== 'function') throw new Error(`[${label}] createPersistedRecord needs an empty() factory`);
    if (typeof merge !== 'function') throw new Error(`[${label}] createPersistedRecord needs a merge(stored, memory)`);

    let memory = empty();
    let loaded = false;
    /**
     * Bumped every time something replaces the in-memory record. An
     * `authoritative` load compares it across its own probe to tell "nothing
     * touched this while I was reading" from "an edit landed mid-load".
     */
    let memoryVersion = 0;
    let saveChain = Promise.resolve();
    let saving = false;
    /** The merge-save waiting behind the running one, which later saves join */
    let waitingSave = null;
    /**
     * Bumped by `reset()`. A load or save that started before a reset finds
     * the number changed when its probe returns and stands down: otherwise a
     * save in flight across a character switch would fold the departing
     * character's stored record into the arriving one's memory and write it
     * under the arriving one's key.
     */
    let generation = 0;

    const key = () => (scoped ? characterKey(base) : base);

    /**
     * The stored record as `{found, value}`, or null when it could not be read.
     * @returns {Promise<{found: boolean, value: *}|null>}
     */
    const probe = () => storage.tryGet(key(), store);

    /**
     * Whether saves take the one-transaction path. A storage without `update`
     * (a test double) gets the probe-and-write path instead.
     * @returns {boolean}
     */
    const isAtomic = () => atomic && typeof storage.update === 'function';
    const deferMs = atomic && !immediate ? ATOMIC_DEFER_MS : 0;
    /** The delayed save that every save asked for meanwhile joins: `{promise, resolve, timer}` */
    let deferred = null;
    /** An atomic save has been asked for and its transaction not yet opened */
    let unwritten = false;
    /** The key that unwritten save was asked for under, which a reset must still write to */
    let unwrittenKey = null;
    /** The last write opened outside the save chain (page close, reset), for `flushed()` */
    let directWrite = Promise.resolve(true);
    /** Atomic writes that have failed in a row since the last one committed, for the retry back-off */
    let failedWrites = 0;

    /**
     * Arm the delayed save: every save asked for before it fires joins it.
     * @param {number} delayMs
     * @returns {Promise<boolean>} The delayed save's outcome
     */
    const armDeferred = (delayMs) => {
        let resolve;
        const promise = new Promise((r) => {
            resolve = r;
        });
        deferred = { promise, resolve, timer: setTimeout(() => record._releaseDeferred(), delayMs) };
        return promise;
    };

    /**
     * An atomic write that did not commit — aborted, timed out, refused — leaves
     * the record dirty and asks for the write again, backing off while the
     * database keeps refusing. A save already waiting carries memory anyway, so
     * none is armed then. A write a `reset()` overtook carries a record that has
     * left memory, so it is retried on its own (see `retryDeparting`).
     * @param {boolean} written - Whether the write committed
     * @param {string} writeKey - The key it was for
     * @param {number} askedIn - The generation it belongs to
     * @param {*} held - The record the write carried
     */
    const noteWriteOutcome = (written, writeKey, askedIn, held) => {
        if (written) {
            if (askedIn === generation) failedWrites = 0;
            return;
        }
        if (askedIn !== generation) {
            retryDeparting(writeKey, held, 1);
            return;
        }
        if (!unwritten) {
            unwritten = true;
            unwrittenKey = writeKey;
        }
        failedWrites += 1;
        if (deferred || waitingSave) return;
        armDeferred(Math.min(ATOMIC_RETRY_MAX_MS, ATOMIC_DEFER_MS * 2 ** (failedWrites - 1)));
    };

    /**
     * Write a departing record again after its write failed: a character switch
     * had already taken it out of memory, so nothing else would. Folded with
     * `mergeAfterReset` under the key it was asked for, backing off, a bounded
     * number of times.
     * @param {string} writeKey
     * @param {*} held
     * @param {number} attempt - 1 for the first retry
     */
    const retryDeparting = (writeKey, held, attempt) => {
        if (attempt > ATOMIC_DEPARTING_RETRIES) {
            console.error(`[${label}] ${base}: the departing character's last write could not be saved`);
            return;
        }
        const delay = Math.min(ATOMIC_RETRY_MAX_MS, ATOMIC_DEFER_MS * 2 ** (attempt - 1));
        setTimeout(() => {
            let outcome;
            try {
                outcome = storage.update(
                    writeKey,
                    (current, found) => (!found || current == null ? held : (mergeAfterReset || merge)(current, held)),
                    store
                );
            } catch (error) {
                outcome = Promise.reject(error);
            }
            directWrite = Promise.resolve(outcome)
                .then(
                    (result) => Boolean(result?.written),
                    () => false
                )
                .then((written) => {
                    if (!written) retryDeparting(writeKey, held, attempt + 1);
                    return written;
                });
        }, delay);
    };

    /**
     * Open the read-merge-write transaction for memory as it is now.
     *
     * Synchronous up to `storage.update`'s first `await`, which comes after it
     * has opened the transaction whenever the connection is up — what a
     * page-close listener needs. The fold runs inside the transaction, against
     * whatever another tab committed before it. A `reset()` in between makes it
     * the departing record's write: folded with `mergeAfterReset`, and kept out
     * of the arriving record's memory. One that does not commit is retried (see
     * `noteWriteOutcome`).
     * @param {string} writeKey - The key, resolved by the caller
     * @param {number} askedIn - The generation this write belongs to
     * @returns {Promise<boolean>} Whether a write committed
     */
    const issueUpdate = (writeKey, askedIn) => {
        const held = memory;
        unwritten = false;
        let outcome;
        try {
            outcome = storage.update(
                writeKey,
                (current, found) => {
                    if (!found || current == null) return held;
                    const live = askedIn === generation;
                    const folded = (live ? merge : mergeAfterReset || merge)(current, held);
                    if (live && memory === held) {
                        memory = folded;
                        memoryVersion += 1;
                    }
                    return folded;
                },
                store
            );
        } catch (error) {
            outcome = Promise.reject(error);
        }
        return Promise.resolve(outcome)
            .then(
                (result) => Boolean(result?.written),
                (error) => {
                    console.error(`[${label}] Saving ${base} failed:`, error);
                    return false;
                }
            )
            .then((written) => {
                noteWriteOutcome(written, writeKey, askedIn, held);
                return written;
            });
    };

    const record = {
        /** @returns {*} The in-memory record (live reference) */
        get() {
            return memory;
        },

        /**
         * Replace the in-memory record. Saves still merge what is stored
         * under it, so this never by itself discards stored entries.
         * @param {*} value - The new record
         */
        set(value) {
            memory = value == null ? empty() : value;
            memoryVersion += 1;
        },

        /** @returns {boolean} Whether a readable load has completed */
        isLoaded() {
            return loaded;
        },

        /**
         * Load from storage. An unreadable probe leaves memory as it is — the
         * whole point — and reports `false`; a readable one folds the stored
         * record under memory and reports `true`.
         *
         * `authoritative` is for a caller that wants what is STORED rather than
         * what is stored folded under what it happens to be holding — a
         * re-read of the whole record, as a character switch or a panel reopen
         * wants. The naive way to get that is to blank memory before starting
         * the load, and that is a hole: the record is shared, so between the
         * blanking and the probe returning, anything else that saves is folding
         * against an empty record. So the discarding happens HERE, after the
         * probe, and only when nothing replaced the record while the read was
         * in flight — an edit that landed mid-load is still folded in, exactly
         * as an ordinary load would.
         * @param {Object} [options]
         * @param {boolean} [options.authoritative=false] - Prefer stored over held
         * @returns {Promise<boolean>} Whether storage could be read
         */
        async load({ authoritative = false } = {}) {
            const started = generation;
            const startedVersion = memoryVersion;
            try {
                const probed = await probe();
                if (probed === null) {
                    console.warn(`[${label}] ${base} could not be read; keeping the in-memory record`);
                    return false;
                }
                if (started !== generation) return false;
                let stored;
                if (probed.found) {
                    stored = probed.value;
                } else if (scoped) {
                    // A trustworthy "absent" — let readScoped do its one-time
                    // legacy adoption, which is the only other place the value
                    // could be
                    stored = await readScoped(base, store, null, { migrate });
                    if (started !== generation) return false;
                } else {
                    stored = null;
                }
                if (prepare) {
                    if ((await prepare()) === false) {
                        console.warn(`[${label}] ${base} not loaded: what its merge needs could not be read`);
                        return false;
                    }
                    if (started !== generation) return false;
                }
                const under = authoritative && memoryVersion === startedVersion ? empty() : memory;
                memory = stored == null ? merge(empty(), under) : merge(stored, under);
                memoryVersion += 1;
                loaded = true;
                return true;
            } catch (error) {
                console.error(`[${label}] Loading ${base} failed; keeping the in-memory record:`, error);
                return false;
            }
        },

        /**
         * Save to storage: probe, fold stored under memory, write the fold.
         * Skipped — memory kept, `false` returned — when the probe is
         * unreadable, because a blind overwrite is the accident this exists to
         * prevent. Serialized with every other save of this record, and
         * coalesced: a save asked for while one runs and another waits
         * returns the waiting one, since that will fold in the memory of the
         * moment it runs.
         *
         * An `atomic` record's save waits {@link ATOMIC_DEFER_MS} first (not
         * when `immediate`), and every save asked for meanwhile joins it.
         * @param {Object} [options]
         * @param {boolean} [options.overwrite=false] - Write memory as-is; for
         *   intentional removals only
         * @returns {Promise<boolean>} Whether a write landed
         */
        save({ overwrite = false } = {}) {
            if (overwrite || !isAtomic()) return record._queueSave({ overwrite });
            if (!unwritten) unwrittenKey = key();
            unwritten = true;
            if (deferMs === 0) return record._queueSave({ overwrite: false });
            return deferred ? deferred.promise : armDeferred(deferMs);
        },

        /** Start the delayed atomic save now, if one is waiting. */
        _releaseDeferred() {
            const waiting = deferred;
            if (!waiting) return;
            deferred = null;
            clearTimeout(waiting.timer);
            waiting.resolve(record._queueSave({ overwrite: false }));
        },

        /**
         * The page is closing: open the transaction for an unwritten atomic
         * save before the connection goes. There is no awaiting `prepare` now,
         * so the fold uses what memory holds.
         */
        _writeBeforeTeardown() {
            if (!unwritten || !isAtomic()) return;
            const waiting = deferred;
            deferred = null;
            if (waiting) clearTimeout(waiting.timer);
            directWrite = issueUpdate(key(), generation);
            waiting?.resolve(directWrite);
        },

        /**
         * One probe-merge-write — or, atomic, one `storage.update` — queued
         * behind the saves already asked for. See `save`.
         * @param {Object} [options]
         * @param {boolean} [options.overwrite=false] - As `save`
         * @returns {Promise<boolean>} Whether a write landed
         * @private
         */
        _queueSave({ overwrite = false } = {}) {
            if (!overwrite && saving && waitingSave) return waitingSave;
            /**
             * The generation the save was ASKED FOR in, not the one its queued
             * run happens to start in. An `overwrite` write takes no probe, so
             * the check below is the only thing between it and storage — and
             * `clear()` is precisely the write that is meant to lose entries.
             * A clear asked for on one character while another save is in
             * flight starts running only once that save settles, by which time
             * a switch can have landed: `reset()` has emptied memory and moved
             * the key, so the run wrote an empty record over the *arriving*
             * character's stored one.
             */
            const askedIn = generation;
            let handOff;
            const handedOff = new Promise((resolve) => {
                handOff = resolve;
            });
            const run = async () => {
                runningHandoffs.set(record, handedOff);
                saving = true;
                if (waitingSave === promise) waitingSave = null;
                const started = generation;
                // One key for the probe and the write both, resolved before the
                // read rather than again after it
                const writeKey = scoped ? characterKey(base) : base;
                try {
                    if (overwrite && askedIn !== generation) return false;
                    if (!overwrite && isAtomic()) {
                        if (prepare) {
                            if ((await prepare()) === false) {
                                console.warn(`[${label}] ${base} not saved: what its merge needs could not be read`);
                                // Still dirty, and its timer is spent: ask again, as for a write that failed
                                if (started === generation) noteWriteOutcome(false, writeKey, started, memory);
                                return false;
                            }
                            if (started !== generation) return false;
                        }
                        const written = await issueUpdate(writeKey, started);
                        handOff();
                        return written;
                    }
                    if (!overwrite) {
                        const probed = await storage.tryGet(writeKey, store);
                        if (probed === null) {
                            console.warn(`[${label}] ${base} not saved: storage could not be read first`);
                            return false;
                        }
                        if (started !== generation) return false;
                        if (prepare && probed.found) {
                            if ((await prepare()) === false) {
                                console.warn(`[${label}] ${base} not saved: what its merge needs could not be read`);
                                return false;
                            }
                            if (started !== generation) return false;
                        }
                        if (probed.found) {
                            memory = merge(probed.value, memory);
                            memoryVersion += 1;
                        }
                    }
                    // Resolved before the call: `set` queues the value synchronously
                    // when the database is open, ahead of any flush this wakes.
                    handOff();
                    return await storage.set(writeKey, memory, store, immediate);
                } catch (error) {
                    console.error(`[${label}] Saving ${base} failed:`, error);
                    return false;
                } finally {
                    handOff();
                    if (runningHandoffs.get(record) === handedOff) runningHandoffs.delete(record);
                    saving = false;
                }
            };
            const promise = saveChain.then(run, run);
            if (!overwrite) waitingSave = promise;
            saveChain = promise;
            // Registered at request time, before `run` reaches its first await,
            // so a sync flush sees a save still waiting to read/merge. A newer
            // save owns the slot immediately; an older one handing off must not
            // unregister it.
            pendingHandoffs.set(record, handedOff);
            handedOff.then(() => {
                if (pendingHandoffs.get(record) === handedOff) pendingHandoffs.delete(record);
            });
            return promise;
        },

        /**
         * Mutate the in-memory record and save. `fn` may mutate in place, or
         * return a replacement record (an object or array). Scalar returns —
         * `Array.prototype.push`'s new length, say — are ignored, so a bare
         * `(log) => log.push(entry)` does what it looks like.
         * @param {(current: *) => *} fn - The mutation
         * @returns {Promise<boolean>} Whether the save landed
         */
        async update(fn) {
            const next = fn(memory);
            if (next !== null && typeof next === 'object') memory = next;
            return record.save();
        },

        /**
         * Empty the record, in memory and in storage — the one write that is
         * meant to lose entries.
         * @returns {Promise<boolean>} Whether the write landed
         */
        async clear() {
            memory = empty();
            memoryVersion += 1;
            return record.save({ overwrite: true });
        },

        /**
         * Forget the in-memory record without touching storage — for a
         * character switch, before the next load reads the other character's
         * key. Nothing is written — except by an `atomic` record holding a
         * save it has not written yet, which writes it now, under the key it
         * was asked for under, rather than lose the departing record's last
         * changes to its own delay.
         */
        reset() {
            if (unwritten && isAtomic()) {
                const waiting = deferred;
                deferred = null;
                if (waiting) clearTimeout(waiting.timer);
                directWrite = issueUpdate(unwrittenKey ?? key(), generation);
                waiting?.resolve(directWrite);
            }
            memory = empty();
            memoryVersion += 1;
            loaded = false;
            generation += 1;
        },

        /**
         * Start a delayed save now, and wait for every write asked for so far.
         * @returns {Promise<*>} The pending saves, for tests and shutdown
         */
        flushed() {
            if (!atomic) return saveChain;
            record._releaseDeferred();
            return Promise.all([saveChain, directWrite]).then(([chained]) => chained);
        },
    };

    if (atomic) {
        atomicRecords.add(record);
        hookAtomicLifecycle();
    }
    return record;
}

/**
 * A persisted record for a user-curated list: a watchlist, a favourites map,
 * a checkbox state.
 *
 * The plain record folds stored under memory on every save, which is right
 * for a history — nothing recorded is meant to disappear — and wrong for a
 * list the user edits: an item they took off would come back from storage on
 * the next save. So here the merge is used only until a readable load has
 * completed (so an edit made before the load finished is not lost, and a
 * save before any load cannot erase what is stored); from then on memory is
 * the list, and saves write it as-is. The probe-and-refuse on an unreadable
 * store still applies, which is the protection that matters. `reset()` (a
 * character switch) goes back to merging until the next readable load.
 *
 * `keepMerging: true` opts out of trusting memory: every save folds through
 * `merge`, which must then carry removals itself (the enhancement sessions
 * keep tombstones). That is for a list two tabs edit at once, where memory
 * written whole puts back what the other tab removed and drops what it added.
 *
 * @param {Object} options - As {@link createPersistedRecord}; `merge` defaults
 *   to {@link mergeMaps} and is only consulted before the first readable load
 *   unless `keepMerging` is set
 * @param {boolean} [options.keepMerging=false] - Merge on every save, not only before the first load
 * @returns {Object} The record handle
 */
export function createCuratedRecord({ merge = mergeMaps(), keepMerging = false, ...options }) {
    let trustMemory = false;
    const record = createPersistedRecord({
        ...options,
        merge: (stored, memory) => (trustMemory && !keepMerging ? memory : merge(stored, memory)),
    });
    const { load, reset } = record;
    record.load = async (options) => {
        trustMemory = false;
        const readable = await load(options);
        trustMemory = readable;
        return readable;
    };
    record.reset = () => {
        trustMemory = false;
        reset();
    };
    return record;
}

export default {
    createPersistedRecord,
    createCuratedRecord,
    _pendingRecordCountForTests,
    flushPersistedRecords,
    mergeById,
    mergeMaps,
    mergeSeriesMaps,
};
