/**
 * Game Data Lookup Utilities
 *
 * Centralized functions for resolving display names to HRIDs.
 * Handles the ★ ↔ (R) refined item display name difference between
 * test server and live server.
 */

import dataManager from '../core/data-manager.js';
import { isTesterShopEntry, testerShopEnabled } from './tester-shop.js';

/**
 * Generate alternate display names to handle ★ ↔ (R) refined item naming.
 * @param {string} name - Original display name
 * @returns {string[]} Array of alternate names to try (may be empty)
 */
function getRefinedNameVariants(name) {
    const variants = [];
    if (name.includes('★')) {
        variants.push(name.replace(/\s*★/, ' (R)'));
    }
    if (name.includes('(R)')) {
        variants.push(name.replace(/\s*\(R\)/, ' ★'));
    }
    return variants;
}

/**
 * Name → hrid memo for one detail map, keyed on the map's identity.
 *
 * These lookups run on per-panel and per-tooltip paths — a couple of dozen call
 * sites — and each used to walk the whole detail map (twice more on a miss, once
 * per refined-name variant). The map is built once per detail map and rebuilt
 * only when a different map object is handed out (a character switch that
 * replaces init_client_data); a re-read of the same object is a Map.get.
 *
 * Resolution order is unchanged: the first hrid in map order whose display name
 * equals the query, then the first whose name equals a ★ ↔ (R) variant of it.
 */
class NameIndex {
    constructor() {
        this.sourceMap = null;
        /** @type {Map<string, string>|null} display name → first hrid with that name */
        this.byName = null;
    }

    /**
     * Resolve a display name against a detail map.
     * @param {Object|undefined} detailMap - hrid → { name } (action or item details)
     * @param {string} name - Display name to resolve
     * @returns {string|null} The hrid, or null
     */
    lookup(detailMap, name) {
        if (!detailMap) return null;
        if (detailMap !== this.sourceMap) {
            this.byName = buildNameMap(detailMap);
            this.sourceMap = detailMap;
        }
        const exact = this.byName.get(name);
        if (exact !== undefined) return exact;
        for (const variant of getRefinedNameVariants(name)) {
            const hit = this.byName.get(variant);
            if (hit !== undefined) return hit;
        }
        return null;
    }
}

/**
 * Build display name → first hrid for a detail map.
 * @param {Object} detailMap - hrid → { name }
 * @returns {Map<string, string>}
 */
function buildNameMap(detailMap) {
    const byName = new Map();
    for (const hrid in detailMap) {
        const name = detailMap[hrid]?.name;
        if (name === undefined || byName.has(name)) continue;
        byName.set(name, hrid);
    }
    return byName;
}

const actionNames = new NameIndex();
const itemNames = new NameIndex();

/**
 * Find an action HRID from its display name.
 * Tries exact match first, then ★ ↔ (R) variants for refined items.
 * @param {string} actionName - Display name of the action
 * @returns {string|null} Action HRID or null if not found
 */
export function getActionHridFromName(actionName) {
    return actionNames.lookup(dataManager.getInitClientData()?.actionDetailMap, actionName);
}

/**
 * Find an item HRID from its display name.
 * Tries exact match first, then ★ ↔ (R) variants for refined items.
 * @param {string} itemName - Display name of the item
 * @returns {string|null} Item HRID or null if not found
 */
export function getItemHridFromName(itemName) {
    return itemNames.lookup(dataManager.getInitClientData()?.itemDetailMap, itemName);
}

/**
 * Get the coin cost of an item from the in-game shop.
 * Returns 0 if the item is not available in the shop or not purchasable with coins.
 * @param {string} itemHrid - Item HRID
 * @returns {number} Coin cost, or 0 if not available in shop
 */
export function getShopCoinCost(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.shopItemDetailMap) return 0;

    // The test server's Tester tab is a price source only when asked for —
    // see tester-shop.js — so its entries are skipped otherwise
    const testerOn = testerShopEnabled();
    for (const [key, shopItem] of Object.entries(gameData.shopItemDetailMap)) {
        if (!testerOn && isTesterShopEntry(shopItem, key)) continue;
        if (shopItem.itemHrid === itemHrid) {
            if (shopItem.costs && shopItem.costs.length > 0) {
                const coinCost = shopItem.costs.find((cost) => cost.itemHrid === '/items/coin');
                if (coinCost) {
                    return coinCost.count;
                }
            }
        }
    }

    return 0;
}
