/**
 * Networth Cache
 * LRU cache for expensive enhancement cost calculations
 * Prevents recalculating the same enhancement paths repeatedly
 */

import dataManager from '../../core/data-manager.js';
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

class NetworthCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map();
        this.marketDataHash = null;
        this._paramsFingerprint = null;
        this._paramsFingerprintAt = 0;
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

        return String(hash);
    }

    /**
     * Check if market data has changed and invalidate cache if needed
     * @param {Object} marketData - Current market data
     */
    checkAndInvalidate(marketData) {
        const newHash = this.generateMarketHash(marketData);

        if (this.marketDataHash !== null && this.marketDataHash !== newHash) {
            // Market data changed, invalidate entire cache
            this.clear();
        }

        this.marketDataHash = newHash;
    }

    /**
     * Get cached enhancement cost
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {number|null} Cached cost or null if not found
     */
    get(itemHrid, enhancementLevel) {
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
     */
    set(itemHrid, enhancementLevel, cost) {
        const key = this.generateKey(itemHrid, enhancementLevel);

        // Delete if exists (to update position)
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // Add to end
        this.cache.set(key, cost);

        // Evict oldest if over size limit
        if (this.cache.size > this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }

    /**
     * Clear entire cache
     */
    clear() {
        this.cache.clear();
        this.marketDataHash = null;
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
