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
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { readScoped, writeScoped, characterKey } from '../../utils/character-key.js';
import { detectFills, trimLedger, LEDGER_RECORD_CAP } from '../../utils/trade-ledger.js';

/** Same store the other market trackers live in. */
const LEDGER_STORE = 'marketListings';

/** Per-character fill records, capped at LEDGER_RECORD_CAP oldest-out. */
const RECORDS_BASE = 'tradeLedgerRecords';

/**
 * Per-character listing-state baselines (id → last observed fill progress).
 * Persisted so fills that land while the page is closed still surface as a
 * delta against the stored baseline when the next snapshot arrives.
 */
const STATE_BASE = 'tradeLedgerState';

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

/*
 * Registered so a cross-device sync PULL combines this record instead of
 * overwriting it. Registration runs at import time, which is long before the
 * earliest pull (the staggered startup pull, 20s+ after load), so the registry
 * is complete by the time sync consults it. See utils/sync-merge-registry.js.
 */
registerSyncMerge({ store: LEDGER_STORE, base: RECORDS_BASE, merge: mergeRecords, label: 'Trade ledger fills' });
registerSyncMerge({ store: LEDGER_STORE, base: STATE_BASE, merge: mergeStates, label: 'Trade ledger baselines' });

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

        await this.load();

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
     */
    async load() {
        try {
            const recordsProbe = await storage.tryGet(characterKey(RECORDS_BASE), LEDGER_STORE);
            if (recordsProbe === null) {
                console.warn('[TradeLedger] Records could not be read; keeping the in-memory copy');
            } else {
                const stored = recordsProbe.found
                    ? recordsProbe.value
                    : (await readScoped(RECORDS_BASE, LEDGER_STORE, [])) || [];
                this.records = mergeRecords(stored, this.records);
            }

            const statesProbe = await storage.tryGet(characterKey(STATE_BASE), LEDGER_STORE);
            if (statesProbe === null) {
                console.warn('[TradeLedger] Listing baselines could not be read; keeping the in-memory copy');
            } else {
                const stored = statesProbe.found
                    ? statesProbe.value
                    : (await readScoped(STATE_BASE, LEDGER_STORE, {})) || {};
                this.states = mergeStates(stored, this.states);
            }
        } catch (error) {
            console.error('[TradeLedger] Failed to load ledger:', error);
            // Keep whatever is in memory; an empty ledger here would be written
            // back over the stored one by the next fill
        }
        this.isLoaded = true;
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
        for (const listing of Array.isArray(data?.endMarketListings) ? data.endMarketListings : []) {
            if (listing && listing.id !== undefined && listing.id !== null) {
                byId.set(listing.id, listing);
            }
        }

        if (byId.size === 0) {
            return;
        }

        this.processListings([...byId.values()], false);
    }

    /**
     * Diff a batch of listings against stored baselines, appending any fills.
     * @param {Array<Object>} listings - Listing objects from the wire
     * @param {boolean} snapshot - Whether `listings` is the complete set of open listings
     */
    processListings(listings, snapshot) {
        if (!this.isLoaded) {
            return;
        }

        const { fills, states, changed } = detectFills(this.states, listings, { snapshot });
        this.states = states;

        if (fills.length > 0) {
            this.records = trimLedger([...this.records, ...fills], LEDGER_RECORD_CAP);
            this.saveRecords();
        }
        if (changed) {
            this.saveStates();
        }
    }

    /**
     * Persist fill records (immediate — fills are the whole point of the ledger).
     *
     * Read-merge-write, serialized: the stored ledger is re-read and folded
     * under the in-memory one before the write, so another tab's fills, or
     * records this tab never loaded, are carried forward rather than
     * overwritten. When the pre-write read cannot be made the write is skipped
     * outright — the ledger in memory is kept and the next save retries —
     * because a blind overwrite from a possibly-empty copy is exactly the
     * accident this exists to prevent.
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveRecords() {
        const run = async () => {
            try {
                const probe = await storage.tryGet(characterKey(RECORDS_BASE), LEDGER_STORE);
                if (probe === null) {
                    console.warn('[TradeLedger] Records not saved: storage could not be read first');
                    return false;
                }
                const stored = probe.found && Array.isArray(probe.value) ? probe.value : [];
                this.records = mergeRecords(stored, this.records);
                return await writeScoped(RECORDS_BASE, this.records, LEDGER_STORE, true);
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
            try {
                const probe = await storage.tryGet(characterKey(STATE_BASE), LEDGER_STORE);
                if (probe === null) {
                    console.warn('[TradeLedger] Listing baselines not saved: storage could not be read first');
                    return false;
                }
                const stored = probe.found ? probe.value : {};
                this.states = mergeStates(stored, this.states);
                return await writeScoped(STATE_BASE, this.states, LEDGER_STORE);
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
        this.records = [];
        this.states = {};
        this.isLoaded = false;
        await this.initialize();
    }
}

const tradeLedgerStore = new TradeLedgerStore();
tradeLedgerStore.setupSettingListener();

dataManager.on('character_switched', () => {
    if (config.getSetting('market_tradeLedger')) {
        tradeLedgerStore.handleCharacterSwitch();
    }
});

export default tradeLedgerStore;
