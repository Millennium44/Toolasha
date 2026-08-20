// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Which buffs a simulated player walks in wearing.
 *
 * Some buffs are the same for everyone in the fight — community buffs, MooPass —
 * and arrive as one shared array. Others belong to the individual: their guild's
 * combat buffs, the buffs their own completed achievements grant, the Labyrinth
 * scrolls they chose to carry. Those have to be read off each player's own DTO,
 * or a party sim hands player 1's guild, achievements and scrolls to all five.
 */

import { combatScrollBuff } from '../../../utils/combat-scroll-buffs.js';

/**
 * Turn a player's chosen combat scrolls into buff objects the engine consumes.
 *
 * Each scroll's magnitude and whether it is a ratio or flat boost come from the
 * combat-scroll table (values read off the game's own item tooltips), emitted in
 * the same permanent-buff shape the labyrinth token upgrades use. A buff type
 * that is not a combat scroll is skipped rather than added as a no-op.
 * @param {string[]} scrollTypeHrids - Buff-type hrids the player has active
 * @returns {Array<Object>} Buff objects in the shape the server sends
 */
export function buildScrollBuffs(scrollTypeHrids) {
    const list = Array.isArray(scrollTypeHrids) ? scrollTypeHrids : [];
    const buffs = [];
    for (const typeHrid of list) {
        const buff = combatScrollBuff(typeHrid);
        if (buff) buffs.push(buff);
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
    // Achievement combat buffs are auto-detected and applied by default; the
    // Configure section lets a player exclude one for a what-if by listing its
    // buff type in achievementBuffsOff.
    const off = new Set(Array.isArray(playerDTO?.achievementBuffsOff) ? playerDTO.achievementBuffsOff : []);
    const achievementBuffs = (
        Array.isArray(playerDTO?.achievementCombatBuffs) ? playerDTO.achievementCombatBuffs : []
    ).filter((buff) => !off.has(buff?.typeHrid));
    const scrollBuffs = buildScrollBuffs(playerDTO?.scrollBuffs);

    return [...shared, ...guildBuffs, ...achievementBuffs, ...scrollBuffs];
}
