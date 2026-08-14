/**
 * Official market values and the tradable-range clamp.
 *
 * Since the 8/13/2026 update the game publishes an estimated value for every
 * item and enhancement level — the same figure behind the inventory's "Total
 * Market Value" tooltip. Two things follow from it:
 *
 *  - A **value** for items whose live order book is empty or stale, so networth
 *    can price an illiquid item the way the game does rather than falling all
 *    the way back to crafting cost.
 *  - A **tradable range** (about ±10% around the value): the game rejects buy
 *    or sell orders outside it, so a hypothetical sell above the band or buy
 *    below it cannot actually fill. A stale snapshot price parked outside the
 *    band would otherwise print an impossible profit or valuation.
 *
 * The range here is a multiplicative ~±10% approximation. The 8/14/2026 hotfix
 * widened the game's real range by one price increment on each side (so cheap
 * items get a proportionally wider band). We do not model that extra increment:
 * the game does not publish the range bounds — only the value — and the plugin
 * has no price-increment tier table (it drives the game's own +/- buttons). The
 * resulting error is bounded to one increment on a boundary price — a few coins
 * even on cheap items — so the band runs one increment tighter than the game's
 * on each edge. If the game ever exposes the increment or the range bounds
 * directly, widen {@link bandFromValue} by one increment each side.
 *
 * The map is reached through the game's own `localStorageUtil.getMarketItemValues()`
 * (via dataManager), which decompresses the localStorage blob for us — reading it
 * raw yields compressed bytes. The dev's advice was to cache it rather than
 * re-fetch, so the util is called at most once per refresh interval and the map
 * is swapped only when its version changes; everything else reads the cache.
 *
 * All of this is gated behind {@link isMarketplacePatchLive}: the util does not
 * exist on the live server until the patch lands, so before then every helper
 * here is an inert pass-through and the plugin behaves exactly as it did.
 */

import dataManager from '../core/data-manager.js';
import { isMarketplacePatchLive } from './server-gate.js';

/** The width of the tradable range either side of the value (~±10%). */
export const BAND_FACTOR = 1.1;

/** Re-read the value map at most this often; the game util decompresses on each call. */
const REFRESH_INTERVAL_MS = 30_000;

let cache = { version: null, values: null };
let lastRefresh = 0;

/**
 * Re-read the value map through the game util, throttled and version-guarded so
 * the decompress happens at most once per interval and only swaps the cache when
 * the map actually changed. A no-op until the patch is live. Cheap to call often.
 * @param {number} [now=Date.now()] - Injectable clock, for tests
 * @returns {Object|null} `{ itemHrid: { level: value } }`, or null before any read
 */
export function refreshMarketValues(now = Date.now()) {
    if (!isMarketplacePatchLive()) return cache.values;
    if (cache.values && now - lastRefresh < REFRESH_INTERVAL_MS) return cache.values;
    if (typeof dataManager.getMarketItemValues !== 'function') return cache.values;
    lastRefresh = now;
    try {
        const payload = dataManager.getMarketItemValues();
        const version = payload?.marketValuesVersion ?? null;
        const values = payload?.marketItemValues ?? null;
        if (values && version !== cache.version) {
            cache = { version, values };
        }
        return cache.values;
    } catch (error) {
        console.error('[Market Values] Reading market values failed:', error);
        return cache.values;
    }
}

/**
 * The official value of one item at one enhancement level, from cache.
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {number|null}
 */
export function marketValueFor(itemHrid, enhancementLevel = 0) {
    const value = cache.values?.[itemHrid]?.[String(enhancementLevel)];
    return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * The tradable range implied by a market value (~±10% around it).
 * @param {number|null} value - Market value
 * @returns {{min:number, max:number}|null}
 */
export function bandFromValue(value) {
    if (!(value > 0)) return null;
    return { min: value / BAND_FACTOR, max: value * BAND_FACTOR };
}

/**
 * Reconcile a raw order-book ask/bid pair against the official value.
 *
 * A pass-through until the patch is live or when the item has no official value.
 * Otherwise each present side is clamped into the tradable range (a stale price
 * parked outside it is pulled to the nearest edge, which is as far as an order
 * could actually reach), and a missing side is filled with the value itself — so
 * an item with an empty book is still priced the way the game prices it.
 *
 * @param {number|null} ask - Raw best ask
 * @param {number|null} bid - Raw best bid
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {{ask:number|null, bid:number|null}}
 */
export function reconcileBook(ask, bid, itemHrid, enhancementLevel = 0) {
    if (!isMarketplacePatchLive()) return { ask, bid };
    const value = marketValueFor(itemHrid, enhancementLevel);
    if (value === null) return { ask, bid };
    const band = bandFromValue(value);
    const clamp = (x) => (typeof x === 'number' && x >= 0 ? Math.min(Math.max(x, band.min), band.max) : null);
    return {
        ask: typeof ask === 'number' && ask >= 0 ? clamp(ask) : value,
        bid: typeof bid === 'number' && bid >= 0 ? clamp(bid) : value,
    };
}

/** Reset the cache and refresh throttle. Tests only. */
export function _resetMarketValues() {
    cache = { version: null, values: null };
    lastRefresh = 0;
}
