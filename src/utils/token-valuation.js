/**
 * Token Valuation Utility
 * Shared logic for calculating dungeon token values
 * (Task token valuation lives in features/tasks/task-profit-calculator.js)
 */

import config from '../core/config.js';
import marketAPI from '../api/marketplace.js';
import dataManager from '../core/data-manager.js';

/**
 * Calculate dungeon token value based on best shop item value
 * Uses "best market value per token" approach: finds the shop item with highest (market price / token cost)
 * @param {string} tokenHrid - Token HRID (e.g., '/items/chimerical_token')
 * @param {string} pricingModeSetting - Config setting key for pricing mode (default: 'profitCalc_pricingMode')
 * @param {string} respectModeSetting - Config setting key for respect pricing mode flag (default: 'expectedValue_respectPricingMode')
 * @returns {number|null} Value per token, or null if no data
 */
export function calculateDungeonTokenValue(
    tokenHrid,
    pricingModeSetting = 'profitCalc_pricingMode',
    respectModeSetting = 'expectedValue_respectPricingMode'
) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return null;

    // Get all shop items for this token type
    const shopItems = Object.values(gameData.shopItemDetailMap || {}).filter(
        (item) => item.costs && item.costs[0]?.itemHrid === tokenHrid
    );

    if (shopItems.length === 0) return null;

    let bestValuePerToken = 0;

    // For each shop item, calculate market price / token cost
    for (const shopItem of shopItems) {
        const itemHrid = shopItem.itemHrid;
        const tokenCost = shopItem.costs[0].count;

        // Get market price for this item
        const prices = marketAPI.getPrice(itemHrid, 0);
        if (!prices) continue;

        // Use pricing mode to determine which price to use
        const pricingMode = config.getSettingValue(pricingModeSetting, 'conservative');
        const respectPricingMode = config.getSettingValue(respectModeSetting, true);

        let marketPrice = 0;
        if (respectPricingMode) {
            // Conservative/Patient Buy: Bid, Hybrid/Optimistic: Ask
            marketPrice = pricingMode === 'conservative' || pricingMode === 'patientBuy' ? prices.bid : prices.ask;
        } else {
            // Always conservative
            marketPrice = prices.bid;
        }

        if (marketPrice <= 0) continue;

        // Calculate value per token
        const valuePerToken = marketPrice / tokenCost;

        // Keep track of best value
        if (valuePerToken > bestValuePerToken) {
            bestValuePerToken = valuePerToken;
        }
    }

    // Fallback to essence price if no shop items found
    if (bestValuePerToken === 0) {
        const essenceMap = {
            '/items/chimerical_token': '/items/chimerical_essence',
            '/items/sinister_token': '/items/sinister_essence',
            '/items/enchanted_token': '/items/enchanted_essence',
            '/items/pirate_token': '/items/pirate_essence',
        };

        const essenceHrid = essenceMap[tokenHrid];
        if (essenceHrid) {
            const essencePrice = marketAPI.getPrice(essenceHrid, 0);
            if (essencePrice) {
                const pricingMode = config.getSettingValue(pricingModeSetting, 'conservative');
                const respectPricingMode = config.getSettingValue(respectModeSetting, true);

                let marketPrice = 0;
                if (respectPricingMode) {
                    marketPrice =
                        pricingMode === 'conservative' || pricingMode === 'patientBuy'
                            ? essencePrice.bid
                            : essencePrice.ask;
                } else {
                    marketPrice = essencePrice.bid;
                }

                return marketPrice > 0 ? marketPrice : null;
            }
        }
    }

    return bestValuePerToken > 0 ? bestValuePerToken : null;
}

/**
 * The best coins a labyrinth token can be turned into.
 *
 * Labyrinth rewards are bought with tokens, and a token is worth whatever the
 * most valuable thing in its shop converts to. Only tradable shop lines count —
 * a shop line nobody can sell prices a token at nothing, which would then price
 * every reward at nothing.
 *
 * @param {Object} shopMap - The game's `labyrinthShopItemDetailMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {number} Coins per token, or 0 when nothing in the shop is priced
 */
export function labyrinthTokenValue(shopMap, priceOf) {
    let best = 0;

    for (const line of Object.values(shopMap || {})) {
        const cost = line?.cost?.count || 0;
        if (!(cost > 0)) continue;

        const price = priceOf(line.itemHrid);
        if (!(price > 0)) continue;

        // One token can buy several of something, and the shop says so
        const perToken = (price * (line.outputCount || 1)) / cost;
        if (perToken > best) best = perToken;
    }
    return best;
}

/**
 * What a labyrinth reward is worth, through the tokens it costs.
 *
 * Scrolls and seals never appear on the market — they are bought from the
 * labyrinth shop and used — so a market-only reading prices them at nothing and
 * leaves them out of a chest's contents entirely. They cost tokens, and tokens
 * have a value, so they have one.
 *
 * @param {string} itemHrid - The reward
 * @param {Object} shopMap - The game's `labyrinthShopItemDetailMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {number|null} Coins, or null when it is not a labyrinth reward
 */
export function labyrinthRewardValue(itemHrid, shopMap, priceOf) {
    const line = Object.values(shopMap || {}).find((entry) => entry?.itemHrid === itemHrid);
    const cost = line?.cost?.count || 0;
    if (!(cost > 0)) return null;

    const perToken = labyrinthTokenValue(shopMap, priceOf);
    if (!(perToken > 0)) return null;

    return (perToken * cost) / (line.outputCount || 1);
}
