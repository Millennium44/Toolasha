/**
 * Task Shop valuation: what a Task Token is worth, and what a Task Shop item costs in coins.
 *
 * Lives in utils so the enhancement input rule can price a Task Crystal (untradable, bought with
 * Task Tokens) without importing the task profit calculator and everything it pulls in.
 * `features/tasks/task-profit-calculator.js` re-exports {@link findBestTaskShopValue}.
 */

import dataManager from '../core/data-manager.js';
import { expectedValueCalculator } from './bundle-bridge.js';
import { calculatePriceAfterTax } from './profit-helpers.js';
import { getItemPrice } from './market-data.js';

export const TASK_TOKEN_HRID = '/items/task_token';

/**
 * Value one Task Shop line is worth per task token.
 * Openable items (the caches/crates/chests) are worth their expected contents;
 * anything else tradable is worth its market price.
 * @param {string} itemHrid - Shop item
 * @param {Object} itemDetailMap - Game item details
 * @returns {{value: number, partialDrops: number}} Coins the item is worth (0 when unpriceable),
 *   and how many of its drops could not be priced — non-zero makes the value a lower bound
 */
function valueOfShopItem(itemHrid, itemDetailMap) {
    // Post-tax: this is what the shop item would fetch if sold, and every other sell-side
    // figure in the plugin is net of the marketplace cut. Quoting a token pre-tax while the
    // action profit it is compared against is post-tax overstated every task by the tax rate.
    const listed = getItemPrice(itemHrid, { context: 'profit', side: 'sell' });
    let value = listed > 0 ? calculatePriceAfterTax(listed) : 0;

    let partialDrops = 0;

    if (itemDetailMap?.[itemHrid]?.isOpenable) {
        const evData = expectedValueCalculator()?.calculateExpectedValue(itemHrid);
        const expectedValue = evData?.expectedValue || 0;
        if (expectedValue > value) {
            value = expectedValue;
            // The chest's own total left out drops nothing could price, so a token valued
            // through it is a floor. Carried up so the panel can say so rather than
            // presenting an incomplete figure as the answer.
            partialDrops = evData?.missingCount || 0;
        }
    }

    return { value, partialDrops };
}

/**
 * A shop line's costs, whichever shape the game used for it.
 * @param {Object} line - Shop line
 * @returns {Array<Object>} Cost entries
 */
function shopCosts(line) {
    if (Array.isArray(line?.costs)) return line.costs;
    if (line?.cost) return [line.cost];
    return [];
}

/**
 * Find the best coins-per-token line in the Task Shop.
 *
 * Reads taskShopItemDetailMap, so a new shop line, a changed token price or a
 * line that buys several of something is priced correctly — none of which a
 * hardcoded list of three chests at 30 tokens each could ever notice.
 *
 * @returns {{perToken: number, itemHrid: string, tokenCost: number, itemValue: number,
 *   partialDrops: number}|null}
 */
export function findBestTaskShopValue() {
    const gameData = dataManager.getInitClientData();
    const shopMap = gameData?.taskShopItemDetailMap;
    if (!shopMap) {
        return null;
    }

    const itemDetailMap = gameData.itemDetailMap || {};
    let best = null;

    for (const line of Object.values(shopMap)) {
        const itemHrid = line?.itemHrid;
        if (!itemHrid) continue;

        // Only lines actually bought with task tokens say anything about what a
        // task token is worth
        const costs = shopCosts(line);
        if (costs.length !== 1 || costs[0]?.itemHrid !== TASK_TOKEN_HRID) continue;

        const tokenCost = costs[0].count || 0;
        if (tokenCost <= 0) continue;

        const { value: unitValue, partialDrops } = valueOfShopItem(itemHrid, itemDetailMap);
        if (unitValue <= 0) continue;

        // One purchase can hand over several of something, and the shop says so
        const itemValue = unitValue * (line.outputCount || 1);
        const perToken = itemValue / tokenCost;
        if (!best || perToken > best.perToken) {
            best = { perToken, itemHrid, tokenCost, itemValue, partialDrops };
        }
    }

    return best;
}

/**
 * What a Task Shop item costs in coins, valuing the Task Tokens it is bought with at the best
 * coins-per-token the same shop offers ({@link findBestTaskShopValue}).
 *
 * This is a token valuation, an estimate of what the tokens would have fetched, not a price
 * anyone quotes. It answers null (never 0) when the shop does not sell the item for Task Tokens
 * alone, when the shop data or the expected-value calculator is not ready (an openable line would
 * then be valued at its bare market price and the token undervalued), or when no shop line prices
 * a token at all. `partial` marks a token value that is itself a floor (the best line's contents
 * could not all be priced).
 *
 * @param {string} itemHrid - The item
 * @returns {{price: number, partial: boolean, tokenCost: number}|null} Coins per unit bought
 */
export function taskShopTokenPrice(itemHrid) {
    if (!itemHrid || !expectedValueCalculator()?.isInitialized) return null;
    const shopMap = dataManager.getInitClientData()?.taskShopItemDetailMap;
    if (!shopMap) return null;

    const line = Object.values(shopMap).find((entry) => entry?.itemHrid === itemHrid && isTokenLine(entry));
    if (!line) return null;

    const tokenCost = shopCosts(line)[0].count;
    const best = findBestTaskShopValue();
    if (!(best?.perToken > 0)) return null;

    return {
        price: (tokenCost * best.perToken) / (line.outputCount || 1),
        partial: best.partialDrops > 0,
        tokenCost,
    };
}

/**
 * Whether a shop line is paid for with Task Tokens alone.
 * @param {Object} line - Shop line
 * @returns {boolean}
 */
function isTokenLine(line) {
    const costs = shopCosts(line);
    return costs.length === 1 && costs[0]?.itemHrid === TASK_TOKEN_HRID && costs[0].count > 0;
}
