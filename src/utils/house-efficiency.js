/**
 * House Efficiency Utility
 * Calculates efficiency bonuses from house rooms
 *
 * PART OF EFFICIENCY SYSTEM (Phase 2):
 * - House rooms provide +1.5% efficiency per level to matching actions
 * - Formula: houseLevel × 1.5%
 * - Data source: WebSocket (characterHouseRoomMap)
 */

import dataManager from '../core/data-manager.js';

/** A house room level is worth this much efficiency, in percentage points. */
const EFFICIENCY_PER_ROOM_LEVEL = 1.5;

/**
 * Calculate house efficiency bonus for an action type.
 *
 * Which room helps which skill is the game's own `usableInActionTypeMap`, not a
 * table kept here. A hand-written action-type → room map was the second of two
 * implementations of this — the other looped `houseRoomDetailMap` — and the two
 * could disagree the moment the game added a room or let one room cover a second
 * skill. This is the single implementation; the loop was the correct one, so this
 * is it.
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
    if (!actionTypeHrid) return 0;

    const rooms = dataManager.getHouseRooms();
    if (!rooms || rooms.size === 0) return 0;

    const roomDetailMap = (gameData ?? dataManager.getInitClientData())?.houseRoomDetailMap;
    if (!roomDetailMap) return 0;

    let efficiency = 0;
    for (const [roomHrid, room] of rooms) {
        const detail = roomDetailMap[room.houseRoomHrid || roomHrid];
        if (detail?.usableInActionTypeMap?.[actionTypeHrid]) {
            efficiency += (room.level || 0) * EFFICIENCY_PER_ROOM_LEVEL;
        }
    }

    return efficiency;
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
    getHouseRoomName,
    calculateHouseRareFind,
};
