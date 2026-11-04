/**
 * Trade Ledger Store Module
 *
 * Records every observed fill on your own market listings — one record per
 * fill event, partial fills included — by diffing successive listing states
 * from `market_listings_updated`. Where `trade-history.js` keeps only the last
 * buy/sell price per item, this keeps the whole history, which is what realized
 * flip profit needs.
 *
 * The diffing itself (what counts as a fill, what a baseline is, how the state
 * map stays bounded) lives in `src/utils/trade-ledger.js`; this module owns the
 * wiring: WebSocket events in, per-character IndexedDB persistence out.
 *
 * ## How the fills are stored
 *
 * One record per UTC day, keyed `tradeLedgerRec_<charId>_<YYYY-MM-DD>`, rather
 * than one array per character. The single array was read back, merged and
 * rewritten in full — up to `LEDGER_RECORD_CAP` records — immediately on every
 * fill, so recording one fill cost the size of every fill ever recorded. A fill
 * now touches its own day's record and nothing else (see `utils/chunked-history.js`
 * for the reasoning behind chunking; this store keeps its own read-merge-write
 * per bucket instead of that helper's diff, because two tabs may both be
 * appending to today's record).
 *
 * The pre-split single key is migrated on the first load after the upgrade:
 * split into day records, then replaced by a per-character marker that says the
 * split has happened. The marker is what stops every later load from treating
 * the absent single key as a legacy value to adopt, and it makes a single key
 * that comes back — an older tab still writing it, a sync pull from a device
 * on the old layout — something to fold into the day records rather than a
 * history to migrate over them. A split that cannot be written (a full disk)
 * leaves the single key in place and the store keeps using it as before.
 *
 * ## A fill is written the moment it is found
 *
 * A new fill's rows go straight to disk on their own (see `_flushUnsaved`), before anything else this store does
 * with them, and its baseline waits until they have committed. The one failure this ledger cannot recover from is a
 * baseline stored ahead of its row, or a listing that ends with its row only in memory: the next snapshot has nothing
 * left to diff. A row stored without its baseline is only a duplicate, and the repair cuts that once the listing ends.
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { registerSyncMerge, registerSyncRetention, onSyncPullApplied } from '../../utils/sync-merge-registry.js';
import { readScoped } from '../../utils/character-key.js';
import { timeChunkId, recordKeysFor, registerCharacterScopedPrefix } from '../../utils/chunked-history.js';
import { detectFills, trimLedger, repairOverRecorded, LEDGER_RECORD_CAP } from '../../utils/trade-ledger.js';
import listingArchive, { ARCHIVE_PREFIX } from './listing-archive.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/** Same store the other market trackers live in. */
const LEDGER_STORE = 'marketListings';

/** Per-character fill records, capped at LEDGER_RECORD_CAP oldest-out — the pre-split single key. */
const RECORDS_BASE = 'tradeLedgerRecords';

/** Per-character, per-day fill records: `tradeLedgerRec_<charId>_<YYYY-MM-DD>`. */
const RECORD_PREFIX = 'tradeLedgerRec';

/*
 * Registered as character-scoped so the health panel counts these day records
 * per character rather than adding every character's together. They share
 * `marketListings` with account-wide market caches, whose flat 2,000-key budget
 * they are not part of: without this, a four-character account trips that
 * budget while no single character is near its own. `CHARACTER_FAMILY_BUDGETS`
 * in `core/storage.js` carries the per-character number and says how it was
 * chosen. Registration runs at import, long before any budget report.
 */
registerCharacterScopedPrefix(LEDGER_STORE, RECORD_PREFIX);

/**
 * The personal listing log's key base (`marketListingTimestamps_<charId>`), written by `estimated-listing-age.js`
 * and read here, never written, to learn how much a finished listing really filled.
 */
const LISTING_LOG_BASE = 'marketListingTimestamps';

/**
 * The one log status the repair trusts. `filled` is the wire's own terminal stamp (a cancel after a partial
 * fill included). `expired` is not trusted: the history viewer's DOM scrape can stamp it onto an open listing
 * that looks the same as the one that expired, and the row then keeps a stale, low count.
 */
const TRUSTED_LOG_STATUS = 'filled';

/** Wire statuses after which a listing can never fill again */
const ENDED_WIRE_STATUSES = new Set([
    '/market_listing_status/cancelled',
    '/market_listing_status/expired',
    '/market_listing_status/filled',
]);

/**
 * Per-character cap floor, `tradeLedgerRecFloor_<charId>_<YYYY-MM-DD>`: the oldest day record the cap still
 * keeps, in the key's name, so sync can drop every older day record (see the retention rule below). Spelled so
 * neither the day-record prefix (`tradeLedgerRec_`) nor the single key's base (`tradeLedgerRecords`) matches
 * it, as chunked-history spells its tombstone keys.
 */
const FLOOR_PREFIX = 'tradeLedgerRecFloor';

/**
 * Per-character marker written once the single key has been split into day
 * records. `{at, records}` — when, and how many fills were carried over.
 */
const SPLIT_MARKER_BASE = 'tradeLedgerRecordsSplit';

/**
 * Per-character listing-state baselines (id → last observed fill progress).
 * Persisted so fills that land while the page is closed still surface as a
 * delta against the stored baseline when the next snapshot arrives.
 */
const STATE_BASE = 'tradeLedgerState';

/**
 * How long a one-off migration write is given before the load moves on.
 *
 * The split runs inside `initialize()` of a feature the rest of startup waits
 * on, so a storage call that never settles does not just lose the ledger, it
 * stops every feature registered after this one. Fifteen seconds is far longer
 * than a bulk write of a day's records takes and short enough that a wedged
 * database costs a pause rather than the session.
 */
export const MIGRATION_TIMEOUT_MS = 15000;

/**
 * Resolve to `fallback` if `promise` has not settled within `timeoutMs`.
 *
 * The abandoned promise is not cancelled — nothing can cancel an IndexedDB
 * request — it is simply no longer awaited, so a write that lands late still
 * lands; the next load sees the result.
 * @param {Promise<*>} promise - What to wait for
 * @param {number} timeoutMs - How long to wait
 * @param {*} fallback - What to resolve to on timeout
 * @returns {Promise<*>} The promise's value, or the fallback
 */
export async function withTimeout(promise, timeoutMs, fallback) {
    let timer = null;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(fallback), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}

/**
 * The identity of a fill record, for folding two copies of the ledger together.
 *
 * Fills carry no id of their own: one is "listing N moved by Q units at time
 * T", and that triple is what tells two records apart. The wire sends one
 * object per changed listing per event, so the same listing cannot fill twice
 * at the same millisecond; two records agreeing on all three are the same
 * fill seen twice (by two tabs, or before and after a failed read).
 * @param {Object} record - Fill record
 * @returns {string} `listingId|t|quantity`
 */
export function fillKey(record) {
    return `${record.listingId}|${record.t}|${record.quantity}`;
}

/**
 * Two ledgers folded into one by {@link fillKey}, the second winning on a
 * clash, then capped the way every other ledger write is.
 * @param {Array<Object>} base - Records, typically as stored
 * @param {Array<Object>} fresh - Records, typically in memory
 * @returns {Array<Object>} Merged, oldest first, at most LEDGER_RECORD_CAP
 */
export function mergeRecords(base, fresh) {
    const byKey = new Map();
    for (const record of Array.isArray(base) ? base : []) {
        if (record && record.itemHrid) byKey.set(fillKey(record), record);
    }
    for (const record of Array.isArray(fresh) ? fresh : []) {
        if (record && record.itemHrid) byKey.set(fillKey(record), record);
    }
    return trimLedger(
        [...byKey.values()].sort((a, b) => a.t - b.t),
        LEDGER_RECORD_CAP
    );
}

/**
 * Which fill a row is a copy of, whatever quantity the copy carries: a trimmed row keeps its original's listing and
 * time and changes its quantity, so {@link fillKey} tells the two apart.
 * @param {Object} row - Fill record
 * @returns {string} `listingId|t`
 */
function trimStamp(row) {
    return `${row.listingId}|${row.t}`;
}

/**
 * A row as text with its keys sorted, so two rows holding the same fields compare equal whatever order they were
 * written in.
 * @param {Object} row - Fill record
 * @returns {string} Canonical text
 */
function rowSignature(row) {
    return JSON.stringify(
        Object.keys(row || {})
            .sort()
            .map((key) => [key, row[key]])
    );
}

/**
 * Whether two day records hold the same rows, whatever order they list them in.
 * @param {Array<Object>} a - One day record
 * @param {Array<Object>} b - The other
 * @returns {boolean} True when each holds exactly the other's rows
 */
function sameRows(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const left = a.map(rowSignature).sort();
    const right = b.map(rowSignature).sort();
    return left.every((signature, index) => signature === right[index]);
}

/**
 * One listing's baseline from two copies of it.
 *
 * A listing only ever moves forward: its fill count grows and its end is final. So the copy that is further
 * along is the right one, and a stale copy (another device's older baseline, a pull of an old gist) must never
 * win by being the later argument. That is how a finished `{done}` tombstone, or a baseline already counted,
 * was replaced by a zero baseline and the same fill recorded again on the next snapshot.
 * @param {*} a - One copy
 * @param {*} b - The other
 * @returns {*} The copy further along; `{done: true}` when either is finished
 */
function furtherAlong(a, b) {
    const valid = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry);
    if (!valid(a) || !valid(b)) {
        if (valid(a)) return a;
        if (valid(b)) return b;
        // Neither is a baseline: settle on content, not on which side came first
        return (JSON.stringify(b) ?? '') > (JSON.stringify(a) ?? '') ? b : a;
    }
    if (a.done || b.done) return { done: true };
    const filledA = Number(a.filledQuantity) || 0;
    const filledB = Number(b.filledQuantity) || 0;
    if (filledA !== filledB) return filledA > filledB ? a : b;
    // Same progress: the copies describe one listing, so they agree; the tie is broken by content, not by
    // argument order, so the fold is the same whichever side it meets first
    return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

/**
 * Two baseline maps folded into one by listing id, the copy further along winning.
 *
 * Commutative and idempotent. Baselines only one side knows (another tab's, or written before a failed read)
 * are kept: a baseline this tab never loaded is still the only thing that can turn that listing's next update
 * into a fill. A finished listing (`{done}`) beats every unfinished copy; otherwise the higher
 * `filledQuantity` wins.
 * @param {Object<string, Object>} base - Baselines, typically as stored
 * @param {Object<string, Object>} fresh - Baselines, typically in memory
 * @returns {Object<string, Object>} Merged map
 */
export function mergeStates(base, fresh) {
    const safe = (map) => (map && typeof map === 'object' && !Array.isArray(map) ? map : {});
    const merged = { ...safe(base) };
    for (const [id, entry] of Object.entries(safe(fresh))) {
        merged[id] = id in merged ? furtherAlong(merged[id], entry) : entry;
    }
    return merged;
}

/**
 * Which day record a fill belongs in.
 * @param {Object} record - Fill record
 * @returns {string} `YYYY-MM-DD`, in UTC
 */
export function bucketOf(record) {
    return timeChunkId(record?.t, 'day');
}

/**
 * The character id the ledger keys carry — the same one `characterKey` uses,
 * so a day record and the single key it replaced agree on whose they are.
 * @returns {string} Character id, or `default` before login
 */
function ledgerCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * One character's scoped key, built from an id the caller captured.
 *
 * Deliberately not `characterKey()`: that reads whoever is current at the
 * moment it is called, and every key in a load or a save has to belong to the
 * character the read started under, not to one who arrived during it.
 * @param {string} base - The unscoped key
 * @param {string} charId - Whose key, from {@link ledgerCharId}
 * @returns {string} `base_<charId>`
 */
function charKey(base, charId) {
    return `${base}_${charId}`;
}

/**
 * @param {string} charId - Whose record
 * @param {string} bucket - Which day
 * @returns {string} The key that day's fills live under
 */
export function recordKey(charId, bucket) {
    return `${RECORD_PREFIX}_${charId}_${bucket}`;
}

/**
 * @param {string} charId - Whose ledger
 * @param {string} bucket - The oldest day record the cap keeps
 * @returns {string} The key recording that floor
 */
export function floorKey(charId, bucket) {
    return `${FLOOR_PREFIX}_${charId}_${bucket}`;
}

/**
 * Days since the epoch of a `YYYY-MM-DD` day id.
 * @param {string} bucket - Day id
 * @returns {number} Whole days, or NaN for something else
 */
function dayNumber(bucket) {
    const time = Date.parse(`${bucket}T00:00:00.000Z`);
    return Number.isFinite(time) ? Math.round(time / 86400000) : NaN;
}

const DAY_RECORD_RE = new RegExp(`^${RECORD_PREFIX}_([0-9a-zA-Z]+)_(\\d{4}-\\d{2}-\\d{2})$`);
const FLOOR_RE = new RegExp(`^${FLOOR_PREFIX}_([0-9a-zA-Z]+)_(\\d{4}-\\d{2}-\\d{2})$`);

/**
 * A ledger key as the sync retention rule reads it: a day record's character and day, or a floor marker's
 * character and floor day. Null for every other key under the prefix (the single key, the split marker).
 * @param {string} key - Storage key
 * @returns {{group: string, order: number}|{group: string, floor: number}|null} The rule's reading
 */
export function parseLedgerRetentionKey(key) {
    const day = DAY_RECORD_RE.exec(key);
    if (day) {
        const order = dayNumber(day[2]);
        return Number.isFinite(order) ? { group: day[1], order } : null;
    }
    const floor = FLOOR_RE.exec(key);
    if (floor) {
        const at = dayNumber(floor[2]);
        return Number.isFinite(at) ? { group: floor[1], floor: at } : null;
    }
    return null;
}

/**
 * Fills grouped by day record.
 * @param {Array<Object>} records - Fill records
 * @returns {Map<string, Array<Object>>} bucket → its records, in input order
 */
function groupByBucket(records) {
    const grouped = new Map();
    for (const record of records || []) {
        if (!record) continue;
        const bucket = bucketOf(record);
        const list = grouped.get(bucket);
        if (list) list.push(record);
        else grouped.set(bucket, [record]);
    }
    return grouped;
}

/*
 * Registered so a cross-device sync PULL combines these records instead of
 * overwriting them — the single key for devices still on the old layout, the
 * day records for devices on this one. Registration runs at import time, which
 * is long before the earliest pull (the staggered startup pull, 20s+ after
 * load), so the registry is complete by the time sync consults it. See
 * utils/sync-merge-registry.js.
 */
registerSyncMerge({
    store: LEDGER_STORE,
    base: RECORDS_BASE,
    merge: mergeRecords,
    label: 'Trade ledger fills',
});
/*
 * A pull folds a day record through the store's `_foldPulledDay`, not the plain union: the over-recorded repair
 * cuts doubled fills on load and leaves no tombstone, so the union with a gist that still holds them brought the
 * cut rows back on every pull, wrote the day, latched it and asked for a reload that cut them again. Uploads keep
 * the plain union (`merge`): the gist is every device's copy, and this device's cut is not another device's to
 * inherit.
 */
registerSyncMerge({
    store: LEDGER_STORE,
    prefix: `${RECORD_PREFIX}_`,
    merge: mergeRecords,
    pull: (local, incoming, context) => tradeLedgerStore._foldPulledDay(local, incoming, context),
    label: 'Trade ledger fills (daily)',
});
registerSyncMerge({
    store: LEDGER_STORE,
    base: STATE_BASE,
    merge: mergeStates,
    label: 'Trade ledger baselines',
});

/*
 * The cap, told to sync. The cap keeps the newest LEDGER_RECORD_CAP fills across every day record and evicts
 * the day records wholly older than the oldest fill it keeps: a count over values, which no rule over key names
 * can work out. So the store writes the cut down as a floor marker (`floorKey`), and the rule drops every day
 * record of that character older than the highest floor either side holds, exactly the days `_evictBefore`
 * deletes. Without it the gist kept every evicted day, each pull wrote them back, and every merged push reported
 * news. The floor day itself is kept whole on disk (see `saveRecords`), so both sides' copies of it agree.
 */
registerSyncRetention({
    store: LEDGER_STORE,
    prefix: RECORD_PREFIX,
    parse: parseLedgerRetentionKey,
    floorMarkers: true,
});

class TradeLedgerStore {
    constructor() {
        this.records = [];
        this.states = {};
        this.isInitialized = false;
        this.isLoaded = false;
        this.initHandler = null;
        this.updateHandler = null;
        this._recordsChain = null;
        this._statesChain = null;
        /**
         * One repair at a time, each reading the log and the archive here and only then joining `_recordsChain`
         * for its cut. A fill's save must never wait on an archive read: its baseline lands regardless, and a fill
         * whose baseline is stored and whose row is not is gone for good.
         */
        this._repairChain = null;
        /**
         * Bumped by {@link handleCharacterSwitch}. A load or a save that began
         * under the departing character finds the number moved and stands
         * down rather than adopting that character's rows into the arriving
         * one's memory or writing them under their keys.
         */
        this._generation = 0;
        /**
         * The character id `records` and `states` were loaded for, set where {@link load} marks the ledger loaded and
         * cleared by {@link handleCharacterSwitch}. The data manager moves its current id one macrotask before it
         * announces `character_switched`, so for that moment memory still belongs to the departing character while
         * {@link ledgerCharId} already names the arriving one (see {@link _departing}).
         * @type {string|null}
         */
        this._loadedFor = null;
        /**
         * Whether the single key is still the record.
         *
         * Set when the split could not be written; reads and writes then go
         * to the single key as they always did, and the next load tries again.
         */
        this._legacy = false;
        /**
         * The day records this tab has written for a character this session
         * (`charId → Set<day>`), re-folded on every records save.
         *
         * A sync pull, or another tab, can write a day record whole in the
         * moment after this tab wrote it, without the fill this tab had just
         * added — and a day nobody fills again is never written again, so
         * that fill was gone at the next reload. Re-folding the days written
         * here puts it back on the next fill of any day, and costs a read per
         * such day and no write when the stored copy already holds everything.
         * @type {Map<string, Set<string>>}
         */
        this._writtenDays = new Map();
        /**
         * Fills this tab has found and has not yet seen committed: `charId → Map(fillKey → {row, writing, singleKey})`.
         *
         * Normally a row is here for the milliseconds its transaction takes. It stays while storage is failing, and
         * while it does no baseline moves: {@link saveStates} stores nothing for a character with a row here. By
         * character, because a row found under one character is still that character's after a switch.
         * @type {Map<string, Map<string, {row: Object, writing: boolean, singleKey: boolean}>>}
         */
        this._unsavedFills = new Map();
        /** The writes of those rows now in flight, so a baseline can wait for them. @type {Set<Promise<void>>} */
        this._fillWrites = new Set();
        /** A baseline save stood down for this character: the next chance to save one is taken even with no change. */
        this._statesOwed = false;
        /**
         * What the over-recorded repair has done this session, per character (`charId → {runs, cut}`), for the
         * sync pull report. Read-only bookkeeping: nothing here changes what the repair does. Kept by character
         * id so a switch can never show one character's count against another, and kept across `disable()` as
         * the session's history, not the feature's state.
         * @type {Map<string, {runs: number, cut: number}>}
         */
        this._repairStats = new Map();
        /**
         * What the repair knows about ended listings, for the sync pull fold: `{charId, caps}`, `caps` being
         * listing id to final filled quantity. A fold is synchronous and the caps come from async reads, so the
         * pull uses the ones held here.
         *
         * Holds only caps checked against the archive: a low log count is not a cap until the archive has been
         * asked, because a fold that trusted one would drop a real fill the repair, reading the archive, keeps.
         * So the first repair run of a load reads the archive whatever the ledger holds, and that run is what
         * creates this. Null until then (the archive unreadable, the log unreadable, the ledger off, a switch),
         * which makes the fold a plain union: a reload prompt, nothing lost. A later run that read no archive
         * only raises a cap already here; a listing that ended since waits for a run that read it.
         *
         * `archiveOnly` names the caps no trusted log row gives. Those cut only a listing with two or more rows
         * (see {@link _hasDoubling}).
         * @type {{charId: string, caps: Map<number, number>, archiveOnly: Set<number>}|null}
         */
        this._pullCaps = null;
        /** Bumped by {@link disable}, so a repair run still out when the ledger is switched off holds nothing. */
        this._capsEpoch = 0;
        /**
         * What was read out of one download, by the download's own object (see {@link _readDownload}).
         * @type {WeakMap<Object, {charId: string, counts: Map<number, number>, trims: Set<string>}>}
         */
        this._pulledCountsMemo = new WeakMap();
    }

    /**
     * Hold new fills until they are seen committed.
     * @param {string} charId - Whose fills
     * @param {Array<Object>} fills - Fill records
     * @private
     */
    _noteFills(charId, fills) {
        let held = this._unsavedFills.get(charId);
        if (!held) {
            held = new Map();
            this._unsavedFills.set(charId, held);
        }
        for (const row of fills) held.set(fillKey(row), { row, writing: false, singleKey: this._legacy });
    }

    /**
     * Whose ledger memory holds, when that is not the character now current.
     *
     * The data manager moves its id and defers `character_switched` by a macrotask, so a market event already
     * queued for the departing character can arrive in between: the id is the arriving character's, memory is
     * still the departing one's. Anything keyed by {@link ledgerCharId} there files the departing character's
     * fills under the arriving one for good. A ledger loaded before login (`default`) is not a departure: the id
     * is simply catching up, and the keys follow it as they always did.
     * @returns {string|null} The id memory belongs to, or null when memory is the current character's or unowned
     * @private
     */
    _departing() {
        const owner = this.isLoaded ? this._loadedFor : null;
        if (!owner || owner === 'default') return null;
        return owner === ledgerCharId() ? null : owner;
    }

    /**
     * Store a departing character's baselines from the gap before the switch lands (see {@link _departing}).
     *
     * {@link saveStates} reads the current id and stands down on the switch, which is right for every other
     * moment and would drop this one, leaving the baseline behind a row that is already stored (the listing would
     * be found filled again on the character's return). So the departing character's own key is written directly,
     * from the memory that still belongs to them, and only once their rows are stored: a baseline never runs ahead of
     * its row. Folded inside the write, so a baseline another writer stored meanwhile is kept.
     * @param {string} owner - The departing character
     * @param {Promise<*>|null} [fillsSaved] - The writes of the fills this baseline accounts for
     * @returns {Promise<boolean>} Whether a write was issued
     * @private
     */
    async _saveDepartingStates(owner, fillsSaved = null) {
        const states = this.states;
        try {
            if (fillsSaved) await fillsSaved;
            if (this._unsavedFills.has(owner)) return false;
            return await storage.set(charKey(STATE_BASE, owner), states, LEDGER_STORE, false, {
                fold: (now, held) => (now && typeof now === 'object' ? mergeStates(now, held) : held),
            });
        } catch (error) {
            console.error('[TradeLedger] Failed to save the departing character listing states:', error);
            return false;
        }
    }

    /**
     * Write every held fill, each folded into its stored record as it lands.
     *
     * The rows alone, in a transaction opened in this tick, so a page closing a moment later still lands them. Three
     * things follow from writing only the rows and folding inside the write:
     *
     * - No read comes first, so one that fails cannot hold a fill back. That read guarded against a blind overwrite;
     *   a fold cannot be one, since it sees what is stored and adds to it. Only a failed write leaves a row held.
     * - It goes past a restore's latch. The latch exists so pre-restore memory does not land over what a restore put
     *   there, and it stays up for all of that memory (`saveRecords`). A fill found after the restore is not
     *   pre-restore state and the fold takes nothing away. It cannot wait for the reload the latch asks for: a
     *   listing that ends in the meantime is gone from the next snapshot, so its row would never be found again.
     * - Nothing new reaches disk: a row in a day record, as any build reads it.
     * @param {{force?: boolean}} [options] - `force` also writes rows whose earlier write has not answered, for page
     *   close
     * @returns {Promise<Array<void>>} Settles when every write in flight has answered; never rejects
     * @private
     */
    _flushUnsaved({ force = false } = {}) {
        for (const [charId, held] of this._unsavedFills) {
            const byKey = new Map();
            for (const entry of held.values()) {
                if (entry.writing && !force) continue;
                const key = entry.singleKey ? charKey(RECORDS_BASE, charId) : recordKey(charId, bucketOf(entry.row));
                if (byKey.has(key)) byKey.get(key).push(entry);
                else byKey.set(key, [entry]);
            }
            for (const [key, entries] of byKey) {
                const write = (async () => {
                    try {
                        await this._writeFills(charId, key, entries);
                    } finally {
                        this._fillWrites.delete(write);
                    }
                })();
                this._fillWrites.add(write);
            }
        }
        return Promise.all([...this._fillWrites]);
    }

    /**
     * One record's held rows, written and, once committed, let go.
     *
     * A write that lands while a restore is running stays held and is written again afterwards. The restore's copy
     * of the record was worked out before this row existed, and for a day this device held no copy of when it read
     * (the first fill of a UTC day) that copy then goes down whole, row or no row.
     * @param {string} charId - Whose fills
     * @param {string} key - The record they go in
     * @param {Array<{row: Object, writing: boolean, singleKey: boolean}>} entries - The held rows
     * @returns {Promise<void>}
     * @private
     */
    async _writeFills(charId, key, entries) {
        const duringRestore = storage.isRestoreInProgress?.() === true;
        for (const entry of entries) entry.writing = true;
        let landed = false;
        try {
            const written = await storage.putAll(
                LEDGER_STORE,
                { [key]: entries.map((entry) => entry.row) },
                {
                    bypassRestoreLatch: true,
                    folds: {
                        [key]: (stored, rows) =>
                            Array.isArray(stored) && Array.isArray(rows) ? mergeRecords(stored, rows) : rows,
                    },
                }
            );
            landed = written === 1;
        } catch (error) {
            console.error('[TradeLedger] Failed to write new fills:', error);
        }
        for (const entry of entries) entry.writing = false;
        if (!landed) {
            console.warn(`[TradeLedger] ${entries.length} new fill(s) not saved yet; keeping them and retrying`);
            return;
        }
        if (duringRestore) return;
        const held = this._unsavedFills.get(charId);
        for (const entry of entries) {
            const id = fillKey(entry.row);
            if (held?.get(id) === entry) held.delete(id);
        }
        if (held?.size === 0) this._unsavedFills.delete(charId);
        if (!entries[0].singleKey) {
            const days = this._writtenDays.get(charId) || new Set();
            for (const entry of entries) days.add(bucketOf(entry.row));
            this._writtenDays.set(charId, days);
        }
    }

    /**
     * Try the held fills again, and the baseline they were holding back.
     * @private
     */
    _retryUnsaved() {
        if (this._unsavedFills.size === 0) return;
        const writes = this._flushUnsaved();
        if (this._statesOwed && this.isLoaded) this.saveStates(writes);
    }

    /**
     * Remember the caps a repair run derived, for {@link _foldPulledDay}.
     *
     * Merged upward: a higher count means less is cut, so a raise is always the safe direction, and a lower count
     * never replaces a higher one. A listing that turned out to be open has no cap at all.
     * @param {string} charId - The character the run began under
     * @param {Map<number, number>} caps - Listing id to final filled quantity of an ended listing
     * @param {Set<number>} logged - The listings of `caps` a trusted log row gives
     * @param {boolean} checked - Whether this run read the archive
     * @param {Set<number>} openIds - Listings open as of this run
     * @private
     */
    _noteCaps(charId, caps, logged, checked, openIds) {
        const mine = this._pullCaps && this._pullCaps.charId === charId ? this._pullCaps : null;
        if (!mine && !checked) return;
        const held = mine ? mine.caps : new Map();
        const archiveOnly = mine ? mine.archiveOnly : new Set();
        for (const [id, cap] of caps) {
            if (!checked && !held.has(id)) continue;
            if (!(held.get(id) >= cap)) held.set(id, cap);
            if (logged.has(id)) archiveOnly.delete(id);
            else archiveOnly.add(id);
        }
        for (const id of openIds) {
            held.delete(id);
            archiveOnly.delete(id);
        }
        this._pullCaps = { charId, caps: held, archiveOnly };
    }

    /**
     * Whether a listing with no trusted log row may be cut at all: only with two or more rows.
     *
     * A doubling always has two rows, so one row alone was not doubled. An archive count below it is a low count
     * (an old retired row, an imported file), and the row is the fill.
     * @param {number} id - Listing id
     * @param {Array<Object>} records - The rows to count
     * @returns {boolean} True with two or more rows of that listing
     * @private
     */
    _hasDoubling(id, records) {
        let rows = 0;
        for (const record of records) {
            if (record && record.listingId === id) {
                rows += 1;
                if (rows >= 2) return true;
            }
        }
        return false;
    }

    /**
     * The fold a sync pull applies to one day record: the union with the downloaded copy, less the rows the
     * over-recorded repair would cut again.
     *
     * The repair leaves no tombstone, so a gist that still holds the doubled rows hands them back; folded
     * plainly, that read as news on every pull. The union is run through the same repair here, on the evidence
     * the repair itself would use once this pull has landed (see {@link _capsForFold}) and the rest of the ledger
     * from memory as the other days' share of each listing, so a listing whose fills span two days is cut exactly
     * as the whole-ledger repair would cut this day: earliest fills first, never below the count the log, the
     * archive and the baselines hold for the listing. A real new fill in the same download, a row of a listing
     * not known as ended, or a lone row of a listing the log has no count for, is kept.
     *
     * Each day folds on its own, and only memory is counted for the other days, never the rows the download holds
     * there: a day in the download may not land (the retention rule takes it out after the folds), and a row left
     * uncounted can only make a fold keep more than the whole-ledger repair would, which the next load then cuts.
     * The one thing that makes memory count too much is a row the download holds trimmed on its own day, whose fold
     * replaces memory's original: that listing is not cut here at all (see {@link _listingsTrimmedElsewhere}).
     *
     * Falls back to the plain union, as before, when no checked caps are held, they are another character's (or
     * were dropped because the ledger was switched off), the ledger is not loaded or still the single key, the rows
     * span more than one day, or there is no download to read the other days from. A result holding exactly this
     * device's rows (in any order) is this device's own array, so the pull reads it as unchanged.
     * @param {Array<Object>} local - This device's day record
     * @param {Array<Object>} incoming - The downloaded day record
     * @param {{download?: Object<string, *>}} [context] - The whole download of this store, as it came
     * @returns {Array<Object>} The folded day record
     */
    _foldPulledDay(local, incoming, context) {
        let result = mergeRecords(local, incoming);
        try {
            result = this._cutPulledDay(result, context?.download);
        } catch (error) {
            console.error('[TradeLedger] Could not apply the repair to a pulled day; keeping the union:', error);
        }
        return Array.isArray(local) && sameRows(result, local) ? local : result;
    }

    /**
     * One folded day's rows with the repair applied (see {@link _foldPulledDay}).
     * @param {Array<Object>} rows - The union of the two copies of one day
     * @param {Object<string, *>} [download] - The whole download of this store
     * @returns {Array<Object>} `rows` itself when nothing is cut, else the day's rows after the cut
     * @private
     */
    _cutPulledDay(rows, download) {
        const held = this._pullCaps;
        const charId = ledgerCharId();
        if (!held || held.caps.size === 0 || held.charId !== charId) return rows;
        if (!this.isLoaded || this._legacy || rows.length === 0) return rows;
        if (!download || typeof download !== 'object' || Array.isArray(download)) return rows;
        if (!rows.some((row) => held.caps.has(row.listingId))) return rows;
        const day = bucketOf(rows[0]);
        if (rows.some((row) => bucketOf(row) !== day)) return rows;
        const others = this.records.filter((record) => held.caps.has(record.listingId) && bucketOf(record) !== day);
        const caps = this._capsForFold(rows, others, held, charId, download);
        if (caps.size === 0) return rows;
        const { records, repairedIds } = repairOverRecorded([...others, ...rows], caps);
        if (repairedIds.size === 0) return rows;
        return records.filter((record) => bucketOf(record) === day);
    }

    /**
     * The caps one fold may cut with: the held ones, as the repair would read them once this pull has landed.
     *
     * The held caps are as old as the last repair run. The same download can carry the proof that one is stale,
     * another device's log, archive or baseline saying the listing filled more, along with the fill itself. The
     * repair after the reload would read that and keep the fill, so the fold has to as well. Any status counts: a
     * listing cannot have filled less than any device ever saw it fill. The same goes for this tab's own baseline,
     * and a listing back on the book has no cap, nor has a lone row of a listing the log gives no count for, nor
     * one whose count on another day this fold cannot trust (see {@link _listingsTrimmedElsewhere}).
     * @param {Array<Object>} rows - The folded day's rows
     * @param {Array<Object>} others - The same listings' rows on other days, from memory
     * @param {{caps: Map<number, number>, archiveOnly: Set<number>}} held - The held caps
     * @param {string} charId - Whose ledger
     * @param {Object<string, *>} download - The whole download of this store
     * @returns {Map<number, number>} Listing id to the count to cut to, for this day's listings only
     * @private
     */
    _capsForFold(rows, others, held, charId, download) {
        const open = new Set();
        for (const entry of dataManager.getMarketListings() || []) {
            if (entry && !ENDED_WIRE_STATUSES.has(entry.status)) open.add(Number(entry.id));
        }
        const pulled = this._readDownload(download, charId);
        const unsure = this._listingsTrimmedElsewhere(others, pulled.trims);
        const caps = new Map();
        for (const { listingId: id } of rows) {
            if (caps.has(id) || !held.caps.has(id) || open.has(id) || unsure.has(id)) continue;
            if (held.archiveOnly.has(id) && !this._hasDoubling(id, [...rows, ...others])) continue;
            const baseline = Number(this.states[String(id)]?.filledQuantity) || 0;
            caps.set(id, Math.max(held.caps.get(id), baseline, pulled.counts.get(id) || 0));
        }
        return caps;
    }

    /**
     * The listings whose rows on other days will not be what memory holds once this pull has landed: an untrimmed
     * row in memory that the download holds trimmed. That day's own fold replaces the original with the trimmed
     * copy (see `repairOverRecorded`), so counting the original here would count units the ledger no longer holds,
     * and cut this day's real fill for them. Such a listing is left whole by this fold; the next load cuts whatever
     * was really over. A day the download lacks replaces nothing, so what memory holds there stands.
     *
     * A row memory already holds trimmed is not one of these, whatever other trim a device made of it: the count
     * memory holds for it is the one the repair uses. After the reload that follows a pulled day memory holds the
     * trimmed copy too, so this does not hold a listing open pull after pull.
     * @param {Array<Object>} others - The rows on other days, from memory
     * @param {Set<string>} trims - The download's trimmed rows, by {@link trimStamp}
     * @returns {Set<number>} Listing ids this fold must not cut
     * @private
     */
    _listingsTrimmedElsewhere(others, trims) {
        const unsure = new Set();
        if (trims.size === 0) return unsure;
        const settled = new Set();
        for (const row of others) if (row.trimmed) settled.add(trimStamp(row));
        for (const row of others) {
            const stamp = trimStamp(row);
            if (trims.has(stamp) && !settled.has(stamp)) unsure.add(row.listingId);
        }
        return unsure;
    }

    /**
     * What a fold needs from the rest of a download, read once per download and only when a day has something a held
     * cap applies to: the highest fill count it holds for each listing of one character (its log, its archive months
     * and its baselines), and that character's trimmed rows.
     * @param {Object<string, *>} download - The whole download of this store
     * @param {string} charId - Whose rows
     * @returns {{charId: string, counts: Map<number, number>, trims: Set<string>}} Listing id to count, and the
     *   trimmed rows by {@link trimStamp}
     * @private
     */
    _readDownload(download, charId) {
        const memo = this._pulledCountsMemo.get(download);
        if (memo && memo.charId === charId) return memo;
        const counts = new Map();
        const trims = new Set();
        const raise = (id, filled) => {
            const count = Number(filled);
            if (Number.isFinite(id) && count > 0 && !(counts.get(id) >= count)) counts.set(id, count);
        };
        const logKey = charKey(LISTING_LOG_BASE, charId);
        const statesKey = charKey(STATE_BASE, charId);
        const archiveMonths = `${ARCHIVE_PREFIX}_${charId}_`;
        const dayRecords = `${RECORD_PREFIX}_${charId}_`;
        for (const [key, value] of Object.entries(download)) {
            if (key === statesKey) {
                if (!value || typeof value !== 'object') continue;
                for (const [id, entry] of Object.entries(value)) raise(Number(id), entry?.filledQuantity);
            } else if ((key === logKey || key.startsWith(archiveMonths)) && Array.isArray(value)) {
                for (const row of value) raise(Number(row?.id), row?.filledQuantity);
            } else if (key.startsWith(dayRecords) && Array.isArray(value)) {
                for (const row of value) if (row?.trimmed) trims.add(trimStamp(row));
            }
        }
        const read = { charId, counts, trims };
        this._pulledCountsMemo.set(download, read);
        return read;
    }

    /**
     * Note one finished run of the over-recorded repair.
     * @param {string} charId - The character the run began under
     * @param {number} cut - How many listings it cut back (0 when it found nothing over-recorded)
     * @private
     */
    _noteRepair(charId, cut) {
        const entry = this._repairStats.get(charId) || { runs: 0, cut: 0 };
        entry.runs += 1;
        entry.cut += cut;
        this._repairStats.set(charId, entry);
    }

    /**
     * What the over-recorded repair did this session for the character now on screen.
     *
     * `runs: 0` is "has not run yet" (the ledger was not loaded, the open listings were not known, or the
     * archive could not be read), which is not the same as a run that cut nothing (`runs > 0, cut: 0`).
     * `recording` says whether the ledger is on, so a report can tell "off" from "has not got there yet".
     * @returns {{charId: string, runs: number, cut: number, recording: boolean}} A copy; never the live entry
     */
    repairStats() {
        const charId = ledgerCharId();
        const entry = this._repairStats.get(charId);
        return { charId, runs: entry ? entry.runs : 0, cut: entry ? entry.cut : 0, recording: this.isInitialized };
    }

    /**
     * Setup setting listener for feature toggle
     */
    setupSettingListener() {
        config.onSettingChange('market_tradeLedger', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        // A character switch clears the settings cache and fans `character_switched`
        // out to this module's import-time listener *before* feature-registry
        // reloads settings, so the initialize() below reads no stored value and
        // getSetting() answers from SCHEMA_DEFAULTS — `true` for the ledger.
        // A character who turned it off would silently start recording again,
        // and initialize()'s isInitialized short-circuit means the later
        // re-init corrects nothing; loadSettings() fires no per-key change
        // callback on a switch either (the previous map is empty). This
        // channel, which fires whenever settings finish loading, is the one
        // signal that reaches here, so the real value gets the last word.
        // Only downward: bringing the feature *up* is the registry's re-init.
        config.onSettingsLoaded(() => {
            if (!config.getSetting('market_tradeLedger')) {
                this.disable();
            }
        });
    }

    /**
     * Initialize ledger recording
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_tradeLedger')) {
            return;
        }

        this.isInitialized = true;

        // `isInitialized` is set *before* the read, deliberately: moving it after
        // would make a switch's re-initialise early-return and leave the ledger
        // dead until a reload. What it does not do is protect the resumed tail,
        // which is what the ticket is for.
        //
        // `disable()` — the feature toggled off, or `onSettingsLoaded` finding
        // the arriving character had it off — nulls both handler fields and does
        // *not* bump `_generation`, so `load()`'s own character/generation guard
        // sees nothing wrong and runs to completion. The tail then resumed on a
        // torn-down store: it ran a snapshot `processListings` (which sweeps
        // baselines and persists them through `saveStates`) and re-registered
        // both handlers into the fields `disable()` had just cleared, so a
        // feature the user had switched off went on recording with no handle
        // left to stop it by. On a character switch the same tail orphaned the
        // departing character's handler pair under the arriving character's.
        const ticket = captureOwner(this);
        await this.load();
        // Ahead of the snapshot pass, not merely ahead of the registrations:
        // the snapshot writes, and a torn-down store must not write.
        if (!stillOurs(ticket)) return;

        // Diff the listings we already have against the stored baselines: fills
        // that landed while the script was not running surface here. Snapshot
        // mode, because this is the complete set of open listings — baselines
        // for listings that ended offline are unknowable and get dropped. Only
        // when character data has actually arrived, though: before that,
        // getMarketListings() is an empty array that means "not loaded yet",
        // and treating it as a snapshot would wipe every stored baseline.
        if (dataManager.characterData) {
            this.processListings(dataManager.getMarketListings(), true);
            this._repairOverRecorded();
        }

        this.initHandler = (data) => {
            if (Array.isArray(data?.myMarketListings)) {
                this.processListings(data.myMarketListings, true);
                this._repairOverRecorded(data.myMarketListings);
            }
        };
        this.updateHandler = (data) => {
            this.handleMarketUpdate(data);
        };

        dataManager.on('character_initialized', this.initHandler);
        dataManager.on('market_listings_updated', this.updateHandler);
    }

    /**
     * Load records and listing-state baselines from storage.
     *
     * A read that could not be made is not an empty ledger: each key is probed
     * with a read that says whether it worked, and on failure the in-memory
     * copy stands. Taking a failed read for an empty one, and then writing it
     * back on the next fill, is how a whole ledger would vanish. What is stored
     * is folded under what is in memory, so a fill this tab recorded while a
     * save was in flight is kept.
     *
     * The first load after the upgrade splits the single key into day records
     * (see the module doc); every later load reads the day records and folds in
     * a single key that has come back from somewhere.
     */
    async load() {
        // The character is captured once, before the first read, and every key
        // below is built from it. `characterKey()` answers with whoever is
        // current at the moment it is called, so a switch landing between two
        // of these reads used to give the marker, the day records, the single
        // key and the baselines different owners — and the migration writes
        // below then wrote the departing character's split marker over the
        // arriving character's, and deleted the arriving character's
        // un-migrated single key, losing their whole ledger.
        const charId = ledgerCharId();
        const started = this._generation;
        /** Whether this load still speaks for the character it began under. */
        const current = () => this._generation === started && ledgerCharId() === charId;
        const capsEpoch = this._capsEpoch;
        try {
            const markerProbe = await storage.tryGet(charKey(SPLIT_MARKER_BASE, charId), LEDGER_STORE);
            if (!current()) return;
            if (markerProbe === null) {
                console.warn('[TradeLedger] Records could not be read; keeping the in-memory copy');
            } else if (markerProbe.found) {
                this._legacy = false;
                let stored = await this._readBuckets(charId);
                const legacyProbe = await storage.tryGet(charKey(RECORDS_BASE, charId), LEDGER_STORE);
                if (!current()) return;
                if (legacyProbe?.found && Array.isArray(legacyProbe.value)) {
                    stored = mergeRecords(stored, legacyProbe.value);
                    await withTimeout(this._absorbLegacy(charId, legacyProbe.value), MIGRATION_TIMEOUT_MS, undefined);
                    if (!current()) return;
                }
                this.records = mergeRecords(stored, this.records);
            } else {
                const recordsProbe = await storage.tryGet(charKey(RECORDS_BASE, charId), LEDGER_STORE);
                if (!current()) return;
                if (recordsProbe === null) {
                    console.warn('[TradeLedger] Records could not be read; keeping the in-memory copy');
                } else {
                    const stored = recordsProbe.found
                        ? recordsProbe.value
                        : (await readScoped(RECORDS_BASE, LEDGER_STORE, [])) || [];
                    if (!current()) return;
                    // A split that hangs must not hold up the features that
                    // initialize after this one: fall back to the legacy path
                    const split = await withTimeout(
                        this._split(charId, Array.isArray(stored) ? stored : []),
                        MIGRATION_TIMEOUT_MS,
                        false
                    );
                    if (!current()) return;
                    this._legacy = !split;
                    this.records = mergeRecords(stored, this.records);
                }
            }

            const statesProbe = await storage.tryGet(charKey(STATE_BASE, charId), LEDGER_STORE);
            if (!current()) return;
            if (statesProbe === null) {
                console.warn('[TradeLedger] Listing baselines could not be read; keeping the in-memory copy');
            } else {
                const stored = statesProbe.found
                    ? statesProbe.value
                    : (await readScoped(STATE_BASE, LEDGER_STORE, {})) || {};
                if (!current()) return;
                this.states = mergeStates(stored, this.states);
            }
        } catch (error) {
            console.error('[TradeLedger] Failed to load ledger:', error);
            // Keep whatever is in memory; an empty ledger here would be written
            // back over the stored one by the next fill
        }
        if (!current()) return;
        // Rows still waiting for storage are part of this ledger however the reads above went
        const unsaved = this._unsavedFills.get(charId);
        if (unsaved) {
            this.records = mergeRecords(
                this.records,
                [...unsaved.values()].map((entry) => entry.row)
            );
        }
        this.isLoaded = true;
        this._loadedFor = charId;
        // A ledger at its cap evicts, and records its floor for sync, on the
        // load too: day records a pull wrote back before the floor was recorded
        // would otherwise wait for this character's next fill to go
        if (!this._legacy && this.records.length >= LEDGER_RECORD_CAP) this.saveRecords(new Set());
        this._repairOverRecorded(null, capsEpoch);
    }

    /**
     * What the log and the archive say each listing finally filled, for the repair. Reads only, off the records
     * chain: this can take as long as the archive does, and a fill's save must not wait for it.
     *
     * Only `filled` rows with a positive count count (`expired` is ignored, see {@link TRUSTED_LOG_STATUS}), and
     * never a row an import stamped (`importedAt`): its count came from a file and may be low. A log
     * that cannot be read, or holds no array, names nothing: that is "not loaded", which is not "empty of fills".
     *
     * The archive is read once for a load, by the first run that has anything to check, so the caps the sync pull
     * fold holds are checked before any pull (see `_pullCaps`). After that it is read only when {@link _archiveNeeded}
     * says so. A read costs every month of the character's archive.
     * @param {string} charId - Whose listings
     * @param {Set<number>} openIds - Listings still open (or not known to have ended)
     * @param {boolean} [askArchive] - Read the archive whatever the rows say
     * @returns {Promise<{logCounts: Map<number, number>, archiveCounts: Map<number, number>, seenInLog: Set<number>,
     *   logRead: boolean, checked: boolean}|null>} `checked` is whether this read the archive; null when the
     *   archive was needed and could not be read, which defers the whole repair
     * @private
     */
    async _readFinalCounts(charId, openIds, askArchive = false) {
        const counts = {
            logCounts: new Map(),
            archiveCounts: new Map(),
            seenInLog: new Set(),
            logRead: false,
            checked: false,
        };
        // A row an import stamped is a count out of a file, not something this ledger watched the game finish: it
        // may be lower than what the player really filled, and a cap that is too low cuts real fills. It names
        // nothing. A real log or archive row of the same listing still does
        const imported = (row) => row?.importedAt !== undefined && row?.importedAt !== null;
        const note = (row, into) => {
            const id = Number(row?.id);
            const filled = Number(row?.filledQuantity);
            if (imported(row)) return;
            if (!Number.isFinite(id) || row?.status !== TRUSTED_LOG_STATUS || !(filled > 0)) return;
            if (!(into.get(id) >= filled)) into.set(id, filled);
        };
        const probe = await storage.tryGet(charKey(LISTING_LOG_BASE, charId), LEDGER_STORE);
        // Unreadable, or not an array: not loaded. Absent: a log with nothing in it, the archive may still know
        if (probe === null || (probe.found && !Array.isArray(probe.value))) return counts;
        counts.logRead = true;
        if (probe.found) {
            for (const row of probe.value) {
                const id = Number(row?.id);
                // An imported row does not count as the log knowing the listing: the archive is then asked
                if (Number.isFinite(id) && !imported(row)) counts.seenInLog.add(id);
                note(row, counts.logCounts);
            }
        }
        if (askArchive || this._archiveNeeded(charId, counts, openIds)) {
            // A read that never settles counts as unreadable: the next repair is waiting behind this one
            const archived = await withTimeout(listingArchive.read(charId), MIGRATION_TIMEOUT_MS, null);
            // `read` answers null when the archive could not be read and an array (possibly empty) when it
            // could: an unreadable archive may hold a higher count than the log, so the repair waits
            if (!Array.isArray(archived)) return null;
            for (const row of archived) note(row, counts.archiveCounts);
            counts.checked = true;
        }
        return counts;
    }

    /**
     * Whether the archive has to be asked before this log can be acted on: on a load's first look, or when a row
     * would be cut. Any total over its log count, since the repair would trim it. A single fill missing from the
     * log has no cap to be trimmed to, so it does not cost a read of its own.
     * @param {string} charId - Whose listings
     * @param {{logCounts: Map<number, number>, seenInLog: Set<number>}} counts - What the log said
     * @param {Set<number>} openIds - Listings still open (or not known to have ended)
     * @returns {boolean} True when the archive must be read first
     * @private
     */
    _archiveNeeded(charId, { logCounts, seenInLog }, openIds) {
        const firstLook = this._pullCaps?.charId !== charId;
        if (firstLook && (logCounts.size > 0 || this.records.length > 0)) return true;
        const totals = new Map(); // listing id to {total, rows}
        for (const record of this.records) {
            const entry = totals.get(record.listingId) || { total: 0, rows: 0 };
            entry.total += Number(record.quantity) || 0;
            entry.rows += 1;
            totals.set(record.listingId, entry);
        }
        for (const [id, { total, rows }] of totals) {
            if (openIds.has(id)) continue;
            if (total > (logCounts.get(id) ?? Infinity) || (rows >= 2 && !seenInLog.has(id))) return true;
        }
        return false;
    }

    /**
     * The final fill count of every listing known as ended, by listing id, as of now.
     *
     * Taken when the cut runs, not when the counts were read: the count is raised to the highest `filledQuantity`
     * this tab's baselines ever saw for the listing, so a stale low count can never cut a fill the baseline already
     * counted, and a fill landing during an archive read has moved the baseline by then. A listing not known as
     * ended is left out.
     * @param {{logCounts: Map<number, number>, archiveCounts: Map<number, number>}} counts - What was read
     * @param {Set<number>} openIds - Listings still open (or not known to have ended)
     * @returns {{caps: Map<number, number>, logged: Set<number>}} The caps, and which of them a log row gives
     * @private
     */
    _endedFills({ logCounts, archiveCounts }, openIds) {
        const caps = new Map(logCounts);
        for (const [id, filled] of archiveCounts) if (!(caps.get(id) >= filled)) caps.set(id, filled);
        for (const id of [...caps.keys()]) {
            if (openIds.has(id)) {
                caps.delete(id);
                continue;
            }
            const baseline = Number(this.states[String(id)]?.filledQuantity);
            if (baseline > caps.get(id)) caps.set(id, baseline);
        }
        return { caps, logged: new Set(logCounts.keys()) };
    }

    /**
     * Cut the recorded fills of any ended listing back to what the listing's own log row says it filled.
     *
     * Repairs what a stale baseline recorded twice (see {@link mergeStates}). Idempotent and safe to run on
     * every load: it only ever shrinks a listing that is over its final count, never touches one the log
     * does not know as ended, and a listing already at or under its count is left byte for byte as it was.
     * Nothing is stored beyond the day records themselves, so there is no tombstone to sync: the cut is a pure
     * function of the rows and the log, and a pull that brings an old device's rows back is cut again by the
     * next load, or by the pull's own fold when it lands ({@link _foldPulledDay}). A day left with nothing is
     * kept as an empty record so that fold runs on it. The rewrite replaces the repaired listings' rows inside the write's own transaction (so the
     * removed rows do not come back through the union that the other writes use) and leaves every other row
     * of the day alone.
     *
     * A listing no trusted log row gives a count for is cut only with two or more rows (see {@link _hasDoubling}).
     *
     * The reads run first, on their own chain; only the cut joins the record saves, so a fill's save never waits on
     * the archive (a fill stored behind a slow read could be lost to a baseline landing first). A row that went over
     * its count after the reads sends the run back to the archive before anything is trimmed.
     * Standing down on a character switch, and on a store that is still the single key, which this repair does not
     * handle (the next load that has split it will).
     * Skipped whole, with nothing cut, until the character's open listings are known: an empty list that
     * means "not loaded" is not an empty book.
     * @param {Array<Object>|null} [openListings] - The character's listings, when the caller has them (the
     *   `character_initialized` payload); otherwise the data manager's, once character data has arrived
     * @param {number} [capsEpoch] - `_capsEpoch` when the work this run belongs to began: a run the ledger was
     *   switched off behind cuts as asked but holds no caps for the pull fold
     * @returns {Promise<number>} How many listings were cut
     * @private
     */
    _repairOverRecorded(openListings = null, capsEpoch = this._capsEpoch) {
        // Keyed by the id read below, over memory that is the departing character's for a moment before a switch
        // lands (see _departing): a cut there would be filed under the arriving character
        if (this._departing()) return Promise.resolve(0);
        const charId = ledgerCharId();
        const started = this._generation;
        const current = () => this._generation === started && ledgerCharId() === charId;
        const openNow = () => {
            const listings = Array.isArray(openListings)
                ? openListings
                : dataManager.characterData
                  ? dataManager.getMarketListings()
                  : null;
            if (!listings) return null;
            const openIds = new Set();
            for (const entry of listings) {
                if (entry && !ENDED_WIRE_STATUSES.has(entry.status)) openIds.add(Number(entry.id));
            }
            return openIds;
        };
        /** The cut, on the records chain. Answers null when the archive has to be read first. */
        const cut = async (counts) => {
            try {
                if (!current() || this._legacy || !this.isLoaded) return 0;
                const openIds = openNow();
                if (!openIds) return 0;
                if (counts.logRead && !counts.checked && this._archiveNeeded(charId, counts, openIds)) return null;
                const { caps: known, logged } = this._endedFills(counts, openIds);
                if (this._capsEpoch === capsEpoch) this._noteCaps(charId, known, logged, counts.checked, openIds);
                const caps = new Map();
                for (const [id, cap] of known) {
                    if (logged.has(id) || this._hasDoubling(id, this.records)) caps.set(id, cap);
                }
                if (caps.size === 0) {
                    this._noteRepair(charId, 0);
                    return 0;
                }

                const { records, repairedIds } = repairOverRecorded(this.records, caps);
                if (repairedIds.size === 0) {
                    this._noteRepair(charId, 0);
                    return 0;
                }
                this._noteRepair(charId, repairedIds.size);
                const days = new Set();
                for (const record of this.records) if (repairedIds.has(record.listingId)) days.add(bucketOf(record));
                this.records = records;

                const mine = (record) => record && repairedIds.has(record.listingId);
                for (const day of days) {
                    const key = recordKey(charId, day);
                    const probe = await storage.tryGet(key, LEDGER_STORE);
                    // A day that cannot be read is repaired by the next load; memory is already right
                    if (probe === null || !current()) continue;
                    const stored = probe.found && Array.isArray(probe.value) ? probe.value : [];
                    // Memory's rows of the day, not only the repaired listings': the immediate write below drops a
                    // debounced one still queued for this key (a fill found at load or on a reconnect, whose save
                    // waits behind this cut), and that fill lives only in memory. `records` is already cut, so
                    // a row removed above is not among them
                    const next = mergeRecords(
                        stored.filter((record) => !mine(record)),
                        records.filter((r) => bucketOf(r) === day)
                    );
                    // Nothing stored and nothing to put: nothing to do
                    if (next.length === 0 && !probe.found) continue;
                    // Immediate and awaited: a debounced write still pending when the next save reads would let that
                    // save fold the removed rows straight back in. The fold runs inside the write's own transaction,
                    // on what is stored when it lands, so a fill another tab stored after the read above survives.
                    // A day left with nothing stays as an empty record rather than being deleted: a key that is
                    // gone is one a pull writes back whole from a gist that still holds the cut rows (no fold runs
                    // for a key this device lacks), where an empty record is folded like any other day and, with
                    // nothing new in it, left alone. Every reader treats it as a day with no fills
                    await storage.set(key, next, LEDGER_STORE, true, {
                        fold: (now, held) =>
                            Array.isArray(now) && Array.isArray(held)
                                ? mergeRecords(
                                      now.filter((record) => !mine(record)),
                                      held
                                  )
                                : held,
                    });
                }
                return repairedIds.size;
            } catch (error) {
                console.error('[TradeLedger] Failed to repair over-recorded fills:', error);
                return 0;
            }
        };
        const queueCut = (counts) => {
            const work = () => cut(counts);
            this._recordsChain = (this._recordsChain || Promise.resolve()).then(work, work);
            return this._recordsChain;
        };
        const run = async () => {
            try {
                if (!current() || this._legacy || !this.isLoaded) return 0;
                const openIds = openNow();
                if (!openIds) return 0;
                const counts = await this._readFinalCounts(charId, openIds);
                // Stood down (a switch landed) or deferred (the archive could not be read): the repair did not run
                if (!current() || counts === null) return 0;
                const result = await queueCut(counts);
                if (result !== null) return result;
                // A fill landed since the reads and took a listing over its count: ask the archive, then cut
                const checked = await this._readFinalCounts(charId, openIds, true);
                if (!current() || checked === null) return 0;
                return (await queueCut(checked)) ?? 0;
            } catch (error) {
                console.error('[TradeLedger] Failed to repair over-recorded fills:', error);
                return 0;
            }
        };
        this._repairChain = (this._repairChain || Promise.resolve()).then(run, run);
        return this._repairChain;
    }

    /**
     * Every day record of one character, as one ledger.
     *
     * One key at a time rather than a whole-store read: the store holds the
     * other market trackers too.
     * @param {string} charId - Whose records
     * @returns {Promise<Array<Object>>} Oldest first, capped
     * @private
     */
    async _readBuckets(charId) {
        const keys = await storage.getAllKeys(LEDGER_STORE);
        const records = [];
        for (const key of recordKeysFor(keys, RECORD_PREFIX, charId)) {
            const bucket = await storage.get(key, LEDGER_STORE, null);
            if (Array.isArray(bucket)) records.push(...bucket);
        }
        return mergeRecords([], records);
    }

    /**
     * Split the single key into day records and replace it with the marker.
     *
     * Day records that already exist — an earlier attempt that got as far as
     * writing some of them — are merged, not overwritten. The marker is written
     * only once every record has landed, so a split that stalls is simply
     * retried by the next load; a single key that outlives its marker is
     * absorbed by that load (see {@link _absorbLegacy}).
     * @param {string} charId - Whose ledger
     * @param {Array<Object>} legacy - The single-key value, possibly empty
     * @returns {Promise<boolean>} True when the day records are now the record
     * @private
     */
    async _split(charId, legacy) {
        const grouped = groupByBucket(legacy);
        if (grouped.size > 0) {
            const entries = {};
            for (const [bucket, records] of grouped) {
                const key = recordKey(charId, bucket);
                const existing = await storage.get(key, LEDGER_STORE, null);
                entries[key] = Array.isArray(existing) ? mergeRecords(existing, records) : records;
            }
            const written = await storage.putAll(LEDGER_STORE, entries);
            if (written !== grouped.size || storage.isQuotaExceeded()) {
                console.warn(
                    `[TradeLedger] Splitting the stored ledger stalled (${written}/${grouped.size} days) — ` +
                        'keeping the single key and reading from it'
                );
                return false;
            }
        }

        const marked = await storage.set(
            charKey(SPLIT_MARKER_BASE, charId),
            { at: Date.now(), records: legacy.length },
            LEDGER_STORE,
            true
        );
        if (!marked) {
            console.warn('[TradeLedger] The split marker could not be written — keeping the single key');
            return false;
        }

        // A delete that fails here is not a problem: the next load finds the
        // marker, folds the single key back into the day records and tries
        // the delete again
        await storage.delete(charKey(RECORDS_BASE, charId), LEDGER_STORE);
        return true;
    }

    /**
     * Fold a single key that reappeared after the split into the day records,
     * then remove it.
     *
     * Merge, never overwrite: the day records may hold fills the single key
     * never saw, and the single key may hold fills (from the device or tab
     * that wrote it) the day records never saw.
     * @param {string} charId - Whose ledger
     * @param {Array<Object>} legacy - The single-key value
     * @returns {Promise<void>}
     * @private
     */
    async _absorbLegacy(charId, legacy) {
        const grouped = groupByBucket(legacy);
        const entries = {};
        for (const [bucket, records] of grouped) {
            const key = recordKey(charId, bucket);
            const existing = await storage.get(key, LEDGER_STORE, null);
            entries[key] = Array.isArray(existing) ? mergeRecords(existing, records) : records;
        }
        const written = grouped.size > 0 ? await storage.putAll(LEDGER_STORE, entries) : 0;
        if (written !== grouped.size) {
            console.warn('[TradeLedger] A returned single key could not be folded into the day records; leaving it');
            return;
        }
        await storage.delete(charKey(RECORDS_BASE, charId), LEDGER_STORE);
    }

    /**
     * Handle a market_listings_updated event.
     *
     * `endMarketListings` is the raw array of changed listings (fills, cancels,
     * expiries, new orders); `myMarketListings` is dataManager's merged view of
     * everything still open. Both describe the same listings, so they are
     * deduplicated by id with the `endMarketListings` copy winning — it is the
     * one that carries terminal statuses and final fill counts.
     * @param {Object} data - Event payload from dataManager
     */
    handleMarketUpdate(data) {
        const byId = new Map();
        for (const listing of Array.isArray(data?.myMarketListings) ? data.myMarketListings : []) {
            if (listing && listing.id !== undefined && listing.id !== null) {
                byId.set(listing.id, listing);
            }
        }
        const changedIds = new Set();
        for (const listing of Array.isArray(data?.endMarketListings) ? data.endMarketListings : []) {
            if (listing && listing.id !== undefined && listing.id !== null) {
                byId.set(listing.id, listing);
                changedIds.add(listing.id);
            }
        }

        if (byId.size === 0) {
            return;
        }

        this.processListings([...byId.values()], false, changedIds);
    }

    /**
     * Diff a batch of listings against stored baselines, appending any fills.
     * @param {Array<Object>} listings - Listing objects from the wire
     * @param {boolean} snapshot - Whether `listings` is the complete set of open listings
     * @param {Set<number|string>} [changedIds] - Ids the live event itself reported changed
     */
    processListings(listings, snapshot, changedIds = null) {
        if (!this.isLoaded) {
            return;
        }

        // In the gap before `character_switched` (see _departing) memory is the departing character's and the id is
        // not. A snapshot there is the arriving character's and would sweep the departing one's baselines. A live
        // event is read only for listings that name the departing character: one that names another, or none, is
        // not provably theirs, and the arriving character's own listings are found by their snapshot at load.
        const departing = this._departing();
        let batch = listings;
        if (departing) {
            if (snapshot) return;
            batch = (Array.isArray(listings) ? listings : []).filter(
                (listing) => listing && String(listing.characterID) === String(departing)
            );
            if (batch.length === 0) return;
        }
        // Fills belong to whoever memory belongs to, never to whoever the id says by the time this runs
        const owner = departing || ledgerCharId();

        const { fills, states, changed } = detectFills(this.states, batch, { snapshot, changedIds });
        this.states = states;

        let dirty = null;
        if (fills.length > 0) {
            const before = this.records;
            const after = trimLedger([...before, ...fills], LEDGER_RECORD_CAP);

            // The day records to write: the new fills' days, plus the days of
            // any records the cap just pushed out (those records shrink or go)
            dirty = new Set(fills.map(bucketOf));
            if (after.length < before.length + fills.length) {
                const kept = new Set(after);
                for (const record of before) {
                    if (!kept.has(record)) dirty.add(bucketOf(record));
                }
            }

            this.records = after;
            this._noteFills(owner, fills);
        }
        const writes = this._unsavedFills.size > 0 ? this._flushUnsaved() : null;
        if (departing) {
            // The flush above writes the rows under their own character. A save keyed by the current id must not
            // run from here; the day records' cap bookkeeping waits for that character's next save
            if (changed) this._saveDepartingStates(departing, writes);
            return;
        }
        if (dirty) this.saveRecords(dirty);
        if (changed || this._statesOwed) {
            this.saveStates(writes);
        }
    }

    /**
     * Fold a day's records in memory and storage together, and apply the cap.
     *
     * New fills do not depend on this: {@link _flushUnsaved} has already written them. What this adds is the rows
     * only storage knew coming into memory, memory's rows going back to a day another writer replaced, and the cap.
     * All of that is memory from before any restore, so all of it stays behind the latch.
     *
     * Only the day records named in `buckets` are written — a fill touches its
     * own day, not the whole ledger. Each one is read-merge-written, serialized:
     * the stored day record is re-read and folded under the in-memory one
     * before the write, so another tab's fills in that day, or records this
     * tab never loaded, are carried forward rather than overwritten. When the
     * pre-write read cannot be made the write is skipped outright — the ledger
     * in memory is kept and the next save retries — because a blind overwrite
     * from a possibly-empty copy is exactly the accident this exists to
     * prevent. Writes go through the debounce, so a burst of fills in one
     * event lands as one write per day touched.
     *
     * With the cap reached, the oldest records in memory are the floor: stored
     * records older than that are dropped from the day record as they are from
     * memory, which is how the cap shrinks storage and not just memory.
     *
     * While the single key is still the record (a split that could not be
     * written), the whole ledger is read-merge-written to it as it always was.
     * @param {Iterable<string>} [buckets] - Day ids to write; every day in memory when omitted
     * @returns {Promise<boolean>} Whether every write was issued
     */
    async saveRecords(buckets) {
        const wanted = buckets ? new Set(buckets) : null;
        const run = async () => {
            // Memory is the departing character's for a moment before the switch lands (see _departing): a save
            // keyed by the arriving id would file their records under it. Their fills are already written
            if (this._departing()) return false;
            // Captured before the first read and used for every key, probe and
            // write alike: a switch landing in the read-merge-write below made
            // the probe one character's and the write another's, folding the
            // departing character's fills into the arriving character's key.
            const charId = ledgerCharId();
            const started = this._generation;
            const current = () => this._generation === started && ledgerCharId() === charId;
            try {
                if (this._legacy) {
                    const probe = await storage.tryGet(charKey(RECORDS_BASE, charId), LEDGER_STORE);
                    if (probe === null) {
                        console.warn('[TradeLedger] Records not saved: storage could not be read first');
                        return false;
                    }
                    if (!current()) return false;
                    const stored = probe.found && Array.isArray(probe.value) ? probe.value : [];
                    this.records = mergeRecords(stored, this.records);
                    // Debounced, and the probe above is only as fresh as the moment it ran: a sync pull can store
                    // a copy in the seconds before this lands. The fold runs again inside the transaction that
                    // lands it, so that copy is merged rather than written over.
                    return await storage.set(charKey(RECORDS_BASE, charId), this.records, LEDGER_STORE, false, {
                        fold: (now, held) =>
                            Array.isArray(now) && Array.isArray(held) ? mergeRecords(now, held) : held,
                    });
                }

                const grouped = groupByBucket(this.records);
                const days = wanted ? new Set(wanted) : new Set(grouped.keys());
                const writtenDays = this._writtenDays.get(charId) || new Set();
                for (const day of writtenDays) if (grouped.has(day)) days.add(day);
                let floorT = -Infinity;
                if (this.records.length >= LEDGER_RECORD_CAP) {
                    floorT = Infinity;
                    for (const record of this.records) if (record.t < floorT) floorT = record.t;
                }
                // Storage is cut by whole days: the floor day keeps the fills
                // below the floor that memory let go of. A day record is the
                // unit sync can see (the floor marker names a day); one trimmed
                // inside differed from the gist's copy of it, and every merged
                // push reported that difference as news
                const floorBucket = Number.isFinite(floorT) ? bucketOf({ t: floorT }) : null;

                let issued = true;
                const carried = [];
                for (const bucket of days) {
                    const key = recordKey(charId, bucket);
                    const probe = await storage.tryGet(key, LEDGER_STORE);
                    if (probe === null) {
                        console.warn(`[TradeLedger] ${bucket} not saved: storage could not be read first`);
                        issued = false;
                        continue;
                    }
                    if (!current()) return false;
                    const stored = probe.found && Array.isArray(probe.value) ? probe.value : [];
                    const memory = grouped.get(bucket) || [];
                    const keep = (record) => floorBucket === null || bucketOf(record) >= floorBucket;
                    const merged = mergeRecords(stored, memory).filter(keep);

                    if (merged.length === 0) {
                        if (probe.found) await storage.delete(key, LEDGER_STORE);
                        continue;
                    }
                    // Only what memory's own cap keeps is carried into memory
                    const reachable = merged.filter((record) => record.t >= floorT);
                    if (reachable.length > memory.length) carried.push(...reachable);
                    // Nothing memory holds is missing from the stored copy, and the
                    // cap took nothing out of it: there is nothing to write
                    const storedKeys = new Set(stored.map((record) => record && fillKey(record)));
                    if (
                        probe.found &&
                        merged.length === stored.length &&
                        merged.every((record) => storedKeys.has(fillKey(record)))
                    ) {
                        continue;
                    }
                    writtenDays.add(bucket);
                    this._writtenDays.set(charId, writtenDays);
                    // Folded again as it lands, inside the write's own transaction:
                    // what another tab or a pull stored after the read above is kept
                    storage.set(key, merged, LEDGER_STORE, false, {
                        fold: (now, value) =>
                            Array.isArray(now) && Array.isArray(value) ? mergeRecords(now, value).filter(keep) : value,
                    });
                }

                // Rows only storage knew come into memory too, as they did
                // when the whole ledger was merged on every save
                if (carried.length > 0) this.records = mergeRecords(this.records, carried);

                // Days that fell off the cap before this save are not in
                // `days` — nothing in memory points at them any more — so
                // trimming only the days being written leaves them in storage
                // for ever. Sweep them by key, which costs one `getAllKeys`
                // and only when the cap is actually in force.
                if (floorBucket !== null) {
                    await this._evictBefore(charId, floorBucket);
                }
                return issued;
            } catch (error) {
                console.error('[TradeLedger] Failed to save records:', error);
                return false;
            }
        };
        // One save at a time, in order: two interleaved read-merge-writes could
        // each miss the other's entries
        this._recordsChain = (this._recordsChain || Promise.resolve()).then(run, run);
        return this._recordsChain;
    }

    /**
     * Delete day records entirely older than the cap's floor day, and record
     * the floor for sync.
     *
     * Day ids are `YYYY-MM-DD`, so a plain string comparison is a date
     * comparison; the floor day itself is kept whole.
     *
     * The floor marker (`floorKey`) is written before anything is deleted and
     * the character's older markers are deleted after it: an eviction sync
     * cannot see is one the gist hands back on the next pull. A marker that
     * does not land deletes nothing: storage keeps those days until a later
     * capped save records the floor, never a lost record.
     * @param {string} charId - Whose records
     * @param {string} floorBucket - Oldest day still in memory
     * @returns {Promise<number>} How many day records were deleted
     * @private
     */
    async _evictBefore(charId, floorBucket) {
        try {
            // `tryGetAllKeys`, not `getAllKeys`: the latter answers a listing it
            // could not make with an empty array, indistinguishable from a store
            // that genuinely has nothing to sweep. Failing this direction is
            // safe either way — nothing gets deleted, and the next capped save
            // retries the sweep — but null is still the honest answer.
            const allKeys = await storage.tryGetAllKeys(LEDGER_STORE);
            if (allKeys === null) return 0;
            const marker = floorKey(charId, floorBucket);
            if (!allKeys.includes(marker)) {
                const written = await storage.set(marker, { floor: floorBucket }, LEDGER_STORE, true);
                if (written === false) {
                    // Nothing is deleted without its marker: the gist would keep those
                    // days and every pull write them back. The next capped save retries
                    console.warn('[TradeLedger] The cap floor could not be recorded for sync; evicting nothing');
                    return 0;
                }
            }
            const keys = recordKeysFor(allKeys, RECORD_PREFIX, charId);
            const prefix = `${RECORD_PREFIX}_${charId}_`;
            let deleted = 0;
            for (const key of keys) {
                if (key.slice(prefix.length) >= floorBucket) continue;
                await storage.delete(key, LEDGER_STORE);
                deleted += 1;
            }
            // Superseded floors: sync reads only the highest
            const floorPrefix = `${FLOOR_PREFIX}_${charId}_`;
            for (const key of recordKeysFor(allKeys, FLOOR_PREFIX, charId)) {
                if (key.slice(floorPrefix.length) < floorBucket) await storage.delete(key, LEDGER_STORE);
            }
            return deleted;
        } catch (error) {
            console.error('[TradeLedger] Failed to evict day records past the cap:', error);
            return 0;
        }
    }

    /**
     * Persist listing-state baselines (debounced — they change on every event).
     *
     * Same read-merge-write as {@link saveRecords}, by listing id with memory
     * winning: a baseline this tab has moved past is the fresher one, and one
     * only storage knows is the only thing that can turn that listing's next
     * update into a fill.
     *
     * A baseline waits for the rows it accounts for, and nothing is stored while this character has a row unsaved,
     * whatever the change that asked. `this.states` has moved past that fill, so a save for any reason (a listing
     * placed) would carry the baseline to disk ahead of its row: the next load then diffs to zero and the fill is gone
     * for good. Unstored, the next load finds it again. A save held back here is owed, and made once the rows land.
     * A switch while waiting stands it down: the departing character's baseline stays behind its row, which at worst
     * records the fill once more on their next load.
     * @param {Promise<*>|null} [fillsSaved] - The writes of the fills this baseline accounts for
     * @returns {Promise<boolean>} Whether a write was issued
     */
    async saveStates(fillsSaved = null) {
        const owner = this._generation;
        const run = async () => {
            if (fillsSaved) await fillsSaved;
            if (this._generation !== owner) return false;
            // Memory is the departing character's for a moment before the switch lands: store theirs under theirs
            const departing = this._departing();
            if (departing) return this._saveDepartingStates(departing);
            // Same capture-before-the-read as saveRecords: the probe and the
            // write have to name the same character.
            const charId = ledgerCharId();
            const started = this._generation;
            /** Whether a row this baseline accounts for is still only in memory. */
            const heldBack = () => {
                if (!this._unsavedFills.has(charId)) return false;
                this._statesOwed = true;
                return true;
            };
            if (heldBack()) return false;
            try {
                const probe = await storage.tryGet(charKey(STATE_BASE, charId), LEDGER_STORE);
                if (probe === null) {
                    console.warn('[TradeLedger] Listing baselines not saved: storage could not be read first');
                    this._statesOwed = true;
                    return false;
                }
                if (this._generation !== started || ledgerCharId() !== charId) return false;
                // Again, right against the write: a fill found during the read has moved `this.states`
                if (heldBack()) return false;
                const stored = probe.found ? probe.value : {};
                this.states = mergeStates(stored, this.states);
                this._statesOwed = false;
                // Debounced, and the probe above is only as fresh as the moment it ran: the fold runs again inside
                // the transaction that lands the write, so a baseline a sync pull stored meanwhile is kept.
                return await storage.set(charKey(STATE_BASE, charId), this.states, LEDGER_STORE, false, {
                    fold: (now, held) => (now && typeof now === 'object' ? mergeStates(now, held) : held),
                });
            } catch (error) {
                console.error('[TradeLedger] Failed to save listing states:', error);
                return false;
            }
        };
        this._statesChain = (this._statesChain || Promise.resolve()).then(run, run);
        return this._statesChain;
    }

    /**
     * All fill records, oldest first, as copies.
     * @returns {Array<Object>} Fill records `{t, itemHrid, enhancementLevel, side, quantity, price, coins, listingId}`
     */
    getRecords() {
        return this.records.map((record) => ({ ...record }));
    }

    /**
     * Whether ledger data is loaded
     * @returns {boolean}
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Stop recording (keeps stored data)
     */
    disable() {
        noteTeardown(this);
        this._capsEpoch += 1;
        try {
            if (this.initHandler) {
                dataManager.off('character_initialized', this.initHandler);
                this.initHandler = null;
            }
            if (this.updateHandler) {
                dataManager.off('market_listings_updated', this.updateHandler);
                this.updateHandler = null;
            }
            this.isInitialized = false;
            this._pullCaps = null;
            // A row found before the ledger was switched off is still a real fill
            if (this._unsavedFills.size > 0) this._flushUnsaved();
        } catch (error) {
            console.error('[Trade Ledger] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Handle character switch - drop the old character's data and reinitialize
     */
    async handleCharacterSwitch() {
        this.disable();
        this._generation += 1;
        this._statesOwed = false;
        this._writtenDays = new Map();
        this._pullCaps = null;
        // A departing character's slow archive read stands down when it returns; the arriving one does not wait for it
        this._repairChain = null;
        this.records = [];
        this.states = {};
        this.isLoaded = false;
        this._loadedFor = null;
        this._legacy = false;
        await this.initialize();
    }
}

const tradeLedgerStore = new TradeLedgerStore();
tradeLedgerStore.setupSettingListener();

// Always reset in-memory state on a character switch, even while the feature
// is off: initialize() itself no-ops until the setting is on, but if we only
// reset while it's on, toggling the feature off, switching characters, then
// back on leaves the previous character's records/states in memory. load()
// then merges the new character's stored data underneath that stale copy
// instead of replacing it, corrupting the new character's ledger.
dataManager.on('character_switched', () => {
    tradeLedgerStore.handleCharacterSwitch();
});

// The last chance for a row still held: the transaction has to open before the page's connection closes, which a
// `pagehide` listener of this module's own would be too late for
storage.onBeforeTeardown?.(() => {
    tradeLedgerStore._flushUnsaved({ force: true });
});

// A row written while the pull was running has to be written again now it has landed (see `_writeFills`)
onSyncPullApplied(() => tradeLedgerStore._retryUnsaved());

export default tradeLedgerStore;
