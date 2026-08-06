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
import { readScoped, writeScoped } from '../../utils/character-key.js';
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

class TradeLedgerStore {
    constructor() {
        this.records = [];
        this.states = {};
        this.isInitialized = false;
        this.isLoaded = false;
        this.initHandler = null;
        this.updateHandler = null;
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
     * Load records and listing-state baselines from storage
     */
    async load() {
        try {
            this.records = (await readScoped(RECORDS_BASE, LEDGER_STORE, [])) || [];
            this.states = (await readScoped(STATE_BASE, LEDGER_STORE, {})) || {};
        } catch (error) {
            console.error('[TradeLedger] Failed to load ledger:', error);
            this.records = [];
            this.states = {};
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
     * Persist fill records (immediate — fills are the whole point of the ledger)
     */
    async saveRecords() {
        try {
            await writeScoped(RECORDS_BASE, this.records, LEDGER_STORE, true);
        } catch (error) {
            console.error('[TradeLedger] Failed to save records:', error);
        }
    }

    /**
     * Persist listing-state baselines (debounced — they change on every event)
     */
    async saveStates() {
        try {
            await writeScoped(STATE_BASE, this.states, LEDGER_STORE);
        } catch (error) {
            console.error('[TradeLedger] Failed to save listing states:', error);
        }
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
        if (this.initHandler) {
            dataManager.off('character_initialized', this.initHandler);
            this.initHandler = null;
        }
        if (this.updateHandler) {
            dataManager.off('market_listings_updated', this.updateHandler);
            this.updateHandler = null;
        }
        this.isInitialized = false;
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
