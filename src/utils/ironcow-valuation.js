/**
 * Iron Cow item valuation.
 *
 * An Iron Cow character cannot use the marketplace, so an ask or a bid says
 * nothing about what its items are worth to it. `profitCalc_ironCowValuation`
 * lets such a character value items instead at what it can actually turn them
 * into: the NPC vendor price, or the better of that and coinifying them.
 *
 * The setting is stored per character like every other, and is read only while
 * the current character's game mode is an Iron Cow one; for any other character
 * every function here answers as if it were 'market'.
 *
 * Coinify value of one item (the gross coins it yields, no catalyst, tea or time):
 *
 *     sellPrice × 5 × successRate
 *     successRate = clamp(0.7 × (1 + perLevel × (alchemyLevel − itemLevel)), 0, 1)
 *     perLevel    = 0.9 / itemLevel, applied only when alchemyLevel < itemLevel
 *
 * Sources: one coinify attempt consumes `alchemyDetail.bulkMultiplier` items and,
 * on success, yields `sellPrice × bulkMultiplier × 5` coins
 * (alchemy-profit-calculator.js `calculateCoinifyProfit`); the items are consumed
 * whether or not it succeeds (that method's `computeNetProfit` charges the input
 * on every attempt), so the bulk multiplier cancels out of a per-item value and
 * the success rate does not. The 0.7 base rate and the under-level penalty are
 * the calculator's `BASE_SUCCESS_RATES.COINIFY` and `getUnderLevelPenalty`, which
 * import these constants so the two cannot drift apart.
 *
 * This module must not import market-data.js or the alchemy calculator: both
 * import it.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';

/** Per-character setting: 'market' | 'vendor' | 'best'. */
export const IRONCOW_VALUATION_SETTING = 'profitCalc_ironCowValuation';

/** Every value the setting accepts. */
export const IRONCOW_VALUATION_MODES = Object.freeze(['market', 'vendor', 'best']);

/** Coins per point of `sellPrice` per item on a successful coinify. */
export const COINIFY_COINS_PER_SELL_PRICE = 5;

/** Unmodified coinify success rate. */
export const COINIFY_BASE_SUCCESS_RATE = 0.7;

/** Under-level alchemy penalty numerator: `perLevel = 0.9 / itemLevel`. */
export const UNDER_LEVEL_PENALTY_NUMERATOR = 0.9;

const COIN_HRID = '/items/coin';

/**
 * Whether the current character plays an Iron Cow game mode.
 * The game reports 'ironcow' and 'legacy_ironcow'; 'standard' is a market character.
 * @returns {boolean}
 */
export function isIronCowCharacter() {
    if (typeof dataManager.getCurrentCharacterGameMode !== 'function') return false;
    const gameMode = dataManager.getCurrentCharacterGameMode();
    return typeof gameMode === 'string' && gameMode.includes('ironcow');
}

/**
 * The valuation in force for the current character.
 * @returns {'market'|'vendor'|'best'} Always 'market' for a character that is not Iron Cow
 */
export function getIronCowValuationMode() {
    if (!isIronCowCharacter()) return 'market';
    const mode = config.getSettingValue?.(IRONCOW_VALUATION_SETTING, 'market');
    return IRONCOW_VALUATION_MODES.includes(mode) ? mode : 'market';
}

/**
 * Current alchemy level, 1 when unknown.
 * @returns {number}
 */
function alchemyLevel() {
    const skills = typeof dataManager.getSkills === 'function' ? dataManager.getSkills() : null;
    return skills?.find?.((s) => s.skillHrid === '/skills/alchemy')?.level || 1;
}

/**
 * Coinify success rate for an item at an alchemy level, without catalyst or tea.
 * @param {number} itemLevel - The item's level
 * @param {number} level - The character's alchemy level
 * @returns {number} 0..1
 */
export function coinifySuccessRate(itemLevel, level) {
    const item = itemLevel || 1;
    const penalty = level < item ? (UNDER_LEVEL_PENALTY_NUMERATOR / item) * (level - item) : 0;
    return Math.min(1, Math.max(0, COINIFY_BASE_SUCCESS_RATE * (1 + penalty)));
}

/**
 * Expected coins one item yields when coinified.
 * @param {Object|null} itemDetails - Entry from `itemDetailMap`
 * @param {number} [level] - Alchemy level; the current character's when omitted
 * @returns {number|null} Coins per item, or null when the item cannot be coinified
 */
export function coinifyUnitValue(itemDetails, level = alchemyLevel()) {
    if (itemDetails?.alchemyDetail?.isCoinifiable !== true) return null;
    const sellPrice = itemDetails.sellPrice;
    if (!(sellPrice > 0)) return null;
    return sellPrice * COINIFY_COINS_PER_SELL_PRICE * coinifySuccessRate(itemDetails.itemLevel, level);
}

/**
 * What an item is worth to the current character under its Iron Cow valuation.
 *
 * Null means "use the market path as before": the character is not Iron Cow, the
 * option is 'market', the item is enhanced (the vendor and coinify figures here
 * are base-item figures), or it has neither a vendor price nor a coinify output.
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {{price: number, source: 'vendor'|'coinify'}|null}
 */
export function getIronCowValue(itemHrid, enhancementLevel = 0) {
    const mode = getIronCowValuationMode();
    if (mode === 'market') return null;
    if (itemHrid === COIN_HRID) return { price: 1, source: 'vendor' };
    if (enhancementLevel) return null;

    const itemDetails = dataManager.getItemDetails?.(itemHrid) ?? null;
    const vendor = itemDetails?.sellPrice > 0 ? itemDetails.sellPrice : null;
    if (mode === 'vendor') {
        return vendor === null ? null : { price: vendor, source: 'vendor' };
    }

    const coinify = coinifyUnitValue(itemDetails);
    if (coinify !== null && (vendor === null || coinify > vendor)) {
        return { price: coinify, source: 'coinify' };
    }
    return vendor === null ? null : { price: vendor, source: 'vendor' };
}

/**
 * An Iron Cow value shaped like `marketAPI.getPrice`'s book, for readers that
 * take ask/bid off the raw book: `ironCowBook(hrid) ?? marketAPI.getPrice(hrid)`.
 * Both sides carry the same value — there is no spread without a market.
 * @param {string} itemHrid - Item HRID
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {{ask: number, bid: number, source: 'vendor'|'coinify'}|null}
 */
export function ironCowBook(itemHrid, enhancementLevel = 0) {
    const value = getIronCowValue(itemHrid, enhancementLevel);
    return value ? { ask: value.price, bid: value.price, source: value.source } : null;
}
