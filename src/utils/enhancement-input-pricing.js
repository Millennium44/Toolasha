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
 * Sides: a surface that names a side (the tooltip's Ask and Bid columns, the score, the loot log)
 * forces `mode` to it; the profit mode applies only where no side is named. A custom price of 0 or
 * less reads as unpriced, as it does in the resolver.
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
import { getShopCoinCost } from './game-lookups.js';
import { getCustomPriceVersion } from '../features/settings/custom-price-overrides.js';
import {
    TRAINEE_SHOP_PRICE,
    getCheapestProtectionPrice as getCheapestProtectionPriceFrom,
    getProductionCost,
    getProductionCostDetailed,
    perAttemptMaterialCost as perAttemptMaterialCostFrom,
    getRealisticBaseItemPrice as getRealisticBaseItemPriceFrom,
} from './enhancement-pricing.js';

const PHILOSOPHERS_MIRROR = '/items/philosophers_mirror';

/** Build the result record from a bare price. */
function result(price, estimated = false, custom = false, partial = false) {
    return price > 0
        ? { price, unpriced: false, estimated, custom, partial }
        : { price: null, unpriced: true, estimated: false, custom: false, partial: false };
}

/** The book side a buy is priced on: the forced mode, else the context's mode. */
function buySide(options) {
    return options.mode || getPricingMode(options.context || 'profit', 'buy');
}

/**
 * Whether a craft-cost figure is a partial bill: a recipe input nothing could price was counted as 0.
 * @param {string} itemHrid - The crafted item
 * @param {'ask'|'bid'|'average'|string} side - The side the cost was taken on
 * @returns {boolean}
 */
function craftPartial(itemHrid, side) {
    return getProductionCostDetailed(itemHrid, side === 'bid' ? 'bid' : 'ask').partial;
}

/**
 * When the side being priced has no live quote but the opposite side does, the opposite live quote
 * stands in for it, as the old material rule did ("when only one side is quoted, both sides use it").
 * The resolver does not: with the mode's side absent it answers from an estimate, craft cost, shop
 * floor or nothing, whichever the book is missing a live quote for. A shop floor still competes with
 * the cross-filled quote, as it does with any book price. Custom prices, Iron Cow valuation and the
 * average mode are left to the resolver.
 */
function crossFill(itemHrid, level, side, resolved) {
    if (resolved.custom || (side !== 'ask' && side !== 'bid')) return resolved;
    const book = getItemPrices(itemHrid, level);
    if (!book) return resolved;
    const live = (price, estimated) => price > 0 && !estimated;
    const askLive = live(book.ask, book.askEstimated);
    const bidLive = live(book.bid, book.bidEstimated);
    const ownLive = side === 'ask' ? askLive : bidLive;
    const otherLive = side === 'ask' ? bidLive : askLive;
    if (ownLive || !otherLive) return resolved;
    const price = side === 'ask' ? book.bid : book.ask;
    if (level === 0) {
        const shop = getShopCoinCost(itemHrid);
        // The shop's price is guaranteed, not a one-sided market quote: it keeps its provenance, so the
        // inflation guard leaves it alone as it does on the ordinary shop path. (A custom price returned
        // above and never reaches here.)
        if (shop > 0 && shop < price) {
            return { price: shop, custom: false, missing: false, estimated: false };
        }
    }
    return { price, custom: false, missing: false, estimated: false, crossFilled: true };
}

/** The resolver, with the context/mode options every function here takes (and the cross-fill). */
function resolve(itemHrid, { context = 'profit', mode, level = 0 } = {}) {
    try {
        const resolved = resolveItemPrice(itemHrid, {
            context,
            side: 'buy',
            ...(level > 0 ? { enhancementLevel: level } : {}),
            ...(mode ? { mode } : {}),
        });
        return crossFill(itemHrid, level, buySide({ context, mode }), resolved);
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
    const partial = Boolean(resolved.production) && craftPartial(itemHrid, buySide(options));
    return result(resolved.price, resolved.estimated, Boolean(resolved.custom), partial);
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
    if (resolved.custom || resolved.estimated) return { quotes: same, resolved };
    // A figure taken from the opposite side because its own side had no live quote is a one-sided book
    // to the guard, whichever mode asked: the quote it holds is the only one there is (an estimate
    // filling the other side is not a quote)
    if (resolved.crossFilled) {
        return { quotes: mode === 'ask' ? { ask: 0, bid: resolved.price } : { ask: resolved.price, bid: 0 }, resolved };
    }
    if (mode !== 'ask') return { quotes: same, resolved };
    const book = getItemPrices(itemHrid, 0);
    // Only a plain, live book quote is weighed; a shop floor or patient tick is not the book's ask, and
    // an official-value estimate filling an empty side is not a quote at all
    const askLive = book?.ask > 0 && !book.askEstimated;
    if (askLive && book.ask === resolved.price) {
        return { quotes: { ask: book.ask, bid: book.bid > 0 ? book.bid : 0 }, resolved };
    }
    return { quotes: same, resolved };
}

/**
 * A short string that changes whenever something the rule reads outside the order book changes: the
 * profit pricing mode, the net-worth mode, the base-item crafting setting, and the custom prices. A
 * cache over prices built by this rule puts it in its key.
 * @returns {string}
 */
export function pricingStamp() {
    let custom = 0;
    try {
        custom = getCustomPriceVersion();
    } catch {
        // A bundle or test without the override store has no custom prices to version
    }
    const setting = (key) => config.getSettingValue?.(key) ?? '';
    return [
        setting('profitCalc_pricingMode'),
        setting('networth_pricingMode'),
        config.isFeatureEnabled?.('enhanceSim_baseItemCraftingCost') ? 'craft' : 'buy',
        // A buy at the bid is priced one tick up when this is on, so it moves every bid-side input
        config.getSetting?.('profitCalc_patientTickBuy') === true ? 'tick' : '',
        custom,
    ].join('|');
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
    // A craft-cost figure (the resolver's own fallback, or the guard swapping an inflated ask for it)
    // is a partial bill when a recipe input went unpriced
    let partial = false;
    if (resolved.production) partial = craftPartial(itemHrid, buySide(options));
    else if (price !== resolved.price) {
        const craft = getProductionCostDetailed(itemHrid, 'ask');
        partial = craft.cost === price && craft.partial;
    }
    return result(price, resolved.estimated || price !== resolved.price, Boolean(resolved.custom), partial);
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
    if (!(best.price > 0)) return { price: null, itemHrid: null, unpriced: true, estimated: false, partial: false };
    const picked = priceGuarded(best.itemHrid, pricing);
    return {
        price: best.price,
        itemHrid: best.itemHrid,
        unpriced: false,
        estimated: picked.estimated,
        partial: picked.partial,
    };
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
    // A custom price is the player's own answer and wins absolutely: the craft cost only ever competes
    // with market quotes
    if (bought.custom) return { ...bought, crafted: false };
    const crafting = useCraftingCost ?? config.isFeatureEnabled('enhanceSim_baseItemCraftingCost');
    if (!crafting) return { ...bought, crafted: false };
    const side = mode || getPricingMode(context, 'buy');
    const craft = getProductionCost(itemHrid, side === 'bid' ? 'bid' : 'ask');
    if (craft > 0 && (bought.unpriced || craft < bought.price)) {
        return {
            price: craft,
            unpriced: false,
            estimated: true,
            custom: false,
            partial: craftPartial(itemHrid, side),
            crafted: true,
        };
    }
    return { ...bought, crafted: false };
}

/**
 * An enhanced copy bought as an input (a mirror attempt's base-item copy, a spare protection stack
 * loaded at a level): at +0 the base-item rule, above it the resolver at that level (custom price
 * for that level, Iron Cow, the book). An enhanced level with no quote stays unpriced; its craft
 * cost is the price of a different thing, so there is no fallback.
 * @param {string} itemHrid - The item
 * @param {number} level - Enhancement level
 * @param {Object} [options] - Same as {@link priceMaterial}
 * @returns {{price: number|null, unpriced: boolean, estimated: boolean}}
 */
export function priceAtLevel(itemHrid, level = 0, options = {}) {
    if (!itemHrid) return result(0);
    // +0 follows the base-item rule, so a tracker's base copy, the panel's mirror column and the
    // tooltip's level 0 all quote one number
    if (!(level > 0)) return priceBase(itemHrid, options);
    try {
        const { context = 'profit', mode } = options;
        const resolved = resolve(itemHrid, { context, mode, level });
        return result(resolved.price, resolved.estimated, Boolean(resolved.custom));
    } catch {
        return result(0);
    }
}

// ---------------------------------------------------------------------------
// Number-only shapes for the callers that import the older helpers
// ---------------------------------------------------------------------------

/**
 * Drop-in for `getEnhancementMaterialPrice`. The side is a label, and it is honored: 'ask' is the
 * rule forced to the ask, 'bid' the rule forced to the bid (custom prices, the shop floor and the
 * trainee price still apply). A surface that wants the player's profit mode with no side named calls
 * {@link priceMaterial} instead.
 * @param {string} itemHrid - Material item HRID
 * @param {'ask'|'bid'} [side='ask'] - Book side to force
 * @returns {number} Unit price, 0 when nothing prices it (callers treat that as unpriced)
 */
export function getEnhancementMaterialPrice(itemHrid, side = 'ask') {
    return priceMaterial(itemHrid, { mode: side === 'bid' ? 'bid' : 'ask' }).price || 0;
}

/**
 * Drop-in for `getRealisticBaseItemPrice`: the guarded profit-mode price, 0 when unpriced.
 * @param {string} itemHrid - The item
 * @param {Object} [options] - Same as {@link priceMaterial}
 * @returns {number} Coins
 */
export function getRealisticBaseItemPrice(itemHrid, options = {}) {
    return priceGuarded(itemHrid, options).price || 0;
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
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @returns {{cost: number, hasCost: boolean, hasMissingPrices: boolean}}
 */
export function perAttemptMaterialCost(itemDetails, { context = 'profit', mode } = {}) {
    return perAttemptMaterialCostFrom(itemDetails, {
        priceMaterial: (hrid) => priceMaterial(hrid, { context, mode }).price || 0,
    });
}
