/**
 * Networth Cache
 * LRU cache for expensive enhancement cost calculations
 * Prevents recalculating the same enhancement paths repeatedly
 */

import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';

/**
 * How long a params fingerprint is trusted before it is rebuilt.
 *
 * The cost of a +N depends on the enhancer's level, gear, tea and Observatory,
 * none of which change between two items of the same sweep — and enhancement-config
 * already memoises detection for about this long, so matching it costs nothing.
 */
const PARAMS_FINGERPRINT_MS = 1000;

/**
 * A short, stable string for a set of enhancing parameters.
 * @param {Object} params - `getEnhancingParams()` shape
 * @returns {string} Fingerprint
 */
function fingerprintParams(params) {
    if (!params || typeof params !== 'object') return 'none';
    return Object.keys(params)
        .sort()
        .map((key) => {
            const value = params[key];
            return `${key}:${typeof value === 'object' ? JSON.stringify(value) : value}`;
        })
        .join('|');
}

/**
 * Entries kept before the least recently used is evicted. The inventory badges walk every tile in
 * order on each pass, and a cache smaller than the set of +N pieces they price is evicted entry by
 * entry before the next pass reads it back — every pass then recomputed every enhancement path
 * (100+ ms for a +20 piece). An entry is a short key and a {cost, partial} pair, so even a few
 * thousand cost a few hundred KB.
 */
const DEFAULT_MAX_SIZE = 5000;

/**
 * The hrid of a `hrid:level` price key.
 * @param {string} key - Price key as marketAPI.getPrice() reads it
 * @returns {string}
 */
function hridOfPriceKey(key) {
    const split = key.lastIndexOf(':');
    return split === -1 ? key : key.slice(0, split);
}

class NetworthCache {
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.marketDataHash = null;
        this._paramsFingerprint = null;
        this._paramsFingerprintAt = 0;
        // Which cached costs read which item's price, so a patch to one book drops only the
        // costs built on it: input hrid -> cache keys. Costs whose reads were not recorded
        // (no recorder, or a memo that could not say) are kept in `_wide` and dropped on any move.
        this._byHrid = new Map();
        this._wide = new Set();
        /** The read recording opened by a get() miss, closed by the set() of the same key */
        this._recording = null;
        /** What syncWithMarket last saw: the market's priceVersion and the salt */
        this._syncedVersion = null;
        this._syncedSalt = null;
    }

    /**
     * The current character + enhancing-params fingerprint, memoised briefly.
     *
     * Without it the cache answers a level-140-with-blessed-tea question with a
     * level-40-no-tea cost — same item, same target level, different enhancer.
     *
     * @returns {string} Fingerprint segment for cache keys
     */
    contextKey() {
        const now = Date.now();
        if (this._paramsFingerprint !== null && now - this._paramsFingerprintAt < PARAMS_FINGERPRINT_MS) {
            return this._paramsFingerprint;
        }

        let fingerprint = 'none';
        try {
            const characterId = dataManager?.getCurrentCharacterId?.() ?? 'anon';
            fingerprint = `${characterId}#${fingerprintParams(getEnhancingParams())}`;
        } catch (error) {
            console.error('[NetworthCache] Could not read enhancing params:', error);
        }

        this._paramsFingerprint = fingerprint;
        this._paramsFingerprintAt = now;
        return fingerprint;
    }

    /**
     * Generate cache key for enhancement calculation
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {string} Cache key
     */
    generateKey(itemHrid, enhancementLevel) {
        return `${this.contextKey()}_${itemHrid}_${enhancementLevel}`;
    }

    /**
     * Generate hash of market data for cache invalidation
     * Uses first 10 items' prices as a simple hash
     * @param {Object} marketData - Market data object
     * @returns {string} Hash string
     */
    generateMarketHash(marketData) {
        if (!marketData || !marketData.marketData) return 'empty';

        // Cheap rolling hash over every item so any price change invalidates the
        // cache (sampling only the first 10 items left stale values behind)
        let hash = 0;
        for (const [hrid, data] of Object.entries(marketData.marketData)) {
            const entry = `${hrid}:${data[0]?.a || 0}:${data[0]?.b || 0}`;
            let entryHash = 0;
            for (let i = 0; i < entry.length; i++) {
                entryHash = (entryHash * 31 + entry.charCodeAt(i)) | 0;
            }
            hash = (hash ^ entryHash) | 0;
        }

        // Live price patches override the snapshot (marketAPI.getPrice), so a patch
        // (key + timestamp + sides) must change the hash too. One entry per patched
        // item, so this stays cheap; invalidation only happens when a calculation
        // next asks, so a burst of patches costs one recompute, not one per patch.
        for (const [key, patch] of Object.entries(marketData.pricePatchs || {})) {
            if (!patch) continue;
            const entry = `patch:${key}:${patch.timestamp || 0}:${patch.a ?? ''}:${patch.b ?? ''}`;
            let entryHash = 0;
            for (let i = 0; i < entry.length; i++) {
                entryHash = (entryHash * 31 + entry.charCodeAt(i)) | 0;
            }
            hash = (hash ^ entryHash) | 0;
        }

        return String(hash);
    }

    /**
     * Check if market data has changed and invalidate cache if needed
     * @param {Object} marketData - Current market data
     * @param {string} [salt=''] - Everything else the cached costs were priced from that the market
     *   hash does not see (the net-worth pricing mode, the custom prices): a change clears the cache
     */
    checkAndInvalidate(marketData, salt = '') {
        const newHash = this.generateMarketHash(marketData) + '|' + salt;

        if (this.marketDataHash !== null && this.marketDataHash !== newHash) {
            // Market data changed, invalidate entire cache
            this.clear();
        }

        this.marketDataHash = newHash;
    }

    /**
     * Catch up with the market and drop only the costs a change reached.
     *
     * A single order-book patch used to change the whole-book hash above and empty the cache, so
     * opening one book re-ran every enhancement path in the inventory (about 180 of them, a few ms
     * each). The market now logs what moved (marketAPI.changesSince), and each cost remembers the
     * prices it read, so a patch drops the costs that read that item and keeps the rest. A new
     * snapshot, a source switch, a changed salt, or falling behind the log still empties it all.
     * @param {Object} api - marketAPI, with priceVersion and changesSince()
     * @param {string} [salt=''] - As checkAndInvalidate
     * @returns {boolean} False when `api` has no change log (a stub), so the caller falls back
     */
    syncWithMarket(api, salt = '') {
        if (!api || typeof api.changesSince !== 'function' || !Number.isFinite(api.priceVersion)) return false;
        const version = api.priceVersion;
        if (this._syncedVersion === null || this._syncedSalt !== salt) {
            // First look (anything already held was priced against nothing known), or a mode,
            // custom price or setting moved: nothing cached can be trusted
            if (this.cache.size > 0) this.clear();
        } else if (version !== this._syncedVersion) {
            const change = api.changesSince(this._syncedVersion);
            if (change.full) {
                this.clear();
            } else {
                this.dropForHrids(change.hrids);
            }
        }
        this._syncedVersion = version;
        this._syncedSalt = salt;
        return true;
    }

    /**
     * Drop every cost that read a price of one of these items, and every cost whose reads are unknown.
     * @param {Iterable<string>} hrids - Items whose price moved
     */
    dropForHrids(hrids) {
        let any = false;
        for (const hrid of hrids) {
            any = true;
            const keys = this._byHrid.get(hrid);
            if (!keys) continue;
            for (const key of [...keys]) this._deleteKey(key);
        }
        if (!any) return;
        for (const key of [...this._wide]) this._deleteKey(key);
    }

    /**
     * Get cached enhancement cost
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {number|null} Cached cost or null if not found
     */
    get(itemHrid, enhancementLevel) {
        // A miss that never reached set() (the path could not be priced) leaves its recording open
        this._closeRecording();
        const entry = this._entry(itemHrid, enhancementLevel);
        if (entry) {
            // A reader recording its own reads (a pass over many costs) is owed this cost's
            marketAPI?.notePriceReads?.(entry.reads);
            return entry.cost;
        }
        // Every caller computes the cost synchronously between this miss and its set(), so what
        // getPrice() is asked for in between is what the cost is priced from
        if (typeof marketAPI?.recordPriceReads === 'function') {
            this._recording = {
                key: this.generateKey(itemHrid, enhancementLevel),
                recorder: marketAPI.recordPriceReads(),
            };
        }
        return null;
    }

    /**
     * Stop the open read recording.
     * @returns {{key: string, recorder: Object}|null} What it was
     * @private
     */
    _closeRecording() {
        const recording = this._recording;
        if (!recording) return null;
        this._recording = null;
        recording.recorder.stop();
        return recording;
    }

    /**
     * Remove one entry and its index rows.
     * @param {string} key - Cache key
     * @private
     */
    _deleteKey(key) {
        const entry = this.cache.get(key);
        if (!entry) return;
        this.cache.delete(key);
        if (!entry.hrids) {
            this._wide.delete(key);
            return;
        }
        for (const hrid of entry.hrids) {
            const keys = this._byHrid.get(hrid);
            if (!keys) continue;
            keys.delete(key);
            if (keys.size === 0) this._byHrid.delete(hrid);
        }
    }

    /**
     * Whether the cached cost for an item is a partial crafting bill (a selected input nothing prices)
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {boolean} False when nothing is cached
     */
    isPartial(itemHrid, enhancementLevel) {
        return this._entry(itemHrid, enhancementLevel)?.partial === true;
    }

    /**
     * The cached entry, moved to most-recently-used
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {{cost: number, partial: boolean}|null}
     * @private
     */
    _entry(itemHrid, enhancementLevel) {
        const key = this.generateKey(itemHrid, enhancementLevel);

        if (!this.cache.has(key)) {
            return null;
        }

        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);

        return value;
    }

    /**
     * Set cached enhancement cost
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @param {number} cost - Enhancement cost
     * @param {boolean} [partial=false] - Whether the cost is a partial crafting bill
     */
    set(itemHrid, enhancementLevel, cost, partial = false) {
        const key = this.generateKey(itemHrid, enhancementLevel);

        // The reads behind this cost, when the get() miss that preceded it recorded them
        const recording = this._closeRecording();
        let reads = null;
        let hrids = null;
        if (recording && recording.key === key && !recording.recorder.wide) {
            reads = recording.recorder.keys;
            // The item's own book always counts: its price at other levels feeds the path
            hrids = new Set([itemHrid]);
            for (const read of reads) hrids.add(hridOfPriceKey(read));
        }

        // Delete if exists (to update position)
        this._deleteKey(key);

        // Add to end
        this.cache.set(key, { cost, partial: Boolean(partial), reads, hrids });
        if (hrids) {
            for (const hrid of hrids) {
                let keys = this._byHrid.get(hrid);
                if (!keys) {
                    keys = new Set();
                    this._byHrid.set(hrid, keys);
                }
                keys.add(key);
            }
        } else {
            this._wide.add(key);
        }

        // Evict oldest if over size limit
        if (this.cache.size > this.maxSize) {
            this._deleteKey(this.cache.keys().next().value);
        }
    }

    /**
     * Clear entire cache
     */
    clear() {
        this._closeRecording();
        this.cache.clear();
        this._byHrid.clear();
        this._wide.clear();
        this.marketDataHash = null;
        // Empty is in step with the market as it stands; the salt is kept, so a cost priced under
        // a salt the next sync does not match is still dropped then
        const version = marketAPI?.priceVersion;
        this._syncedVersion = Number.isFinite(version) ? version : null;
        this._paramsFingerprint = null;
        this._paramsFingerprintAt = 0;
    }

    /**
     * Get cache statistics
     * @returns {Object} {size, maxSize, hitRate}
     */
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            marketDataHash: this.marketDataHash,
        };
    }
}

const networthCache = new NetworthCache();

// A switch changes the enhancer, so every cached cost belongs to somebody else.
// The keys carry the character already; this only stops the old character's
// entries occupying the LRU until they age out.
try {
    dataManager?.on?.('character_switching', () => networthCache.clear());
} catch (error) {
    console.error('[NetworthCache] Could not subscribe to character switches:', error);
}

export default networthCache;
