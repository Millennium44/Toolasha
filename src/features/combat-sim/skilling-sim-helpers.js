/**
 * Skilling Sim Helpers
 * Pure functions that convert editor state into buff arrays
 * for use with LabyrinthClearRate.getSkillingMetricsFromOverrides().
 */

import dataManager from '../../core/data-manager.js';
import { parseEquipmentSpeedBonuses, parseEquipmentEfficiencyBonuses } from '../../utils/equipment-parser.js';

const PRODUCTION_SKILLS = [
    '/action_types/alchemy',
    '/action_types/brewing',
    '/action_types/cheesesmithing',
    '/action_types/cooking',
    '/action_types/crafting',
    '/action_types/tailoring',
];

const GATHERING_SKILLS = ['/action_types/foraging', '/action_types/milking', '/action_types/woodcutting'];

/** Every action type a labyrinth skilling room can be run in */
const ALL_SKILLING_ACTION_TYPES = [...PRODUCTION_SKILLS, ...GATHERING_SKILLS, '/action_types/enhancing'];

/**
 * Highest level a community buff can reach.
 *
 * Twenty, which is what the game shows as "Level: 20 (Max)". The combat sim's
 * own community candidates use a ceiling of 30 for a different question — what
 * an already-maxed buff is *worth* — and borrowing that number here would offer
 * a Lv20 → Lv21 that cannot be donated for.
 */
export const MAX_COMMUNITY_BUFF_LEVEL = 20;

/**
 * The community buffs the labyrinth skilling model reads, and what each one is.
 *
 * Fallbacks, not the source of truth: `communityBuffTypeDetailMap` in the game
 * data carries the same numbers and is preferred whenever it has loaded. These
 * are what keeps the module working before it has, and are the same formulas the
 * rest of the script uses (`flatBoost + (level − 1) × flatBoostLevelBonus`).
 *
 * Combat drop quantity and the Moo Pass are absent on purpose: neither produces
 * a buff type `applyBuff` maps onto a skilling metric, so a level of either
 * changes a skilling room by exactly nothing.
 */
const COMMUNITY_BUFFS = [
    {
        key: 'productionEfficiency',
        hrid: '/community_buff_types/production_efficiency',
        name: 'Production Efficiency',
        typeHrid: '/buff_types/efficiency',
        flatBoost: 0.14,
        flatBoostLevelBonus: 0.003,
        actionTypes: PRODUCTION_SKILLS,
    },
    {
        key: 'enhancingSpeed',
        hrid: '/community_buff_types/enhancing_speed',
        name: 'Enhancing Speed',
        typeHrid: '/buff_types/action_speed',
        flatBoost: 0.2,
        flatBoostLevelBonus: 0.005,
        actionTypes: ['/action_types/enhancing'],
    },
    {
        key: 'gatheringQuantity',
        hrid: '/community_buff_types/gathering_quantity',
        name: 'Gathering Quantity',
        typeHrid: '/buff_types/gathering',
        flatBoost: 0.2,
        flatBoostLevelBonus: 0.005,
        actionTypes: GATHERING_SKILLS,
    },
    {
        key: 'experience',
        hrid: '/community_buff_types/experience',
        name: 'Experience',
        typeHrid: '/buff_types/wisdom',
        flatBoost: 0.2,
        flatBoostLevelBonus: 0.005,
        actionTypes: ALL_SKILLING_ACTION_TYPES,
    },
];

/**
 * Buff types `LabyrinthClearRate.applyBuff` turns into a skilling metric.
 *
 * `/buff_types/gathering` is here, and is the one that is not unconditional —
 * it only lands on the three gathering skills, and is checked separately.
 */
const SKILLING_BUFF_TYPES = new Set([
    '/buff_types/efficiency',
    '/buff_types/action_speed',
    '/buff_types/labyrinth_double_progress',
    '/buff_types/success_rate',
    '/buff_types/wisdom',
    '/buff_types/gathering',
]);

/**
 * One community buff definition, with whatever the game data says overlaid.
 *
 * Reading the detail map rather than trusting the constants above is what keeps
 * a balance patch from silently leaving this module a patch behind — and it is
 * where `usableInActionTypeMap` comes from, which is the game's own answer to
 * "does this buff apply to that skill" and better than any list kept here.
 *
 * @param {Object} def - An entry of `COMMUNITY_BUFFS`
 * @returns {Object} The definition, resolved against game data
 */
function resolveCommunityBuff(def) {
    const detail = dataManager.getInitClientData?.()?.communityBuffTypeDetailMap?.[def.hrid];
    const buff = detail?.buff;
    const num = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    return {
        ...def,
        name: detail?.name || def.name,
        typeHrid: buff?.typeHrid || def.typeHrid,
        flatBoost: num(buff?.flatBoost, def.flatBoost),
        flatBoostLevelBonus: num(buff?.flatBoostLevelBonus, def.flatBoostLevelBonus),
        ratioBoost: num(buff?.ratioBoost, 0),
        ratioBoostLevelBonus: num(buff?.ratioBoostLevelBonus, 0),
        usableInActionTypeMap: detail?.usableInActionTypeMap || null,
        // Cowbells per minute of uptime, which is what the game charges for a
        // donation. Not the price of a level — see the candidate builder below.
        cowbellCost: num(detail?.cowbellCost, null),
    };
}

/**
 * Whether one community buff can change one skilling room's outcome.
 *
 * Two questions, both answered from data: does the buff apply to this action
 * type at all (the game's own `usableInActionTypeMap` when it has loaded), and
 * is its buff type one the skilling metrics read.
 *
 * @param {Object} resolved - From `resolveCommunityBuff`
 * @param {string} actionTypeHrid - e.g. `/action_types/cooking`
 * @returns {boolean}
 */
function communityBuffMovesSkill(resolved, actionTypeHrid) {
    const applies = resolved.usableInActionTypeMap
        ? Boolean(resolved.usableInActionTypeMap[actionTypeHrid])
        : resolved.actionTypes.includes(actionTypeHrid);
    if (!applies) return false;
    if (!SKILLING_BUFF_TYPES.has(resolved.typeHrid)) return false;
    // Gathering quantity is the labyrinth's double-progress chance for the three
    // gathering skills and is dropped on the floor for everybody else
    if (resolved.typeHrid === '/buff_types/gathering') return GATHERING_SKILLS.includes(actionTypeHrid);
    // Enhancing rooms clear on success rate and speed; the efficiency term never
    // enters `computeEnhancingClearWithParams`
    if (resolved.typeHrid === '/buff_types/efficiency' && actionTypeHrid === '/action_types/enhancing') return false;
    return true;
}

/**
 * The value one community buff has at a level.
 * @param {Object} resolved - From `resolveCommunityBuff`
 * @param {number} level - Buff level (0 = not running)
 * @returns {{flatBoost: number, ratioBoost: number}}
 */
function communityBuffValue(resolved, level) {
    if (level <= 0) return { flatBoost: 0, ratioBoost: 0 };
    return {
        flatBoost: resolved.flatBoost + (level - 1) * resolved.flatBoostLevelBonus,
        ratioBoost: resolved.ratioBoost + (level - 1) * resolved.ratioBoostLevelBonus,
    };
}

/**
 * Convert editor equipment DTO format to the Map format the equipment parser expects.
 * DTO: { '/equipment_types/body': { hrid, enhancementLevel } }
 * Parser: Map<'/item_locations/body', { itemHrid, enhancementLevel }>
 * @param {Object} editorEquipment - Equipment from DTO
 * @returns {Map}
 */
function toEquipmentMap(editorEquipment) {
    const map = new Map();
    for (const [slot, item] of Object.entries(editorEquipment || {})) {
        if (!item?.hrid) continue;
        const locationKey = slot.replace('/equipment_types/', '/item_locations/');
        map.set(locationKey, { itemHrid: item.hrid, enhancementLevel: item.enhancementLevel || 0 });
    }
    return map;
}

/**
 * Build equipment buff array for a specific action type from editor equipment.
 * @param {Object} editorEquipment - { '/equipment_types/body': { hrid, enhancementLevel } }
 * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
 * @param {Object} itemDetailMap - From gameData
 * @returns {Array} Buff objects compatible with getSkillingMetricsFromOverrides()
 */
export function buildEquipmentBuffsForSkill(editorEquipment, actionTypeHrid, itemDetailMap) {
    const equipMap = toEquipmentMap(editorEquipment);
    const buffs = [];

    const speedBonus = parseEquipmentSpeedBonuses(equipMap, actionTypeHrid, itemDetailMap);
    if (speedBonus > 0) {
        buffs.push({ typeHrid: '/buff_types/action_speed', flatBoost: speedBonus, ratioBoost: 0 });
    }

    const efficiencyBonus = parseEquipmentEfficiencyBonuses(equipMap, actionTypeHrid, itemDetailMap);
    if (efficiencyBonus > 0) {
        buffs.push({ typeHrid: '/buff_types/efficiency', flatBoost: efficiencyBonus / 100, ratioBoost: 0 });
    }

    return buffs;
}

/**
 * Build community buff array for a specific action type from editor levels.
 *
 * The Experience buff used to be missing from here, and only from here: the DTO
 * has carried its level since the adapter was written, the skilling metrics have
 * a `/buff_types/wisdom` branch waiting for it, and nothing joined the two. So
 * every XP-per-room figure the labyrinth skilling tab reported — the baseline it
 * ranks the Experience token and the Scholar shrine against — was computed as
 * though the server's biggest, most permanently-running buff were switched off.
 *
 * @param {Object} communityBuffLevels - { productionEfficiency, enhancingSpeed, gatheringQuantity, experience }
 * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
 * @returns {Array} Buff objects
 */
export function buildCommunityBuffsForSkill(communityBuffLevels, actionTypeHrid) {
    const buffs = [];
    if (!communityBuffLevels) return buffs;

    for (const def of COMMUNITY_BUFFS) {
        const level = Math.max(0, Math.floor(Number(communityBuffLevels[def.key]) || 0));
        if (level <= 0) continue;

        const resolved = resolveCommunityBuff(def);
        if (!communityBuffMovesSkill(resolved, actionTypeHrid)) continue;

        const { flatBoost, ratioBoost } = communityBuffValue(resolved, level);
        if (flatBoost === 0 && ratioBoost === 0) continue;
        buffs.push({ typeHrid: resolved.typeHrid, flatBoost, ratioBoost });
    }

    return buffs;
}

/**
 * One-level-up candidates for the community buffs that touch the rooms being run.
 *
 * Only buffs that can move the outcome are offered, and only for the skills
 * actually being simmed: Gathering Quantity is the double-progress chance of a
 * Foraging room and nothing whatsoever in a Cooking one, so offering it in a
 * Cooking run would be a simulation spent proving +0.00%.
 *
 * A buff already at the cap gets no row. There is no level 21 to donate for, and
 * a candidate the game cannot sell is not an upgrade — the separate question of
 * what an already-maxed buff is worth belongs to the combat sim's own community
 * handling, which asks it by simulating the buff *off*.
 *
 * ### On cost
 *
 * Left unpriced, exactly as `calculateUpgradeCost` leaves the combat sim's
 * community candidates, so the two panels rank the same row the same way. It is
 * not a coy answer: the game data prices a community buff as `cowbellCost`
 * cowbells *per minute of uptime*, and a buff's level is what the whole server's
 * donated minutes add up to — there is no "cost of the next level" for one
 * player to pay. The rate is carried on the candidate so a row can say what
 * keeping the buff running costs, which is the honest number that does exist.
 *
 * @param {Object} communityBuffLevels - From the editor DTO
 * @param {string[]} actionTypeHrids - The action types being simmed
 * @returns {Array<Object>} Candidates of type 'community_buff'
 */
export function generateSkillingCommunityBuffCandidates(communityBuffLevels, actionTypeHrids = []) {
    const candidates = [];
    if (!actionTypeHrids.length) return candidates;

    for (const def of COMMUNITY_BUFFS) {
        const resolved = resolveCommunityBuff(def);
        if (!actionTypeHrids.some((actionTypeHrid) => communityBuffMovesSkill(resolved, actionTypeHrid))) continue;

        const currentLevel = Math.max(0, Math.floor(Number(communityBuffLevels?.[def.key]) || 0));
        if (currentLevel >= MAX_COMMUNITY_BUFF_LEVEL) continue;

        const upgradeLevel = currentLevel + 1;
        candidates.push({
            type: 'community_buff',
            buffKey: def.key,
            buffHrid: def.hrid,
            buffTypeHrid: resolved.typeHrid,
            currentLevel,
            upgradeLevel,
            cowbellCost: resolved.cowbellCost,
            // A wisdom level changes what a cleared room pays, never how often
            // it clears, so its row is read on XP rather than on clear rate
            metric: resolved.typeHrid === '/buff_types/wisdom' ? 'xpPerRoom' : 'clearRate',
            description: `${resolved.name} Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }

    return candidates;
}

/**
 * Build house buff array for a specific action type from editor house room levels.
 * @param {Object} editorHouseRooms - { '/house_rooms/brewery': level, ... }
 * @param {string} actionTypeHrid - e.g. "/action_types/brewing"
 * @param {Object} houseRoomDetailMap - From gameData
 * @returns {Array} Buff objects
 */
export function buildHouseBuffsForSkill(editorHouseRooms, actionTypeHrid, houseRoomDetailMap) {
    const buffs = [];
    if (!editorHouseRooms || !houseRoomDetailMap) return buffs;

    for (const [hrid, level] of Object.entries(editorHouseRooms)) {
        if (!level || level <= 0) continue;
        const roomDetail = houseRoomDetailMap[hrid];
        if (!roomDetail) continue;

        if (Array.isArray(roomDetail.actionBuffs)) {
            for (const buff of roomDetail.actionBuffs) {
                if (!buff?.usableInActionTypeMap?.[actionTypeHrid]) continue;
                const flatBoost = (buff.flatBoostLevelBonus || 0) * level;
                const ratioBoost = (buff.ratioBoostLevelBonus || 0) * level;
                if (flatBoost === 0 && ratioBoost === 0) continue;
                buffs.push({ typeHrid: buff.typeHrid, flatBoost, ratioBoost });
            }
        }

        if (Array.isArray(roomDetail.globalBuffs)) {
            for (const buff of roomDetail.globalBuffs) {
                const flatBoost = (buff.flatBoostLevelBonus || 0) * level;
                const ratioBoost = (buff.ratioBoostLevelBonus || 0) * level;
                if (flatBoost === 0 && ratioBoost === 0) continue;
                buffs.push({ typeHrid: buff.typeHrid, flatBoost, ratioBoost });
            }
        }
    }

    return buffs;
}

/**
 * Build crate buff array from selected crate HRIDs.
 * @param {string[]} crateHrids - Array of crate item HRIDs
 * @param {Object} labyrinthCrateDetailMap - From gameData
 * @returns {Array} Buff objects
 */
export function buildCrateBuffs(crateHrids, labyrinthCrateDetailMap) {
    const allBuffs = [];
    if (!labyrinthCrateDetailMap) return allBuffs;

    for (const hrid of crateHrids || []) {
        if (!hrid) continue;
        const buffs = labyrinthCrateDetailMap[hrid];
        if (Array.isArray(buffs)) {
            allBuffs.push(...buffs);
        }
    }
    return allBuffs;
}

/**
 * Build the full overrides object for a single skill from editor state.
 * @param {Object} editorState - { equipment, houseRooms, tokenUpgrades, communityBuffLevels }
 * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - { itemDetailMap, houseRoomDetailMap, labyrinthCrateDetailMap }
 * @returns {Object} Overrides for getSkillingMetricsFromOverrides()
 */
export function buildOverridesForSkill(editorState, actionTypeHrid, crateHrids, gameData) {
    return {
        equipmentBuffs: buildEquipmentBuffsForSkill(editorState.equipment, actionTypeHrid, gameData.itemDetailMap),
        communityBuffs: buildCommunityBuffsForSkill(editorState.communityBuffLevels, actionTypeHrid),
        houseBuffs: buildHouseBuffsForSkill(editorState.houseRooms, actionTypeHrid, gameData.houseRoomDetailMap),
        crateBuffs: buildCrateBuffs(crateHrids, gameData.labyrinthCrateDetailMap),
        tokenUpgrades: editorState.tokenUpgrades,
    };
}
