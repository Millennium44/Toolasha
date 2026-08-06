/**
 * Dungeon entry-key forecast
 *
 * The entry key is a consumable in everything but the equipment slot: a dungeon
 * run eats one per clear, and the run stops the moment there are none left —
 * exactly the failure the Consumables panel exists to warn about. This module
 * turns "the character is running a dungeon" into an entry the panel's
 * forecast arithmetic (`consumable-forecast.js`) can treat like any coffee.
 *
 * ## Where each figure comes from
 *
 * - **Which key**: the dungeon's own action detail, when the game data names one
 *   (`combatZoneInfo.dungeonInfo.keyItemHrid`), falling back to the script's own
 *   dungeon → key table in `key-ledger.js`. The fallback is load-bearing: the
 *   rest of this repository has never needed to read the field from game data,
 *   so the table is the mapping everything else already trusts.
 * - **How many are held**: the character's inventory, counted directly — keys
 *   are not in `combatConsumables`, so the collector's tracked counts cannot
 *   supply this one.
 * - **How fast they go**: the same session measurement the panel's cost figures
 *   already use. `calculateKeyCosts` counts one entry key per regular chest the
 *   run dropped, and dividing that by the session's duration is a measured clear
 *   rate. No chests yet means no rate — reported as none rather than guessed.
 */

import { entryKeyFor } from './key-ledger.js';

/** Where a key has to be sitting for it to be spendable on a run */
const INVENTORY = '/item_locations/inventory';

/**
 * The entry key a dungeon action consumes, or null when this is not a dungeon.
 *
 * Reads the game's own field first and falls back to the script's table, so a
 * future dungeon whose key is named in the data works without a code change,
 * and the four current dungeons keep working if the field never existed.
 *
 * @param {string} actionHrid - The current combat action
 * @param {Object|null} actionDetail - Its entry in `actionDetailMap`
 * @returns {string|null} Key item hrid, or null for non-dungeons and unknowns
 */
export function dungeonEntryKey(actionHrid, actionDetail) {
    if (!actionHrid || actionDetail?.combatZoneInfo?.isDungeon !== true) return null;

    const fromData = actionDetail.combatZoneInfo.dungeonInfo?.keyItemHrid;
    if (typeof fromData === 'string' && fromData.startsWith('/items/')) return fromData;

    return entryKeyFor(actionHrid);
}

/**
 * How many of an item the character is actually holding.
 *
 * Only the inventory counts: a key listed on the market or sitting in a chest
 * cannot be spent on the next run, and counting it would overstate how long the
 * runs can continue.
 *
 * @param {Array<Object>|null} items - Rows from `dataManager.getInventory()`
 * @param {string} itemHrid - The item to count
 * @returns {number} Total held, zero when the inventory is unavailable
 */
export function heldInInventory(items, itemHrid) {
    if (!Array.isArray(items) || !itemHrid) return 0;

    let held = 0;
    for (const item of items) {
        if (item?.itemHrid !== itemHrid) continue;
        if (item.itemLocationHrid && item.itemLocationHrid !== INVENTORY) continue;

        const count = Number(item.count);
        if (Number.isFinite(count) && count > 0) held += count;
    }
    return held;
}

/**
 * An entry key shaped like a `consumableBreakdown` row, ready for `forecast()`.
 *
 * The rate comes from the session's key breakdown — one entry key per regular
 * chest, over the session's duration — which is the same measurement the combat
 * stats already price keys with. A session that has dropped no chests yet has
 * no rate, and the entry says so with a rate of zero: the panel renders that as
 * "—" for the rates while still showing what is held, which is honest about
 * what has and has not been measured.
 *
 * @param {Object} input - What is known about the key
 * @param {string} input.itemHrid - The key
 * @param {string} [input.itemName] - Display name, falling back to the breakdown's
 * @param {number} input.held - How many are in the inventory
 * @param {Array<Object>} [input.keyBreakdown] - `keyBreakdown` from `calculatePlayerStats`
 * @param {number} [input.durationSeconds] - The session the breakdown covers
 * @param {number|null} [input.fallbackPrice] - Price when the breakdown has none
 * @returns {Object} A breakdown-shaped entry for `forecast()`
 */
export function keyConsumableEntry({ itemHrid, itemName, held, keyBreakdown, durationSeconds, fallbackPrice = null }) {
    const row = (keyBreakdown || []).find((entry) => entry?.itemHrid === itemHrid) || null;

    const count = Number(row?.count) || 0;
    const duration = Number(durationSeconds) || 0;
    const rate = count > 0 && duration > 0 ? count / duration : 0;

    // The breakdown's price is the cheaper of buying and crafting the key,
    // which is what the panel's cost columns should agree with; the market ask
    // only stands in when no run has priced the key yet
    const rowPrice = Number(row?.pricePerItem);
    const standIn = Number(fallbackPrice);
    const price = rowPrice > 0 ? rowPrice : standIn > 0 ? standIn : null;

    return {
        itemHrid,
        itemName: itemName || row?.itemName || itemHrid,
        inventoryAmount: Number(held) || 0,
        consumptionRate: rate,
        consumedPerDay: rate > 0 ? Math.ceil(rate * 86400) : 0,
        pricePerItem: price,
    };
}
