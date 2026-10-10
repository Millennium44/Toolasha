/**
 * Loot Log History Storage
 * Persists loot log entries to IndexedDB for extended history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { createChunkedHistory, timeChunkId, recordKeysFor } from '../../utils/chunked-history.js';
import { registerSyncRetention } from '../../utils/sync-merge-registry.js';
import { lootEntryIdentity, isMoreCompleteEntry } from './loot-log-analytics.js';

const STORE_NAME = 'lootLogHistory';

/**
 * How many sessions the log keeps.
 *
 * Five hundred is a fortnight of hard play, which is enough to scroll back
 * through and not enough to aggregate: the analytics pivot divides a whole
 * history into per-action rows, and a rate over three sessions of an action is
 * noise wearing a decimal point.
 *
 * Two thousand rather than upstream's five thousand, because the ceiling here is
 * key count rather than bytes. Entries are grouped into one record per hour of
 * play, so the worst case — a long gathering run per hour, one entry per chunk —
 * is one key per entry: 2,000 keys against the store's 500-key soft budget,
 * which is raised in lockstep in `core/storage.js`. Five thousand would put the
 * worst case at ten times that budget in a store shared across characters. Size
 * is the lesser constraint: a combat entry with three dozen drop kinds and eight
 * skills serialises to about 2 KB and a gathering entry to about 0.4 KB, so
 * 2,000 entries is ~1.4 MB for a mixed history and ~3.9 MB if every one of them
 * is combat.
 */
export const MAX_ENTRIES = 2000;

/**
 * One record per hour of play.
 *
 * `loot_log_updated` arrives every few seconds while a fast action runs, and
 * each one used to rewrite the whole window. Hourly buckets hold the dozen or so
 * entries recorded since the hour began, so the write is that dozen — and every
 * entry from a previous hour, which has not changed and cannot change, is never
 * touched again.
 *
 * An hour rather than a day because a day of hard play is most of the window,
 * which would leave the amplification roughly where it started.
 */
const RECORD_PREFIX = 'lootLogRec';

/**
 * Per-character cap floor, `lootLogRecFloor_<charId>_<YYYY-MM-DDTHH>`: the oldest hour chunk the cap still keeps,
 * in the key's name, so sync can drop every older chunk (see the retention rule below). Spelled so neither the
 * record prefix (`lootLogRec_`) nor the deletions key (`lootLogRecTomb_`) matches it.
 */
const FLOOR_PREFIX = 'lootLogRecFloor';

/**
 * @param {string} charId - Whose loot log
 * @param {string} chunkId - The oldest hour chunk the cap keeps
 * @returns {string} The key recording that floor
 */
export function floorKey(charId, chunkId) {
    return `${FLOOR_PREFIX}_${charId}_${chunkId}`;
}

/**
 * Hours since the epoch of a `YYYY-MM-DDTHH` chunk id.
 * @param {string} chunkId - Hour chunk id
 * @returns {number} Whole hours, or NaN for something else
 */
function hourNumber(chunkId) {
    const time = Date.parse(`${chunkId}:00:00.000Z`);
    return Number.isFinite(time) ? Math.round(time / 3600000) : NaN;
}

const HOUR_RECORD_RE = new RegExp(`^${RECORD_PREFIX}_([^_]+)_(\\d{4}-\\d{2}-\\d{2}T\\d{2})$`);
const FLOOR_RE = new RegExp(`^${FLOOR_PREFIX}_([^_]+)_(\\d{4}-\\d{2}-\\d{2}T\\d{2})$`);

/**
 * A loot log key as the sync retention rule reads it: an hour record's character and hour, or a floor marker's
 * character and floor hour. Null for everything else under the prefix (the deletions key, the legacy key).
 * @param {string} key - Storage key
 * @returns {{group: string, order: number}|{group: string, floor: number}|null} The rule's reading
 */
export function parseLootLogRetentionKey(key) {
    const record = HOUR_RECORD_RE.exec(key);
    if (record) {
        const order = hourNumber(record[2]);
        return Number.isFinite(order) ? { group: record[1], order } : null;
    }
    const floor = FLOOR_RE.exec(key);
    if (floor) {
        const at = hourNumber(floor[2]);
        return Number.isFinite(at) ? { group: floor[1], floor: at } : null;
    }
    return null;
}

/*
 * The cap, told to sync. The cap keeps the newest MAX_ENTRIES entries across every hour chunk and evicts the
 * chunks wholly older than the oldest entry it keeps: a count over values, which no rule over key names can work
 * out. So the store writes the cut down as a floor marker, and the rule drops every chunk of that character older
 * than the highest floor either side holds, exactly the chunks `_capped` lets go of. Without it the gist kept
 * every evicted chunk, each pull wrote them back, and every merged push reported news.
 */
registerSyncRetention({
    store: STORE_NAME,
    prefix: RECORD_PREFIX,
    parse: parseLootLogRetentionKey,
    floorMarkers: true,
});

/**
 * Which chunk a loot entry belongs to. Named so a merge can name the hours it moved
 * without reaching into the store.
 * @param {Object} entry - A loot log entry
 * @returns {string} Chunk id
 */
const entryChunkId = (entry) => timeChunkId(Date.parse(entry?.startTime), 'hour');

/**
 * Every `characterActionId` this run has been seen under, as strings, in first-seen order.
 * @param {...Object} entries - Copies of one run
 * @returns {string[]}
 */
function seenActionIds(...entries) {
    const ids = [];
    for (const entry of entries) {
        const own = Array.isArray(entry?.legacyIds) ? entry.legacyIds : [];
        for (const id of [...own, entry?.characterActionId]) {
            if (id == null) continue;
            const text = String(id);
            if (!ids.includes(text)) ids.push(text);
        }
    }
    return ids;
}

/**
 * The copy that is further along, carrying every id either copy has been seen under. A run whose
 * `characterActionId` is reissued (123 -> 148) keeps one row, but a peer on the earlier build may
 * still hold the 123 partial, and only a tombstone filed under 123 reaches it.
 * @param {Object} winner - The copy that is kept
 * @param {Object} other - The copy it replaces or folds with
 * @returns {Object} The winner, copied with `legacyIds` only when it must grow
 */
function carryingLegacyIds(winner, other) {
    if (!winner || !other) return winner;
    const ids = seenActionIds(other, winner);
    const held = seenActionIds(winner);
    if (ids.length <= 1 || ids.length === held.length) return winner;
    return { ...winner, legacyIds: ids };
}

class LootLogHistory {
    constructor() {
        /**
         * Where the entries live, and the memory of what was last written.
         *
         * Debouncing the write means storage is behind memory for up to three
         * seconds, and `loot_log_updated` arrives far more often than that — so
         * a read that went through to storage would merge onto a stale array and
         * undo the merge before it. Memory is the truth between flushes; storage
         * is where it goes to survive a reload.
         */
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            legacyKey: (charId) => `lootLog_${charId}`,
            groupOf: entryChunkId,
            // Newest first, which is the order the loot panel reads them in
            compare: (a, b) => Date.parse(b?.startTime) - Date.parse(a?.startTime) || 0,
            // An entry's identity is its action, not its contents: a session
            // still running has its `endTime` and `actionCount` rewritten on
            // every loot message, so a deep-equality dedupe would keep two
            // copies of the same action whenever two copies of the history are
            // folded together (a sync pull, or a legacy key being absorbed).
            // Not `characterActionId` either, which the game can reissue
            // mid-run — see `lootEntryIdentity`.
            identityOf: lootEntryIdentity,
            // What the identity was before, so a deletion filed under it — by
            // this device last week, or by a peer still on that build — holds
            legacyIdentitiesOf: (entry) => seenActionIds(entry),
            // Two copies of one run (a reissued id's partial rows, a peer's older
            // snapshot) fold to the one further along. Given this, every read
            // also folds copies already side by side on disk and writes the
            // chunk back, which is what collapses history stored before the
            // identity changed — once, since a folded chunk has nothing to fold
            mergeCopies: (first, second) =>
                isMoreCompleteEntry(second, first)
                    ? carryingLegacyIds(second, first)
                    : carryingLegacyIds(first, second),
            // A deletion also covers any copy no further along than the one
            // deleted: a peer's older snapshot, or a partial row of the same run
            revisionOf: (entry) => Number(entry?.actionCount),
            label: 'LootLogHistory',
        });

        /**
         * One merge at a time, in order.
         *
         * `mergeAndSave` is a read-merge-write, and it is called straight off
         * the `loot_log_updated` message with no await: two messages a few
         * hundred milliseconds apart both read the same `existing` array, both
         * merge their own delta onto it, and the second save overwrites the
         * first — so the first message's entries are gone. Chaining costs
         * nothing (the second merge starts against the first one's result) and
         * is what `trade-ledger-store.js` and `persisted-record.js` already do
         * for the same reason.
         */
        this._chain = Promise.resolve();

        /**
         * The highest cap floor this tab has recorded for a character (`charId -> chunk id`), so a
         * merge that cuts at the same hour again does not rewrite the marker.
         * @type {Map<string, string>}
         */
        this._floors = new Map();
    }

    /**
     * Apply the cap: the newest MAX_ENTRIES entries, rounded up to whole hour chunks.
     *
     * The floor chunk is kept whole on disk, so both sides' copies of it agree and sync never sees a
     * partly-evicted chunk. The floor marker is written before anything is evicted: an eviction sync cannot
     * see is one the gist hands back on the next pull. A marker that does not land evicts nothing; the
     * entries stay until a later capped merge records the floor.
     * @param {Array} merged - Every entry, newest first
     * @param {string} charId - Whose log
     * @returns {Promise<Array>} The entries to keep
     * @private
     */
    async _capped(merged, charId) {
        if (merged.length <= MAX_ENTRIES) return merged;
        const floorChunk = entryChunkId(merged[MAX_ENTRIES - 1]);
        let cut = merged.length;
        for (let i = MAX_ENTRIES; i < merged.length; i += 1) {
            if (entryChunkId(merged[i]) < floorChunk) {
                cut = i;
                break;
            }
        }
        if (cut >= merged.length) return merged;

        const recorded = this._floors.get(charId);
        if (recorded === undefined || recorded < floorChunk) {
            try {
                const written = await storage.set(
                    floorKey(charId, floorChunk),
                    { floor: floorChunk },
                    STORE_NAME,
                    true
                );
                if (written === false) {
                    console.warn('[LootLogHistory] The cap floor could not be recorded for sync; evicting nothing');
                    return merged;
                }
            } catch (error) {
                console.error('[LootLogHistory] Recording the cap floor failed; evicting nothing:', error);
                return merged;
            }
            this._floors.set(charId, floorChunk);
            // Superseded floors: sync reads only the highest
            try {
                const keys = await storage.tryGetAllKeys(STORE_NAME);
                const prefix = `${FLOOR_PREFIX}_${charId}_`;
                for (const key of recordKeysFor(keys || [], FLOOR_PREFIX, charId)) {
                    if (key.slice(prefix.length) < floorChunk) await storage.delete(key, STORE_NAME);
                }
            } catch (error) {
                console.error('[LootLogHistory] Removing superseded cap floors failed:', error);
            }
        }
        return merged.slice(0, cut);
    }

    /** @returns {string|null} Whose loot log, or null before login */
    _charId() {
        return dataManager.getCurrentCharacterId() || null;
    }

    /**
     * @param {string} [charId] - Whose history — defaults to whoever is current now.
     *   A caller spanning an await (like `_merge`) should capture one up front and
     *   pass it through, rather than let `_load` and a later `_save` each read the
     *   current character independently and risk disagreeing after a switch.
     * @returns {Promise<Array>} Every stored entry, newest first
     */
    async _load(charId = this._charId()) {
        if (!charId) return [];
        return this._store.load(charId);
    }

    /**
     * Queue the entries for writing.
     *
     * Deliberately not awaited and not `immediate`: the debounce coalesces a
     * burst of loot messages into one write per quiet moment, and the
     * `beforeunload` `flushAll()` in the entrypoint is what makes the last one
     * land. Awaiting here would block the caller on the debounce timer itself.
     * @param {Array} entries - The history as it now stands, newest first
     * @param {Set<string>} [changedChunks] - Chunks whose entries moved, so the rest
     *   are carried over from the last snapshot instead of being re-serialised
     * @param {string} [charId] - Whose history — see `_load`'s note on why a caller
     *   spanning an await should pass this explicitly rather than rely on the default
     */
    _save(entries, changedChunks, charId = this._charId()) {
        if (!charId) return;
        this._store.save(charId, entries, { changedChunks });
    }

    /**
     * Merge entries from a loot_log_updated message into stored history.
     * One row per entry (`lootEntryIdentity`); an incoming copy replaces the stored one when it is
     * further along, so ongoing sessions stay fresh and a run whose `characterActionId` was reissued
     * stays one row. Keeps newest first, caps at MAX_ENTRIES.
     *
     * Whose log it is is decided here, when the message arrives, not when the
     * chain reaches it: a merge queued behind another waits out that one's
     * storage read, and a character switch landing in the wait would otherwise
     * have this message read "the current character" as the arriving one and
     * file the departing character's loot under it.
     * @param {Array} lootLog - Array from the WebSocket message
     * @returns {Promise<void>} Resolves when this merge has been queued for writing
     */
    async mergeAndSave(lootLog) {
        const charId = this._charId();
        const run = () => this._mergeAndSave(lootLog, charId);
        this._chain = this._chain.then(run, run);
        return this._chain;
    }

    /**
     * The merge itself, run one at a time by `mergeAndSave`.
     * @param {Array} lootLog - Array from the WebSocket message
     * @param {string|null} charId - Whose log it is, taken when the message arrived
     * @returns {Promise<void>}
     * @private
     */
    async _mergeAndSave(lootLog, charId) {
        try {
            await this._merge(lootLog, charId);
        } catch (error) {
            // Never rejected: the chain is what the next message extends, and a
            // rejected link would surface as an unhandled rejection in a caller
            // that deliberately does not await
            console.error('[LootLogHistory] Merging the loot log failed:', error);
        }
    }

    /**
     * @param {Array} lootLog - Array from the WebSocket message
     * @param {string|null} [owner] - Whose log it is, taken when the message arrived;
     *   the current character when omitted
     * @returns {Promise<void>}
     * @private
     */
    async _merge(lootLog, owner = this._charId()) {
        if (!lootLog || lootLog.length === 0) return;
        // Nothing that follows can be stored, and building it costs a full
        // merge over the whole window per loot message
        if (storage.isQuotaExceeded()) return;

        // Captured once and threaded through the load and the save below,
        // rather than each independently reading "the current character" —
        // `_load` is an IndexedDB round trip, and a character switch landing
        // inside that window must not have the save that follows write this
        // merge under the *new* character's keys. See trade-ledger-store.js
        // for the same pattern.
        const charId = owner;
        if (!charId || this._charId() !== charId) return;

        const existing = await this._load(charId);
        // A newer switch happened while the read was in flight: this merge
        // belongs to a character that is no longer current, and saving it
        // now would write stale data under the character that switched away —
        // `character_switching` already dropped this instance's cache for it.
        if (this._charId() !== charId) return;

        const byId = new Map(existing.map((e) => [lootEntryIdentity(e), e]));

        // A loot message is a handful of actions against a window of thousands spread
        // over hundreds of hourly chunks; naming the hours that moved is what keeps
        // the save from re-serialising all of them
        const touchedChunks = new Set();
        let changed = false;
        for (const entry of lootLog) {
            const id = lootEntryIdentity(entry);
            if (id === undefined) continue;
            const stored = byId.get(id);
            if (isMoreCompleteEntry(entry, stored)) {
                if (stored) touchedChunks.add(entryChunkId(stored));
                touchedChunks.add(entryChunkId(entry));
                byId.set(id, carryingLegacyIds(entry, stored));
                changed = true;
            } else {
                // Not further along, but possibly under a reissued id the stored row has not seen
                const folded = carryingLegacyIds(stored, entry);
                if (folded !== stored) {
                    touchedChunks.add(entryChunkId(stored));
                    byId.set(id, folded);
                    changed = true;
                }
            }
        }
        if (!changed) return;

        // Parsed once per entry rather than once per comparison: the sort runs on
        // every loot message, and `new Date(...)` inside the comparator is two
        // string parses per comparison — about 2·n·log₂n of them, so roughly
        // 44,000 across a full window where this is 2,000
        const startMs = new Map();
        for (const entry of byId.values()) startMs.set(entry, Date.parse(entry?.startTime) || 0);

        const merged = [...byId.values()];
        merged.sort((a, b) => startMs.get(b) - startMs.get(a));

        // Entries past the cap fall out of the array here; the chunks they were
        // the last of are deleted by the save that notices they have gone
        const capped = await this._capped(merged, charId);
        // See the check after the read: the floor write is an await too
        if (this._charId() !== charId) return;
        this._save(capped, touchedChunks, charId);
    }

    /**
     * Remove one stored entry — queued on the same chain as `mergeAndSave`.
     *
     * This used to be a direct `_load`/`_save` from the caller, outside the
     * chain: a delete landing while a `loot_log_updated` merge was mid-flight
     * raced it exactly the way two merges used to race each other (see
     * `mergeAndSave`'s note). The merge's `existing` is read before the
     * delete, so its `merged` array still had the deleted entry — and
     * whichever `_save` ran last, usually the merge's since it goes on to
     * touch other chunks, put the entry straight back.
     * @param {Object|string} target - The entry to remove, or its `lootEntryIdentity`
     * @returns {Promise<void>} Resolves when this delete has been queued for writing
     */
    async deleteEntry(target) {
        // Whose entry, decided at the click, for the same reason as `mergeAndSave`
        const charId = this._charId();
        const id = target && typeof target === 'object' ? lootEntryIdentity(target) : target;
        const run = () => this._deleteEntry(id, charId);
        this._chain = this._chain.then(run, run);
        return this._chain;
    }

    /**
     * @param {string} id - The `lootEntryIdentity` of the entry to remove
     * @param {string|null} [owner] - Whose entry, taken at the click; the current character when omitted
     * @returns {Promise<void>}
     * @private
     */
    async _deleteEntry(id, owner = this._charId()) {
        try {
            const charId = owner;
            if (!charId || this._charId() !== charId) return;

            const existing = await this._load(charId);
            // See `_merge`'s note on the same check: a switch landing inside the
            // read must not have this delete's save land under the character
            // that switched away.
            if (this._charId() !== charId) return;

            if (id === undefined || id === null) return;
            const filtered = existing.filter((e) => lootEntryIdentity(e) !== id);
            if (filtered.length === existing.length) return;

            this._save(filtered, undefined, charId);
        } catch (error) {
            // Never rejected, for the same reason `_mergeAndSave` never is: the
            // chain is what the next queued write extends.
            console.error('[LootLogHistory] Deleting an entry failed:', error);
        }
    }

    /**
     * Get entries that are in storage but not in the current game-provided set.
     * @param {Set<string>} currentIds - `lootEntryIdentity` of each entry in the current loot_log_updated
     * @returns {Promise<Array>}
     */
    async getHistoricalEntries(currentIds) {
        const all = await this._load();
        return all.filter((e) => !currentIds.has(lootEntryIdentity(e)));
    }

    /**
     * Delete this character's stored loot log.
     * @returns {Promise<boolean>} Whether the history is gone; false when the
     *   store could not be listed and the records are therefore still on disk,
     *   which a caller must not report as a successful clear
     */
    async clearHistory() {
        const charId = this._charId();
        if (!charId) return false;
        this._floors.delete(charId);
        return this._store.clear(charId);
    }
}

const lootLogHistory = new LootLogHistory();
export default lootLogHistory;

// A character switch must not serve the departing character's entries to the
// arriving one, nor write them back under the arriving one's keys
dataManager.on?.('character_switching', () => {
    lootLogHistory._store.forget();
    lootLogHistory._floors.clear();
});
