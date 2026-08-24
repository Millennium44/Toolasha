/**
 * House Efficiency Utility
 * Calculates buffs granted by house rooms
 *
 * PART OF EFFICIENCY SYSTEM (Phase 2):
 * - Data source: WebSocket (characterHouseRoomMap) + game data (houseRoomDetailMap)
 * - A room's effect is whatever its own `actionBuffs` say it is, per buff type.
 *   Most skilling rooms grant /buff_types/efficiency at 1.5%/level; the Observatory
 *   grants /buff_types/action_speed to enhancing, which is a different number in a
 *   different formula and must not be added to the efficiency total.
 */

import dataManager from '../core/data-manager.js';

/** The buff a skilling room grants when it makes actions *repeat*. */
const EFFICIENCY_BUFF = '/buff_types/efficiency';

/** The buff a room grants when it makes actions *shorter* (Observatory → enhancing). */
const ACTION_SPEED_BUFF = '/buff_types/action_speed';

/**
 * Does this buff apply to this action type?
 *
 * The game tags the scope in two places and does not always fill both: the buff
 * carries its own `usableInActionTypeMap`, and the room carries one covering all
 * of its buffs. The buff's own tag wins when it exists, because a room with two
 * buffs of different scopes can only express that per buff.
 * @param {Object} buff - Entry from roomDetail.actionBuffs
 * @param {Object} roomDetail - Entry from houseRoomDetailMap
 * @param {string} actionTypeHrid - Action type being asked about
 * @returns {boolean}
 */
function buffCoversActionType(buff, roomDetail, actionTypeHrid) {
    if (buff?.usableInActionTypeMap) return Boolean(buff.usableInActionTypeMap[actionTypeHrid]);
    return Boolean(roomDetail?.usableInActionTypeMap?.[actionTypeHrid]);
}

/**
 * Sum one buff type across every owned house room, for one action type.
 *
 * The per-level scaling is the game's own: `flatBoost` is the level-1 value and
 * `flatBoostLevelBonus` is added once per level above it — the same arithmetic
 * the combat engine's `Buff` applies. For the ordinary skilling rooms both are
 * 0.015, which is where the familiar "1.5% per level" comes from; reading the
 * numbers rather than hardcoding them is what keeps a room that scales
 * differently (or grants a different buff entirely) honest.
 *
 * @param {string} actionTypeHrid - Action type HRID
 * @param {string} buffTypeHrid - Buff type HRID to sum
 * @param {Object|null} gameData - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Summed boost as a ratio (0.12 for 12%)
 */
function sumHouseBuff(actionTypeHrid, buffTypeHrid, gameData) {
    if (!actionTypeHrid) return 0;

    const rooms = dataManager.getHouseRooms();
    if (!rooms || rooms.size === 0) return 0;

    const roomDetailMap = (gameData ?? dataManager.getInitClientData())?.houseRoomDetailMap;
    if (!roomDetailMap) return 0;

    let total = 0;
    for (const [roomHrid, room] of rooms) {
        const level = room.level || 0;
        if (level <= 0) continue;

        const detail = roomDetailMap[room.houseRoomHrid || roomHrid];
        const actionBuffs = detail?.actionBuffs;
        if (!Array.isArray(actionBuffs)) continue;

        for (const buff of actionBuffs) {
            if (buff?.typeHrid !== buffTypeHrid) continue;
            if (!buffCoversActionType(buff, detail, actionTypeHrid)) continue;
            total += (buff.flatBoost || 0) + (level - 1) * (buff.flatBoostLevelBonus || 0);
        }
    }

    return total;
}

/**
 * Calculate house efficiency bonus for an action type.
 *
 * Only true efficiency buffs count. The room-level `usableInActionTypeMap` alone
 * used to be the whole test, which credited every buff a listed room has as
 * efficiency: the Observatory covers enhancing, so enhancing was handed a
 * fictitious +1.5%/level of efficiency for what is really an action-speed buff,
 * and combat rooms were credited the same way for queued combat actions.
 *
 * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/brewing")
 * @param {Object} [options]
 * @param {Object} [options.gameData] - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Efficiency bonus percentage (e.g., 12 for 12%)
 *
 * @example
 * calculateHouseEfficiency("/action_types/brewing")
 * // Returns: 12 (if brewery is level 8: 8 × 1.5% = 12%)
 */
export function calculateHouseEfficiency(actionTypeHrid, { gameData = null } = {}) {
    return sumHouseBuff(actionTypeHrid, EFFICIENCY_BUFF, gameData) * 100;
}

/**
 * Calculate the house action-speed bonus for an action type.
 *
 * Separate from efficiency on purpose: speed shortens each action
 * (`time / (1 + bonus)`), efficiency grants free repeats. The Observatory is the
 * room this exists for — it speeds up enhancing.
 *
 * @param {string} actionTypeHrid - Action type HRID (e.g., "/action_types/enhancing")
 * @param {Object} [options]
 * @param {Object} [options.gameData] - Pre-fetched init client data, to avoid re-fetching
 * @returns {number} Speed bonus as a ratio (0.12 for 12%), matching the other speed sources
 */
export function calculateHouseActionSpeed(actionTypeHrid, { gameData = null } = {}) {
    return sumHouseBuff(actionTypeHrid, ACTION_SPEED_BUFF, gameData);
}

/**
 * Get friendly name for house room
 * @param {string} houseRoomHrid - House room HRID
 * @returns {string} Friendly name
 */
export function getHouseRoomName(houseRoomHrid) {
    const names = {
        '/house_rooms/brewery': 'Brewery',
        '/house_rooms/forge': 'Forge',
        '/house_rooms/kitchen': 'Kitchen',
        '/house_rooms/workshop': 'Workshop',
        '/house_rooms/garden': 'Garden',
        '/house_rooms/dairy_barn': 'Dairy Barn',
        '/house_rooms/sewing_parlor': 'Sewing Parlor',
        '/house_rooms/log_shed': 'Log Shed',
        '/house_rooms/laboratory': 'Laboratory',
    };

    return names[houseRoomHrid] || 'Unknown';
}

/**
 * Calculate total Rare Find bonus from all house rooms
 * @returns {number} Total rare find bonus as percentage (e.g., 1.6 for 1.6%)
 *
 * @example
 * calculateHouseRareFind()
 * // Returns: 1.6 (if total house room levels = 8: 8 × 0.2% per level = 1.6%)
 *
 * Formula from game data:
 * - flatBoostLevelBonus: 0.2% per level
 * - Total: totalLevels × 0.2%
 * - Max: 8 rooms × 8 levels = 64 × 0.2% = 12.8%
 */
export function calculateHouseRareFind() {
    // Get all house rooms
    const houseRooms = dataManager.getHouseRooms();

    if (!houseRooms || houseRooms.size === 0) {
        return 0; // No house rooms
    }

    // Sum all house room levels
    let totalLevels = 0;
    for (const [_hrid, room] of houseRooms) {
        totalLevels += room.level || 0;
    }

    // Formula: totalLevels × flatBoostLevelBonus
    // flatBoostLevelBonus: 0.2% per level (no base bonus)
    const flatBoostLevelBonus = 0.2;

    return totalLevels * flatBoostLevelBonus;
}

export default {
    calculateHouseEfficiency,
    calculateHouseActionSpeed,
    getHouseRoomName,
    calculateHouseRareFind,
};
