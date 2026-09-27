/**
 * Enhancement XP Calculations
 * Based on Ultimate Enhancement Tracker formulas
 */

import dataManager from '../../core/data-manager.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { getEnhancingParams, describeParamsSource } from '../../utils/enhancement-config.js';
import { MIN_ACTION_TIME_SECONDS } from '../../utils/profit-constants.js';

/**
 * Get base item level from item HRID
 * @param {string} itemHrid - Item HRID
 * @returns {number} Base item level
 */
function getBaseItemLevel(itemHrid) {
    try {
        const gameData = dataManager.getInitClientData();
        const itemData = gameData?.itemDetailMap?.[itemHrid];

        if (itemData?.itemLevel) {
            return itemData.itemLevel;
        }

        return 0;
    } catch {
        return 0;
    }
}

/**
 * The per-action-type buff maps the game unions into an action's buffs, as named on
 * `characterData`. The client's `calcSkillingActionTypeBuffsDict` takes exactly these, plus the
 * personal (Labyrinth scroll) map and the achievement map, which are read through dataManager's
 * getters below so a scroll the player is simulating counts the way it does everywhere else.
 */
const CHARACTER_BUFF_MAPS = [
    'mooPassActionTypeBuffsMap',
    'communityActionTypeBuffsMap',
    'houseActionTypeBuffsMap',
    'guildActionTypeBuffsMap',
    'consumableActionTypeBuffsMap',
    'equipmentActionTypeBuffsMap',
];

/**
 * Sum one buff type's flatBoost and ratioBoost over every source the game applies to enhancing.
 *
 * The client builds an action's buffs from eight maps (MooPass, community, house, guild,
 * achievement, consumable, equipment, personal) and sums every entry of a type. Reading only
 * some of them is how this module missed the MooPass's 5% wisdom and a Scroll of Wisdom.
 *
 * @param {Object} charData - dataManager.characterData
 * @param {string} buffTypeHrid - e.g. '/buff_types/wisdom'
 * @returns {{flatBoost: number, ratioBoost: number}} Totals across all sources
 */
function sumEnhancingBuff(charData, buffTypeHrid) {
    const total = { flatBoost: 0, ratioBoost: 0 };
    for (const mapName of CHARACTER_BUFF_MAPS) {
        const buffs = charData?.[mapName]?.['/action_types/enhancing'];
        if (!Array.isArray(buffs)) continue;
        for (const buff of buffs) {
            if (buff?.typeHrid !== buffTypeHrid) continue;
            total.flatBoost += buff.flatBoost || 0;
            total.ratioBoost += buff.ratioBoost || 0;
        }
    }
    total.flatBoost += dataManager.getAchievementBuffFlatBoost?.('/action_types/enhancing', buffTypeHrid) || 0;
    total.ratioBoost += dataManager.getAchievementBuffRatioBoost?.('/action_types/enhancing', buffTypeHrid) || 0;
    total.flatBoost += dataManager.getPersonalBuffFlatBoost?.('/action_types/enhancing', buffTypeHrid) || 0;
    return total;
}

/**
 * The enhancing level the game compares against the item's level, as getBoostedSkillLevel does:
 * (1 + Σ ratio) × level + Σ flat over every enhancing_level buff, unfloored.
 * @param {Object} charData - dataManager.characterData
 * @returns {number} Boosted enhancing level
 */
function getBoostedEnhancingLevel(charData) {
    const enhancingSkill = charData?.characterSkills?.find((s) => s.skillHrid === '/skills/enhancing');
    const baseLevel = enhancingSkill?.level || 1;
    const boost = sumEnhancingBuff(charData, '/buff_types/enhancing_level');
    return (1 + boost.ratioBoost) * baseLevel + boost.flatBoost;
}

/**
 * Get wisdom buff percentage from all sources
 * Reads from dataManager.characterData (NOT localStorage)
 * @returns {number} Wisdom buff as decimal (e.g., 0.20 for 20%)
 */
function getWisdomBuff() {
    try {
        // Use dataManager for character data (NOT localStorage)
        const charData = dataManager.characterData;
        if (!charData) return 0;

        // Every source the game sums, the MooPass and a Scroll of Wisdom included
        const totalFlatBoost = sumEnhancingBuff(charData, '/buff_types/wisdom').flatBoost;

        // Return as decimal (flatBoost is already in decimal form, e.g., 0.2 for 20%)
        return totalFlatBoost;
    } catch {
        return 0;
    }
}

/**
 * Calculate XP gained from successful enhancement
 * Formula: 1.4 × (1 + wisdom) × enhancementMultiplier × (10 + baseItemLevel)
 * @param {number} previousLevel - Enhancement level before success
 * @param {string} itemHrid - Item HRID
 * @returns {number} XP gained
 */
export function calculateSuccessXP(previousLevel, itemHrid) {
    const baseLevel = getBaseItemLevel(itemHrid);
    const wisdomBuff = getWisdomBuff();

    // Special handling for enhancement level 0 (base items)
    const enhancementMultiplier =
        previousLevel === 0
            ? 1.0 // Base value for unenhanced items
            : previousLevel + 1; // Normal progression

    return Math.floor(1.4 * (1 + wisdomBuff) * enhancementMultiplier * (10 + baseLevel));
}

/**
 * Calculate XP gained from failed enhancement
 * Formula: 10% of success XP
 * @param {number} previousLevel - Enhancement level that failed
 * @param {string} itemHrid - Item HRID
 * @returns {number} XP gained
 */
export function calculateFailureXP(previousLevel, itemHrid) {
    return Math.floor(calculateSuccessXP(previousLevel, itemHrid) * 0.1);
}

/**
 * Calculate adjusted attempt number from session data
 * This makes tracking resume-proof (doesn't rely on WebSocket currentCount)
 * @param {Object} session - Session object
 * @returns {number} Next attempt number
 */
export function calculateAdjustedAttemptCount(session) {
    let successCount = 0;
    let failCount = 0;

    // Sum all successes and failures across all levels
    for (const level in session.attemptsPerLevel) {
        const levelData = session.attemptsPerLevel[level];
        successCount += levelData.success || 0;
        failCount += levelData.fail || 0;
    }

    // For the first attempt, return 1
    if (successCount === 0 && failCount === 0) {
        return 1;
    }

    // Return total + 1 for the next attempt
    return successCount + failCount + 1;
}

/**
 * Calculate enhancing action time from the game's buff maps
 * Reads the pre-computed action_speed flatBoost values from all buff sources
 * and adds level advantage, matching the game's actual speed calculation
 * @param {string} itemHrid - Item HRID being enhanced
 * @returns {number} Per-action time in seconds
 */
export function getEnhancingActionTime(itemHrid) {
    try {
        const charData = dataManager.characterData;
        if (!charData) return 12;

        // Get base time from game data
        const actionDetails = dataManager.getActionDetails('/actions/enhancing/enhance');
        const baseTime = actionDetails?.baseTimeCost ? actionDetails.baseTimeCost / 1e9 : 12;

        // Sum action_speed flatBoost from every source the game applies
        let totalSpeedBuff = sumEnhancingBuff(charData, '/buff_types/action_speed').flatBoost;

        // Add level advantage: (boostedLevel - itemLevel) / 100
        const effectiveLevel = getBoostedEnhancingLevel(charData);
        const itemLevel = getBaseItemLevel(itemHrid);
        if (effectiveLevel > itemLevel) {
            totalSpeedBuff += (effectiveLevel - itemLevel) / 100;
        }

        return Math.max(MIN_ACTION_TIME_SECONDS, baseTime / (1 + totalSpeedBuff));
    } catch {
        return 12;
    }
}

/**
 * Get enhancing speed breakdown from the game's buff maps
 * Returns per-source speed values and total, matching the game's actual calculation
 * @param {string} itemHrid - Item HRID being enhanced
 * @returns {Object} Speed breakdown with total and per-source values (as percentages)
 */
export function getEnhancingSpeedBreakdown(itemHrid) {
    try {
        const charData = dataManager.characterData;
        if (!charData)
            return {
                total: 0,
                equipment: 0,
                house: 0,
                guild: 0,
                community: 0,
                consumable: 0,
                personal: 0,
                levelAdvantage: 0,
            };

        // Get enhancing skill level
        const enhancingSkill = charData.characterSkills?.find((s) => s.skillHrid === '/skills/enhancing');
        const baseLevel = enhancingSkill?.level || 1;

        // Get tea level bonus from consumable buff map
        let teaLevelBonus = 0;
        const consumableBuffs = charData.consumableActionTypeBuffsMap?.['/action_types/enhancing'];
        if (Array.isArray(consumableBuffs)) {
            for (const buff of consumableBuffs) {
                if (buff.typeHrid === '/buff_types/enhancing_level') {
                    teaLevelBonus = buff.flatBoost || 0;
                }
            }
        }

        // Read action_speed flatBoost from each buff source individually
        const sources = {
            equipment: charData.equipmentActionTypeBuffsMap,
            house: charData.houseActionTypeBuffsMap,
            guild: charData.guildActionTypeBuffsMap,
            community: charData.communityActionTypeBuffsMap,
            consumable: charData.consumableActionTypeBuffsMap,
        };

        const breakdown = {
            equipment: 0,
            house: 0,
            guild: 0,
            community: 0,
            consumable: 0,
            personal: 0,
            levelAdvantage: 0,
        };

        for (const [source, buffMap] of Object.entries(sources)) {
            const enhancingBuffs = buffMap?.['/action_types/enhancing'];
            if (!Array.isArray(enhancingBuffs)) continue;

            for (const buff of enhancingBuffs) {
                if (buff.typeHrid === '/buff_types/action_speed') {
                    breakdown[source] += buff.flatBoost || 0;
                }
            }
        }

        // Personal buffs (Labyrinth seals)
        breakdown.personal = dataManager.getPersonalBuffFlatBoost(
            '/action_types/enhancing',
            '/buff_types/action_speed'
        );

        // Level advantage
        const effectiveLevel = baseLevel + teaLevelBonus;
        const itemLevel = getBaseItemLevel(itemHrid);
        if (effectiveLevel > itemLevel) {
            breakdown.levelAdvantage = (effectiveLevel - itemLevel) / 100;
        }

        // Total (as decimal, e.g. 1.56 for +156%)
        // Guild is read above and applied by the game, so it belongs in the total; leaving it out
        // made the displayed speed lag the real one for anyone in a guild with a speed buff.
        breakdown.total =
            breakdown.equipment +
            breakdown.house +
            breakdown.guild +
            breakdown.community +
            breakdown.consumable +
            breakdown.personal +
            breakdown.levelAdvantage;

        return breakdown;
    } catch {
        return {
            total: 0,
            equipment: 0,
            house: 0,
            guild: 0,
            community: 0,
            consumable: 0,
            personal: 0,
            levelAdvantage: 0,
        };
    }
}

/**
 * Calculate enhancement predictions using character stats
 * @param {string} itemHrid - Item HRID being enhanced
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {number} protectFrom - Level to start using protection
 * @returns {Object|null} Prediction data or null if cannot calculate
 */
export function calculateEnhancementPredictions(itemHrid, startLevel, targetLevel, protectFrom) {
    try {
        // Get item level
        const itemLevel = getBaseItemLevel(itemHrid);

        // Use getEnhancingParams() for all character stats (level, speed, success, teas, etc.)
        const params = getEnhancingParams();

        // Check for blessed tea
        const hasBlessed = params.teas?.blessed || false;

        // Per-action time from the game's buff maps (authoritative source), handed to the
        // calculator as an override so the prediction and anything reading result.totalTime
        // later work off one time base instead of two that can disagree.
        const perActionTime = getEnhancingActionTime(itemHrid);

        // Calculate predictions (Markov chain for attempts, protections, success rates)
        const result = calculateEnhancement({
            enhancingLevel: params.enhancingLevel,
            houseLevel: params.houseLevel,
            toolBonus: params.toolBonus,
            speedBonus: params.speedBonus,
            itemLevel,
            targetLevel,
            startLevel,
            protectFrom,
            blessedTea: hasBlessed,
            guzzlingBonus: params.guzzlingBonus,
            blessedTeaBonus: params.blessedTeaBonus,
            perActionTimeOverride: perActionTime,
        });

        if (!result) {
            return null;
        }

        return {
            expectedAttempts: Math.round(result.attemptsRounded),
            expectedProtections: Math.round(result.protectionCount),
            // The distribution behind the expectation, kept with it so a finished
            // run can be read back as a percentile of what was actually predicted
            // — recomputing the chain later would measure the run against stats
            // it was not played with. Additive: older sessions simply lack them,
            // and every reader treats that as "no distribution recorded".
            expectedAttemptsExact: result.attempts,
            attemptsVariance: result.attemptsVariance,
            minAttempts: result.minAttempts,
            expectedTime: result.totalTime,
            perActionTime: result.perActionTime,
            successMultiplier: result.successMultiplier,
            successRates: result.successRates,
            // Recorded with the prediction, so a session opened days later still says which
            // stats it was predicted against
            paramsNote: describeParamsSource(params),
        };
    } catch {
        return null;
    }
}
