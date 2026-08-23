/**
 * Market Data Utility
 * Centralized access to market prices with smart pricing mode handling
 */

import marketAPI from '../api/marketplace.js';
import config from '../core/config.js';
import { getCustomPrice } from '../features/settings/custom-price-overrides.js';
import { formatRelativeTime } from './formatters.js';
import { refreshMarketValues, reconcileBook } from './market-values.js';

// Track logged warnings to prevent console spam
const loggedWarnings = new Set();

/**
 * A pricing mode forced on the `'profit'` context for the duration of one call.
 *
 * Some surfaces describe a flow the user's global pricing mode does not:
 * the marketplace's alchemy sort quotes insta-buying the input at ask and
 * insta-selling the outputs at bid, which is `'conservative'` whatever the
 * setting says. Rather than thread an override through every `getItemPrice`
 * call inside the profit calculators, the override sits here — the one place
 * that turns the setting into an ask/bid choice.
 */
let profitPricingModeOverride = null;

/**
 * Run `fn` with the `'profit'` pricing context pinned to a specific mode.
 *
 * Synchronous only: the override is global for its duration, so an awaited
 * callback would leak it across whatever else ran in the meantime. Nesting is
 * safe — the previous override is restored, not cleared.
 *
 * @param {string|null} mode - A `profitCalc_pricingMode` value ('conservative'|'hybrid'|'optimistic'|'patientBuy'), or null for no override
 * @param {Function} fn - Synchronous callback
 * @returns {*} Whatever `fn` returns
 */
export function withProfitPricingMode(mode, fn) {
    const previous = profitPricingModeOverride;
    profitPricingModeOverride = mode;
    try {
        return fn();
    } finally {
        profitPricingModeOverride = previous;
    }
}

/**
 * Get item price based on pricing mode and context
 * @param {string} itemHrid - Item HRID
 * @param {Object} options - Configuration options
 * @param {number} [options.enhancementLevel=0] - Enhancement level
 * @param {string} [options.mode] - Pricing mode ('ask'|'bid'|'average'). If not provided, uses context or user settings
 * @param {string} [options.context] - Context hint ('profit'|'networth'|null). Used to determine pricing mode from settings
 * @param {string} [options.side='sell'] - Transaction side ('buy'|'sell') - used with 'profit' context to determine correct price
 * @returns {number|null} Price in gold, or null if no market data
 */
export function getItemPrice(itemHrid, options = {}) {
    return getItemPriceInfo(itemHrid, options).price;
}

/**
 * Price an item and say where the number came from.
 *
 * `getItemPrice` returns a bare number and always will — too much depends on
 * that shape. But since the marketplace patch an item with an empty order book
 * is still priced, from the game's official value map, and a caller that cannot
 * tell that apart from a real listing quietly reports an estimate as a quote.
 * Everything that used to mean "no market data" (`missing`, `hasMissingPrices`,
 * `hasPriceData`) stopped firing the day value-filling landed; this is how a
 * caller gets that signal back.
 *
 * @param {string} itemHrid - Item HRID
 * @param {Object} options - Same options as {@link getItemPrice}
 * @returns {{price: number|null, source: 'custom'|'book'|'value'|null, estimated: boolean}}
 *   `source` is `'custom'` for a user override, `'book'` for a live order-book price,
 *   `'value'` for one derived from the official value map, `null` when unpriced.
 *   `estimated` is true exactly when `source === 'value'`.
 */
export function getItemPriceInfo(itemHrid, options = {}) {
    const unpriced = { price: null, source: null, estimated: false };

    // Validate inputs
    if (!itemHrid || typeof itemHrid !== 'string') {
        return unpriced;
    }

    // Handle case where someone passes enhancementLevel as second arg (old API)
    if (typeof options === 'number') {
        options = { enhancementLevel: options };
    }

    // Ensure options is an object
    if (typeof options !== 'object' || options === null) {
        options = {};
    }

    const { enhancementLevel = 0, mode, context, side = 'sell' } = options;

    // Check for custom price override
    const customPrice = getCustomPrice(itemHrid, enhancementLevel, side);
    if (customPrice !== null) {
        return { price: customPrice, source: 'custom', estimated: false };
    }

    // Get raw price data from API, reconciled against the official market value:
    // stale prices are clamped into the tradable range and an empty book is
    // valued the way the game values it. A pass-through until the patch is live.
    refreshMarketValues();
    const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
    const { ask, bid, askSource, bidSource } = reconcileBook(
        priceData?.ask ?? null,
        priceData?.bid ?? null,
        itemHrid,
        enhancementLevel
    );

    if (ask === null && bid === null) {
        return unpriced;
    }

    // Determine pricing mode
    const pricingMode = mode || getPricingMode(context, side);

    // Validate pricing mode
    const validModes = ['ask', 'bid', 'average'];
    if (!validModes.includes(pricingMode)) {
        const warningKey = `mode:${pricingMode}`;
        if (!loggedWarnings.has(warningKey)) {
            console.warn(`[Market Data] Unknown pricing mode: ${pricingMode}, no price returned`);
            loggedWarnings.add(warningKey);
        }
        // A mode nobody recognises is a bug, and answering it with the ask (or
        // worse, 0) hides that bug behind a plausible number. Unpriced is honest.
        return unpriced;
    }

    const resolveSide = (value, source) => {
        if (typeof value !== 'number' || value < 0) {
            return unpriced;
        }
        return { price: value, source, estimated: source === 'value' };
    };

    // Return price based on mode
    switch (pricingMode) {
        case 'ask':
            return resolveSide(ask, askSource);
        case 'bid':
            return resolveSide(bid, bidSource);
        case 'average': {
            if (typeof ask !== 'number' || typeof bid !== 'number') {
                return unpriced;
            }

            if (ask < 0 || bid < 0) {
                return unpriced;
            }

            // An average is only as solid as its weaker half
            const estimated = askSource === 'value' || bidSource === 'value';
            return { price: (ask + bid) / 2, source: estimated ? 'value' : 'book', estimated };
        }
        default:
            return resolveSide(ask, askSource);
    }
}

/**
 * Whether an item's price is an estimate from the official value map rather
 * than a live order-book quote. The parallel-check counterpart of
 * {@link isPriceOverridden}, for callers that hold a bare number.
 * @param {string} itemHrid - Item HRID
 * @param {Object} [options] - Same options as {@link getItemPrice}
 * @returns {boolean}
 */
export function isPriceEstimated(itemHrid, options = {}) {
    return getItemPriceInfo(itemHrid, options).estimated;
}

/**
 * Check whether a custom price override applies to a given item/side.
 * `getItemPrice` returns a bare number for backward compatibility, so callers that need to
 * know whether that number came from the user's own price overrides (rather than the market)
 * can check this in parallel instead of relying on `getItemPrice`'s return shape.
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @param {string} [side='sell'] - Transaction side ('buy'|'sell')
 * @returns {boolean} True if a custom price override is set for this item/enhancement/side
 */
export function isPriceOverridden(itemHrid, enhancementLevel = 0, side = 'sell') {
    if (!itemHrid || typeof itemHrid !== 'string') {
        return false;
    }

    return getCustomPrice(itemHrid, enhancementLevel, side) !== null;
}

/**
 * Get a short, human-readable description of how stale the current market price data is.
 * Backed by marketAPI's fetch timestamp (data is refreshed at most every CACHE_DURATION).
 * @returns {string|null} e.g. "prices 4m old", "prices updated just now", or null if no data loaded yet
 */
export function getPriceAgeString() {
    const ageMs = marketAPI.getDataAge();
    if (ageMs === null) {
        return null;
    }

    const relative = formatRelativeTime(ageMs);
    return relative === 'Just now' ? 'prices updated just now' : `prices ${relative} old`;
}

/**
 * Get all price variants for an item
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {Object|null} Object with {ask, bid, average, askEstimated, bidEstimated} or null if no
 *   market data. The `*Estimated` flags are true when that side was filled in from the official
 *   value map rather than read off a live order book.
 */
export function getItemPrices(itemHrid, enhancementLevel = 0) {
    refreshMarketValues();
    const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
    const { ask, bid, askSource, bidSource } = reconcileBook(
        priceData?.ask ?? null,
        priceData?.bid ?? null,
        itemHrid,
        enhancementLevel
    );

    if (ask === null && bid === null) {
        return null;
    }

    return {
        ask,
        bid,
        average: (ask + bid) / 2,
        askEstimated: askSource === 'value',
        bidEstimated: bidSource === 'value',
    };
}

/**
 * Format price with K/M/B suffixes
 * @param {number} amount - Amount to format
 * @param {Object} options - Formatting options
 * @param {number} [options.decimals=1] - Number of decimal places
 * @param {boolean} [options.showZero=true] - Whether to show '0' for zero values
 * @returns {string} Formatted price string
 */
export function formatPrice(amount, options = {}) {
    const { decimals = 1, showZero = true } = options;

    if (amount === null || amount === undefined) {
        return '--';
    }

    if (amount === 0) {
        return showZero ? '0' : '--';
    }

    const absAmount = Math.abs(amount);
    const sign = amount < 0 ? '-' : '';

    if (absAmount >= 1_000_000_000) {
        return `${sign}${(absAmount / 1_000_000_000).toFixed(decimals)}B`;
    } else if (absAmount >= 1_000_000) {
        return `${sign}${(absAmount / 1_000_000).toFixed(decimals)}M`;
    } else if (absAmount >= 1_000) {
        return `${sign}${(absAmount / 1_000).toFixed(decimals)}K`;
    } else {
        return `${sign}${absAmount.toFixed(decimals)}`;
    }
}

/**
 * Determine pricing mode from context and user settings
 * @param {string} [context] - Context hint ('profit'|'networth'|null)
 * @param {string} [side='sell'] - Transaction side ('buy'|'sell') - used with 'profit' context
 * @returns {string} Pricing mode ('ask'|'bid'|'average')
 */
export function getPricingMode(context, side = 'sell') {
    // If no context, default to 'ask'
    if (!context) {
        return 'ask';
    }

    // Validate context is a string
    if (typeof context !== 'string') {
        return 'ask';
    }

    // Get pricing mode from settings based on context
    switch (context) {
        case 'profit': {
            const profitMode = profitPricingModeOverride || config.getSettingValue('profitCalc_pricingMode');

            // Convert profit calculation modes to price types based on transaction side
            // Conservative: Ask/Bid (instant buy materials, instant sell output)
            // Hybrid: Ask/Ask (instant buy materials, patient sell output)
            // Optimistic: Bid/Ask (patient buy materials, patient sell output)
            // Patient Buy: Bid/Bid (patient buy materials, instant sell output)
            let selectedPriceType;
            switch (profitMode) {
                case 'conservative':
                    selectedPriceType = side === 'buy' ? 'ask' : 'bid';
                    break;
                case 'hybrid':
                    selectedPriceType = 'ask'; // Ask for both buy and sell
                    break;
                case 'optimistic':
                    selectedPriceType = side === 'buy' ? 'bid' : 'ask';
                    break;
                case 'patientBuy':
                    selectedPriceType = 'bid'; // Bid for both buy and sell
                    break;
                default:
                    selectedPriceType = 'ask';
            }
            return selectedPriceType;
        }
        case 'networth': {
            return config.getSettingValue('networth_pricingMode') || 'ask';
        }
        default: {
            const warningKey = `context:${context}`;
            if (!loggedWarnings.has(warningKey)) {
                console.warn(`[Market Data] Unknown context: ${context}, defaulting to ask`);
                loggedWarnings.add(warningKey);
            }
            return 'ask';
        }
    }
}

/**
 * Get prices for multiple items in batch
 * @param {Array<{itemHrid: string, enhancementLevel?: number}>} items - Array of items to price
 * @param {Object} options - Configuration options
 * @param {string} [options.mode] - Pricing mode ('ask'|'bid'|'average')
 * @param {string} [options.context] - Context hint ('profit'|'networth'|null)
 * @param {string} [options.side='sell'] - Transaction side ('buy'|'sell')
 * @returns {Map<string, number>} Map of itemHrid+enhancementLevel to price
 */
export function getItemPricesBatch(items, options = {}) {
    const result = new Map();

    for (const item of items) {
        const key = `${item.itemHrid}:${item.enhancementLevel || 0}`;
        const price = getItemPrice(item.itemHrid, {
            enhancementLevel: item.enhancementLevel || 0,
            mode: options.mode,
            context: options.context,
            side: options.side,
        });

        if (price !== null) {
            result.set(key, price);
        }
    }

    return result;
}

export default {
    getItemPrice,
    getItemPriceInfo,
    isPriceEstimated,
    getItemPrices,
    formatPrice,
    getPricingMode,
    getItemPricesBatch,
    isPriceOverridden,
    getPriceAgeString,
};
