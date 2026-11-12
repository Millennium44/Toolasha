/**
 * Dungeon key rows, for everyone in the party
 *
 * The Consumables panel and the overlay's Consumables tile both have to answer
 * "when does this run stop?", and the entry key is part of that answer for every
 * member: a run needs one key per clear, so a member holding 38 keys at 115
 * clears a day stops in eight hours whatever their food says. The two surfaces
 * live in different bundles, so the arithmetic lives here — in a module both
 * reach through `Toolasha.Utils` — and neither can drift from the other.
 *
 * ## Where each figure comes from
 *
 * - **Your keys**: your inventory, exact.
 * - **A member's keys**: whatever the party's key-count message last stated for
 *   them (the dungeon tracker parses it). A member the message did not name gets
 *   no key row at all — an absent number is not a zero, and a row that invented
 *   one would put a countdown on someone the script knows nothing about.
 * - **The rate**: yours. Every member spends one key per clear, so the party's
 *   clear rate is one number, measured from the chests your session dropped.
 * - **The price**: the key pricing setting. On the craft basis a key is priced
 *   at what the recipe costs and the row's buy route is the recipe's materials;
 *   on a market basis it is priced off the book and bought.
 *
 * ## The chest key
 *
 * A chest key opens a chest; running out stops nothing. It is therefore NOT in
 * the list of forecasts — every function that asks "what stops this run" reads
 * that list, and a flag would have to be honored by each of them. It is a
 * separate field that only the cost sums and the row drawing read.
 *
 * The collector and the stats calculator are deliberately not imported: a
 * second inlined copy of the collector would hold no data. The caller passes
 * `statsOf`.
 */

import dataManager from '../core/data-manager.js';
import { getItemPrices } from './market-data.js';
import { forecast } from './consumable-forecast.js';
import { dungeonEntryKey, heldInInventory, keyConsumableEntry } from './dungeon-key-forecast.js';
import { DUNGEON_CHEST_CHEST_KEYS, DUNGEON_CHEST_ENTRY_KEYS } from './dungeon-keys.js';
import { describeKeyCost, resolveKeyPricing } from './key-cost.js';
import { dungeonTracker } from './bundle-bridge.js';

/** How long a key costing is reused; see `describeKeyCostCached` */
const KEY_COST_TTL_MS = 60_000;

/** `keyHrid` to `{pricing, at, cost}` */
const keyCostCache = new Map();

/**
 * What one key costs to buy and to craft, cached for a minute.
 *
 * `describeKeyCost` reads the recipe's action stats against this character's own
 * efficiency and artisan bonus, which is more than a panel that redraws every
 * five seconds (or a tile that rebuilds every four) should redo each time — and
 * the answer moves only when the market does. The pricing identity and the
 * character are part of the cache identity: a key priced at ask is not the same
 * costing as the same key at craft cost, and a craft cost is this character's
 * own.
 *
 * @param {string|null} keyHrid - A dungeon key
 * @returns {Object|null} From `describeKeyCost`, or null when it cannot run
 */
export function describeKeyCostCached(keyHrid) {
    if (!keyHrid) return null;
    const resolved = resolveKeyPricing();
    const pricing = `${resolved.setting}|${resolved.priceSide}|${resolved.basis}|${dataManager.getCurrentCharacterId?.() ?? '?'}`;
    const hit = keyCostCache.get(keyHrid);
    if (hit && hit.pricing === pricing && Date.now() - hit.at < KEY_COST_TTL_MS) return hit.cost;

    let cost = null;
    try {
        cost = describeKeyCost(keyHrid);
    } catch (error) {
        console.error('[DungeonPartyKeys] Pricing the key failed:', error);
    }
    keyCostCache.set(keyHrid, { pricing, at: Date.now(), cost });
    return cost;
}

/** Forget every cached costing, for a setting change or a character switch. */
export function dropKeyCostCache() {
    keyCostCache.clear();
}

/**
 * The party's entry keys, as the game itself stated them.
 *
 * Every run the game posts a key-count message to party chat naming each member
 * and the keys they have left, and the dungeon tracker parses it. Read through
 * the bridge because the tracker is a websocket-fed singleton in the combat
 * bundle. Guarded on the dungeon: a tracked run of a different dungeon would
 * hand over counts of the wrong key.
 *
 * @param {string} actionHrid - The dungeon
 * @returns {Object} Name to key count; empty when no message has arrived
 */
export function partyKeyCounts(actionHrid) {
    try {
        const run = dungeonTracker()?.getCurrentRun?.();
        if (!run || run.dungeonHrid !== actionHrid) return {};
        return run.keyCountsMap || {};
    } catch (error) {
        console.error('[DungeonPartyKeys] Reading the party key counts failed:', error);
        return {};
    }
}

/**
 * A breakdown with the current character's held counts read from the live inventory.
 *
 * The collector's counts come from battle snapshots, which the game sends when a fight
 * starts and when something is consumed - a purchase updates neither, so a restock mid-run
 * read as unchanged until the next fight began. The inventory message lands the moment the
 * purchase does, and it is visible only for this character, so party members keep the
 * snapshot figure (theirs is the only count their battles state). Shared by the panel and
 * the tile so a purchase shows on both at once.
 *
 * @param {Array<Object>} breakdown - Entries as the exact-rate pass left them
 * @param {Object} player - The collector's player entry
 * @param {Array<Object>|null} inventory - Rows from `dataManager.getInventory()`
 * @returns {Array<Object>} The same entries, own counts read live
 */
export function withLiveCounts(breakdown, player, inventory) {
    if (!player?.isCurrentPlayer) return breakdown;
    if (!Array.isArray(inventory) || !inventory.length) return breakdown;

    return (breakdown || []).map((entry) => {
        if (!entry?.itemHrid) return entry;
        return { ...entry, inventoryAmount: heldInInventory(inventory, entry.itemHrid) };
    });
}

/**
 * The stated key count for a member, or null when there is none.
 * A stated zero is a real answer; an absent, blank or negative one is not.
 *
 * @param {Object} counts - Name to count
 * @param {string} name - The member
 * @returns {number|null}
 */
export function statedKeys(counts, name) {
    if (!name || !counts || !Object.prototype.hasOwnProperty.call(counts, name)) return null;
    const raw = counts[name];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * The chest key that opens a dungeon's chests, from its entry key.
 * @param {string|null} entryKeyHrid - The dungeon's entry key
 * @returns {string|null}
 */
export function chestKeyForEntryKey(entryKeyHrid) {
    if (!entryKeyHrid) return null;
    const chest = Object.keys(DUNGEON_CHEST_ENTRY_KEYS).find((hrid) => DUNGEON_CHEST_ENTRY_KEYS[hrid] === entryKeyHrid);
    return chest ? DUNGEON_CHEST_CHEST_KEYS[chest] || null : null;
}

/**
 * How a key is priced and how a shortfall of it is acquired.
 *
 * The route is craft only when the setting says craft AND the costing actually
 * used the recipe: with no recipe, or a material nobody sells, the costing falls
 * back to the market and the route follows it, with the reason kept for the
 * tooltip. One costing result decides the price, both cost sides and the route,
 * so they cannot disagree.
 *
 * @param {Object|null} cost - From `describeKeyCost`
 * @param {boolean} craftBasis - Whether the key pricing setting is the craft basis
 * @param {Object|null} market - The key's market prices
 * @returns {{route: 'craft'|'buy', prices: Object, unitCost: number|null, craftActionHrid: string|null,
 *   note: string}}
 */
export function keyRoute(cost, craftBasis, market) {
    const unit = Number(cost?.unitCost);
    if (craftBasis && cost?.cheaper === 'craft' && cost.craftActionHrid && unit > 0) {
        return {
            route: 'craft',
            prices: { ask: unit, bid: unit },
            unitCost: unit,
            craftActionHrid: cost.craftActionHrid,
            note: '',
        };
    }

    let note = '';
    if (craftBasis) {
        if (!cost) note = 'the key could not be costed';
        else if (!cost.craftActionHrid) note = 'it has no recipe';
        else if (!(cost.craftCost > 0)) note = 'a material of its recipe has no price';
        else note = 'the market price was used';
        note = `Key pricing is set to craft cost, but ${note}, so it is priced and bought at the market.`;
    }
    return { route: 'buy', prices: market || {}, unitCost: null, craftActionHrid: null, note };
}

/**
 * A forecast row for a key, with what the panel needs to draw and act on it.
 *
 * @param {Object} entry - A breakdown-shaped entry
 * @param {Object} routeInfo - From {@link keyRoute}
 * @param {Object} extra - Fields to carry on the row
 * @returns {Object}
 */
function keyRow(entry, routeInfo, extra) {
    const priced = routeInfo.route === 'craft' ? { ...entry, pricePerItem: routeInfo.unitCost } : entry;
    return {
        ...forecast(priced, routeInfo.prices),
        isKey: true,
        route: routeInfo.route,
        craftActionHrid: routeInfo.craftActionHrid,
        routeNote: routeInfo.note,
        ...extra,
    };
}

/**
 * The key rows for every player in a snapshot. Pure: everything it reads is an argument.
 *
 * - Your row reads your inventory. A member's row reads the stated count and is
 *   made only when one was stated; a member sharing your name is never given a
 *   row (they would be you counted twice).
 * - The branch is on `isCurrentPlayer` before any name is looked up, so nobody
 *   can take your inventory by sharing your name.
 * - The chest key is yours alone: nothing states a member's chest keys.
 *
 * @param {Object} input - The situation
 * @param {Object} input.data - The collector's snapshot
 * @param {Function} input.statsOf - `(player) => stats` with `keyBreakdown`
 * @param {Array<Object>} [input.inventory] - Rows from `dataManager.getInventory()`
 * @param {Object} [input.keyCounts] - Name to the count the key-count message stated
 * @param {string} input.keyHrid - The dungeon's entry key
 * @param {string|null} [input.chestKeyHrid] - Its chest key
 * @param {Function} [input.itemName] - `(hrid) => display name`
 * @param {Function} [input.pricesFor] - `(hrid) => {ask, bid}`
 * @param {Object|null} [input.keyCost] - `describeKeyCost` for the entry key
 * @param {Object|null} [input.chestKeyCost] - `describeKeyCost` for the chest key
 * @param {boolean} [input.craftBasis] - Whether the key pricing setting is craft cost
 * @returns {Map<Object, {entry: Object|null, chest: Object|null}>} Keyed by the snapshot's player objects
 */
export function buildKeyRows({
    data,
    statsOf,
    inventory = [],
    keyCounts = {},
    keyHrid,
    chestKeyHrid = null,
    itemName = () => '',
    pricesFor = () => ({}),
    keyCost = null,
    chestKeyCost = null,
    craftBasis = false,
}) {
    const rows = new Map();
    const players = data?.players || [];
    if (!keyHrid || !players.length) return rows;

    const duration = data.durationSeconds || 0;
    const self = players.find((player) => player?.isCurrentPlayer) || null;
    const selfStats = self ? statsOf(self) : null;

    // The clear rate is one number for the party, and it is yours
    const base = keyConsumableEntry({
        itemHrid: keyHrid,
        itemName: itemName(keyHrid),
        held: 0,
        keyBreakdown: selfStats?.keyBreakdown,
        lootMap: self?.loot,
        durationSeconds: duration,
        fallbackPrice: pricesFor(keyHrid)?.ask,
    });
    const entryRoute = keyRoute(keyCost, craftBasis, pricesFor(keyHrid));

    for (const player of players) {
        if (!player) continue;

        if (player.isCurrentPlayer) {
            const entry = keyRow({ ...base, inventoryAmount: heldInInventory(inventory, keyHrid) }, entryRoute, {
                statedCount: false,
            });

            let chest = null;
            if (chestKeyHrid) {
                const chestBase = keyConsumableEntry({
                    itemHrid: chestKeyHrid,
                    itemName: itemName(chestKeyHrid),
                    held: heldInInventory(inventory, chestKeyHrid),
                    keyBreakdown: selfStats?.keyBreakdown,
                    lootMap: player.loot,
                    durationSeconds: duration,
                    fallbackPrice: pricesFor(chestKeyHrid)?.ask,
                    lootKeyTable: DUNGEON_CHEST_CHEST_KEYS,
                });
                chest = keyRow(chestBase, keyRoute(chestKeyCost, craftBasis, pricesFor(chestKeyHrid)), {
                    statedCount: false,
                    isChestKey: true,
                });
            }
            rows.set(player, { entry, chest });
            continue;
        }

        // Never the same person twice
        if (!player.name || (self?.name && player.name === self.name)) continue;
        const stated = statedKeys(keyCounts, player.name);
        if (stated === null) continue;

        rows.set(player, {
            entry: keyRow({ ...base, inventoryAmount: stated }, entryRoute, { statedCount: true }),
            chest: null,
        });
    }
    return rows;
}

/**
 * The key rows for the current snapshot, reading the live game.
 *
 * Both the panel and the tile call this, so neither assembles its own.
 *
 * @param {Object} data - The collector's snapshot
 * @param {Function} statsOf - `(player) => stats`
 * @returns {{keyHrid: string|null, chestKeyHrid: string|null,
 *   rows: Map<Object, {entry: Object|null, chest: Object|null}>}}
 */
export function keyRowsForData(data, statsOf) {
    const empty = { keyHrid: null, chestKeyHrid: null, rows: new Map() };
    try {
        const actionHrid = data?.actionHrid;
        if (!actionHrid) return empty;

        const keyHrid = dungeonEntryKey(actionHrid, dataManager.getActionDetails?.(actionHrid));
        if (!keyHrid) return empty;

        const chestKeyHrid = chestKeyForEntryKey(keyHrid);
        const craftBasis = resolveKeyPricing().basis === 'craft';
        return {
            keyHrid,
            chestKeyHrid,
            rows: buildKeyRows({
                data,
                statsOf,
                inventory: dataManager.getInventory?.(),
                keyCounts: partyKeyCounts(actionHrid),
                keyHrid,
                chestKeyHrid,
                itemName: (hrid) => dataManager.getItemDetails?.(hrid)?.name,
                pricesFor: (hrid) => getItemPrices(hrid),
                // Only the craft basis needs the recipe walked
                keyCost: craftBasis ? describeKeyCostCached(keyHrid) : null,
                chestKeyCost: craftBasis && chestKeyHrid ? describeKeyCostCached(chestKeyHrid) : null,
                craftBasis,
            }),
        };
    } catch (error) {
        console.error('[DungeonPartyKeys] Building the key rows failed:', error);
        return empty;
    }
}

export default {
    describeKeyCostCached,
    dropKeyCostCache,
    partyKeyCounts,
    statedKeys,
    withLiveCounts,
    chestKeyForEntryKey,
    keyRoute,
    buildKeyRows,
    keyRowsForData,
};
