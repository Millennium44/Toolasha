/**
 * Which gathering action to name for an item several actions drop.
 *
 * "The first action that drops it, in the action map's order" is arbitrary, and the order is not
 * the player's: a level-100 action that drops a lower tier's item as a 1-per-roll side product
 * (the Eternal Holy Cow drops Holy Milk, the Ancient Arcane Tree drops Arcane Log) sorts ahead of the action
 * everybody actually runs for it. The rule used instead: the action that yields the most of the item per
 * second of base action time, then the one with the lower level requirement.
 */

/**
 * Items of one kind an action's regular drop table yields per second of base action time.
 * @param {Object} action - An `actionDetailMap` entry
 * @param {string} itemHrid - The item
 * @returns {number} 0 when the action's regular table does not drop it
 */
export function gatheringItemsPerSecond(action, itemHrid) {
    let perAction = 0;
    for (const drop of action?.dropTable || []) {
        if (drop?.itemHrid !== itemHrid) continue;
        const min = Number.isFinite(drop.minCount) ? drop.minCount : 1;
        const max = Number.isFinite(drop.maxCount) ? drop.maxCount : min;
        perAction += (drop.dropRate ?? 1) * ((min + max) / 2);
    }
    const seconds = (Number(action?.baseTimeCost) || 0) / 1e9;
    return seconds > 0 ? perAction / seconds : perAction;
}

/**
 * Whether a candidate action is a better source of an item than the one held.
 * @param {Object|null} held - The action held so far (null: nothing yet)
 * @param {Object} candidate - The action being weighed
 * @param {string} itemHrid - The item
 * @returns {boolean} True to replace; a tie keeps the one held, so map order still settles true ties
 */
export function isBetterGatheringSource(held, candidate, itemHrid) {
    if (!held) return true;
    const heldRate = gatheringItemsPerSecond(held, itemHrid);
    const candidateRate = gatheringItemsPerSecond(candidate, itemHrid);
    if (candidateRate !== heldRate) return candidateRate > heldRate;
    const heldLevel = held.levelRequirement?.level ?? 0;
    const candidateLevel = candidate.levelRequirement?.level ?? 0;
    return candidateLevel < heldLevel;
}
