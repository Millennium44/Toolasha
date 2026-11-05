/**
 * Game maximums, read from the game's own data.
 *
 * Every cap here has a constant fallback, used when the game data has not loaded yet or carries nothing
 * usable. A value read from data is only ever taken when it is at least the fallback: a table shorter than
 * today's is far likelier a partial load than a patch that lowers a cap, and a cap of 0, -1 or NaN would
 * clamp real input. A patch that raises a cap (a longer level table, a higher building ceiling) flows
 * through without a Toolasha release.
 *
 * Game data is not reachable from a sim worker, so engine code keeps its own constants.
 */

import dataManager from '../core/data-manager.js';

/** Highest skill and ability level, when the level table is missing */
export const FALLBACK_MAX_LEVEL = 200;

/** Highest enhancement level, when the enhancement multiplier table is missing */
export const FALLBACK_MAX_ENHANCEMENT_LEVEL = 20;

/** Highest guild building level, when the building detail map is missing */
export const FALLBACK_MAX_GUILD_BUILDING_LEVEL = 20;

/** Highest guild shrine level, when the shrine detail map is missing */
export const FALLBACK_MAX_GUILD_SHRINE_LEVEL = 20;

/** Highest house room level, when the room detail map is missing */
export const FALLBACK_MAX_HOUSE_ROOM_LEVEL = 8;

/**
 * The client data to read, unless the caller passes its own (null included, which reads as "not loaded").
 * @param {Object|null|undefined} gameData
 * @returns {Object|null}
 */
function resolveClientData(gameData) {
    if (gameData !== undefined) return gameData && typeof gameData === 'object' ? gameData : null;
    try {
        return dataManager.getInitClientData?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * A level ceiling from a table whose index is the level, where index 0 is the unused slot.
 * @param {*} table
 * @param {number} fallback
 * @returns {number}
 */
function ceilingFromTable(table, fallback) {
    const length = Array.isArray(table) ? table.length : NaN;
    return Number.isFinite(length) && length - 1 > fallback ? length - 1 : fallback;
}

/**
 * The highest `maxLevel` any entry of a detail map states, or the fallback when none states a usable one.
 * Unlike a table length, the field is an explicit statement of the cap, so it is taken as given.
 * @param {*} map
 * @param {number} fallback
 * @returns {number}
 */
function ceilingFromDetailMap(map, fallback) {
    let best = 0;
    for (const detail of Object.values(map && typeof map === 'object' ? map : {})) {
        const level = Math.floor(Number(detail?.maxLevel));
        if (Number.isFinite(level) && level > best) best = level;
    }
    return best > 0 ? best : fallback;
}

/**
 * Highest skill or ability level the game allows (the level experience table is indexed by level, so its
 * length is the cap plus one).
 * @param {Object|null} [gameData] - Client data; read from the data manager when omitted
 * @returns {number}
 */
export function maxLevel(gameData) {
    return ceilingFromTable(resolveClientData(gameData)?.levelExperienceTable, FALLBACK_MAX_LEVEL);
}

/**
 * Highest enhancement level the game allows (the multiplier table is indexed by level).
 * @param {Object|null} [gameData] - Client data; read from the data manager when omitted
 * @returns {number}
 */
export function maxEnhancementLevel(gameData) {
    return ceilingFromTable(
        resolveClientData(gameData)?.enhancementLevelTotalBonusMultiplierTable,
        FALLBACK_MAX_ENHANCEMENT_LEVEL
    );
}

/**
 * Highest level any guild building can reach, from the buildings' own `maxLevel`.
 * @param {Object|null} [gameData] - Client data; read from the data manager when omitted
 * @returns {number}
 */
export function maxGuildBuildingLevel(gameData) {
    return ceilingFromDetailMap(resolveClientData(gameData)?.guildBuildingDetailMap, FALLBACK_MAX_GUILD_BUILDING_LEVEL);
}

/**
 * Highest level any guild shrine can reach, from the shrines' own `maxLevel`.
 * @param {Object|null} [gameData] - Client data; read from the data manager when omitted
 * @returns {number}
 */
export function maxGuildShrineLevel(gameData) {
    return ceilingFromDetailMap(resolveClientData(gameData)?.guildShrineDetailMap, FALLBACK_MAX_GUILD_SHRINE_LEVEL);
}

/**
 * Highest house room level: the highest level any room has an upgrade cost for. Rooms carry no max-level
 * field, so the upgrade-cost ladder is the only source in the data.
 * @param {Object|null} [gameData] - Client data; read from the data manager when omitted
 * @returns {number}
 */
export function maxHouseRoomLevel(gameData) {
    const rooms = resolveClientData(gameData)?.houseRoomDetailMap;
    let best = FALLBACK_MAX_HOUSE_ROOM_LEVEL;
    for (const room of Object.values(rooms && typeof rooms === 'object' ? rooms : {})) {
        const costs = room?.upgradeCostsMap;
        for (const key of Object.keys(costs && typeof costs === 'object' ? costs : {})) {
            const level = Math.floor(Number(key));
            if (Number.isFinite(level) && level > best) best = level;
        }
    }
    return best;
}
