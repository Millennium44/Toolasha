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
 *
 * The cache is kept through a persisted record (`utils/persisted-record.js`):
 * a read that cannot be made leaves the cache in hand rather than starting an
 * empty one that the next flush would write over the stored one, and a flush
 * folds the stored cache under memory — the newer reading of each item
 * winning — so a second tab's browsing is kept rather than overwritten.
 */

import dataManager from '../../../core/data-manager.js';
import { createPersistedRecord } from '../../../utils/persisted-record.js';
import {
    entryFromBook,
    foldPrice,
    priceKey,
    specialPrice,
    pruneStale,
    depthFromBook,
    foldDepth,
    hasDepth,
    mergeDepth,
    PRICE_MAX_AGE_MS,
} from './market-prices.js';

const STORAGE_KEY = 'mooketPrices';
/**
 * Order-book depth, kept beside the prices rather than in them. `marketListings` syncs, and the prices
 * are shared between devices; depth is one device's last look at a book and meant to stay there, so
 * this key's prefix is in `DEVICE_ONLY_STORE_KEY_PREFIXES` (sync-ownership.js) and the price entries
 * keep the shape every build reads.
 */
const DEPTH_KEY = 'mooketDepth';
const SAVE_INTERVAL_MS = 60 * 1000;

/**
 * Fold a stored cache under the one in memory: per item, the reading taken
 * later wins, and anything past its age goes.
 * @param {Object} stored - key → entry, as read back
 * @param {Object} memory - key → entry, as held
 * @returns {Object} The merged cache
 */
function mergePrices(stored, memory) {
    const merged = { ...(stored && typeof stored === 'object' ? stored : {}) };
    for (const [key, entry] of Object.entries(memory && typeof memory === 'object' ? memory : {})) {
        const theirs = merged[key];
        if (!theirs || !(theirs.at > (entry?.at ?? -Infinity))) merged[key] = entry;
    }
    return pruneStale(merged, Date.now() - PRICE_MAX_AGE_MS);
}

/**
 * Fold a stored depth map under the one in memory (newer depthAt wins; old or
 * unusable records go).
 * @param {Object} stored - key -> depth record, as read back
 * @param {Object} memory - key -> depth record, as held
 * @returns {Object} The merged map
 */
function mergeDepths(stored, memory) {
    const now = Date.now();
    return mergeDepth(stored, memory, now - PRICE_MAX_AGE_MS, now);
}

class MarketPriceStore {
    constructor() {
        this.record = createPersistedRecord({
            base: STORAGE_KEY,
            store: 'marketListings',
            scoped: false,
            empty: () => ({}),
            merge: mergePrices,
            label: 'MooketPrices',
        });
        this.depthRecord = createPersistedRecord({
            base: DEPTH_KEY,
            store: 'marketListings',
            scoped: false,
            empty: () => ({}),
            merge: mergeDepths,
            label: 'MooketDepth',
        });
        this.depthDirty = false;
        /**
         * Set by the first {@link MarketPriceStore#depthFor} of a session. Depth is always recorded in
         * memory, but nothing is written until a reader has asked for it: a user with no reader would
         * otherwise write a record nobody reads.
         */
        this.depthWanted = false;
        this.listeners = new Set();
        this.bookHandler = null;
        this.saveTimer = null;
        this.dirty = false;
        this.loaded = false;
        /**
         * Bumped by every {@link MarketPriceStore#cleanup}, so a start-up whose
         * read is still in flight can tell that the layer it was started for
         * has been torn down since.
         */
        this.generation = 0;
        /** The marketplace.json object last folded in, so the same one is not re-walked */
        this.lastSnapshot = null;
    }

    /** @returns {Object} key → entry, the live in-memory cache */
    get entries() {
        return this.record.get();
    }

    set entries(value) {
        this.record.set(value);
    }

    /** @returns {Object} key -> {askLevels, bidLevels, depthAt}, the live in-memory depth */
    get depth() {
        return this.depthRecord.get();
    }

    set depth(value) {
        this.depthRecord.set(value);
    }

    async initialize() {
        if (this.bookHandler) return;

        // The guard above is the only thing between two concurrent start-ups,
        // and it is read *before* the read below — so a character switch, which
        // tears the panel down mid-read and immediately starts the arriving
        // character's initialize, put two runs past it. Both then resumed and
        // both registered: the second overwrote `bookHandler` and `saveTimer`,
        // leaving the first run's order-book listener and 60s flush interval
        // live with no handle left to remove them by. One leaked pair per
        // switch, and they outlived the feature being switched off entirely.
        const generation = this.generation;

        // An unreadable store keeps the cache in hand rather than starting empty
        await Promise.all([this.record.load(), this.depthRecord.load()]);
        // Torn down while the read was in flight, or another run got there
        // first — either way this one registers nothing
        if (generation !== this.generation || this.bookHandler) return;
        this.entries = pruneStale(this.entries, Date.now() - PRICE_MAX_AGE_MS);
        this.depth = mergeDepths({}, this.depth);
        this.loaded = true;

        this.bookHandler = (data) => this.onOrderBooks(data);
        dataManager.on('market_item_order_books_updated', this.bookHandler);

        // Batched rather than written per book: opening an item pushes twenty
        // enhancement levels at once, and a write each would be twenty writes
        this.saveTimer = setInterval(() => this.flush(), SAVE_INTERVAL_MS);
    }

    cleanup() {
        // First, so a teardown that throws part-way has still invalidated the
        // start-up it interrupted
        this.generation += 1;
        if (this.bookHandler) {
            dataManager.off('market_item_order_books_updated', this.bookHandler);
            this.bookHandler = null;
        }
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }
        // flush() reads the flag before its first await, so this still writes for a reader that asked
        this.flush();
        // Session state like the rest: the next session's reader asks again
        this.depthWanted = false;
        this.listeners.clear();
        this.lastSnapshot = null;
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
        let depthChanged = false;

        levels.forEach((book, enhancementLevel) => {
            // A null level is an item that cannot be enhanced that far. The
            // original crashed on these until it learned to skip them.
            if (!book) return;

            const key = priceKey(itemHrid, enhancementLevel);
            const nextDepth = foldDepth(this.depth[key], depthFromBook(book, at), at);
            if (nextDepth) {
                this.depth[key] = nextDepth;
                depthChanged = true;
            }

            const next = foldPrice(this.entries[key], entryFromBook(book, at));
            if (!next) return;

            this.entries[key] = next;
            changed.push(key);
        });

        if (depthChanged) this.depthDirty = true;
        if (!changed.length) return;
        this.dirty = true;
        this.notify(changed);
    }

    /**
     * Take prices from the periodic marketplace.json snapshot.
     *
     * It carries no sizes. Readings fold newest-wins by timestamp
     * ({@link foldPrice}), so a snapshot fresher than a stored order-book
     * reading replaces it and resets its sizes to zero — depth survives only
     * until the next snapshot re-reads that item. This is deliberate: the sole
     * reader of stored sizes (the crafting plan's thin-market reroute) treats a
     * zero size as "depth unknown" and falls back to buying, so a wiped size
     * fails safe rather than force-crafting on stale depth.
     *
     * @param {Object} marketData - itemHrid -> { level: { a, b } }
     * @param {number} timestamp - When the snapshot was taken (ms)
     */
    ingestSnapshot(marketData, timestamp) {
        if (!marketData) return;
        // The feed's listeners also hear about every order-book price patch,
        // and the snapshot has not moved for those: it is a new object only
        // when marketplace.json is fetched again. Re-walking the whole table
        // for the same one changes nothing.
        if (marketData === this.lastSnapshot) return;
        this.lastSnapshot = marketData;
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

    /**
     * The order-book depth of one item, when a book has been seen.
     *
     * Read from the device-only depth record, never from the price entry, so
     * `depthAt` is the age of the book and the price (see {@link get}) may be
     * newer. A caller must check `asks[0].price` / `bids[0].price` against the
     * current best ask / bid before trusting the levels: when they differ the
     * price has moved since `depthAt`.
     *
     * @param {string} itemHrid - Item
     * @param {number} [enhancementLevel=0] - Enhancement level
     * @returns {{asks: Array<{price: number, quantity: number}>, bids: Array<{price: number, quantity: number}>, depthAt: number}|null}
     *   Best first; null when depth is unknown (no book seen on this device, a
     *   record timed in the future, or a malformed one). An empty array is a
     *   side seen empty. Coin and cowbell have none.
     */
    depthFor(itemHrid, enhancementLevel = 0) {
        // A reader exists: from the next flush on, the depth held so far (books seen before this call
        // too) is written
        this.depthWanted = true;
        const record = this.depth[priceKey(itemHrid, enhancementLevel)];
        if (!hasDepth(record, Date.now())) return null;
        return {
            asks: record.askLevels.map((level) => ({ price: level.price, quantity: level.quantity })),
            bids: record.bidLevels.map((level) => ({ price: level.price, quantity: level.quantity })),
            depthAt: record.depthAt,
        };
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

    /**
     * Write the depth back, folding the stored one under it. Left dirty when it does not land. Writes
     * nothing until a reader has called {@link MarketPriceStore#depthFor}; the dirty flag is kept so
     * the books recorded meanwhile go out on the first flush after.
     */
    async flushDepth() {
        if (!this.depthWanted || !this.depthDirty) return;
        this.depthDirty = false;
        try {
            this.depth = mergeDepths({}, this.depth);
            const landed = await this.depthRecord.save();
            if (!landed) this.depthDirty = true;
        } catch (error) {
            console.error('[MooketPrices] Saving depth failed:', error);
            this.depthDirty = true;
        }
    }

    /**
     * Write the cache back, folding the stored one under it. Skipped — and
     * left dirty for the next flush — when storage cannot be read first.
     */
    async flush() {
        if (!this.loaded) return;
        // Both start at once, so each takes its dirty flag before either awaits
        await Promise.all([this.flushDepth(), this.flushPrices()]);
    }

    /** @private */
    async flushPrices() {
        if (!this.dirty) return;
        this.dirty = false;
        try {
            this.entries = pruneStale(this.entries, Date.now() - PRICE_MAX_AGE_MS);
            const landed = await this.record.save();
            if (!landed) this.dirty = true;
        } catch (error) {
            console.error('[MooketPrices] Saving prices failed:', error);
            this.dirty = true;
        }
    }
}

const marketPriceStore = new MarketPriceStore();
export default marketPriceStore;
