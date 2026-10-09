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
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { registerSyncMerge, registerSyncRetention } from '../../utils/sync-merge-registry.js';
import { readScoped } from '../../utils/character-key.js';
import { timeChunkId, recordKeysFor, registerCharacterScopedPrefix } from '../../utils/chunked-history.js';
import { detectFills, trimLedger, LEDGER_RECORD_CAP } from '../../utils/trade-ledger.js';
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
 * Two baseline maps folded into one by listing id, the second winning.
 *
 * Baselines only the stored side knows (another tab's, or written before a
 * failed read) are kept: a baseline this tab never loaded is still the only
 * thing that can turn that listing's next update into a fill.
 * @param {Object<string, Object>} base - Baselines, typically as stored
 * @param {Object<string, Object>} fresh - Baselines, typically in memory
 * @returns {Object<string, Object>} Merged map
 */
export function mergeStates(base, fresh) {
    const safe = (map) => (map && typeof map === 'object' && !Array.isArray(map) ? map : {});
    return { ...safe(base), ...safe(fresh) };
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
registerSyncMerge({ store: LEDGER_STORE, base: RECORDS_BASE, merge: mergeRecords, label: 'Trade ledger fills' });
registerSyncMerge({
    store: LEDGER_STORE,
    prefix: `${RECORD_PREFIX}_`,
    merge: mergeRecords,
    label: 'Trade ledger fills (daily)',
});
registerSyncMerge({ store: LEDGER_STORE, base: STATE_BASE, merge: mergeStates, label: 'Trade ledger baselines' });

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
         * Bumped by {@link handleCharacterSwitch}. A load or a save that began
         * under the departing character finds the number moved and stands
         * down rather than adopting that character's rows into the arriving
         * one's memory or writing them under their keys.
         */
        this._generation = 0;
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
        }

        this.initHandler = (data) => {
            if (Array.isArray(data?.myMarketListings)) {
                this.processListings(data.myMarketListings, true);
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
        this.isLoaded = true;
        // A ledger at its cap evicts, and records its floor for sync, on the
        // load too: day records a pull wrote back before the floor was recorded
        // would otherwise wait for this character's next fill to go
        if (!this._legacy && this.records.length >= LEDGER_RECORD_CAP) this.saveRecords(new Set());
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

        const { fills, states, changed } = detectFills(this.states, listings, { snapshot, changedIds });
        this.states = states;

        if (fills.length > 0) {
            const before = this.records;
            const after = trimLedger([...before, ...fills], LEDGER_RECORD_CAP);

            // The day records to write: the new fills' days, plus the days of
            // any records the cap just pushed out (those records shrink or go)
            const dirty = new Set(fills.map(bucketOf));
            if (after.length < before.length + fills.length) {
                const kept = new Set(after);
                for (const record of before) {
                    if (!kept.has(record)) dirty.add(bucketOf(record));
                }
            }

            this.records = after;
            this.saveRecords(dirty);
        }
        if (changed) {
            this.saveStates();
        }
    }

    /**
     * Persist fill records.
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
                    return await storage.set(charKey(RECORDS_BASE, charId), this.records, LEDGER_STORE);
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
     * @returns {Promise<boolean>} Whether a write was issued
     */
    async saveStates() {
        const run = async () => {
            // Same capture-before-the-read as saveRecords: the probe and the
            // write have to name the same character.
            const charId = ledgerCharId();
            const started = this._generation;
            try {
                const probe = await storage.tryGet(charKey(STATE_BASE, charId), LEDGER_STORE);
                if (probe === null) {
                    console.warn('[TradeLedger] Listing baselines not saved: storage could not be read first');
                    return false;
                }
                if (this._generation !== started || ledgerCharId() !== charId) return false;
                const stored = probe.found ? probe.value : {};
                this.states = mergeStates(stored, this.states);
                return await storage.set(charKey(STATE_BASE, charId), this.states, LEDGER_STORE);
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
        this._writtenDays = new Map();
        this.records = [];
        this.states = {};
        this.isLoaded = false;
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

export default tradeLedgerStore;
