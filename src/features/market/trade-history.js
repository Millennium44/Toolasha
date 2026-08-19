/**
 * Personal Trade History Module
 * Tracks your buy/sell prices for marketplace items
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';

/**
 * Two history maps folded into one, per item key and per side, the second
 * winning on a clash.
 *
 * Per side rather than per item: a stored `{sell}` and an in-memory `{buy}` for
 * the same item are two halves of one record, not two versions of it.
 * @param {Object<string, {buy?: number, sell?: number}>} base - Typically as stored
 * @param {Object<string, {buy?: number, sell?: number}>} fresh - Typically in memory
 * @returns {Object<string, {buy?: number, sell?: number}>} Merged map
 */
export function mergeHistory(base, fresh) {
    const safe = (map) => (map && typeof map === 'object' && !Array.isArray(map) ? map : {});
    const merged = {};
    for (const [key, entry] of Object.entries(safe(base))) {
        if (entry && typeof entry === 'object') merged[key] = { ...entry };
    }
    for (const [key, entry] of Object.entries(safe(fresh))) {
        if (entry && typeof entry === 'object') merged[key] = { ...(merged[key] || {}), ...entry };
    }
    return merged;
}

/**
 * TradeHistory class manages personal buy/sell price tracking
 */
class TradeHistory {
    constructor() {
        this.history = {}; // itemHrid:enhancementLevel -> { buy, sell }
        this.isInitialized = false;
        this.isLoaded = false;
        this.characterId = null;
        this.marketUpdateHandler = null; // Store handler reference for cleanup
        this._saveChain = null;
    }

    /**
     * Get character-specific storage key
     * @returns {string} Storage key with character ID suffix
     */
    getStorageKey() {
        if (this.characterId) {
            return `tradeHistory_${this.characterId}`;
        }
        return 'tradeHistory'; // Fallback for no character ID
    }

    /**
     * Setup setting listener for feature toggle
     */
    setupSettingListener() {
        config.onSettingChange('market_tradeHistory', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Initialize trade history tracking
     */
    async initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_tradeHistory')) {
            return;
        }

        // Get current character ID
        this.characterId = dataManager.getCurrentCharacterId();

        // Load existing history from storage
        await this.loadHistory();

        this.marketUpdateHandler = (data) => {
            this.handleMarketUpdate(data);
        };

        // Hook into data manager for market listing updates
        dataManager.on('market_listings_updated', this.marketUpdateHandler);

        this.isInitialized = true;
    }

    /**
     * Load trade history from storage.
     *
     * A read that could not be made is not an empty history: the key is probed
     * with a read that says whether it worked, and on failure the in-memory
     * map stands rather than being blanked and written back by the next fill.
     * What is stored is folded under what is in memory, so a price recorded
     * while a save was in flight is kept.
     */
    async loadHistory() {
        try {
            const probe = await storage.tryGet(this.getStorageKey(), 'settings');
            if (probe === null) {
                console.warn('[TradeHistory] History could not be read; keeping the in-memory copy');
            } else {
                this.history = mergeHistory(probe.found ? probe.value : {}, this.history);
            }
        } catch (error) {
            console.error('[TradeHistory] Failed to load history:', error);
            // Keep whatever is in memory
        }
        this.isLoaded = true;
    }

    /**
     * Save trade history to storage.
     *
     * Read-merge-write, serialized: the stored map is re-read and folded under
     * the in-memory one before the write, so prices another tab recorded are
     * carried forward rather than overwritten. When the pre-write read cannot
     * be made the write is skipped — memory is kept and the next save retries —
     * because a blind overwrite from a possibly-empty copy is exactly the
     * accident this exists to prevent.
     *
     * @param {Object} [options]
     * @param {boolean} [options.overwrite=false] - Write the in-memory map as-is;
     *   for clears, whose whole point is that the stored copy loses entries
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveHistory({ overwrite = false } = {}) {
        const run = async () => {
            try {
                const storageKey = this.getStorageKey();
                if (!overwrite) {
                    const probe = await storage.tryGet(storageKey, 'settings');
                    if (probe === null) {
                        console.warn('[TradeHistory] History not saved: storage could not be read first');
                        return false;
                    }
                    this.history = mergeHistory(probe.found ? probe.value : {}, this.history);
                }
                return await storage.setJSON(storageKey, this.history, 'settings', true);
            } catch (error) {
                console.error('[TradeHistory] Failed to save history:', error);
                return false;
            }
        };
        // One save at a time, in order: two interleaved read-merge-writes could
        // each miss the other's entries
        this._saveChain = (this._saveChain || Promise.resolve()).then(run, run);
        return this._saveChain;
    }

    /**
     * Handle market_listings_updated WebSocket message
     * @param {Object} data - Market update data
     */
    handleMarketUpdate(data) {
        if (!data.endMarketListings) return;

        let hasChanges = false;

        // Process each completed order
        data.endMarketListings.forEach((order) => {
            // Only track orders that actually filled
            if (order.filledQuantity === 0) return;

            const key = `${order.itemHrid}:${order.enhancementLevel}`;

            // Get existing history for this item or create new
            const itemHistory = this.history[key] || {};

            // Update buy or sell price
            if (order.isSell) {
                itemHistory.sell = order.price;
            } else {
                itemHistory.buy = order.price;
            }

            this.history[key] = itemHistory;
            hasChanges = true;
        });

        // Save to storage if any changes
        if (hasChanges) {
            this.saveHistory();
        }
    }

    /**
     * Get trade history for a specific item
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level (default 0)
     * @returns {Object|null} { buy, sell } or null if no history
     */
    getHistory(itemHrid, enhancementLevel = 0) {
        const key = `${itemHrid}:${enhancementLevel}`;
        return this.history[key] || null;
    }

    /**
     * Check if history data is loaded
     * @returns {boolean}
     */
    isReady() {
        return this.isLoaded;
    }

    /**
     * Clear all trade history
     */
    async clearHistory() {
        this.history = {};
        await this.saveHistory({ overwrite: true });
    }

    /**
     * Disable the feature
     */
    disable() {
        if (this.marketUpdateHandler) {
            dataManager.off('market_listings_updated', this.marketUpdateHandler);
            this.marketUpdateHandler = null;
        }

        // Don't clear history data, just stop tracking
        this.isInitialized = false;
    }

    /**
     * Handle character switch - clear old data and reinitialize
     */
    async handleCharacterSwitch() {
        // Disable first to clean up old handlers
        this.disable();

        // Clear old character's data from memory
        this.history = {};
        this.isLoaded = false;

        // Reinitialize with new character
        await this.initialize();
    }
}

const tradeHistory = new TradeHistory();
tradeHistory.setupSettingListener();

// Setup character switch handler
dataManager.on('character_switched', () => {
    if (config.getSetting('market_tradeHistory')) {
        tradeHistory.handleCharacterSwitch();
    }
});

export default tradeHistory;
