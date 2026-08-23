/**
 * Community buff bonuses, read from the game rather than remembered.
 *
 * A community buff's strength is `flatBoost + (level - 1) × flatBoostLevelBonus`,
 * and which skills it touches is `usableInActionTypeMap`. Both live in
 * `communityBuffTypeDetailMap`, which the client ships and updates.
 *
 * Four places used to carry their own copy of that arithmetic — two of them with
 * the coefficients typed in (`0.14`/`0.003` for production efficiency, `0.2`/`0.005`
 * for gathering quantity) and a hand-written list of which skills counted. A
 * balance patch moves those numbers and a new skill joins the list without any
 * of the copies noticing; one of them was already applying production efficiency
 * to skills the game does not, because it never checked `usableInActionTypeMap`.
 * This is the one implementation they all call now.
 */

import dataManager from '../core/data-manager.js';

/** The game's definition of one community buff. */
function buffDefinition(buffTypeHrid) {
    return dataManager.getInitClientData?.()?.communityBuffTypeDetailMap?.[buffTypeHrid] || null;
}

/**
 * The bonus a community buff currently gives an action type.
 *
 * Returns 0 — not a guess — when the buff is inactive, when the game data is not
 * loaded, or when the buff does not apply to that action type at all.
 *
 * @param {string} buffTypeHrid - e.g. '/community_buff_types/production_efficiency'
 * @param {string} actionTypeHrid - e.g. '/action_types/cooking'
 * @param {Object} [options]
 * @param {boolean} [options.asPercent=false] - Return 14 rather than 0.14
 * @param {number|null} [options.level=null] - Override the live buff level (for simulation)
 * @returns {number} The bonus, as a fraction unless `asPercent`
 */
export function getCommunityBuffBonus(buffTypeHrid, actionTypeHrid, { asPercent = false, level = null } = {}) {
    const buffLevel = level ?? dataManager.getCommunityBuffLevel(buffTypeHrid);
    if (!(buffLevel > 0)) return 0;

    const definition = buffDefinition(buffTypeHrid);
    if (!definition?.buff) return 0;

    // A buff that does not list the skill does nothing for it
    if (actionTypeHrid && !definition.usableInActionTypeMap?.[actionTypeHrid]) return 0;

    const flatBoost = definition.buff.flatBoost || 0;
    const levelBonus = (buffLevel - 1) * (definition.buff.flatBoostLevelBonus || 0);
    const bonus = flatBoost + levelBonus;

    return asPercent ? bonus * 100 : bonus;
}

/**
 * Community Production Efficiency for an action type, as a percentage
 * (e.g. 14.3 for level 2), matching how the efficiency stack is expressed.
 * @param {string} actionTypeHrid - Action type HRID
 * @param {Object} [options] - See {@link getCommunityBuffBonus}
 * @returns {number} Efficiency percentage points
 */
export function getCommunityProductionEfficiency(actionTypeHrid, options = {}) {
    return getCommunityBuffBonus('/community_buff_types/production_efficiency', actionTypeHrid, {
        ...options,
        asPercent: true,
    });
}

/**
 * Community Gathering Quantity for an action type, as a fraction
 * (e.g. 0.205 for level 2), matching how gathering bonuses are stacked.
 * @param {string} actionTypeHrid - Action type HRID
 * @param {Object} [options] - See {@link getCommunityBuffBonus}
 * @returns {number} Gathering quantity fraction
 */
export function getCommunityGatheringQuantity(actionTypeHrid, options = {}) {
    return getCommunityBuffBonus('/community_buff_types/gathering_quantity', actionTypeHrid, {
        ...options,
        asPercent: false,
    });
}

export default {
    getCommunityBuffBonus,
    getCommunityProductionEfficiency,
    getCommunityGatheringQuantity,
};
