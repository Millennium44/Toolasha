/**
 * What the Shop's Dungeon tab sells for each dungeon token, and what each item
 * fetches on the market.
 *
 * One reading shared by the token tooltip's "Token Shop Value" table and the
 * spend planner, so the two cannot disagree about a cost or a price. Costs come
 * from `shopItemDetailMap` (the entry's first cost is the token); the value is
 * the item's current ask, the same figure the tooltip has always shown. Tax is
 * not applied here — the tooltip prints the gross ask, and the planner nets it.
 */

import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';

/** The four dungeon tokens, in the order the dungeons unlock */
export const DUNGEON_TOKEN_HRIDS = [
    '/items/chimerical_token',
    '/items/sinister_token',
    '/items/enchanted_token',
    '/items/pirate_token',
];

/**
 * Every Dungeon-shop item bought with one token.
 *
 * @param {string} tokenHrid - A dungeon token
 * @returns {Array<{itemHrid: string, name: string, cost: number, askPrice: number|null, goldPerToken: number}>}
 *   In shop order. `askPrice` is null for an item with no ask (untradeable or an
 *   empty book), and its `goldPerToken` is 0.
 */
export function dungeonShopOffers(tokenHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.shopItemDetailMap || !gameData?.itemDetailMap) return [];

    return Object.values(gameData.shopItemDetailMap)
        .filter((shopItem) => shopItem?.costs?.[0]?.itemHrid === tokenHrid && shopItem.costs[0].count > 0)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
        .map((shopItem) => {
            const cost = shopItem.costs[0].count;
            const ask = getItemPrices(shopItem.itemHrid, 0)?.ask;
            const askPrice = ask > 0 ? ask : null;
            return {
                itemHrid: shopItem.itemHrid,
                name: gameData.itemDetailMap[shopItem.itemHrid]?.name || 'Unknown Item',
                cost,
                askPrice,
                goldPerToken: askPrice ? askPrice / cost : 0,
            };
        });
}

/**
 * How many of a token the character holds, unenhanced and in the inventory.
 * @param {string} tokenHrid - A dungeon token
 * @returns {number}
 */
export function ownedTokenCount(tokenHrid) {
    const inventory = dataManager.getInventory?.() || [];
    let count = 0;
    for (const item of inventory) {
        if (item?.itemHrid !== tokenHrid) continue;
        if (item.itemLocationHrid && item.itemLocationHrid !== '/item_locations/inventory') continue;
        if (item.enhancementLevel) continue;
        count += Number(item.count) || 0;
    }
    return count;
}

export default { DUNGEON_TOKEN_HRIDS, dungeonShopOffers, ownedTokenCount };
