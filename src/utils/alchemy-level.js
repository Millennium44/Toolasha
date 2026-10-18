/**
 * The level an alchemy action's level efficiency is measured from.
 */

/**
 * The level an alchemy action's level efficiency is measured from: the alchemized item's
 * level, not the action's own requirement (1 for every alchemy action). The action bar, the
 * queued-action tooltip, the alchemy profit calculator and the queue summaries all measure it
 * this way; a path that did not would credit an alchemist the whole of their level as efficiency.
 * @param {Object} actionDetails - Action details
 * @param {Object|null} actionObj - The queued action, carrying primaryItemHash
 * @param {Object|null} [itemDetailMap] - Item details by hrid
 * @param {Function|null} [getItemDetails] - Fallback lookup by hrid when the map lacks the item
 * @returns {number|undefined} The item level, or undefined for anything else
 */
export function alchemyLevelRequirement(actionDetails, actionObj, itemDetailMap = null, getItemDetails = null) {
    if (actionDetails?.type !== '/action_types/alchemy' || !actionObj?.primaryItemHash) return undefined;
    // "<id>::/item_locations/inventory::/items/<name>::<enhancement>" - the item is the /items/ part
    const itemHrid = String(actionObj.primaryItemHash)
        .split('::')
        .find((part) => part.startsWith('/items/'));
    if (!itemHrid) return undefined;
    const itemLevel = (itemDetailMap?.[itemHrid] ?? getItemDetails?.(itemHrid))?.itemLevel;
    return itemLevel || undefined;
}
