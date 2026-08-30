/**
 * Enhancement pricing
 *
 * What an enhancement run's inputs cost: the materials it burns every attempt,
 * the protection it spends on a protected failure, and the base item it starts
 * from.
 *
 * These rules used to live in `features/enhancement/tooltip-enhancement.js`,
 * which is where they were written and where most of their callers still are.
 * Two other surfaces — the sim's upgrade advisor and the inventory savings card
 * — could not import them (a different bundle each, and the market bundle
 * cannot reach into the enhancement feature), so each carried its own copy of
 * the rules, and the copies had drifted:
 *
 *   * the advisor had an inline transcription of the material rule, including a
 *     second hard-coded trainee-charm price;
 *   * the savings card priced materials at `ask || sellPrice`, with no
 *     cross-fill and no production fallback, which on a bid-only book quoted
 *     the vendor price — a ninth of the real bill on the fixtures in
 *     `enhancement-cost-parity.test.js`.
 *
 * Living under `src/utils` and shared through the utils bundle, this module is
 * reachable from every bundle, so there is one rule again. `tooltip-enhancement.js`
 * re-exports everything here, so its own callers did not have to move.
 *
 * Pure of the DOM and of any panel: it reads the game data and the market feed
 * and returns numbers.
 */

import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';
import { getItemPrice, getItemPrices } from './market-data.js';
import { parseArtisanBonus, getDrinkConcentration } from './tea-parser.js';
import { findProducingAction } from './production-index.js';

/**
 * What the game's vendor charges for a trainee charm.
 *
 * Nobody lists trainee charms on the market — there is no profit in reselling
 * something the shop stocks at a fixed price — so the market has no ask for one
 * and a market-only reading shows the bottom tier as unpriced. It is not
 * unpriced; it costs this, always.
 *
 * This is the one place the figure lives. It used to be written out three
 * times: here, inline in the upgrade advisor, and again in the profile score
 * calculator. `charm-value.js` re-exports it for the charm panel, which judges
 * every other tier's value per coin against it.
 *
 * The shop sells them unenhanced. A trainee charm at +5 is somebody's
 * enhancement work and is priced by the market like anything else.
 */
export const TRAINEE_SHOP_PRICE = 250_000;

/**
 * Production cost and chain time memos. Both depend on market prices, so an
 * entry is only good for the price feed it was computed against: each entry
 * carries the feed version it saw, and a price update just bumps the version —
 * O(1) instead of emptying both maps — so every older entry misses on its next
 * read and is recomputed (and overwritten) then. The maps stay bounded by the
 * number of distinct keys, since a key is re-set rather than appended.
 */
const _costCache = new Map();
const _chainTimeCache = new Map();
let _priceVersion = 0;

marketAPI.on(() => {
    _priceVersion++;
});

/**
 * Price one enhancement material.
 *
 * Four callers used to each carry their own copy of these rules — trainee
 * charms are untradeable and priced flat, coins are worth their face value, and
 * a market quote with one side missing borrows the side that exists — and they
 * had already drifted apart. This is the single answer all of them ask.
 *
 * @param {string} itemHrid - Material item HRID
 * @param {'ask'|'bid'} [side='ask'] - Which side of the book to price against
 * @returns {number} Unit price in coins, or 0 when nothing is known about the item
 */
export function getEnhancementMaterialPrice(itemHrid, side = 'ask') {
    if (!itemHrid) return 0;

    // Untradeable: no market listing exists, so use the fixed value on both sides
    if (itemHrid.startsWith('/items/trainee_')) {
        return TRAINEE_SHOP_PRICE;
    }
    if (itemHrid === '/items/coin') {
        return 1;
    }

    const marketPrice = getItemPrices(itemHrid, 0);
    if (marketPrice) {
        let ask = marketPrice.ask;
        let bid = marketPrice.bid;

        // Match MCS behavior: when only one side is quoted, both sides use it.
        // A missing side reads as null, and `null < 0` is false, so testing for
        // a negative sentinel never fired: a one-sided book fell through to the
        // production-cost/vendor fallback below instead of using the quote it
        // did have. "Not a positive number" is what missing looks like.
        if (ask > 0 && !(bid > 0)) bid = ask;
        if (bid > 0 && !(ask > 0)) ask = bid;

        const price = side === 'bid' ? bid : ask;
        if (price > 0) return price;
    }

    // Fallback: production cost, then NPC sell price
    const gameData = dataManager.getInitClientData();
    const materialDetail = gameData?.itemDetailMap?.[itemHrid];
    return getProductionCost(itemHrid, side) || materialDetail?.sellPrice || 0;
}

/**
 * What one attempt's materials come to, and whether anything in the recipe went
 * unpriced.
 *
 * Materials are consumed on every attempt regardless of success or failure, and
 * the cost is the same at every enhancement level (`enhancementCosts` is not
 * level-indexed), so one figure serves a whole run.
 *
 * `hasMissingPrices` is the part that matters to a caller: a material nobody
 * can price contributes nothing to the sum, and a total that quietly leaves it
 * out is an under-quote, not a price. Every surface that shows the figure says
 * so rather than presenting a partial bill as a full one.
 *
 * @param {Object} itemDetails - Item details containing `enhancementCosts`
 * @param {Object} [options] - Options
 * @param {function(string, string): number} [options.priceMaterial] - Price one
 *   material; defaults to {@link getEnhancementMaterialPrice}, and exists so a
 *   caller with its own price feed (the enhancing panel reads `resolveItemPrice`)
 *   can keep it without re-implementing the tallying rules
 * @returns {{cost: number, hasCost: boolean, hasMissingPrices: boolean}} Coins per
 *   attempt, whether anything at all could be priced, and whether anything could not
 */
export function perAttemptMaterialCost(itemDetails, { priceMaterial = getEnhancementMaterialPrice } = {}) {
    if (!itemDetails?.enhancementCosts?.length) {
        return { cost: 0, hasCost: false, hasMissingPrices: false };
    }

    let cost = 0;
    let hasCost = false;
    let hasMissingPrices = false;

    for (const material of itemDetails.enhancementCosts) {
        const price = priceMaterial(material.itemHrid, 'ask');
        if (price > 0) {
            cost += (material.count || 0) * price;
            hasCost = true;
        } else {
            hasMissingPrices = true;
        }
    }

    return { cost, hasCost, hasMissingPrices };
}

/**
 * Get realistic base item price with production cost fallback
 * Matches original MWI Tools v25.0 getRealisticBaseItemPrice logic
 * @param {string} itemHrid - The item
 * @returns {number} Coins, 0 when nothing is known
 */
export function getRealisticBaseItemPrice(itemHrid) {
    const marketPrice = getItemPrices(itemHrid, 0);
    const ask = marketPrice?.ask > 0 ? marketPrice.ask : 0;
    const bid = marketPrice?.bid > 0 ? marketPrice.bid : 0;

    // Calculate production cost as fallback
    const productionCost = getProductionCost(itemHrid);

    // If both ask and bid exist
    if (ask > 0 && bid > 0) {
        // If ask is significantly higher than bid (>30% markup), use max(bid, production)
        if (ask / bid > 1.3) {
            return Math.max(bid, productionCost);
        }
        // Otherwise use ask (normal market)
        return ask;
    }

    // If only ask exists
    if (ask > 0) {
        // If ask is inflated compared to production, use production
        if (productionCost > 0 && ask / productionCost > 1.3) {
            return productionCost;
        }
        // Otherwise use max of ask and production
        return Math.max(ask, productionCost);
    }

    // If only bid exists, use max(bid, production)
    if (bid > 0) {
        return Math.max(bid, productionCost);
    }

    // No market data - use production cost as fallback
    return productionCost;
}

/**
 * Calculate production cost from crafting recipe
 * Matches original MWI Tools v25.0 getBaseItemProductionCost logic
 * @param {string} itemHrid - The item
 * @param {'ask'|'bid'} [mode='ask'] - Pricing side to use for input materials
 * @returns {number} Coins per unit produced
 */
export function getProductionCost(itemHrid, mode = 'ask') {
    const cacheKey = `${itemHrid}|${mode}`;
    const cached = _costCache.get(cacheKey);
    if (cached && cached.version === _priceVersion) return cached.value;
    const result = _computeProductionCost(itemHrid, mode);
    _costCache.set(cacheKey, { version: _priceVersion, value: result });
    return result;
}

function _computeProductionCost(itemHrid, mode = 'ask') {
    const gameData = dataManager.getInitClientData();
    const itemDetails = gameData.itemDetailMap[itemHrid];

    if (!itemDetails || !itemDetails.name) {
        return 0;
    }

    // Find the action whose primary output is this item
    const producer = findProducingAction(itemHrid, { primaryOnly: true, actionDetailMap: gameData.actionDetailMap });
    if (!producer) {
        return 0;
    }

    const { action } = producer;
    const outputCount = producer.output.count || 1;
    let totalPrice = 0;

    // Compute artisan tea reduction dynamically (same approach as material-calculator.js)
    let artisanBonus = 0;
    try {
        const equipment = dataManager.getEquipment();
        const itemDetailMap = gameData.itemDetailMap || {};
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
        const activeDrinks = dataManager.getActionDrinkSlots(action.type);
        artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
    } catch {
        // Fall back to no reduction if data unavailable
    }

    // Sum up input material costs (artisan tea reduces material quantities, not upgrade items)
    if (action.inputItems) {
        for (const input of action.inputItems) {
            if (input.itemHrid === '/items/coin') {
                totalPrice += input.count * (1 - artisanBonus);
                continue;
            }
            let inputPrice = getItemPrice(input.itemHrid, { mode }) || 0;
            if (inputPrice === 0) {
                inputPrice = getProductionCost(input.itemHrid, mode);
            }
            totalPrice += inputPrice * input.count * (1 - artisanBonus);
        }
    }

    // Add upgrade item cost if this is an upgrade recipe (not affected by artisan tea)
    // Use min(market, craft) so refined items reflect the cheapest way to obtain the base item
    if (action.upgradeItemHrid) {
        const upgradeMarketPrice = getItemPrice(action.upgradeItemHrid, { mode }) || 0;
        const upgradeCraftPrice = getProductionCost(action.upgradeItemHrid, mode);
        let upgradePrice;
        if (upgradeMarketPrice > 0 && upgradeCraftPrice > 0) {
            upgradePrice = Math.min(upgradeMarketPrice, upgradeCraftPrice);
        } else {
            upgradePrice = upgradeMarketPrice || upgradeCraftPrice;
        }
        totalPrice += upgradePrice;
    }

    return totalPrice / outputCount;
}

/**
 * Get total crafting chain time for an item's upgrade path (recursive).
 * Sums base action times through the upgrade item chain, stopping when market is cheaper.
 * @param {string} itemHrid - Item HRID to get production chain time for
 * @returns {number} Total chain time in seconds (base times, no speed bonuses applied)
 */
export function getProductionChainTime(itemHrid) {
    const cached = _chainTimeCache.get(itemHrid);
    if (cached && cached.version === _priceVersion) return cached.value;
    const result = _computeProductionChainTime(itemHrid);
    _chainTimeCache.set(itemHrid, { version: _priceVersion, value: result });
    return result;
}

function _computeProductionChainTime(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return 0;

    const action = findProducingAction(itemHrid, {
        primaryOnly: true,
        actionDetailMap: gameData.actionDetailMap,
    })?.action;

    if (!action || !action.baseTimeCost) return 0;

    let totalTime = action.baseTimeCost / 1e9;

    if (action.upgradeItemHrid) {
        const marketPrice = getItemPrice(action.upgradeItemHrid, { mode: 'ask' }) || 0;
        const craftPrice = getProductionCost(action.upgradeItemHrid, 'ask');
        if (craftPrice > 0 && (marketPrice === 0 || craftPrice < marketPrice)) {
            totalTime += getProductionChainTime(action.upgradeItemHrid);
        }
    }

    return totalTime;
}

/**
 * Get cheapest protection item price
 *
 * Tests: item itself, mirror of protection, and specific protection items.
 *
 * `price` is null when none of the options could be priced — not 0. A zero read
 * as a price makes protection free, and the upgrade advisor duly ranked the
 * most-protected path first on an under-quote it had no basis for. Callers that
 * gate on `price > 0` are unaffected; the ones that want a number take
 * `?.price || 0` and get the same 0 they always did.
 *
 * @param {string} itemHrid - The item being enhanced
 * @param {Object} [options] - Options
 * @param {boolean} [options.includeSelf=true] - Whether a second copy of the item
 *   itself counts as protection. The savings card turns this off: it exists for
 *   untradable gear, where there is no second copy to buy at any price, and the
 *   vendor sell price the fallback would find is not an offer anyone will honour
 * @returns {{price: number|null, itemHrid: string|null}} The cheapest option
 */
export function getCheapestProtectionPrice(itemHrid, { includeSelf = true } = {}) {
    const gameData = dataManager.getInitClientData();
    const itemDetails = gameData.itemDetailMap[itemHrid];

    // Build list of protection options: [item itself, mirror, ...specific items]
    const protectionOptions = includeSelf ? [itemHrid, '/items/mirror_of_protection'] : ['/items/mirror_of_protection'];

    // Add specific protection items if they exist
    if (itemDetails?.protectionItemHrids && itemDetails.protectionItemHrids.length > 0) {
        protectionOptions.push(...itemDetails.protectionItemHrids);
    }

    // Find cheapest option
    let cheapestPrice = Infinity;
    let cheapestItemHrid = null;
    for (const protectionHrid of protectionOptions) {
        const price = getRealisticBaseItemPrice(protectionHrid);
        if (price > 0 && price < cheapestPrice) {
            cheapestPrice = price;
            cheapestItemHrid = protectionHrid;
        }
    }

    return {
        price: cheapestPrice === Infinity ? null : cheapestPrice,
        itemHrid: cheapestItemHrid,
    };
}
