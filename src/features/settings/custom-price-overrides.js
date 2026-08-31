/**
 * Custom Price Overrides
 * Manages user-defined buy/sell price overrides for profit calculations.
 * Overrides are stored in IndexedDB and cached in memory.
 *
 * The map is a curated record: a read that cannot be made leaves the cache as
 * it is rather than blanking it, no write goes out over a store that could not
 * be read first, and once the map has been read back what is in memory is the
 * map — a cleared override stays cleared. Before that, a write folds the
 * stored map under memory so nothing typed in is lost either way.
 */

import marketAPI from '../../api/marketplace.js';
import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';

const STORAGE_KEY = 'Toolasha_customPriceOverrides';

/** The one global map — overrides are not per character */
const record = createCuratedRecord({
    base: STORAGE_KEY,
    store: 'settings',
    scoped: false,
    empty: () => ({}),
    merge: mergeMaps(),
    immediate: true,
    label: 'CustomPriceOverrides',
});

/** @type {Object|null} In-memory cache of overrides */
let overridesCache = null;

/** @type {Promise<Object>|null} The load in flight, so callers share one read */
let loading = null;

/**
 * Load overrides from storage into cache
 * @returns {Promise<Object>} The overrides object
 */
async function loadOverrides() {
    if (overridesCache === null) {
        if (!loading) {
            loading = (async () => {
                let readable = false;
                try {
                    readable = await record.load();
                } finally {
                    loading = null;
                }
                // An unreadable load is not cached, so the next read tries
                // again; what the record holds is still the best answer there
                // is, and the next write merges rather than overwrites
                if (readable) overridesCache = record.get();
                return record.get();
            })();
        }
        return loading;
    }
    return overridesCache;
}

/**
 * Get all custom price overrides
 * @returns {Object} The overrides object (may be empty if not yet loaded)
 */
export function getCustomPriceOverrides() {
    if (overridesCache === null) {
        // Trigger async load but return empty for now
        loadOverrides();
        return {};
    }
    return overridesCache;
}

/**
 * Get all custom price overrides (async version, guaranteed loaded)
 * @returns {Promise<Object>} The overrides object
 */
export async function getCustomPriceOverridesAsync() {
    return loadOverrides();
}

/**
 * Get a custom price for a specific item, enhancement level, and transaction side.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level (default 0)
 * @param {string} side - Transaction side ('buy' or 'sell')
 * @returns {number|null} Custom price or null if no override exists
 */
export function getCustomPrice(itemHrid, enhancementLevel = 0, side = 'sell') {
    const overrides = getCustomPriceOverrides();
    const key = `${itemHrid}:${enhancementLevel}`;
    const override = overrides[key];
    if (!override) {
        return null;
    }
    const price = override[side];
    if (price === undefined || price === null || price === '') {
        return null;
    }
    return price;
}

/**
 * Write the cache back. The record's save folds what is stored under the
 * cache until a readable load has happened, and refuses to write at all when
 * the store cannot be read.
 * @returns {Promise<boolean>} Whether the write landed
 */
async function persist() {
    record.set(overridesCache);
    const written = await record.save();
    // A merge-save may have folded stored entries in; keep the cache as the
    // record now holds it so reads and the next write agree
    overridesCache = record.get();
    // An override changes what getItemPrice answers, so the surfaces that
    // redraw on price updates (listing displays, value rows, production-cost
    // caches) must hear about the edit the same way they hear about a price
    // patch — coalesced, and even when the write itself could not land, since
    // the in-memory map they read from has already changed.
    marketAPI.scheduleNotify();
    return written;
}

/**
 * Set a custom price override for an item
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @param {number|null} buy - Buy price override (null to clear)
 * @param {number|null} sell - Sell price override (null to clear)
 */
export async function setCustomPriceOverride(itemHrid, enhancementLevel, buy, sell) {
    const overrides = await loadOverrides();
    const key = `${itemHrid}:${enhancementLevel}`;

    const entry = {};
    if (buy !== null && buy !== undefined && buy !== '') {
        entry.buy = Number(buy);
    }
    if (sell !== null && sell !== undefined && sell !== '') {
        entry.sell = Number(sell);
    }

    if (Object.keys(entry).length === 0) {
        // Both empty — remove the override
        delete overrides[key];
    } else {
        overrides[key] = entry;
    }

    overridesCache = overrides;
    await persist();
}

/**
 * Remove a custom price override
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 */
export async function removeCustomPriceOverride(itemHrid, enhancementLevel) {
    const overrides = await loadOverrides();
    const key = `${itemHrid}:${enhancementLevel}`;
    delete overrides[key];
    overridesCache = overrides;
    await persist();
}

/**
 * Initialize the module by loading overrides from storage
 */
export async function initCustomPriceOverrides() {
    await loadOverrides();
}

/**
 * Forget the cache so the next read goes back to storage — for tests, and for
 * a caller that knows the store has changed underneath it.
 */
export function resetCustomPriceOverridesCache() {
    overridesCache = null;
    record.reset();
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushCustomPriceOverrideWrites() {
    return record.flushed();
}
