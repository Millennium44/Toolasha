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
 */

import storage from '../core/storage.js';
import { characterKey, readScoped, writeScoped } from './character-key.js';

/**
 * Merge for arrays of entries that carry an identity: the union, keyed by
 * `idOf`, with memory's copy winning for an id both sides have. Order follows
 * `sort` when given, else stored-then-new.
 * @param {(entry: *) => *} idOf - Identity of an entry; entries whose id is null/undefined are dropped
 * @param {(a: *, b: *) => number} [sort] - Final ordering
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
         * @param {Object} [options]
         * @param {boolean} [options.overwrite=false] - Write memory as-is; for
         *   intentional removals only
         * @returns {Promise<boolean>} Whether a write landed
         */
        save({ overwrite = false } = {}) {
            if (!overwrite && saving && waitingSave) return waitingSave;
            const run = async () => {
                saving = true;
                if (waitingSave === promise) waitingSave = null;
                const started = generation;
                try {
                    if (!overwrite) {
                        const probed = await probe();
                        if (probed === null) {
                            console.warn(`[${label}] ${base} not saved: storage could not be read first`);
                            return false;
                        }
                        if (started !== generation) return false;
                        if (probed.found) {
                            memory = merge(probed.value, memory);
                            memoryVersion += 1;
                        }
                    }
                    return scoped
                        ? await writeScoped(base, memory, store, immediate)
                        : await storage.set(base, memory, store, immediate);
                } catch (error) {
                    console.error(`[${label}] Saving ${base} failed:`, error);
                    return false;
                } finally {
                    saving = false;
                }
            };
            const promise = saveChain.then(run, run);
            if (!overwrite) waitingSave = promise;
            saveChain = promise;
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
         * key. Nothing is written.
         */
        reset() {
            memory = empty();
            memoryVersion += 1;
            loaded = false;
            generation += 1;
        },

        /** @returns {Promise<*>} The pending save chain, for tests and shutdown */
        flushed() {
            return saveChain;
        },
    };

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
 * @param {Object} options - As {@link createPersistedRecord}; `merge` defaults
 *   to {@link mergeMaps} and is only consulted before the first readable load
 * @returns {Object} The record handle
 */
export function createCuratedRecord({ merge = mergeMaps(), ...options }) {
    let trustMemory = false;
    const record = createPersistedRecord({
        ...options,
        merge: (stored, memory) => (trustMemory ? memory : merge(stored, memory)),
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

export default { createPersistedRecord, createCuratedRecord, mergeById, mergeMaps, mergeSeriesMaps };
