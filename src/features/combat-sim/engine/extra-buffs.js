/**
 * Which buffs a simulated player walks in wearing.
 *
 * Some buffs are the same for everyone in the fight — community buffs, MooPass —
 * and arrive as one shared array. Others belong to the individual: their guild's
 * combat buffs, the buffs their own completed achievements grant. Those have to
 * be read off each player's own DTO, or a party sim hands player 1's guild and
 * achievements to all five.
 */

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

    return [...shared, ...guildBuffs, ...achievementBuffs];
}
