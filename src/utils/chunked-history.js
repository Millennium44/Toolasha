/**
 * Append-only history, stored as records rather than as one array.
 *
 * ## The write amplification this exists to end
 *
 * A recorder that keeps its history in a single key does the same three things
 * on every event: read the whole array, push one entry, write the whole array
 * back. The cost of recording one loot drop is therefore the size of every loot
 * drop already recorded, and it grows for as long as the player keeps playing —
 * which is the shape of every quota failure this script has had. The loot log
 * rewrote five hundred entries per `loot_log_updated`; the alchemy trackers
 * rewrote every session ever, immediately, on every completed action.
 *
 * Splitting the array over several keys makes the write proportional to what
 * changed instead of to what is kept. A new entry lands in one record; the other
 * records are untouched, so IndexedDB never sees them.
 *
 * ## Chunks, not one key per entry
 *
 * A key per entry would make every write minimal, and would also put a thousand
 * keys per character into a store whose soft budget is measured in hundreds (see
 * `STORE_KEY_BUDGETS` in `core/storage.js`). Grouping entries by the hour, day or
 * month they belong to keeps both numbers small: the record written is the
 * current bucket, which holds the handful of entries recorded since the bucket
 * opened, and the key count grows with calendar time rather than with events.
 *
 * ## What the callers keep
 *
 * Nothing above this changes shape. A recorder still holds its history as one
 * array, still hands the whole array to `save()`, and still gets the whole array
 * back from `load()`. The diff against the last known state is what turns a
 * whole-array save into a one-record write, so the call sites did not have to
 * learn about chunking to stop paying for it.
 *
 * ## Migration, and what happens when the disk is full
 *
 * The legacy single-array key is split on the first read and then deleted. If
 * the split cannot be written — which on a full disk is exactly when it matters —
 * the legacy key is left alone and the recorder keeps using it. A migration that
 * bricked the history the moment storage filled up would be worse than the write
 * amplification it was meant to fix.
 */

import storage from '../core/storage.js';

/** Two digits, for a date part */
const pad = (value) => String(value).padStart(2, '0');

/**
 * Which bucket a timestamp falls in.
 *
 * UTC rather than local time, so a chunk id does not change meaning when the
 * player travels or the clocks go back — a record written in one zone has to be
 * found again from another.
 *
 * @param {number} t - Milliseconds since the epoch
 * @param {'month'|'day'|'hour'} granularity - How wide a bucket is
 * @returns {string} A sortable id: `YYYY-MM`, `YYYY-MM-DD` or `YYYY-MM-DDTHH`
 */
export function timeChunkId(t, granularity = 'month') {
    const date = new Date(Number.isFinite(t) ? t : 0);
    const month = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
    if (granularity === 'month') return month;
    const day = `${month}-${pad(date.getUTCDate())}`;
    if (granularity === 'day') return day;
    return `${day}T${pad(date.getUTCHours())}`;
}

/**
 * The character ids a set of record keys names.
 *
 * Record keys are `<prefix>_<characterId>_<chunkId>`, so the id is the segment
 * between the prefix and the next underscore. Character ids are alphanumeric
 * (see `NETWORTH_SERIES_RE` in `utils/character-key.js`), which is what makes
 * that split unambiguous.
 *
 * @param {Array<string>} keys - Keys from one store
 * @param {string} prefix - The record prefix including its trailing underscore
 * @returns {Array<string>} Character ids, in key order, deduplicated
 */
export function idsFromRecordKeys(keys, prefix) {
    const ids = [];
    const seen = new Set();
    for (const key of keys || []) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const end = rest.indexOf('_');
        if (end <= 0) continue;
        const id = rest.slice(0, end);
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * Every record key in a store belonging to one character.
 *
 * @param {Array<string>} keys - Keys from one store
 * @param {string} prefix - The record prefix, without its trailing underscore
 * @param {string} charId - Whose records to pick out
 * @returns {Array<string>} Matching keys, in chunk-id order
 */
export function recordKeysFor(keys, prefix, charId) {
    const scoped = `${prefix}_${charId}_`;
    return (keys || []).filter((key) => typeof key === 'string' && key.startsWith(scoped)).sort();
}

/**
 * A history kept as one record per time bucket.
 *
 * @param {Object} options - Wiring
 * @param {string} options.storeName - Object store the records live in
 * @param {string} options.prefix - Record key prefix, e.g. `lootLogRec`
 * @param {Function} options.legacyKey - `(charId) => string`, the pre-split single key
 * @param {Function} options.groupOf - `(entry) => string`, which chunk an entry belongs to
 * @param {Function} options.compare - Sort comparator for the assembled array
 * @param {boolean} [options.immediate] - Skip write debouncing, for recorders that did
 * @param {string} [options.label] - Module name for log lines
 * @returns {ChunkedHistory} The store
 */
export function createChunkedHistory(options) {
    return new ChunkedHistory(options);
}

class ChunkedHistory {
    constructor({ storeName, prefix, legacyKey, groupOf, compare, immediate = false, label = 'ChunkedHistory' }) {
        this.storeName = storeName;
        this.prefix = prefix;
        this.legacyKey = legacyKey;
        this.groupOf = groupOf;
        this.compare = compare;
        this.immediate = immediate;
        this.label = label;

        /** Whose records are in memory */
        this._charId = null;
        /** Whether a read has happened for that character */
        this._loaded = false;
        /** The assembled array, which is the truth between flushes */
        this._entries = [];
        /** chunkId → {json, count} last written for it, so a save can write only what moved */
        this._snapshot = new Map();
        /**
         * Whether the split failed and the legacy key is still the record.
         *
         * Set when a migration could not be written — a full disk, a database
         * that will not answer. Reads and writes then go to the legacy key as
         * they always did, and the next session tries the split again.
         */
        this._legacy = false;
    }

    /**
     * @param {string} charId - Whose record
     * @param {string} chunkId - Which bucket
     * @returns {string} The key that bucket lives under
     */
    keyFor(charId, chunkId) {
        return `${this.prefix}_${charId}_${chunkId}`;
    }

    /** @returns {boolean} True while the legacy single-array key is still in use */
    isLegacy() {
        return this._legacy;
    }

    /**
     * The whole history, oldest or newest first per the comparator.
     *
     * Returns a copy: the array held here is what the next save diffs against,
     * and a caller that sorted or spliced the live one would make that diff a
     * lie. The entry objects themselves are shared, which is what lets a
     * recorder mutate the session it is in the middle of.
     *
     * @param {string} charId - Whose history
     * @returns {Promise<Array<Object>>} The assembled entries
     */
    async load(charId) {
        if (!charId) return [];
        if (this._loaded && this._charId === charId) return [...this._entries];

        this._charId = charId;
        this._loaded = true;
        this._entries = [];
        this._snapshot = new Map();
        this._legacy = false;

        try {
            const legacy = await storage.get(this.legacyKey(charId), this.storeName, null);

            if (Array.isArray(legacy) && legacy.length > 0) {
                const split = await this._migrate(charId, legacy);
                this._legacy = !split;
                this._entries = this._sorted(legacy);
                return [...this._entries];
            }

            if (Array.isArray(legacy)) {
                // An empty legacy array is nothing to split and nothing to keep
                await storage.delete(this.legacyKey(charId), this.storeName);
            }

            this._entries = await this._readRecords(charId);
        } catch (error) {
            console.error(`[${this.label}] Reading the history failed:`, error);
            this._entries = [];
        }

        return [...this._entries];
    }

    /**
     * Persist a whole history, writing only the chunks that moved.
     *
     * Deliberately not awaited by most callers: the debounced write's promise
     * resolves when its timer fires, so awaiting it would stall the caller for
     * the debounce delay. `storage.flushAll()` on unload is what lands the last
     * one.
     *
     * @param {string} charId - Whose history
     * @param {Array<Object>} entries - The history as it now stands
     * @param {Object} [options] - Save options
     * @param {string|Array<string>|Set<string>} [options.changedChunks] - Chunk ids that may have
     *   changed since the last save. An append knows exactly one — `groupOf(entry)` — and passing
     *   it skips serialising every other chunk just to discover they are identical. Omit it and
     *   every chunk is compared, which is always correct and always the full cost.
     * @returns {Promise<boolean>} False when there was nowhere to write it
     */
    async save(charId, entries, options = {}) {
        if (!charId) return false;

        // A save before any read has nothing to diff against, and taking the
        // list as the whole truth would delete every chunk it does not mention
        if (!this._loaded || this._charId !== charId) await this.load(charId);

        const list = Array.isArray(entries) ? entries : [];
        this._entries = this._sorted(list);

        if (this._legacy) {
            storage.set(this.legacyKey(charId), list, this.storeName, this.immediate);
            return true;
        }

        const grouped = this._group(list);
        const next = new Map();
        const pending = [];

        // A history of a year of hourly records is hundreds of chunks, and
        // appending one entry used to re-serialise all of them on every append
        // purely to find the one that moved. A caller that knows which chunk it
        // touched says so, and the rest are carried over from the snapshot
        // untouched.
        const changedChunks = normalizeChunkHint(options.changedChunks);

        for (const [chunkId, bucket] of grouped) {
            const previous = this._snapshot.get(chunkId);

            // Only skip a chunk the caller vouched for AND that we have a previous
            // serialisation of — a chunk we have never written has to be written
            // whatever the hint says. The entry count is the safety net: a prune that
            // took *some* entries out of an older chunk leaves it out of the hint of an
            // appending caller, and skipping it would carry the stale serialisation
            // forward so the shrink never reached disk. Counting is free next to
            // serialising, and a chunk only ever shrinks by losing entries.
            if (
                changedChunks &&
                !changedChunks.has(chunkId) &&
                previous !== undefined &&
                previous.count === bucket.length
            ) {
                next.set(chunkId, previous);
                continue;
            }

            const serialized = JSON.stringify(bucket);
            next.set(chunkId, { json: serialized, count: bucket.length });
            if (previous?.json === serialized) continue;
            const write = storage.set(this.keyFor(charId, chunkId), bucket, this.storeName, this.immediate);
            if (this.immediate) pending.push(write);
        }

        // A rolling window drops its oldest entries; here that is a chunk that
        // no longer has any, and pruning is deleting its key
        for (const chunkId of this._snapshot.keys()) {
            if (next.has(chunkId)) continue;
            pending.push(storage.delete(this.keyFor(charId, chunkId), this.storeName));
        }

        this._snapshot = next;

        if (pending.length > 0) await Promise.all(pending);
        return true;
    }

    /**
     * Forget one character's history entirely, records and legacy key alike.
     * @param {string} charId - Whose history
     * @returns {Promise<void>}
     */
    async clear(charId) {
        if (!charId) return;

        try {
            const keys = await storage.getAllKeys(this.storeName);
            // Issued together rather than awaited one at a time: a year of
            // hourly records is hundreds of keys, and each serial await is a
            // full transaction round trip.
            const deletions = recordKeysFor(keys, this.prefix, charId).map((key) =>
                storage.delete(key, this.storeName)
            );
            deletions.push(storage.delete(this.legacyKey(charId), this.storeName));
            await Promise.all(deletions);
        } catch (error) {
            console.error(`[${this.label}] Clearing the history failed:`, error);
        }

        this.forget();
    }

    /**
     * Drop the in-memory copy, so the next read comes from storage.
     *
     * What a character switch needs: the departing character's entries must not
     * be served to the arriving one, and — far worse — must not be written back
     * under the arriving one's key.
     */
    forget() {
        this._charId = null;
        this._loaded = false;
        this._entries = [];
        this._snapshot = new Map();
        this._legacy = false;
    }

    /**
     * Split a legacy array into records and remove it.
     *
     * @param {string} charId - Whose history
     * @param {Array<Object>} legacy - The single-array value as stored
     * @returns {Promise<boolean>} True when the records are now the record
     * @private
     */
    async _migrate(charId, legacy) {
        const grouped = this._group(legacy);
        if (grouped.size === 0) return false;

        const records = {};
        for (const [chunkId, bucket] of grouped) records[this.keyFor(charId, chunkId)] = bucket;

        const written = await storage.putAll(this.storeName, records);
        if (written !== grouped.size || storage.isQuotaExceeded()) {
            console.warn(
                `[${this.label}] Splitting the stored history stalled (${written}/${grouped.size} chunks) — ` +
                    'keeping the single key and reading from it'
            );
            return false;
        }

        // Records from an interrupted earlier attempt would otherwise show up
        // beside the ones just written, as entries nothing put there
        try {
            const keys = await storage.getAllKeys(this.storeName);
            await Promise.all(
                recordKeysFor(keys, this.prefix, charId)
                    .filter((key) => !(key in records))
                    .map((key) => storage.delete(key, this.storeName))
            );
        } catch (error) {
            console.error(`[${this.label}] Clearing stale chunks failed:`, error);
        }

        const removed = await storage.delete(this.legacyKey(charId), this.storeName);
        if (!removed) {
            // The legacy key outliving the split is the one state that loses
            // data: the next load would read it and overwrite everything
            // recorded since. Stay on it until it can actually be removed.
            console.warn(`[${this.label}] The legacy key could not be removed — continuing to use it`);
            return false;
        }

        this._snapshot = new Map();
        for (const [chunkId, bucket] of grouped) {
            this._snapshot.set(chunkId, { json: JSON.stringify(bucket), count: bucket.length });
        }
        return true;
    }

    /**
     * Read every record of one character back into one array.
     *
     * Named keys rather than `getAll()`: these stores hold other things too — a
     * year of item-level networth snapshots, another feature's keys — and a
     * whole-store read would pull all of it into memory to assemble a series of
     * timestamps and totals. But the named keys go out in one `getMany`
     * transaction rather than one transaction apiece; a character with a year of
     * hourly records was paying several hundred round trips to open a panel.
     *
     * @param {string} charId - Whose records
     * @returns {Promise<Array<Object>>} The assembled entries
     * @private
     */
    async _readRecords(charId) {
        const keys = await storage.getAllKeys(this.storeName);
        const recordKeys = recordKeysFor(keys, this.prefix, charId);
        if (recordKeys.length === 0) return [];

        const buckets = await storage.getMany(recordKeys, this.storeName);
        const entries = [];
        const prefixLength = `${this.prefix}_${charId}_`.length;

        // recordKeys order, not Map order, so the snapshot and the assembled
        // list are built in the same deterministic order as before
        for (const key of recordKeys) {
            const bucket = buckets.get(key);
            if (!Array.isArray(bucket)) continue;
            this._snapshot.set(key.slice(prefixLength), { json: JSON.stringify(bucket), count: bucket.length });
            entries.push(...bucket);
        }

        return this._sorted(entries);
    }

    /**
     * @param {Array<Object>} entries - Entries in any order
     * @returns {Map<string, Array<Object>>} chunkId → its entries, in input order
     * @private
     */
    _group(entries) {
        const grouped = new Map();
        for (const entry of entries || []) {
            if (entry == null) continue;
            const chunkId = this.groupOf(entry);
            if (chunkId === null || chunkId === undefined || chunkId === '') continue;
            const id = String(chunkId);
            const bucket = grouped.get(id);
            if (bucket) bucket.push(entry);
            else grouped.set(id, [entry]);
        }
        return grouped;
    }

    /**
     * @param {Array<Object>} entries - Entries in any order
     * @returns {Array<Object>} A new array in the comparator's order
     * @private
     */
    _sorted(entries) {
        return this.compare ? [...entries].sort(this.compare) : [...entries];
    }
}

/**
 * Normalise a changed-chunk hint into a Set of string ids, or null for "no hint".
 * @param {string|number|Array|Set|null|undefined} hint - What the caller passed
 * @returns {Set<string>|null} The chunk ids to re-serialise, or null for all of them
 */
function normalizeChunkHint(hint) {
    if (hint === null || hint === undefined) return null;
    if (hint instanceof Set) return new Set([...hint].map(String));
    if (Array.isArray(hint)) return new Set(hint.map(String));
    return new Set([String(hint)]);
}

export default { createChunkedHistory, timeChunkId, idsFromRecordKeys, recordKeysFor };
