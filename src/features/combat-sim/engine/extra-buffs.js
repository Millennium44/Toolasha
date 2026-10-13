// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Which buffs a simulated player walks in wearing.
 *
 * Some buffs are the same for everyone in the fight — the community buffs — and
 * arrive as one shared array. Others belong to the individual: their guild's
 * combat buffs, the buffs their own completed achievements grant, the Labyrinth
 * scrolls they chose to carry, their own Moo Pass. Those have to be read off each
 * player's own DTO, or a party sim hands player 1's guild, achievements, scrolls
 * and Moo Pass to all five.
 */

import { combatScrollBuff } from '../../../utils/combat-scroll-buffs.js';

/** Moo Pass's combat wisdom, in the permanent-buff shape the server sends. */
const MOO_PASS_WISDOM_BUFF = {
    uniqueHrid: '/buff_uniques/experience_moo_pass_buff',
    typeHrid: '/buff_types/wisdom',
    ratioBoost: 0,
    ratioBoostLevelBonus: 0,
    flatBoost: 0.05,
    flatBoostLevelBonus: 0,
    startTime: '0001-01-01T00:00:00Z',
    duration: 0,
};

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
    // Only a DTO that says so: the current character's, from its own Moo Pass.
    // A party member's is unknown and gets none.
    const mooPassBuffs = playerDTO?.mooPass === true ? [MOO_PASS_WISDOM_BUFF] : [];

    return [...shared, ...guildBuffs, ...achievementBuffs, ...scrollBuffs, ...mooPassBuffs];
}
