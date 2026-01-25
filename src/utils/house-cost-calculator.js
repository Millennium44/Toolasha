/**
 * House Cost Calculator Utility
 * Calculates the total cost to build house rooms to specific levels
 * Used for combat score calculation
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

            // Match MCS behavior: if one price is positive and other is negative, use positive for both
            let ask = prices.ask;
            let bid = prices.bid;

            if (ask > 0 && bid < 0) {
                bid = ask;
            }
            if (bid > 0 && ask < 0) {
                ask = bid;
            }

            // Use weighted average
            const weightedPrice = (ask + bid) / 2;

            const itemCost = item.count * weightedPrice;
            totalCost += itemCost;
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
