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
 * The range is computed the way the game computes it: ±10% of the value,
 * snapped outward to the price-increment ladder and widened by one increment
 * on each side (the 8/14/2026 hotfix — cheap items get a proportionally wider
 * range). The ladder is the game client's own `getBinnedPrice` tiering, read
 * out of its bundle and verified against live band bounds across nine decades
 * of price on 8/18/2026 — see {@link priceIncrement}. One caveat survives:
 * bands *recalibrate toward* the value at ≤1% per hourly pass, so right after
 * a value moves, the game's actual band lags what this computes from the new
 * value until the passes catch up.
 *
 * The September 2026 market patch replaces the ladder with finer bins and a
 * 5x step for enhanced items (see {@link priceIncrement}); it is staged per
 * server by {@link isSeptember2026MarketPatchLive}. Under that patch every pushed
 * order book also carries the game's own band (`priceBandMins`/`priceBandMaxs`
 * per level); while one is under an hour old it is used as is, and the band is
 * computed from the value only when none is at hand.
 *
 * The map is reached through the game's own `localStorageUtil.getMarketItemValues()`
 * (via dataManager), which decompresses the localStorage blob for us — reading it
 * raw yields compressed bytes. The dev's advice was to cache it rather than
 * re-fetch, so the util is called at most once per refresh interval and the map
 * is swapped only when its version changes; everything else reads the cache.
 * A pushed `market_item_values_updated` message swaps the cache directly —
 * see {@link applyMarketValuesMessage} — so a mid-session refresh does not wait
 * out the interval.
 *
 * All of this is gated behind {@link isMarketplacePatchLive}: the util does not
 * exist on the live server until the patch lands, so before then every helper
 * here is an inert pass-through and the plugin behaves exactly as it did.
 */

import dataManager from '../core/data-manager.js';
import { isMarketplacePatchLive, isSeptember2026MarketPatchLive } from './server-gate.js';

/** The width of the tradable range either side of the value (~±10%). */
export const BAND_FACTOR = 1.1;

/** Re-read the value map at most this often; the game util decompresses on each call. */
const REFRESH_INTERVAL_MS = 30_000;

let cache = { version: null, values: null };
let lastRefresh = 0;

/**
 * Bands already computed for the current value map: itemHrid → band per
 * enhancement level (array index), `null` where the item has no value.
 * Every getItemPrice call goes through reconcileBook/clampToBand, and the band
 * arithmetic allocates a couple of strings each time, so the result is kept per
 * (item, level) and thrown away with the map it was derived from.
 * @type {Map<string, Array<{min:number,max:number}|null>>}
 */
let bandCache = new Map();

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
        // A pushed map can be ahead of localStorage beyond the refresh window.
        // Once a version is known, only a newer stored version may replace it.
        const newerVersion = cache.version === null || (version !== null && version > cache.version);
        if (values && version !== cache.version && newerVersion) {
            cache = { version, values };
            bandCache = new Map();
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
 * `BinGapUnitTiers` from the game client (September 2026 market patch): the step
 * unit for a 4+ digit price by its leading two digits, `[upperExclusive, unit]`.
 * Leading digits 90-99 fall through to 40.
 */
const BIN_GAP_UNIT_TIERS = [
    [12, 4],
    [15, 5],
    [18, 6],
    [24, 8],
    [30, 10],
    [36, 12],
    [48, 16],
    [60, 20],
    [75, 25],
    [90, 30],
];

/**
 * The game client's `binGap` under the September 2026 market patch.
 *
 * 1-2 digits: 1. 3 digits: by first digit — unenhanced 1-3 → 1, 4-7 → 2, 8-9 → 4;
 * enhanced 1 → 2, 2-3 → 5, 4-7 → 10, 8-9 → 20. 4+ digits: the tier unit for the
 * leading two digits × 10^(digits−4), and 5× that for an enhanced item.
 * @param {number} whole - A positive whole price
 * @param {number} enhancementLevel - Enhancement level; any level above 0 is "enhanced"
 * @returns {number}
 */
function binGap(whole, enhancementLevel) {
    const text = String(whole);
    const digits = text.length;
    if (digits <= 2) return 1;
    const enhanced = enhancementLevel > 0;
    if (digits === 3) {
        const first = Number(text[0]);
        if (enhanced) {
            if (first === 1) return 2;
            if (first <= 3) return 5;
            return first <= 7 ? 10 : 20;
        }
        if (first <= 3) return 1;
        return first <= 7 ? 2 : 4;
    }
    const lead2 = Number(text.slice(0, 2));
    const tier = BIN_GAP_UNIT_TIERS.find(([limit]) => lead2 < limit);
    const unit = (tier ? tier[1] : 40) * 10 ** (digits - 4);
    return enhanced ? 5 * unit : unit;
}

/**
 * The marketplace's price increment at a price — the step of the game client's
 * `getBinnedPrice`.
 *
 * Under the September 2026 market patch ({@link isSeptember2026MarketPatchLive})
 * it is the client's `binGap`: 1,000-1,199 → 4, 1,200-1,499 → 5 … 9,000-11,999 →
 * 40, scaling ×10 per extra digit, and 5× for an enhanced item (own table below
 * 1,000). Otherwise it is the earlier ladder, by first digit and digit count,
 * which ignores enhancement level:
 *
 *   first digit 1-2 → 5×10^(digits−4)      (1,000-2,999: 5; 10,000-29,999: 50 …)
 *   first digit 3-4 → 10^(digits−3)        (300-499: 1; 3,000-4,999: 10 …)
 *   first digit 5-9 → 2×10^(digits−3)      (500-999: 2; 5,000-9,999: 20 …)
 *
 * with a floor of 1. On both ladders every tier boundary is a multiple of the
 * step just below it, which {@link nextPriceUp} relies on.
 * @param {number} price - Any price (fractions are floored, as the game does)
 * @param {number} [enhancementLevel=0] - Enhancement level of the item being priced
 * @returns {number} The increment the ladder assigns that price
 */
export function priceIncrement(price, enhancementLevel = 0) {
    const whole = Math.floor(price);
    if (!(whole > 0)) return 1;
    if (isSeptember2026MarketPatchLive()) return binGap(whole, enhancementLevel);
    const text = String(whole);
    const digits = text.length;
    const first = text[0];
    if (first === '1' || first === '2') return digits >= 4 ? 5 * 10 ** (digits - 4) : 1;
    if (first === '3' || first === '4') return digits >= 3 ? 10 ** (digits - 3) : 1;
    return digits >= 3 ? 2 * 10 ** (digits - 3) : 1;
}

/**
 * The next price on the increment ladder strictly above `price`.
 *
 * The step is the one at `price` itself, and the result is snapped to a
 * multiple of it — every tier boundary is a multiple of the step below it, so
 * 999 goes to 1,000 rather than 1,001.
 * @param {number} price - A price (fractions are floored first)
 * @param {number} [enhancementLevel=0] - Enhancement level of the item being priced
 * @returns {number} The next ladder price up; 1 for anything not above 0
 */
export function nextPriceUp(price, enhancementLevel = 0) {
    const whole = Math.floor(price);
    if (!(whole > 0)) return 1;
    const step = priceIncrement(whole, enhancementLevel);
    return (Math.floor(whole / step) + 1) * step;
}

/**
 * The next price on the increment ladder strictly below `price`.
 *
 * The step is taken from one below `price`, so crossing down into a finer
 * tier uses the finer step: 1,000 goes to 998 on the earlier ladder (the 500-999
 * step of 2), not 995. Never goes below 1, the lowest price an order can carry.
 * @param {number} price - A price (fractions are rounded up first, so the result stays below it)
 * @param {number} [enhancementLevel=0] - Enhancement level of the item being priced
 * @returns {number} The next ladder price down, floored at 1
 */
export function nextPriceDown(price, enhancementLevel = 0) {
    const below = Math.ceil(price) - 1;
    if (!(below > 1)) return 1;
    const step = priceIncrement(below, enhancementLevel);
    return Math.max(1, Math.floor(below / step) * step);
}

/**
 * The tradable range implied by a market value, as the game computes it:
 * ±10%, snapped outward to the increment ladder, then one bin wider on each side.
 *
 * The outward snap sizes its step from the raw ±10% figure, as `getBinnedPrice`
 * sizes the step from its input, and keeps the float product (460 × 1.1 lands a
 * hair above 506 and snaps a step further out, which the game does too).
 *
 * The widening step differs by server. Under the September 2026 market patch it
 * is one bin from the snapped edge, sized by the gap of the price it reaches: an
 * enhanced min snapped to 300,000 widens to 295,000 by the 5,000 gap below
 * 300,000, not by the 6,000 gap at the raw figure. The min is also floored at the
 * item's vendor sell price. Both were measured against the game's own
 * `priceBandMins`/`priceBandMaxs` on the test server (2026-09-25). On live the
 * earlier rule stands — one step of the raw figure's size, no vendor floor — as
 * verified there on 8/18/2026; nothing measured on live says otherwise.
 * @param {number|null} value - Market value
 * @param {number} [enhancementLevel=0] - Enhancement level the value is for
 * @param {number} [vendorPrice=0] - The item's shop sell price; floors the min on the patched server
 * @returns {{min:number, max:number}|null}
 */
export function bandFromValue(value, enhancementLevel = 0, vendorPrice = 0) {
    if (!(value > 0)) return null;
    const rawMax = value * BAND_FACTOR;
    const maxStep = priceIncrement(rawMax, enhancementLevel);
    const snappedMax = Math.ceil(rawMax / maxStep) * maxStep;
    const rawMin = value / BAND_FACTOR;
    const minStep = priceIncrement(rawMin, enhancementLevel);
    const snappedMin = Math.floor(rawMin / minStep) * minStep;
    if (!isSeptember2026MarketPatchLive()) {
        return { min: Math.max(0, snappedMin - minStep), max: snappedMax + maxStep };
    }
    const below = snappedMin - 1;
    let min = below > 0 ? below - (below % priceIncrement(below, enhancementLevel)) : 0;
    if (vendorPrice > 0 && min < vendorPrice) min = vendorPrice;
    const max = Math.max(min, snappedMax + priceIncrement(snappedMax, enhancementLevel));
    return { min, max };
}

/**
 * The game's own bands from pushed order books: `${itemHrid}:${level}` → bounds
 * and arrival time. Preferred over a computed band while fresh.
 * @type {Map<string, {min:number, max:number, at:number}>}
 */
let wireBands = new Map();

/**
 * How long a pushed band is trusted: the game recalibrates bands hourly
 * (`recalibrationIntervalMinutes: 60`), so an older one may have moved.
 */
const WIRE_BAND_TTL_MS = 60 * 60_000;

/**
 * Record the bands a `market_item_order_books_updated` message carries.
 *
 * The patched server sends `priceBandMins`/`priceBandMaxs` keyed by enhancement
 * level (as a string) beside the order books. A level whose bounds are missing,
 * non-positive or inverted is skipped rather than recorded.
 * @param {Object} data - `{ marketItemOrderBooks: { itemHrid, priceBandMins, priceBandMaxs } }`
 * @param {number} [now=Date.now()] - Arrival time
 * @returns {number} How many levels were recorded
 */
function applyOrderBookBands(data, now = Date.now()) {
    const books = data?.marketItemOrderBooks;
    const itemHrid = books?.itemHrid;
    const mins = books?.priceBandMins;
    const maxs = books?.priceBandMaxs;
    if (typeof itemHrid !== 'string' || !mins || typeof mins !== 'object' || !maxs || typeof maxs !== 'object') {
        return 0;
    }
    let recorded = 0;
    for (const [level, min] of Object.entries(mins)) {
        const max = maxs[level];
        if (!(typeof min === 'number' && min > 0 && typeof max === 'number' && max >= min)) continue;
        wireBands.set(`${itemHrid}:${Number(level)}`, { min, max, at: now });
        recorded++;
    }
    return recorded;
}

/**
 * The game's pushed band for one item and level, while fresh.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @param {number} [now=Date.now()] - Current time
 * @returns {{min:number, max:number}|null}
 */
function wireBandFor(itemHrid, enhancementLevel, now = Date.now()) {
    const band = wireBands.get(`${itemHrid}:${enhancementLevel}`);
    if (!band || now - band.at > WIRE_BAND_TTL_MS) return null;
    return { min: band.min, max: band.max };
}

/**
 * The item's vendor sell price, or 0 when the item data is not at hand.
 * @param {string} itemHrid - Item HRID
 * @returns {number}
 */
function vendorPriceOf(itemHrid) {
    if (typeof dataManager?.getItemDetails !== 'function') return 0;
    const sellPrice = dataManager.getItemDetails(itemHrid)?.sellPrice;
    return typeof sellPrice === 'number' && sellPrice > 0 ? sellPrice : 0;
}

/**
 * The tradable range of one item at one level: the game's own pushed band while
 * fresh, else the band computed from the value (memoised per value map).
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @returns {{min:number, max:number}|null}
 */
function bandFor(itemHrid, enhancementLevel) {
    const wire = wireBandFor(itemHrid, enhancementLevel);
    if (wire) return wire;
    let perLevel = bandCache.get(itemHrid);
    if (perLevel === undefined) {
        perLevel = [];
        bandCache.set(itemHrid, perLevel);
    }
    let band = perLevel[enhancementLevel];
    if (band === undefined) {
        band = bandFromValue(marketValueFor(itemHrid, enhancementLevel), enhancementLevel, vendorPriceOf(itemHrid));
        perLevel[enhancementLevel] = band;
    }
    return band;
}

/**
 * Clamp one price into the item's tradable range, when one is known.
 *
 * The single-price face of {@link reconcileBook}: a present price parked
 * outside the band is pulled to the nearest edge (as far as an order could
 * actually reach); a missing price stays missing — this never invents a
 * price, so callers that treat null as "no market" keep that meaning.
 * Pass-through until the patch is live or when the item has no band (no pushed
 * band and no official value).
 *
 * @param {number|null} price - A raw ask or bid
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {number|null} The price, banded when a band is known
 */
export function clampToBand(price, itemHrid, enhancementLevel = 0) {
    if (typeof price !== 'number') return price ?? null;
    // A non-positive price is never a real quote: 0 falls below the
    // marketplace's price grid (whose minimum step snaps anything at or below
    // it up to 2), and a negative price is not a price at all. Treat both as
    // absent rather than clamp them into the band — clamping 0 up to band.min,
    // or a negative up to it, would fabricate a price no order ever offered,
    // and letting a negative pass through unclamped is no better.
    if (price <= 0) return null;
    if (!isMarketplacePatchLive()) return price;
    // Self-sufficient: direct order-book consumers call this without going
    // through getPrice, and a clamp against an empty cache would be a no-op.
    // The refresh is throttled and version-guarded, so this is cheap.
    refreshMarketValues();
    const band = bandFor(itemHrid, enhancementLevel);
    if (!band) return price;
    return Math.min(Math.max(price, band.min), band.max);
}

/**
 * Reconcile a raw order-book ask/bid pair against the official value.
 *
 * A pass-through until the patch is live or when the item has neither an official
 * value nor a pushed band. Otherwise each present side is clamped into the tradable range (a stale price
 * parked outside it is pulled to the nearest edge, which is as far as an order
 * could actually reach), and a missing side is filled with the value itself — so
 * an item with an empty book is still priced the way the game prices it. With a
 * pushed band but no value, present sides are clamped and a missing side stays
 * missing.
 *
 * @param {number|null} ask - Raw best ask
 * @param {number|null} bid - Raw best bid
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {{ask:number|null, bid:number|null, askSource:string|null, bidSource:string|null}}
 *   Each `*Source` is `'book'` when the side came from the live order book (clamped or not),
 *   `'value'` when it was filled in from the official value map, and `null` when there is no
 *   price at all. Callers that must distinguish a real quote from an estimate read these —
 *   without them a value-filled side is indistinguishable from a genuine listing, and every
 *   "no market data" signal downstream silently stops firing.
 */
export function reconcileBook(ask, bid, itemHrid, enhancementLevel = 0) {
    // A side of exactly 0 is never a real quote (see clampToBand), so it is
    // treated the same as a missing side throughout — sourced as 'value' below
    // rather than clamped up to band.min, which would fabricate a price no
    // order ever offered.
    const sourceOf = (x) => (typeof x === 'number' && x > 0 ? 'book' : null);
    if (!isMarketplacePatchLive()) {
        return { ask, bid, askSource: sourceOf(ask), bidSource: sourceOf(bid) };
    }
    const value = marketValueFor(itemHrid, enhancementLevel);
    const band = bandFor(itemHrid, enhancementLevel);
    if (!band) return { ask, bid, askSource: sourceOf(ask), bidSource: sourceOf(bid) };
    const clamp = (x) => (typeof x === 'number' && x > 0 ? Math.min(Math.max(x, band.min), band.max) : null);
    const askIsBook = typeof ask === 'number' && ask > 0;
    const bidIsBook = typeof bid === 'number' && bid > 0;
    // A pushed band can arrive for an item with no value in the map: clamp what
    // the book has, but there is nothing to fill a missing side with
    const sourceFor = (isBook) => (isBook ? 'book' : value === null ? null : 'value');
    return {
        ask: askIsBook ? clamp(ask) : value,
        bid: bidIsBook ? clamp(bid) : value,
        askSource: sourceFor(askIsBook),
        bidSource: sourceFor(bidIsBook),
    };
}

/**
 * Apply a pushed `market_item_values_updated` payload.
 *
 * The map is otherwise only re-read out of localStorage on the throttle above,
 * so between a value refresh and the next read every price this module produces
 * is stale — for the whole session if the game writes the compressed blob once
 * and then only pushes. Handling the message closes that window: the map is
 * swapped, the version bumped, and the derived band cache — the only thing here
 * memoised across a map — dropped so it recomputes against the new values.
 *
 * Both fields are required, the map must carry at least one entry, and — once
 * a version is already cached — the payload's version must not be older than
 * it. Each of the three is a shape the game is never expected to send but a
 * malformed or reordered push could: an empty `marketItemValues` (`{}` is a
 * truthy object, so it slips past a plain `!values` check) would otherwise
 * swap in a cache that prices nothing; an array or string equally passes
 * `typeof === 'object'`/`'string'` naively but carries nothing keyed by item
 * hrid either. A payload failing any of these is ignored rather than applied,
 * so a partial, malformed, or out-of-order push cannot blank out or downgrade
 * pricing.
 *
 * The message and its payload shape were learnt from MWITools (CC-BY-NC-SA-4.0)
 * — see `third-party/mwitools/`.
 *
 * @param {{marketValuesVersion?: number, marketItemValues?: Object}} payload - Message payload
 * @returns {boolean} True when the cache was swapped
 */
export function applyMarketValuesMessage(payload) {
    const values = payload?.marketItemValues;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
    if (Object.keys(values).length === 0) return false;
    const version = payload.marketValuesVersion ?? null;
    if (version !== null && cache.version !== null && version < cache.version) return false;
    cache = { version, values };
    bandCache = new Map();
    // The pushed map is newer than anything localStorage holds, so restart the
    // throttle window rather than letting the next price query re-read over it.
    lastRefresh = Date.now();
    return true;
}

// Global market data, not one character's, so this is not re-armed on a switch.
// This module sits under market-data.js and so under nearly every pricing path;
// the typeof guard keeps a suite that mocks dataManager with only the two
// methods its own subject calls from failing at import time.
if (typeof dataManager?.on === 'function') {
    dataManager.on('market_item_values_updated', (payload) => applyMarketValuesMessage(payload));
    dataManager.on('market_item_order_books_updated', (data) => applyOrderBookBands(data));
}

/** Reset the cache and refresh throttle. Tests only. */
export function _resetMarketValues() {
    cache = { version: null, values: null };
    bandCache = new Map();
    wireBands = new Map();
    lastRefresh = 0;
}
