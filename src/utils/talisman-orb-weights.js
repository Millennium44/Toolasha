/**
 * Talisman orb weights
 *
 * One scale for every talisman orb, shared by the reroll advisor (talisman window) and the Combat Sim's talisman
 * line ranking, so both weigh a strategy the same way: market prices when every orb has a live listing (or the
 * player's own override) or, failing that, the cost of crafting it from its recipe; otherwise the game's item value
 * (`sellPrice`), otherwise one each. The scale is all or nothing: coins only when every orb is priced one of those
 * two ways. A coin cost is shown only when every orb used has such a price; the tester shop's prices are never used.
 *
 * Stateless: the price reader is passed in or read live on each call.
 */

import { getItemPriceInfo } from './market-data.js';
import { orbRecipeCost } from './talisman-orb-recipe-cost.js';

/**
 * The cost weight of every orb, on one scale, and the market price of each orb that has one.
 * @param {Object} info - talismanInfo
 * @param {Object} itemDetailMap
 * @param {Function} [priceInfo] - getItemPriceInfo-shaped; injectable for tests
 * @param {Function} [recipeCost] - (hrid, {orbHrids, priceOrb}) => coins|null; injectable for tests
 * @returns {{weights: Object<string, number>, prices: Object<string, number>, scale: 'market'|'itemValue'|'count',
 *   crafted: string[]}} `prices` holds market and crafting prices; `crafted` names the orbs priced by recipe
 */
export function orbWeights(info, itemDetailMap, priceInfo = getItemPriceInfo, recipeCost = orbRecipeCost) {
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
    // An orb with no market price may still be priced by its recipe (a market price always wins)
    const crafted = [];
    const orbHrids = new Set(hrids);
    for (const hrid of hrids) {
        if (prices[hrid] > 0) continue;
        let cost = null;
        try {
            // An input that is itself an orb is priced at its market price only: no recursion into its recipe
            const marketPrices = { ...prices };
            cost = recipeCost(hrid, { orbHrids, priceOrb: (orb) => marketPrices[orb] || null });
        } catch (error) {
            console.error('[TalismanOrbWeights] Pricing an orb recipe failed:', error);
        }
        if (Number.isFinite(cost) && cost > 0) crafted.push([hrid, cost]);
    }
    for (const [hrid, cost] of crafted) prices[hrid] = cost;
    if (hrids.length > 0 && hrids.every((hrid) => prices[hrid] > 0)) {
        return { weights: { ...prices }, prices, scale: 'market', crafted: crafted.map(([hrid]) => hrid) };
    }
    // Not every orb has a coin price: no coin figure at all, so no crafted price is kept
    for (const [hrid] of crafted) delete prices[hrid];
    const values = {};
    for (const hrid of hrids) values[hrid] = Number(itemDetailMap?.[hrid]?.sellPrice) || 0;
    if (hrids.every((hrid) => values[hrid] > 0)) return { weights: values, prices, scale: 'itemValue', crafted: [] };
    const ones = {};
    for (const hrid of hrids) ones[hrid] = 1;
    return { weights: ones, prices, scale: 'count', crafted: [] };
}

/**
 * Coins the expected orb counts cost, or null unless every orb used has a market or crafting price.
 * @param {Object<string, number>} counts
 * @param {Object<string, number>} prices - Market and crafting prices
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
