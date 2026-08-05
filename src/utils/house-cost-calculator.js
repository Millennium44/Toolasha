/**
 * House Cost Calculator Utility
 *
 * What it costs to build a house room up to a level, materials priced at the
 * market.
 *
 * ## Which side of the book
 *
 * The buy side — the ask. Every question asked of this is some form of "what
 * would it cost me to do this now": the Houses panel's affordability count, the
 * upgrade advisor, the equipment savings goals, the combat score's estimate of
 * what a character's rooms represent. Buying the materials is what any of those
 * would involve, and the ask is what buying costs.
 *
 * It used to price at the ask/bid midpoint, which is a defensible number for
 * nothing in particular and had the concrete cost that the same room was quoted
 * two different figures in two of this script's own panels — the advisor and the
 * savings row already asked for the ask. One side, and it is the one the money
 * actually leaves at.
 */

import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';

/**
 * Calculate the total cost to build a house room to a specific level
 * @param {string} houseRoomHrid - House room HRID (e.g., '/house_rooms/dojo')
 * @param {number} currentLevel - Target level (1-8)
 * @returns {number} Total build cost in coins
 */
export function calculateHouseBuildCost(houseRoomHrid, currentLevel) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return 0;

    const houseRoomDetailMap = gameData.houseRoomDetailMap;
    if (!houseRoomDetailMap) return 0;

    const houseDetail = houseRoomDetailMap[houseRoomHrid];
    if (!houseDetail) return 0;

    const upgradeCostsMap = houseDetail.upgradeCostsMap;
    if (!upgradeCostsMap) return 0;

    let totalCost = 0;

    // Sum costs for all levels from 1 to current
    for (let level = 1; level <= currentLevel; level++) {
        const levelUpgrades = upgradeCostsMap[level];
        if (!levelUpgrades) continue;

        // Add cost for each material required at this level
        for (const item of levelUpgrades) {
            // Special case: Coins have face value of 1 (no market price)
            if (item.itemHrid === '/items/coin') {
                const itemCost = item.count * 1;
                totalCost += itemCost;
                continue;
            }

            const prices = marketAPI.getPrice(item.itemHrid, 0);
            if (!prices) continue;

            // The buy side, because buying is the thing being costed. A book
            // with no ask still has a bid to go on — one side is a worse
            // estimate than two, but it is an estimate, and dropping the
            // material would understate the room by exactly that material
            // (getPrice normalizes missing sides to null)
            const price = prices.ask ?? prices.bid;
            if (price == null) continue;

            totalCost += item.count * price;
        }
    }

    return totalCost;
}

/**
 * Calculate total cost for all battle houses
 * @param {Object} characterHouseRooms - Map of character house rooms from profile data
 * @returns {Object} {totalCost, breakdown: [{name, level, cost}]}
 */
export function calculateBattleHousesCost(characterHouseRooms) {
    const battleHouses = ['dining_room', 'library', 'dojo', 'gym', 'armory', 'archery_range', 'mystical_study'];

    const gameData = dataManager.getInitClientData();
    if (!gameData) return { totalCost: 0, breakdown: [] };

    const houseRoomDetailMap = gameData.houseRoomDetailMap;
    if (!houseRoomDetailMap) return { totalCost: 0, breakdown: [] };

    let totalCost = 0;
    const breakdown = [];

    for (const [houseRoomHrid, houseData] of Object.entries(characterHouseRooms)) {
        // Check if this is a battle house
        const isBattleHouse = battleHouses.some((battleHouse) => houseRoomHrid.includes(battleHouse));

        if (!isBattleHouse) continue;

        const level = houseData.level || 0;
        if (level === 0) continue;

        const cost = calculateHouseBuildCost(houseRoomHrid, level);
        totalCost += cost;

        // Get human-readable name
        const houseDetail = houseRoomDetailMap[houseRoomHrid];
        const houseName = houseDetail?.name || houseRoomHrid.replace('/house_rooms/', '');

        breakdown.push({
            name: houseName,
            level: level,
            cost: cost,
        });
    }

    // Sort by cost descending
    breakdown.sort((a, b) => b.cost - a.cost);

    return { totalCost, breakdown };
}
