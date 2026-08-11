/**
 * My Listings — Mooket Price Refresh
 *
 * A button on the marketplace's My Listings tab that pulls fresher prices for
 * every item you have listed from the pooled Mooket dataset, in one click.
 *
 * The game's `marketplace.json` feed refreshes only about once an hour at no
 * fixed minute, so the Top Order Price column can sit most of an hour behind the
 * real book with nothing in the number to say so. The Mooket pool is fed
 * continuously by clients opening item books, so for anything people are trading
 * its newest sighting is usually far fresher. This walks your listed items, asks
 * Mooket for each one's newest sighting, and — where that sighting is newer than
 * the game's last snapshot — patches it into the same price cache the Top Order
 * Price column already redraws from, so the column updates to the fresher number
 * without opening each item by hand.
 *
 * A sighting older than the game's own snapshot is left alone rather than
 * stamped as current: a rarely-opened item can be staler in the pool than in the
 * snapshot, and overwriting a fresher reading with an older one would be a
 * downgrade dressed up as a refresh.
 *
 * Reading the pool means telling a third-party server which items you looked up,
 * the same cost the price-history panel pays, so this rides the same
 * `market_pooledHistory` switch and does nothing until it is on.
 */

import config from '../../../core/config.js';
import dataManager from '../../../core/data-manager.js';
import marketAPI from '../../../api/marketplace.js';
import domObserver from '../../../core/dom-observer.js';
import { createCleanupRegistry } from '../../../utils/cleanup-registry.js';
import marketHistoryAPI from './market-history-api.js';
import { freshestSighting } from './market-history-data.js';

/** The header row that carries "N / M Listings", Upgrade Capacity and Refresh Next */
const LISTING_COUNT_SEL = '[class*="MarketplacePanel_listingCount"]';
const MY_LISTINGS_TABLE_SEL = '[class*="MarketplacePanel_myListingsTable"]';
const CONTROLS_ID = 'mwi-mooket-listings-refresh';
/** The game's own small-button styling, so the control reads as part of the bar */
const BTN_CLASS = 'Button_button__1Fe9z Button_small__3fqC7';
/** Kept low so a click on a long listing list does not burst the third-party server */
const FETCH_CONCURRENCY = 4;

/**
 * Whether a Mooket sighting is worth stamping over the game's price.
 *
 * With no game snapshot to measure against there is nothing fresher to protect,
 * so any sighting applies. Otherwise it applies only when it is strictly newer
 * than the snapshot — an equal or older sighting is not a refresh. Pure.
 *
 * @param {number} sightingTimeMs - When Mooket last saw the book
 * @param {number|null} snapshotTimeMs - When the game's snapshot was taken, or null
 * @returns {boolean}
 */
export function shouldApplySighting(sightingTimeMs, snapshotTimeMs) {
    if (typeof sightingTimeMs !== 'number' || sightingTimeMs <= 0) return false;
    if (typeof snapshotTimeMs !== 'number') return true;
    return sightingTimeMs > snapshotTimeMs;
}

/**
 * Distinct listed items from a set of table rows.
 *
 * Reads the item straight off each row's icon and enhancement badge — the rows
 * on screen are exactly "your listings", independent of whether any other
 * feature has stamped them. Coin icons (the price column) are skipped. Pure over
 * its row inputs, so the dedup is testable.
 *
 * @param {Iterable<HTMLElement>} rows - `tbody tr` elements of the My Listings table
 * @returns {Array<{itemHrid: string, enhancementLevel: number}>}
 */
export function distinctListedItems(rows) {
    const byKey = new Map();
    for (const row of rows) {
        const item = readRowItem(row);
        if (!item) continue;
        const key = `${item.itemHrid}:${item.enhancementLevel}`;
        if (!byKey.has(key)) byKey.set(key, item);
    }
    return [...byKey.values()];
}

/**
 * The item a My Listings row is for.
 * @param {HTMLElement} row - A table row
 * @returns {{itemHrid: string, enhancementLevel: number}|null}
 */
function readRowItem(row) {
    let itemHrid = null;
    for (const use of row.querySelectorAll('use')) {
        const id = use.href?.baseVal?.split('#')[1];
        if (id && !id.toLowerCase().includes('coin')) {
            itemHrid = `/items/${id}`;
            break;
        }
    }
    if (!itemHrid) return null;

    const badge = row.querySelector('[class*="enhancementLevel"]');
    const enhancementLevel = Number(badge?.textContent?.replace(/[^0-9]/g, '')) || 0;
    return { itemHrid, enhancementLevel };
}

/**
 * Run an async worker over items with a bounded number in flight at once.
 * @param {Array<any>} items - Work items
 * @param {number} limit - Maximum concurrent workers
 * @param {(item: any) => Promise<void>} worker - Per-item work
 * @returns {Promise<void>}
 */
async function runPool(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
            await worker(queue.shift());
        }
    });
    await Promise.all(runners);
}

class MyListingsPriceRefresh {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.controls = null;
        this.button = null;
        this.status = null;
        this.busy = false;
    }

    initialize() {
        if (this.isInitialized) return;
        // Same third-party read as the history panel, so the same switch governs it
        if (!config.getSetting('market_pooledHistory')) return;
        this.isInitialized = true;

        const unregister = domObserver.onClass(
            'MooketListingsRefresh',
            'MarketplacePanel_listingCount',
            () => this.ensureControls(),
            { debounce: true }
        );
        this.cleanupRegistry.registerCleanup(unregister);
        this.ensureControls();
    }

    cleanup() {
        this.controls?.remove();
        this.controls = null;
        this.button = null;
        this.status = null;
        this.busy = false;
        this.cleanupRegistry.cleanup();
        this.isInitialized = false;
    }

    /** Put the button back in the header bar, rebuilding if the bar was re-rendered. */
    ensureControls() {
        const bar = document.querySelector(LISTING_COUNT_SEL);
        if (!bar) return;
        if (this.controls && this.controls.isConnected && bar.contains(this.controls)) return;

        const controls = document.createElement('span');
        controls.id = CONTROLS_ID;
        controls.style.cssText = 'display:inline-flex; align-items:center; gap:6px; margin-left:6px;';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = BTN_CLASS;
        button.textContent = 'Mooket Refresh';
        button.title =
            'Pull fresher prices for every item in your listings from the pooled Mooket dataset and update the ' +
            'Top Order Price column. Reads a third-party server (the same one the price history panel uses).';
        button.addEventListener('click', () => this.runRefresh());
        controls.appendChild(button);

        const status = document.createElement('span');
        status.style.cssText = 'font-size:12px; color:#9aa4c0;';
        controls.appendChild(status);

        bar.appendChild(controls);
        this.controls = controls;
        this.button = button;
        this.status = status;
    }

    /** @param {string} text - A short message shown next to the button */
    setStatus(text) {
        if (this.status) this.status.textContent = text;
    }

    /**
     * @param {boolean} busy - Whether a refresh is running
     * @param {string} [label] - Button label to show while busy
     */
    setBusy(busy, label) {
        this.busy = busy;
        if (!this.button) return;
        this.button.disabled = busy;
        this.button.style.opacity = busy ? '0.6' : '';
        this.button.textContent = busy ? label || 'Refreshing…' : 'Mooket Refresh';
    }

    /**
     * Fetch Mooket's newest sighting for each listed item and patch the fresher
     * ones into the market price cache, which redraws the Top Order Price column.
     */
    async runRefresh() {
        if (this.busy) return;

        const items = this.gatherListedItems();
        if (!items.length) {
            this.setStatus('No listings found.');
            return;
        }

        this.setBusy(true, `Refreshing ${items.length}…`);
        this.setStatus('');
        // One snapshot age for the whole marketplace.json feed, so it is read once
        const dataAge = marketAPI.getDataAge();
        const snapshotTime = typeof dataAge === 'number' ? Date.now() - dataAge : null;
        let applied = 0;

        try {
            await runPool(items, FETCH_CONCURRENCY, async (item) => {
                try {
                    const rows = await marketHistoryAPI.fetchHistory(item.itemHrid, item.enhancementLevel, 1);
                    const sighting = freshestSighting(rows);
                    if (!sighting || (sighting.ask === null && sighting.bid === null)) return;
                    if (!shouldApplySighting(sighting.time, snapshotTime)) return;

                    // Keep the side Mooket did not see rather than blanking it — a
                    // one-sided sighting should not erase a known price on the other
                    const existing = marketAPI.getPrice(item.itemHrid, item.enhancementLevel);
                    const ask = sighting.ask !== null ? sighting.ask : (existing?.ask ?? null);
                    const bid = sighting.bid !== null ? sighting.bid : (existing?.bid ?? null);
                    marketAPI.updatePrice(item.itemHrid, item.enhancementLevel, ask, bid);
                    applied += 1;
                } catch (error) {
                    console.error('[MooketListingsRefresh] Refreshing an item failed:', item.itemHrid, error);
                }
            });
            this.setStatus(`Updated ${applied} of ${items.length} from Mooket.`);
        } catch (error) {
            console.error('[MooketListingsRefresh] Refresh failed:', error);
            this.setStatus('Refresh failed.');
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * The distinct items you have listed.
     *
     * Taken from the rendered table when it is up, since that is exactly what the
     * button says it refreshes; falls back to the character's listing data when
     * the table is not mounted (nothing is, off the My Listings tab, but the
     * fallback keeps the method honest).
     *
     * @returns {Array<{itemHrid: string, enhancementLevel: number}>}
     */
    gatherListedItems() {
        const table = document.querySelector(MY_LISTINGS_TABLE_SEL);
        if (table) {
            const rows = table.querySelectorAll('tbody tr');
            const items = distinctListedItems(rows);
            if (items.length) return items;
        }

        const byKey = new Map();
        for (const listing of dataManager.getMarketListings()) {
            if (!listing?.itemHrid || listing.status === '/market_listing_status/cancelled') continue;
            const enhancementLevel = Number(listing.enhancementLevel) || 0;
            const key = `${listing.itemHrid}:${enhancementLevel}`;
            if (!byKey.has(key)) byKey.set(key, { itemHrid: listing.itemHrid, enhancementLevel });
        }
        return [...byKey.values()];
    }
}

const myListingsPriceRefresh = new MyListingsPriceRefresh();
export default myListingsPriceRefresh;
