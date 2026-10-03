/**
 * Experience Calculator
 * Shared utility for calculating experience per hour across features
 *
 * Calculates accurate XP/hour including:
 * - Base experience from action
 * - Experience multipliers (Wisdom + Charm Experience)
 * - Action time with speed bonuses
 * - Efficiency repeats (critical for accuracy)
 */

import dataManager from '../core/data-manager.js';
import { calculateActionStats } from './action-calculator.js';
import { calculateExperienceMultiplier } from './experience-parser.js';
import { calculateEfficiencyMultiplier } from './efficiency.js';
import { calculateActionsPerHour, calculateEffectiveActionsPerHour } from './profit-helpers.js';
import { resolveActionContext } from './action-context.js';

/**
 * Calculate experience per hour for an action
 * @param {string} actionHrid - The action HRID (e.g., "/actions/cheesesmithing/cheese")
 * @returns {Object|null} Experience data or null if not applicable
 *   {
 *     expPerHour: number,           // Total XP per hour (with all bonuses)
 *     baseExp: number,              // Base XP per action
 *     modifiedXP: number,           // XP per action after multipliers
 *     actionsPerHour: number,       // Actions per hour (with efficiency)
 *     xpMultiplier: number,         // Total XP multiplier (Wisdom + Charm)
 *     actionTime: number,           // Time per action in seconds
 *     totalEfficiency: number       // Total efficiency percentage
 *   }
 */
export function calculateExpPerHour(actionHrid) {
    const actionDetails = dataManager.getActionDetails(actionHrid);

    // Validate action has experience gain
    if (!actionDetails || !actionDetails.experienceGain || !actionDetails.experienceGain.value) {
        return null;
    }

    // Get character data
    const skills = dataManager.getSkills();
    const { equipment } = resolveActionContext(actionDetails.type);
    const gameData = dataManager.getInitClientData();

    if (!gameData || !skills || !equipment) {
        return null;
    }

    // Calculate action stats (time + efficiency)
    const stats = calculateActionStats(actionDetails, {
        skills,
        equipment,
        itemDetailMap: gameData.itemDetailMap,
        includeCommunityBuff: true,
        includeBreakdown: false,
    });

    if (!stats) {
        return null;
    }

    const { actionTime, totalEfficiency } = stats;

    // Calculate actions per hour (base rate)
    const baseActionsPerHour = calculateActionsPerHour(actionTime);

    // Calculate average queued actions completed per time-consuming action
    // Efficiency gives guaranteed repeats + chance for extra
    const avgActionsPerBaseAction = calculateEfficiencyMultiplier(totalEfficiency);

    // Calculate actions per hour WITH efficiency (total completions including instant repeats)
    const actionsPerHourWithEfficiency = calculateEffectiveActionsPerHour(baseActionsPerHour, avgActionsPerBaseAction);

    // Calculate experience multiplier (Wisdom + Charm Experience)
    const skillHrid = actionDetails.experienceGain.skillHrid;
    const xpData = calculateExperienceMultiplier(skillHrid, actionDetails.type);

    // Calculate exp per hour with all bonuses
    const baseExp = actionDetails.experienceGain.value;
    const modifiedXP = baseExp * xpData.totalMultiplier;
    const expPerHour = actionsPerHourWithEfficiency * modifiedXP;

    return {
        expPerHour: Math.floor(expPerHour),
        baseExp,
        modifiedXP,
        actionsPerHour: actionsPerHourWithEfficiency,
        xpMultiplier: xpData.totalMultiplier,
        actionTime,
        totalEfficiency,
    };
}

/**
 * Efficiency multiplier partway through a grind.
 *
 * The game's level efficiency is `max(0, effective_level − effective_requirement)`, so a
 * character standing below the effective requirement (an Action Level tea raises it, and the
 * panel is also readable for actions above the player's level) gains no efficiency at all
 * until the gap closes. Adding a flat +1% per level from the first one over-credits exactly
 * that gap. The deficit may be fractional, since Action Level bonuses are.
 *
 * @param {number} baseEfficiency - Current total efficiency percentage
 * @param {number} levelsGained - Levels gained so far in the walk
 * @param {number} levelEfficiencyDeficit - Levels still owed before level efficiency starts
 * @returns {number} Multiplier (1 + efficiency/100)
 */
function progressiveEfficiencyMultiplier(baseEfficiency, levelsGained, levelEfficiencyDeficit) {
    const gained = Math.max(0, levelsGained - (levelEfficiencyDeficit || 0));
    return 1 + (baseEfficiency + gained) / 100;
}

/**
 * Charge action cycles for queued completions while carrying unused repeat capacity forward.
 * @param {number} actionCount - Completions to fit into timed cycles
 * @param {number} efficiencyMultiplier - Average completions per timed cycle
 * @param {number} actionTime - Seconds per timed cycle
 * @param {number} carriedCapacity - Unused completion capacity from the previous level
 * @returns {{ timeElapsed: number, carriedCapacity: number }}
 */
function chargeActionCycles(actionCount, efficiencyMultiplier, actionTime, carriedCapacity) {
    const carriedActions = Math.min(actionCount, carriedCapacity);
    const remainingActions = actionCount - carriedActions;
    if (remainingActions === 0) {
        return { timeElapsed: 0, carriedCapacity: carriedCapacity - carriedActions };
    }

    const cycles = Math.ceil(remainingActions / efficiencyMultiplier);
    return {
        timeElapsed: cycles * actionTime,
        carriedCapacity: Math.max(0, cycles * efficiencyMultiplier - remainingActions),
    };
}

/**
 * Calculate actions and time needed to reach a target level
 * Accounts for progressive efficiency gains (+1% per level)
 * @param {number} currentLevel - Current skill level
 * @param {number} currentXP - Current experience points
 * @param {number} targetLevel - Target skill level
 * @param {number} baseEfficiency - Starting efficiency percentage
 * @param {number} actionTime - Time per action in seconds
 * @param {number} xpPerAction - Modified XP per action (with multipliers, success rate, etc.)
 * @param {Object} levelExperienceTable - XP requirements per level
 * @param {number} [levelEfficiencyDeficit=0] - How far the effective level sits *below* the
 *   effective requirement right now. Level efficiency is clamped at zero, so the first
 *   `levelEfficiencyDeficit` levels gained buy no efficiency at all.
 * @returns {{ actionsNeeded: number, timeNeeded: number }} Infinite values when
 *   positive experience is required but `xpPerAction` is not positive.
 */
export function calculateMultiLevelProgress(
    currentLevel,
    currentXP,
    targetLevel,
    baseEfficiency,
    actionTime,
    xpPerAction,
    levelExperienceTable,
    levelEfficiencyDeficit = 0
) {
    let totalActions = 0;
    let totalTime = 0;
    let carriedCapacity = 0;
    let level = currentLevel;
    let xp = currentXP;

    while (
        level < targetLevel &&
        levelExperienceTable[level + 1] !== undefined &&
        xp >= levelExperienceTable[level + 1]
    ) {
        level += 1;
    }
    if (level >= targetLevel) return { actionsNeeded: 0, timeNeeded: 0 };

    // An action count is a count of completions. Efficiency changes how long
    // those completions take, not the XP one completion grants.
    if (!(xpPerAction > 0)) return { actionsNeeded: Infinity, timeNeeded: Infinity };

    while (level < targetLevel) {
        // The table stops at the level cap; walking past it would yield NaN actions
        const xpForNextLevel = levelExperienceTable[level + 1];
        if (xpForNextLevel === undefined) break;

        // XP is cumulative and one completion can cross more than one level.
        // Promote already-crossed thresholds without charging another action.
        if (xp >= xpForNextLevel) {
            level += 1;
            continue;
        }

        const actionsForLevel = Math.ceil((xpForNextLevel - xp) / xpPerAction);

        const efficiencyMultiplier = progressiveEfficiencyMultiplier(
            baseEfficiency,
            level - currentLevel,
            levelEfficiencyDeficit
        );

        totalActions += actionsForLevel;
        const cycleCharge = chargeActionCycles(actionsForLevel, efficiencyMultiplier, actionTime, carriedCapacity);
        totalTime += cycleCharge.timeElapsed;
        carriedCapacity = cycleCharge.carriedCapacity;
        xp += actionsForLevel * xpPerAction;

        // Keep XP earned by the completion that crossed the threshold. It may
        // already satisfy the next level, in which case no action is needed.
        while (
            level < targetLevel &&
            levelExperienceTable[level + 1] !== undefined &&
            xp >= levelExperienceTable[level + 1]
        ) {
            level += 1;
        }
    }

    return { actionsNeeded: totalActions, timeNeeded: totalTime };
}

/**
 * The level and xp reached after a number of actions — the reverse of
 * calculateMultiLevelProgress, walking the same per-level progressive
 * efficiency forward against a fixed action budget. Feeding its action count
 * back into this function reaches at least the target, carrying any XP surplus.
 * @param {number} currentLevel - Current skill level
 * @param {number} currentXP - Current experience points
 * @param {number} actionCount - Queue completions to spend
 * @param {number} baseEfficiency - Starting efficiency percentage
 * @param {number} actionTime - Seconds per action
 * @param {number} xpPerAction - Modified XP per action
 * @param {Object} levelExperienceTable - XP requirements per level
 * @param {number} [levelEfficiencyDeficit=0] - Levels owed before level efficiency starts
 *   (see calculateMultiLevelProgress)
 * @returns {{finalLevel: number, finalXP: number, xpGained: number, timeElapsed: number, percentToNext: number}}
 */
export function calculateLevelFromActions(
    currentLevel,
    currentXP,
    actionCount,
    baseEfficiency,
    actionTime,
    xpPerAction,
    levelExperienceTable,
    levelEfficiencyDeficit = 0
) {
    let remainingActions = actionCount;
    let level = currentLevel;
    let xp = currentXP;
    let timeElapsed = 0;
    let carriedCapacity = 0;

    while (remainingActions > 0) {
        // The current XP may already have crossed one or more thresholds, for
        // example when a single completion grants enough XP for several levels.
        while (levelExperienceTable[level + 1] !== undefined && xp >= levelExperienceTable[level + 1]) {
            level += 1;
        }

        const xpForNextLevel = levelExperienceTable[level + 1];
        const efficiencyMultiplier = progressiveEfficiencyMultiplier(
            baseEfficiency,
            level - currentLevel,
            levelEfficiencyDeficit
        );

        if (xpForNextLevel === undefined) {
            // At the level cap: the queue still runs, it just stops buying levels
            const cycleCharge = chargeActionCycles(remainingActions, efficiencyMultiplier, actionTime, carriedCapacity);
            timeElapsed += cycleCharge.timeElapsed;
            carriedCapacity = cycleCharge.carriedCapacity;
            remainingActions = 0;
            break;
        }

        // Efficiency repeats count toward the queue quantity, but each completed
        // action grants only its own XP. With no XP gain, the queue still takes
        // time and makes no level progress.
        if (!(xpPerAction > 0)) {
            const cycleCharge = chargeActionCycles(remainingActions, efficiencyMultiplier, actionTime, carriedCapacity);
            timeElapsed += cycleCharge.timeElapsed;
            carriedCapacity = cycleCharge.carriedCapacity;
            remainingActions = 0;
            break;
        }

        const actionsToNextLevel = Math.ceil((xpForNextLevel - xp) / xpPerAction);

        if (actionsToNextLevel <= remainingActions) {
            remainingActions -= actionsToNextLevel;
            const cycleCharge = chargeActionCycles(
                actionsToNextLevel,
                efficiencyMultiplier,
                actionTime,
                carriedCapacity
            );
            timeElapsed += cycleCharge.timeElapsed;
            carriedCapacity = cycleCharge.carriedCapacity;
            xp += actionsToNextLevel * xpPerAction;
        } else {
            const cycleCharge = chargeActionCycles(remainingActions, efficiencyMultiplier, actionTime, carriedCapacity);
            timeElapsed += cycleCharge.timeElapsed;
            carriedCapacity = cycleCharge.carriedCapacity;
            xp += remainingActions * xpPerAction;
            remainingActions = 0;
        }
    }

    while (levelExperienceTable[level + 1] !== undefined && xp >= levelExperienceTable[level + 1]) {
        level += 1;
    }

    const xpForLevel = levelExperienceTable[level] || 0;
    const xpForNextLevel = levelExperienceTable[level + 1];
    const percentToNext =
        xpForNextLevel !== undefined ? ((xp - xpForLevel) / (xpForNextLevel - xpForLevel)) * 100 : 100;

    return {
        finalLevel: level,
        finalXP: xp,
        xpGained: xp - currentXP,
        // A non-empty queue takes at least one action cycle, even when its
        // efficiency multiplier exceeds the queued completion count.
        timeElapsed: actionCount > 0 ? Math.max(actionTime, timeElapsed) : timeElapsed,
        percentToNext,
    };
}

export default {
    calculateExpPerHour,
    calculateMultiLevelProgress,
    calculateLevelFromActions,
};
