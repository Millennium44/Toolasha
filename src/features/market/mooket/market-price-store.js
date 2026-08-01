/**
 * Market Price Store
 *
 * Holds the bid/ask/size cache and keeps it fed from the order books the game
 * pushes as you browse.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * Two differences from the original worth naming. It listens through Toolasha's
 * existing WebSocket hook rather than installing a second one — two scripts
 * patching `MessageEvent.data` is how a page ends up with a message handler that
 * silently drops half the traffic. And it stores through Toolasha's IndexedDB
 * layer rather than localStorage, which is a few megabytes shared with the game
 * itself and the thing the original had to keep defensively pruning.
 */

import storage from '../../../core/storage.js';
import dataManager from '../../../core/data-manager.js';
import { entryFromBook, foldPrice, priceKey, specialPrice, pruneStale, PRICE_MAX_AGE_MS } from './market-prices.js';

const STORAGE_KEY = 'mooketPrices';
const SAVE_INTERVAL_MS = 60 * 1000;

class MarketPriceStore {
    constructor() {
        this.entries = {};
        this.listeners = new Set();
        this.bookHandler = null;
        this.saveTimer = null;
        this.dirty = false;
        this.loaded = false;
    }

    async initialize() {
        if (this.bookHandler) return;

        try {
            const stored = (await storage.getJSON(STORAGE_KEY, 'marketListings', {})) || {};
            this.entries = pruneStale(stored, Date.now() - PRICE_MAX_AGE_MS);
        } catch (error) {
            console.error('[MooketPrices] Loading prices failed:', error);
            this.entries = {};
        }
        this.loaded = true;

        this.bookHandler = (data) => this.onOrderBooks(data);
        dataManager.on('market_item_order_books_updated', this.bookHandler);

        // Batched rather than written per book: opening an item pushes twenty
        // enhancement levels at once, and a write each would be twenty writes
        this.saveTimer = setInterval(() => this.flush(), SAVE_INTERVAL_MS);
    }

    cleanup() {
        if (this.bookHandler) {
            dataManager.off('market_item_order_books_updated', this.bookHandler);
            this.bookHandler = null;
        }
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        this.flush();
        this.listeners.clear();
    }

    /**
     * @param {Object} data - market_item_order_books_updated payload
     */
    onOrderBooks(data) {
        const books = data?.marketItemOrderBooks;
        const itemHrid = books?.itemHrid;
        if (!itemHrid || !books.orderBooks) return;

        const at = Date.now();
        const levels = Array.isArray(books.orderBooks) ? books.orderBooks : Object.values(books.orderBooks);
        const changed = [];

        levels.forEach((book, enhancementLevel) => {
            // A null level is an item that cannot be enhanced that far. The
            // original crashed on these until it learned to skip them.
            if (!book) return;

            const key = priceKey(itemHrid, enhancementLevel);
            const next = foldPrice(this.entries[key], entryFromBook(book, at));
            if (!next) return;

            this.entries[key] = next;
            changed.push(key);
        });

        if (!changed.length) return;
        this.dirty = true;
        this.notify(changed);
    }

    /**
     * Take prices from the periodic marketplace.json snapshot.
     *
     * It carries no sizes, so anything already seen in an order book is left
     * alone — a price with depth behind it is worth more than a fresher one
     * without, and overwriting would throw the depth away.
     *
     * @param {Object} marketData - itemHrid -> { level: { a, b } }
     * @param {number} timestamp - When the snapshot was taken (ms)
     */
    ingestSnapshot(marketData, timestamp) {
        if (!marketData) return;
        const changed = [];

        for (const [itemHrid, levels] of Object.entries(marketData)) {
            if (!levels || typeof levels !== 'object') continue;
            for (const [level, price] of Object.entries(levels)) {
                const key = priceKey(itemHrid, level);
                const next = foldPrice(this.entries[key], {
                    ask: typeof price?.a === 'number' ? price.a : -1,
                    bid: typeof price?.b === 'number' ? price.b : -1,
                    askQty: 0,
                    bidQty: 0,
                    at: timestamp,
                });
                if (!next) continue;
                this.entries[key] = next;
                changed.push(key);
            }
        }

        if (!changed.length) return;
        this.dirty = true;
        this.notify(changed);
    }

    /**
     * The price of one item, including the sizes when they are known.
     * @param {string} itemHrid - Item
     * @param {number} [enhancementLevel=0] - Enhancement level
     * @returns {Object|null} { ask, bid, askQty, bidQty, rise, at }
     */
    get(itemHrid, enhancementLevel = 0) {
        const special = specialPrice(itemHrid, (key) => this.entries[key], Date.now());
        if (special) return special;
        return this.entries[priceKey(itemHrid, enhancementLevel)] || null;
    }

    /** @param {Function} listener - Called with the keys that changed */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @private */
    notify(keys) {
        for (const listener of this.listeners) {
            try {
                listener(keys);
            } catch (error) {
                console.error('[MooketPrices] Change listener failed:', error);
            }
        }
    }

    async flush() {
        if (!this.dirty || !this.loaded) return;
        this.dirty = false;
        try {
            this.entries = pruneStale(this.entries, Date.now() - PRICE_MAX_AGE_MS);
            await storage.setJSON(STORAGE_KEY, this.entries, 'marketListings');
        } catch (error) {
            console.error('[MooketPrices] Saving prices failed:', error);
        }
    }
}

const marketPriceStore = new MarketPriceStore();
export default marketPriceStore;
