/**
 * Self-enhanced gear: the ladder.
 *
 * Capes, quivers and the other back pieces carry no `isTradable` in
 * `itemDetailMap`. Nobody can sell you one at any level, the +0 base included,
 * so an upgrade row for one is never "buy it at the market": it is "enhance a
 * copy you hold up to the target level".
 *
 * Which copy is the maintainer's rule. You wear the best one. Once that copy is
 * +5 or more it is too valuable to risk, so you ladder the next copy up behind
 * it and swap when that one arrives. Below +5 you enhance the best copy itself.
 * Holding no copy at all starts a fresh one from +0.
 *
 * The game's enhancing picker only offers inventory stacks
 * (`isItemEnhanceable` rejects any other item location, checked against the
 * client bundle on 2026-10-07). So the copy the price is laddered from may be
 * the worn one, but the Enhance button can only preselect an inventory stack.
 * {@link enhanceHandoffCopy} makes that choice.
 */

import dataManager from '../../core/data-manager.js';
import { buildItemHash } from '../../utils/item-hash.js';

/** The copy at or above this level is the one in use, and the ladder runs on the next */
export const LADDER_SPARE_FROM_LEVEL = 5;

const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * Whether an item can only be had by enhancing a copy yourself.
 *
 * Keyed on tradability, not on the back slot. An ABSENT `isTradable` is the
 * untradable case (as in `enhancement-params-source.js`). An item the data does
 * not know at all reads as tradable, so it keeps the ordinary market path.
 *
 * @param {string} itemHrid - Item HRID
 * @param {Object} [itemDetailMap] - Game item map, the live one when omitted
 * @returns {boolean} True for capes, quivers and the like
 */
export function isSelfEnhancedItem(itemHrid, itemDetailMap = null) {
    if (typeof itemHrid !== 'string' || !itemHrid) return false;
    const map = itemDetailMap || dataManager.getInitClientData?.()?.itemDetailMap;
    const details = map?.[itemHrid];
    if (!details) return false;
    return details.isTradable !== true;
}

/**
 * Every copy of an item the character holds, best first.
 *
 * A stack counts as up to two copies, because the ladder only ever looks at the
 * top two. On a tie the worn copy sorts first, so it is the "in use" one and an
 * inventory copy at the same level is the spare.
 *
 * @param {string} itemHrid - Item HRID
 * @param {Array<Object>|null} items - `characterItems`, inventory and equipped together
 * @returns {Array<{level: number, equipped: boolean, location: string, hash: string|null}>} Copies
 */
export function heldCopies(itemHrid, items) {
    if (!Array.isArray(items)) return [];
    const copies = [];
    for (const item of items) {
        if (!item || item.itemHrid !== itemHrid) continue;
        // Equipped rows do not reliably carry a `count` (see
        // `highestOwnedEnhancements`): an absent one is a single worn copy, and
        // only an explicit zero (a consumed stack) is skipped
        const count = item.count == null ? 1 : Math.floor(Number(item.count) || 0);
        if (count <= 0) continue;
        const location = item.itemLocationHrid || INVENTORY_LOCATION;
        const copy = {
            level: Math.max(0, Math.floor(Number(item.enhancementLevel) || 0)),
            equipped: location !== INVENTORY_LOCATION,
            location,
            hash: typeof item.hash === 'string' && item.hash ? item.hash : null,
        };
        copies.push(copy);
        if (count > 1) copies.push({ ...copy });
    }
    copies.sort((a, b) => b.level - a.level || Number(b.equipped) - Number(a.equipped));
    return copies;
}

/**
 * The copy the ladder enhances: the second-best when the best is +5 or more,
 * otherwise the best. Null when that leaves no copy, which means a fresh one.
 *
 * @param {Array<Object>} copies - From {@link heldCopies}
 * @returns {Object|null} The chosen copy
 */
export function chooseLadderCopy(copies) {
    if (!Array.isArray(copies) || copies.length === 0) return null;
    const [best, second] = copies;
    if (best.level >= LADDER_SPARE_FROM_LEVEL) return second || null;
    return best;
}

/**
 * What enhancing an item to a target level starts from.
 *
 * A chosen copy already at or above the target costs nothing more. The row asks
 * for the item at the target level, and that spare already meets it, so the
 * honest price is zero. Picking a lower copy instead would charge for a level
 * you already hold.
 *
 * @param {number} targetLevel - Level the row asks for
 * @param {Array<Object>} copies - From {@link heldCopies}
 * @returns {{fromLevel: number, copy: Object|null, fresh: boolean, alreadyHeld: boolean,
 *   toLevel: number}} The plan. `fresh` means no copy is held and a base has to be found
 */
export function planSelfEnhance(targetLevel, copies) {
    const toLevel = Math.max(0, Math.floor(Number(targetLevel) || 0));
    const copy = chooseLadderCopy(copies);
    if (!copy) return { fromLevel: 0, copy: null, fresh: true, alreadyHeld: false, toLevel };
    return { fromLevel: copy.level, copy, fresh: false, alreadyHeld: copy.level >= toLevel, toLevel };
}

/**
 * The inventory stack the Enhance button should preselect.
 *
 * The ladder's own copy when it sits in the inventory. When that copy is the
 * worn one, the game cannot preselect it, so the best inventory copy below the
 * target stands in, and `substitute` says so. Null when no inventory copy
 * qualifies, which the caller reads as "open Enhancing with nothing selected".
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} targetLevel - Level the row asks for
 * @param {Array<Object>|null} items - Live `characterItems`
 * @param {string|number|null} [characterId] - For building a hash a stack does not carry
 * @returns {{hash: string, level: number, substitute: boolean, plan: Object}|null} The stack
 */
export function enhanceHandoffCopy(itemHrid, targetLevel, items, characterId = null) {
    const copies = heldCopies(itemHrid, items);
    const plan = planSelfEnhance(targetLevel, copies);
    const hashOf = (copy) =>
        copy.hash ||
        buildItemHash(characterId ?? dataManager.getCurrentCharacterId?.(), copy.location, itemHrid, copy.level);

    if (plan.copy && !plan.copy.equipped) {
        const hash = hashOf(plan.copy);
        return hash ? { hash, level: plan.copy.level, substitute: false, plan } : null;
    }

    const stand = copies.find((copy) => !copy.equipped && copy.level < plan.toLevel);
    if (!stand) return null;
    const hash = hashOf(stand);
    return hash ? { hash, level: stand.level, substitute: true, plan } : null;
}

/**
 * Copies of an item held, for pricing.
 *
 * The live character's inventory and equipment when the row is theirs and the
 * inventory is known. Otherwise only what the candidate itself says is worn:
 * an enhancement row names the piece and level it starts from.
 *
 * @param {string} itemHrid - Item HRID
 * @param {Object} [options]
 * @param {boolean} [options.isSelf=true] - Whether the row belongs to the live character
 * @param {Object} [options.candidate] - The candidate being priced
 * @returns {Array<Object>} Copies, best first
 */
export function copiesForPricing(itemHrid, { isSelf = true, candidate = null } = {}) {
    const items = isSelf ? dataManager.getInventory?.() : null;
    if (Array.isArray(items)) return heldCopies(itemHrid, items);
    if (candidate?.type === 'enhancement' && candidate.currentHrid === itemHrid) {
        const level = Math.max(0, Math.floor(Number(candidate.currentLevel) || 0));
        return [{ level, equipped: true, location: 'worn', hash: null }];
    }
    return [];
}
