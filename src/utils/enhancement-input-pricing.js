/**
 * Enhancement input pricing: the one rule every enhancement cost surface shares.
 *
 * What an enhancing run's inputs cost used to be answered five ways: the panel
 * read the order book directly, the tooltip and its helpers read the raw book
 * with their own cross-fill, the advisor asked the resolver with no context,
 * the profile score fell back to vendor prices (and priced unpriced protection
 * at nothing), and the net-worth worker carried a transcription of it all. A
 * custom price, the shop floor or the player's pricing mode moved some of those
 * numbers and not the others, so one item showed different costs in different
 * places.
 *
 * The rule, in one place:
 *
 *   - Materials: `resolveItemPrice` on the buy side of the chosen context
 *     (custom price, Iron Cow valuation, reconciled book on the mode's side,
 *     shop floor, production cost), with trainee charms at the shop price and
 *     coins at 1 settled first. Unpriced is `null` and flagged, never 0.
 *   - Protection: the cheapest of {the item itself, Mirror of Protection, the
 *     item's listed protection items}, each priced as below.
 *   - Mirror and base item: the resolver's price put through the inflation
 *     guard (`applyInflationGuard`). The guard is an ask-inflation guard, so
 *     it runs only when the mode reads the ask and the figure is a plain book
 *     quote. A custom price, a bid/average mode (the player asked for that
 *     side), a shop floor or a production-cost figure passes through as is.
 *     With `enhanceSim_baseItemCraftingCost` on, the base is also capped by
 *     what it costs to craft.
 *
 * `context` picks the pricing mode: 'profit' (default) reads the profit mode,
 * 'networth' reads the net-worth mode. The structure is shared; the mode is
 * not. `mode` forces one book side outright (the tooltip's patient-buy column).
 *
 * Every function returns `{price, unpriced, estimated}`; `price` is `null`
 * exactly when `unpriced` is true. `estimated` marks a figure that is not a
 * live quote (value-map or production-cost fallback, or a guard substitution).
 * The `get*` wrappers at the bottom keep the number-only shapes the older
 * callers import.
 */

import config from '../core/config.js';
import { getItemPrices, getPricingMode } from './market-data.js';
import { resolveItemPrice } from './profit-helpers.js';
import {
    TRAINEE_SHOP_PRICE,
    getCheapestProtectionPrice as getCheapestProtectionPriceFrom,
    getProductionCost,
    perAttemptMaterialCost as perAttemptMaterialCostFrom,
    getRealisticBaseItemPrice as getRealisticBaseItemPriceFrom,
} from './enhancement-pricing.js';

const PHILOSOPHERS_MIRROR = '/items/philosophers_mirror';

/** Build the result record from a bare price. */
function result(price, estimated = false) {
    return price > 0 ? { price, unpriced: false, estimated } : { price: null, unpriced: true, estimated: false };
}

/** The resolver, with the context/mode options every function here takes. */
function resolve(itemHrid, { context = 'profit', mode } = {}) {
    try {
        return resolveItemPrice(itemHrid, { context, side: 'buy', ...(mode ? { mode } : {}) });
    } catch {
        return { price: null, custom: false, missing: true, estimated: false };
    }
}

/**
 * Price one enhancement material.
 * @param {string} itemHrid - Material item HRID
 * @param {Object} [options] - Options
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @returns {{price: number|null, unpriced: boolean, estimated: boolean}} Unit price
 */
export function priceMaterial(itemHrid, options = {}) {
    if (!itemHrid) return result(0);
    // Untradeable: no listing exists, so the fixed shop price stands on every side and every mode
    if (itemHrid.startsWith('/items/trainee_')) return result(TRAINEE_SHOP_PRICE);
    if (itemHrid === '/items/coin') return result(1);
    const resolved = resolve(itemHrid, options);
    return result(resolved.price, resolved.estimated);
}

/**
 * The two quotes the inflation guard weighs, taken from the resolver's reading.
 * See the module header for when the guard runs.
 */
function guardQuotes(itemHrid, options) {
    const resolved = resolve(itemHrid, options);
    if (!(resolved.price > 0)) return { quotes: null, resolved };
    const same = { ask: resolved.price, bid: resolved.price };
    const mode = options.mode || getPricingMode(options.context || 'profit', 'buy');
    if (resolved.custom || resolved.estimated || mode !== 'ask') return { quotes: same, resolved };
    const book = getItemPrices(itemHrid, 0);
    // Only a plain book quote is weighed; a shop floor or patient tick is not the book's ask
    if (book?.ask > 0 && book.ask === resolved.price) {
        return { quotes: { ask: book.ask, bid: book.bid > 0 ? book.bid : 0 }, resolved };
    }
    if (!(book?.ask > 0) && book?.bid > 0 && book.bid === resolved.price) {
        return { quotes: { ask: 0, bid: book.bid }, resolved };
    }
    return { quotes: same, resolved };
}

/**
 * Price an item bought as a mirror, protection item or base copy: the resolver's figure through
 * the inflation guard.
 * @param {string} itemHrid - The item
 * @param {Object} [options] - Same as {@link priceMaterial}
 * @returns {{price: number|null, unpriced: boolean, estimated: boolean}}
 */
export function priceGuarded(itemHrid, options = {}) {
    if (!itemHrid) return result(0);
    const { quotes, resolved } = guardQuotes(itemHrid, options);
    if (!quotes) return result(0);
    const price = getRealisticBaseItemPriceFrom(itemHrid, { quoteOf: () => quotes });
    return result(price, resolved.estimated || price !== resolved.price);
}

/**
 * Philosopher's Mirror: the same guarded resolver price.
 * @param {Object} [options] - Same as {@link priceMaterial}
 * @returns {{price: number|null, unpriced: boolean, estimated: boolean}}
 */
export function priceMirror(options = {}) {
    return priceGuarded(PHILOSOPHERS_MIRROR, options);
}

/**
 * The cheapest thing that absorbs a failure: min over {the item itself, Mirror of Protection, the
 * item's listed protection items}, each guarded.
 * @param {string} itemHrid - The item being enhanced
 * @param {Object} [options] - Options
 * @param {boolean} [options.includeSelf=true] - Whether a second copy of the item counts
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @returns {{price: number|null, itemHrid: string|null, unpriced: boolean, estimated: boolean}}
 */
export function priceProtection(itemHrid, { includeSelf = true, context = 'profit', mode } = {}) {
    const pricing = { context, mode };
    const best = getCheapestProtectionPriceFrom(itemHrid, {
        includeSelf,
        priceOf: (hrid) => priceGuarded(hrid, pricing).price || 0,
    });
    if (!(best.price > 0)) return { price: null, itemHrid: null, unpriced: true, estimated: false };
    const picked = priceGuarded(best.itemHrid, pricing);
    return { price: best.price, itemHrid: best.itemHrid, unpriced: false, estimated: picked.estimated };
}

/**
 * The base item an enhancing run starts from: the guarded resolver price, or the cheaper of that
 * and the craft cost when `enhanceSim_baseItemCraftingCost` is on.
 * @param {string} itemHrid - The item
 * @param {Object} [options] - Same as {@link priceMaterial}
 * @param {boolean} [options.useCraftingCost] - Override the setting (tests, callers that know)
 * @returns {{price: number|null, unpriced: boolean, estimated: boolean, crafted: boolean}}
 */
export function priceBase(itemHrid, options = {}) {
    const { context = 'profit', mode, useCraftingCost } = options;
    const bought = priceGuarded(itemHrid, { context, mode });
    const crafting = useCraftingCost ?? config.isFeatureEnabled('enhanceSim_baseItemCraftingCost');
    if (!crafting) return { ...bought, crafted: false };
    const side = mode || getPricingMode(context, 'buy');
    const craft = getProductionCost(itemHrid, side === 'bid' ? 'bid' : 'ask');
    if (craft > 0 && (bought.unpriced || craft < bought.price)) {
        return { price: craft, unpriced: false, estimated: true, crafted: true };
    }
    return { ...bought, crafted: false };
}

// ---------------------------------------------------------------------------
// Number-only shapes for the callers that import the older helpers
// ---------------------------------------------------------------------------

/**
 * Drop-in for `getEnhancementMaterialPrice`: 'ask' (the default) is the profit-mode price the cost
 * surfaces show; 'bid' forces the bid side, for the patient-buy comparison.
 * @param {string} itemHrid - Material item HRID
 * @param {'ask'|'bid'} [side='ask'] - Profit-mode price or the forced bid
 * @returns {number} Unit price, 0 when nothing prices it (callers treat that as unpriced)
 */
export function getEnhancementMaterialPrice(itemHrid, side = 'ask') {
    return priceMaterial(itemHrid, side === 'bid' ? { mode: 'bid' } : {}).price || 0;
}

/**
 * Drop-in for `getRealisticBaseItemPrice`: the guarded profit-mode price, 0 when unpriced.
 * @param {string} itemHrid - The item
 * @returns {number} Coins
 */
export function getRealisticBaseItemPrice(itemHrid) {
    return priceGuarded(itemHrid).price || 0;
}

/**
 * Drop-in for `getCheapestProtectionPrice`.
 * @param {string} itemHrid - The item being enhanced
 * @param {Object} [options] - Options of {@link priceProtection}
 * @returns {{price: number|null, itemHrid: string|null}}
 */
export function getCheapestProtectionPrice(itemHrid, options = {}) {
    const { price, itemHrid: hrid } = priceProtection(itemHrid, options);
    return { price, itemHrid: hrid };
}

/**
 * Drop-in for `perAttemptMaterialCost`, tallying with the shared material rule.
 * @param {Object} itemDetails - Item details containing `enhancementCosts`
 * @param {Object} [options] - Options
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @returns {{cost: number, hasCost: boolean, hasMissingPrices: boolean}}
 */
export function perAttemptMaterialCost(itemDetails, { context = 'profit' } = {}) {
    return perAttemptMaterialCostFrom(itemDetails, {
        priceMaterial: (hrid) => priceMaterial(hrid, { context }).price || 0,
    });
}
