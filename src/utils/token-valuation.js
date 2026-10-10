/**
 * Token Valuation Utility
 * Shared logic for calculating dungeon token values
 * (Task token valuation lives in features/tasks/task-profit-calculator.js)
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { getItemPrice, getItemPriceInfo, getItemPrices } from './market-data.js';
import { isPatientTickOn, patientTickPrice } from './patient-tick.js';

/** Essence a dungeon token falls back to when its shop prices nothing. */
const TOKEN_ESSENCE_MAP = {
    '/items/chimerical_token': '/items/chimerical_essence',
    '/items/sinister_token': '/items/sinister_essence',
    '/items/enchanted_token': '/items/enchanted_essence',
    '/items/pirate_token': '/items/pirate_essence',
};

/** The four dungeon currency tokens; each can be valued through its own token shop. */
export const DUNGEON_TOKEN_HRIDS = new Set(Object.keys(TOKEN_ESSENCE_MAP));

/**
 * Which side of the book a token valuation quotes, from the user's settings.
 * @param {string} pricingModeSetting - Config key for the profit pricing mode
 * @param {string} respectModeSetting - Config key for whether that mode is respected
 * @returns {'ask'|'bid'}
 */
function tokenPricingSide(pricingModeSetting, respectModeSetting) {
    // `false` in place of a setting key pins the bid outright, for a caller that promises an instant sale
    if (respectModeSetting === false) return 'bid';
    const pricingMode = config.getSettingValue(pricingModeSetting, 'hybrid');
    const respectPricingMode = config.getSettingValue(respectModeSetting, true);
    if (!respectPricingMode) return 'bid';
    // Conservative/Patient Buy sell into the bid; Hybrid/Optimistic wait for the ask
    return pricingMode === 'conservative' || pricingMode === 'patientBuy' ? 'bid' : 'ask';
}

/**
 * Calculate dungeon token value based on best shop item value.
 *
 * A token is worth the most valuable thing its own shop converts it into —
 * the same rule {@link labyrinthTokenValue} runs on, and the same one the task
 * shop uses. Three details that a naive read of the shop map gets wrong and
 * this does not: a line's token cost may sit anywhere in `costs`, not only at
 * `costs[0]`; a line can hand over several of something (`outputCount`); and a
 * line paid for with a token *and* something else says nothing clean about
 * what a token alone is worth, so it is skipped rather than credited free.
 *
 * Prices go through `getItemPrice`, so a user's custom price overrides count
 * here exactly as they do everywhere else.
 *
 * @param {string} tokenHrid - Token HRID (e.g., '/items/chimerical_token')
 * @param {string} pricingModeSetting - Config setting key for pricing mode (default: 'profitCalc_pricingMode')
 * @param {string|false} respectModeSetting - Config setting key for respect pricing mode flag (default:
 *   'expectedValue_respectPricingMode'), or `false` for an instant sale: order-book bids only, whatever
 *   the settings say
 * @returns {number|null} Value per token, or null if no data
 */
export function calculateDungeonTokenValue(
    tokenHrid,
    pricingModeSetting = 'profitCalc_pricingMode',
    respectModeSetting = 'expectedValue_respectPricingMode'
) {
    return calculateDungeonTokenValueDetail(tokenHrid, pricingModeSetting, respectModeSetting)?.value ?? null;
}

/**
 * {@link calculateDungeonTokenValue}, but also naming what the token is best
 * converted into — the shop line, or the essence when no line is priced — for
 * anywhere the figure has to be explained rather than only used.
 *
 * @param {string} tokenHrid - Token HRID (e.g., '/items/chimerical_token')
 * @param {string} pricingModeSetting - Config setting key for pricing mode
 * @param {string} respectModeSetting - Config setting key for respect pricing mode flag
 * @returns {{value: number, itemHrid: string, via: 'shop'|'essence'}|null} Coins per token and
 *   the item they come from, or null if no data
 */
export function calculateDungeonTokenValueDetail(
    tokenHrid,
    pricingModeSetting = 'profitCalc_pricingMode',
    respectModeSetting = 'expectedValue_respectPricingMode'
) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return null;

    const priceOf = tokenPriceOf(pricingModeSetting, respectModeSetting);

    // Only single-currency lines price a token cleanly
    const tokenShop = Object.values(gameData.shopItemDetailMap || {}).filter((line) => {
        const costs = shopCosts(line);
        return costs.length === 1 && costs[0]?.itemHrid === tokenHrid;
    });

    const best = tokenValueDetailIn(tokenShop, priceOf, tokenHrid);
    if (best) return { ...best, via: 'shop' };

    // Nothing in the shop is priced: fall back to the token's essence
    const essenceHrid = TOKEN_ESSENCE_MAP[tokenHrid];
    const essencePrice = priceOf(essenceHrid);
    return essencePrice > 0 ? { value: essencePrice, itemHrid: essenceHrid, via: 'essence' } : null;
}

/**
 * The best coins a labyrinth token converts into at the labyrinth shop, priced
 * the way {@link calculateDungeonTokenValue} prices a dungeon token: the same
 * side of the book from the same settings, custom prices and the patient tick
 * included. Under the default Hybrid mode that is the ask — the figure the
 * labyrinth token's own tooltip shows as its best Gold/Token.
 *
 * @param {string} pricingModeSetting - Config setting key for pricing mode
 * @param {string} respectModeSetting - Config setting key for respect pricing mode flag
 * @returns {{value: number, itemHrid: string}|null} Coins per token and the shop item, or null
 */
export function calculateLabyrinthTokenValueDetail(
    pricingModeSetting = 'profitCalc_pricingMode',
    respectModeSetting = 'expectedValue_respectPricingMode'
) {
    const shopMap = dataManager.getInitClientData()?.labyrinthShopItemDetailMap;
    if (!shopMap) return null;
    return labyrinthTokenValueDetail(shopMap, tokenPriceOf(pricingModeSetting, respectModeSetting));
}

/**
 * The pricer a token valuation reads its shop lines through.
 * @param {string} pricingModeSetting - Config setting key for pricing mode
 * @param {string} respectModeSetting - Config setting key for respect pricing mode flag
 * @returns {Function} `(itemHrid) => number|null`
 */
function tokenPriceOf(pricingModeSetting, respectModeSetting) {
    // An instant-sale caller (`false`) gets order-book bids only: a custom price or value-map
    // estimate is no bid anyone can sell into
    if (respectModeSetting === false) {
        // The raw book, so a custom override neither counts nor hides a real bid
        return (hrid) => {
            if (!hrid) return null;
            const prices = getItemPrices(hrid);
            return prices && !prices.source && !prices.bidEstimated && prices.bid > 0 ? prices.bid : null;
        };
    }
    const mode = tokenPricingSide(pricingModeSetting, respectModeSetting);
    // Following the global mode, a sale at the ask is a patient one and takes the
    // +1 tick like every other profit price. Respect switched off pins the bid,
    // an exact side, and a custom price or value estimate has no queue to jump.
    const tickable = mode === 'ask' && pricingModeSetting === 'profitCalc_pricingMode' && isPatientTickOn('sell');
    return (hrid) => {
        if (!hrid) return null;
        if (!tickable) return getItemPrice(hrid, { mode });
        const { price, source } = getItemPriceInfo(hrid, { mode });
        if (source !== 'book') return price;
        const book = getItemPrices(hrid);
        return patientTickPrice(price, 'sell', 'ask', {
            ask: book?.ask,
            bid: book?.bid,
            bidEstimated: Boolean(book?.bidEstimated),
            itemHrid: hrid,
        });
    };
}

/**
 * A shop line's costs, whichever shape the shop keeps them in.
 *
 * The dungeon and task shops carry a `costs` array; the labyrinth shop carries a
 * single `cost`. Same idea, two spellings.
 *
 * @param {Object} line - A shop line
 * @returns {Array<{itemHrid: string, count: number}>}
 */
function shopCosts(line) {
    if (Array.isArray(line?.costs)) return line.costs;
    if (line?.cost) return [line.cost];
    return [];
}

/**
 * The best coins one token buys, within the shop that takes it.
 *
 * A token is worth the most valuable thing its own shop converts to. Only lines
 * the market prices count — a line nobody can sell says nothing about what a
 * token is worth.
 *
 * @param {Object} shopMap - One of the game's shop maps
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @param {string} tokenHrid - The currency
 * @returns {number} Coins per token, or 0
 */
function tokenValueIn(shopMap, priceOf, tokenHrid) {
    return tokenValueDetailIn(shopMap, priceOf, tokenHrid)?.value || 0;
}

/**
 * {@link tokenValueIn}, with the shop item the best value comes from.
 * @param {Object} shopMap - One of the game's shop maps
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @param {string} tokenHrid - The currency
 * @returns {{value: number, itemHrid: string}|null} Best coins per token, or null
 */
function tokenValueDetailIn(shopMap, priceOf, tokenHrid) {
    let best = null;

    for (const line of Object.values(shopMap || {})) {
        const cost = shopCosts(line).find((entry) => entry?.itemHrid === tokenHrid);
        if (!(cost?.count > 0)) continue;

        const price = priceOf(line.itemHrid);
        if (!(price > 0)) continue;

        const perToken = (price * (line.outputCount || 1)) / cost.count;
        if (!best || perToken > best.value) best = { value: perToken, itemHrid: line.itemHrid };
    }
    return best;
}

/**
 * What a shop charges for something, in coins.
 *
 * Some equipment is never listed on the market at all — capes drop, and are
 * otherwise bought from a shop for tokens. A market-only reading says such a
 * piece cannot be had at any price, which is the opposite of true. The shop
 * knows the price; it is just quoted in a currency that needs converting, and a
 * token converts at whatever the best line in its own shop is worth.
 *
 * @param {string} itemHrid - The item
 * @param {Array<Object>} shopMaps - The game's shop maps, in preference order
 * @param {Function} priceOf - `(itemHrid) => number|null`, a market ask
 * @returns {number|null} Coins, or null when no shop sells it for anything priceable
 */
export function shopPurchasePrice(itemHrid, shopMaps, priceOf) {
    for (const shopMap of shopMaps || []) {
        const line = Object.values(shopMap || {}).find((entry) => entry?.itemHrid === itemHrid);
        const costs = shopCosts(line);
        if (!costs.length) continue;

        let total = 0;
        let priced = true;

        for (const cost of costs) {
            const each =
                cost?.itemHrid === '/items/coin'
                    ? 1
                    : priceOf(cost?.itemHrid) || tokenValueIn(shopMap, priceOf, cost?.itemHrid);
            // One unpriceable currency makes the whole line unpriceable rather
            // than cheap, the same rule the rest of this file runs on
            if (!(each > 0) || !(cost?.count > 0)) {
                priced = false;
                break;
            }
            total += each * cost.count;
        }

        if (priced && total > 0) return total / (line.outputCount || 1);
    }
    return null;
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
    return labyrinthTokenValueDetail(shopMap, priceOf)?.value || 0;
}

/**
 * {@link labyrinthTokenValue}, but also saying which shop line produced the
 * best conversion — needed anywhere the value has to be explained ("via
 * Labyrinth Refinement Shard"), not just used.
 *
 * @param {Object} shopMap - The game's `labyrinthShopItemDetailMap`
 * @param {Function} priceOf - `(itemHrid) => number|null`
 * @returns {{value: number, itemHrid: string}|null} The best per-token value
 *   and the item it comes from, or null when nothing in the shop is priced
 */
export function labyrinthTokenValueDetail(shopMap, priceOf) {
    let best = null;

    for (const line of Object.values(shopMap || {})) {
        const cost = line?.cost?.count || 0;
        if (!(cost > 0)) continue;

        const price = priceOf(line.itemHrid);
        if (!(price > 0)) continue;

        // One token can buy several of something, and the shop says so
        const perToken = (price * (line.outputCount || 1)) / cost;
        if (!best || perToken > best.value) best = { value: perToken, itemHrid: line.itemHrid };
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
