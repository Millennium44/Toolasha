/**
 * House Cost Calculator
 *
 * What it costs to build a house room up to a level, materials priced at the
 * market. The one calculator for that question: the networth and combat-score
 * totals, the Houses panel's affordability count, the house modal's cost
 * column and the goal planner all ask here. There used to be a second copy in
 * `features/house/`, which meant the same room could be quoted two different
 * figures depending on which panel asked — the same bug the pricing note below
 * records, one layer up.
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
 *
 * When there is no ask, the one side the book has is still a market price, so
 * the bid stands in; a material with no book at all falls back to what the
 * vendor pays for it — a floor, but dropping the material would understate the
 * room by exactly that material. Custom price overrides apply, because they
 * come in through {@link getItemPrice} like every other priced feature.
 */

import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';
import { getItemPrice } from './market-data.js';

/** Whether {@link initialize} has already made sure market data is loaded */
let marketReady = false;

/**
 * Make sure market data is available before costing anything.
 * @returns {Promise<void>}
 */
export async function initialize() {
    if (marketReady) return;

    // Check in-memory first to avoid storage reads
    if (!marketAPI.isLoaded()) {
        await marketAPI.fetch();
    }

    marketReady = true;
}

/**
 * What one unit of a build material costs.
 *
 * Ask first (with any custom override), the bid when nobody is selling, and
 * the vendor's sell price when there is no book at all. Zero only when the
 * game itself has no price for the item.
 *
 * @param {string} itemHrid - Item HRID
 * @returns {number} Price in coins
 */
function materialUnitPrice(itemHrid) {
    const ask = getItemPrice(itemHrid, { mode: 'ask' });
    if (ask !== null && ask !== 0) {
        return ask;
    }

    const bid = getItemPrice(itemHrid, { mode: 'bid' });
    if (bid !== null && bid !== 0) {
        return bid;
    }

    const itemData = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid];
    return itemData?.sellPrice || 0;
}

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
                totalCost += item.count;
                continue;
            }

            totalCost += item.count * materialUnitPrice(item.itemHrid);
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

/**
 * Get current level of a house room
 * @param {string} houseRoomHrid - House room HRID (e.g., "/house_rooms/brewery")
 * @returns {number} Current level (0-8)
 */
export function getCurrentRoomLevel(houseRoomHrid) {
    return dataManager.getHouseRoomLevel(houseRoomHrid);
}

/**
 * Calculate cost for a single level upgrade
 * @param {string} houseRoomHrid - House room HRID
 * @param {number} targetLevel - Target level (1-8)
 * @returns {Promise<Object>} Cost breakdown {level, coins, materials, totalValue}
 */
export async function calculateLevelCost(houseRoomHrid, targetLevel) {
    const initData = dataManager.getInitClientData();
    if (!initData || !initData.houseRoomDetailMap) {
        throw new Error('Game data not loaded');
    }

    const roomData = initData.houseRoomDetailMap[houseRoomHrid];
    if (!roomData) {
        throw new Error(`House room not found: ${houseRoomHrid}`);
    }

    const upgradeCosts = roomData.upgradeCostsMap[targetLevel];
    if (!upgradeCosts) {
        throw new Error(`No upgrade costs for level ${targetLevel}`);
    }

    // Calculate costs
    let totalCoins = 0;
    const materials = [];

    for (const item of upgradeCosts) {
        if (item.itemHrid === '/items/coin') {
            totalCoins = item.count;
        } else {
            const marketPrice = materialUnitPrice(item.itemHrid);
            materials.push({
                itemHrid: item.itemHrid,
                count: item.count,
                marketPrice: marketPrice,
                totalValue: marketPrice * item.count,
            });
        }
    }

    const totalMaterialValue = materials.reduce((sum, m) => sum + m.totalValue, 0);

    return {
        level: targetLevel,
        coins: totalCoins,
        materials: materials,
        totalValue: totalCoins + totalMaterialValue,
    };
}

/**
 * Calculate cumulative cost from current level to target level
 * @param {string} houseRoomHrid - House room HRID
 * @param {number} currentLevel - Current level
 * @param {number} targetLevel - Target level (currentLevel+1 to 8)
 * @returns {Promise<Object>} Aggregated costs {fromLevel, toLevel, coins, materials, totalValue}
 */
export async function calculateCumulativeCost(houseRoomHrid, currentLevel, targetLevel) {
    if (targetLevel <= currentLevel) {
        throw new Error('Target level must be greater than current level');
    }

    if (targetLevel > 8) {
        throw new Error('Maximum house level is 8');
    }

    let totalCoins = 0;
    const materialMap = new Map(); // itemHrid -> {itemHrid, count, marketPrice, totalValue}

    // Aggregate costs across all levels
    for (let level = currentLevel + 1; level <= targetLevel; level++) {
        const levelCost = await calculateLevelCost(houseRoomHrid, level);

        totalCoins += levelCost.coins;

        // Aggregate materials
        for (const material of levelCost.materials) {
            if (materialMap.has(material.itemHrid)) {
                const existing = materialMap.get(material.itemHrid);
                existing.count += material.count;
                existing.totalValue += material.totalValue;
            } else {
                materialMap.set(material.itemHrid, { ...material });
            }
        }
    }

    const materials = Array.from(materialMap.values());
    const totalMaterialValue = materials.reduce((sum, m) => sum + m.totalValue, 0);

    return {
        fromLevel: currentLevel,
        toLevel: targetLevel,
        coins: totalCoins,
        materials: materials,
        totalValue: totalCoins + totalMaterialValue,
    };
}

/**
 * Get player's inventory count for an item
 * @param {string} itemHrid - Item HRID
 * @returns {number} Item count in inventory
 */
export function getInventoryCount(itemHrid) {
    const inventory = dataManager.getInventory();
    if (!inventory) return 0;

    // Only count items in inventory (not equipped) with no enhancement
    // Enhanced items and equipped items cannot be used for house construction
    const item = inventory.find(
        (i) =>
            i.itemHrid === itemHrid &&
            i.itemLocationHrid === '/item_locations/inventory' &&
            (!i.enhancementLevel || i.enhancementLevel === 0)
    );
    return item ? item.count : 0;
}

/**
 * Get item name from game data
 * @param {string} itemHrid - Item HRID
 * @returns {string} Item name
 */
export function getItemName(itemHrid) {
    if (itemHrid === '/items/coin') {
        return 'Gold';
    }

    const initData = dataManager.getInitClientData();
    const itemData = initData?.itemDetailMap?.[itemHrid];
    return itemData?.name || 'Unknown Item';
}

/**
 * Get house room name from game data
 * @param {string} houseRoomHrid - House room HRID
 * @returns {string} Room name
 */
export function getRoomName(houseRoomHrid) {
    const initData = dataManager.getInitClientData();
    const roomData = initData?.houseRoomDetailMap?.[houseRoomHrid];
    return roomData?.name || 'Unknown Room';
}
