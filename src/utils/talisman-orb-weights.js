/**
 * Talisman orb weights
 *
 * One scale for every talisman orb, shared by the reroll advisor (talisman window) and the Combat Sim's talisman
 * line ranking, so both weigh a strategy the same way: market prices when every orb has a live listing (or the
 * player's own override), otherwise the game's item value (`sellPrice`), otherwise one each. A coin cost is shown
 * only when every orb used has a market price; the tester shop's prices are never used.
 *
 * Stateless: the price reader is passed in or read live on each call.
 */

import { getItemPriceInfo } from './market-data.js';

/**
 * The cost weight of every orb, on one scale, and the market price of each orb that has one.
 * @param {Object} info - talismanInfo
 * @param {Object} itemDetailMap
 * @param {Function} [priceInfo] - getItemPriceInfo-shaped; injectable for tests
 * @returns {{weights: Object<string, number>, prices: Object<string, number>, scale: 'market'|'itemValue'|'count'}}
 */
export function orbWeights(info, itemDetailMap, priceInfo = getItemPriceInfo) {
    const hrids = [...Object.keys(info?.rerollInputMap || {})];
    if (info?.lockInputItemHrid) hrids.push(info.lockInputItemHrid);
    const prices = {};
    for (const hrid of hrids) {
        let quote = null;
        try {
            quote = priceInfo(hrid, { context: 'profit', side: 'buy', marketQuote: true });
        } catch (error) {
            console.error('[TalismanOrbWeights] Pricing an orb failed:', error);
        }
        // Only a live listing (or the player's own override) is a market price; an estimate is not
        if (quote && (quote.source === 'book' || quote.source === 'custom') && quote.price > 0) {
            prices[hrid] = quote.price;
        }
    }
    if (hrids.length > 0 && hrids.every((hrid) => prices[hrid] > 0)) {
        return { weights: { ...prices }, prices, scale: 'market' };
    }
    const values = {};
    for (const hrid of hrids) values[hrid] = Number(itemDetailMap?.[hrid]?.sellPrice) || 0;
    if (hrids.every((hrid) => values[hrid] > 0)) return { weights: values, prices, scale: 'itemValue' };
    const ones = {};
    for (const hrid of hrids) ones[hrid] = 1;
    return { weights: ones, prices, scale: 'count' };
}

/**
 * Coins the expected orb counts cost, or null unless every orb used has a market price.
 * @param {Object<string, number>} counts
 * @param {Object<string, number>} prices - Market prices only
 * @returns {number|null}
 */
export function coinCost(counts, prices) {
    const used = Object.keys(counts || {});
    if (used.length === 0) return null;
    if (!used.every((hrid) => prices?.[hrid] > 0)) return null;
    return used.reduce((sum, hrid) => sum + counts[hrid] * prices[hrid], 0);
}

/**
 * Weights rounded to two significant figures, so a small price move keeps the same solve.
 * @param {Object<string, number>} weights
 * @returns {Object<string, number>}
 */
export function roundWeights(weights) {
    const out = {};
    for (const [hrid, value] of Object.entries(weights || {}))
        out[hrid] = value > 0 ? Number(value.toPrecision(2)) : value;
    return out;
}
