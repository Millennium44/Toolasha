/**
 * Which buffs a simulated player walks in wearing.
 *
 * Some buffs are the same for everyone in the fight — community buffs, MooPass —
 * and arrive as one shared array. Others belong to the individual: their guild's
 * combat buffs, the buffs their own completed achievements grant, the Labyrinth
 * scrolls they chose to carry. Those have to be read off each player's own DTO,
 * or a party sim hands player 1's guild, achievements and scrolls to all five.
 */

import { SCROLL_BUFF_VALUES, COMBAT_SCROLL_BUFF_TYPES } from '../../../utils/scroll-buff-values.js';

const COMBAT_SCROLL_SET = new Set(COMBAT_SCROLL_BUFF_TYPES);

/**
 * Turn a player's chosen scroll buff types into buff objects the engine consumes.
 *
 * Scrolls carry no `consumableDetail` in the game JSON, so the magnitudes come
 * from `SCROLL_BUFF_VALUES`, applied as a flat boost in the same permanent-buff
 * shape the labyrinth token upgrades use. Only combat-effective scroll types
 * (wisdom → combat experience, rare find → rare-drop multiplier) are emitted;
 * a skilling-only type slipping through is ignored rather than added as a no-op.
 * @param {string[]} scrollTypeHrids - Buff-type hrids the player has active
 * @returns {Array<Object>} Buff objects in the shape the server sends
 */
export function buildScrollBuffs(scrollTypeHrids) {
    const list = Array.isArray(scrollTypeHrids) ? scrollTypeHrids : [];
    const buffs = [];
    for (const typeHrid of list) {
        if (!COMBAT_SCROLL_SET.has(typeHrid)) continue;
        const flatBoost = SCROLL_BUFF_VALUES[typeHrid];
        if (!flatBoost) continue;
        buffs.push({
            uniqueHrid: `/buff_uniques/toolasha_scroll_${typeHrid.split('/').pop()}`,
            typeHrid,
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        });
    }
    return buffs;
}

/**
 * Combine the shared buffs with the ones that belong to a single player.
 * @param {Array} sharedBuffs - Buffs every player in the sim gets
 * @param {Object} playerDTO - The player's DTO, carrying their own buff arrays
 * @returns {Array} The buff list for this player
 */
export function buildPlayerExtraBuffs(sharedBuffs, playerDTO) {
    const shared = Array.isArray(sharedBuffs) ? sharedBuffs : [];
    const guildBuffs = Array.isArray(playerDTO?.guildCombatBuffs) ? playerDTO.guildCombatBuffs : [];
    const achievementBuffs = Array.isArray(playerDTO?.achievementCombatBuffs) ? playerDTO.achievementCombatBuffs : [];
    const scrollBuffs = buildScrollBuffs(playerDTO?.scrollBuffs);

    return [...shared, ...guildBuffs, ...achievementBuffs, ...scrollBuffs];
}
