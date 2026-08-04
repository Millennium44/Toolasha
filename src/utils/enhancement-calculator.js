/**
 * Enhancement Calculator
 *
 * Uses Markov Chain matrix math to calculate exact expected values for enhancement attempts.
 * Based on the original MWI Tools Enhancelate() function.
 *
 * Math.js library is loaded via userscript @require header.
 */

import { MIN_ACTION_TIME_SECONDS } from './profit-constants.js';

/**
 * Base success rates by enhancement level (before bonuses)
 */
export const BASE_SUCCESS_RATES = [
    50, // +1
    45, // +2
    45, // +3
    40, // +4
    40, // +5
    40, // +6
    35, // +7
    35, // +8
    35, // +9
    35, // +10
    30, // +11
    30, // +12
    30, // +13
    30, // +14
    30, // +15
    30, // +16
    30, // +17
    30, // +18
    30, // +19
    30, // +20
];

/**
 * Blessed Tea's base chance to skip an extra level on success, as a decimal.
 * Used when the caller has no live consumable data to read the real flatBoost from.
 */
export const BLESSED_TEA_BASE_CHANCE = 0.01;

/**
 * Build the enhancement Markov transition matrix.
 *
 * This body is the single source of the chain. The networth and enhancement worker pools run
 * inside blob workers that cannot import a module, so their managers serialise this function
 * with `toString()` and drop the identical text into their worker scripts — which is why it
 * takes `math` and the base rates as arguments and closes over nothing. Any module-scope name
 * read from here would not exist in the worker, and the two copies would drift apart again.
 *
 * @param {Object} math - math.js namespace (a parameter, not the global, so this can be serialised)
 * @param {Object} options - Chain parameters
 * @param {number[]} options.baseSuccessRates - Base success rate per level, as percentages
 * @param {number} options.successMultiplier - Multiplier applied to the base rates
 * @param {number} options.targetLevel - Absorbing state
 * @param {number} [options.protectFrom=0] - Level from which a failure drops one level instead of to 0
 * @param {boolean} [options.blessedTea=false] - Whether Blessed Tea is active
 * @param {number} [options.guzzlingBonus=1.0] - Drink concentration multiplier
 * @param {number} [options.blessedTeaBonus=0.01] - Blessed Tea double-jump chance as a decimal
 * @returns {Object} 20×20 transition matrix
 */
export function buildEnhancementMarkov(math, options) {
    const {
        baseSuccessRates,
        successMultiplier,
        targetLevel,
        protectFrom = 0,
        blessedTea = false,
        guzzlingBonus = 1.0,
        blessedTeaBonus = 0.01,
    } = options;

    const markov = math.zeros(20, 20);

    for (let i = 0; i < targetLevel; i++) {
        const baseSuccessRate = baseSuccessRates[i] / 100.0;
        // A big enough success multiplier pushes the raw product past 1, which would hand the
        // failure row a negative probability and quietly corrupt the whole chain.
        const successChance = Math.min(1, baseSuccessRate * successMultiplier);

        // Where do we go on failure?
        // Protection only applies when protectFrom > 0 AND we're at or above that level
        const failureDestination = protectFrom > 0 && i >= protectFrom ? i - 1 : 0;

        if (blessedTea) {
            // Blessed Tea: base chance to jump +2 (read from item data when available),
            // scaled by guzzling bonus. Remaining success chance goes to +1.
            const skipChance = successChance * blessedTeaBonus * guzzlingBonus;
            const remainingSuccess = successChance * (1 - blessedTeaBonus * guzzlingBonus);

            // A jump from the last transient level lands past the absorbing state, which is
            // outside the matrix. It is already absorbed either way, so drop it.
            if (i + 2 <= targetLevel) {
                markov.set([i, i + 2], skipChance);
            }
            markov.set([i, i + 1], remainingSuccess);
            markov.set([i, failureDestination], 1 - successChance);
        } else {
            // Normal: Success goes to +1, failure goes to destination
            markov.set([i, i + 1], successChance);
            markov.set([i, failureDestination], 1.0 - successChance);
        }
    }

    // Absorbing state at target level
    markov.set([targetLevel, targetLevel], 1.0);

    return markov;
}

/**
 * Calculate total success rate bonus multiplier
 * @param {Object} params - Enhancement parameters
 * @param {number} params.enhancingLevel - Effective enhancing level (base + tea bonus)
 * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house bonus)
 * @param {number} params.itemLevel - Item level being enhanced
 * @returns {number} Success rate multiplier (e.g., 1.0519 = 105.19% of base rates)
 */
function calculateSuccessMultiplier(params) {
    const { enhancingLevel, toolBonus, itemLevel } = params;

    // Total bonus calculation
    // toolBonus already includes equipment + house success bonus from config
    // We only need to add level advantage here

    let totalBonus;

    if (enhancingLevel >= itemLevel) {
        // Above or at item level: +0.05% per level above item level
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        // Below item level: Penalty based on level deficit
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }

    return totalBonus;
}

/**
 * Calculate per-action time for enhancement
 * Simple calculation that doesn't require Markov chain analysis
 * @param {number} enhancingLevel - Effective enhancing level (includes tea bonus)
 * @param {number} itemLevel - Item level being enhanced
 * @param {number} speedBonus - Speed bonus % (for action time calculation)
 * @returns {number} Per-action time in seconds
 */
export function calculatePerActionTime(enhancingLevel, itemLevel, speedBonus = 0) {
    const baseActionTime = 12; // seconds
    let speedMultiplier;

    if (enhancingLevel > itemLevel) {
        // Above item level: Get speed bonus from level advantage + equipment + house
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        // Below item level: Only equipment + house speed bonus
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + speedBonus / 100;
    }

    return Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
}

/**
 * Calculate enhancement statistics using Markov Chain matrix inversion
 * @param {Object} params - Enhancement parameters
 * @param {number} params.enhancingLevel - Effective enhancing level (includes tea bonus)
 * @param {number} params.houseLevel - Observatory house room level (used for speed calculation only)
 * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house success bonus from config)
 * @param {number} params.speedBonus - Speed bonus % (for action time calculation)
 * @param {number} params.itemLevel - Item level being enhanced
 * @param {number} params.targetLevel - Target enhancement level (1-20)
 * @param {number} params.startLevel - Starting enhancement level (0-19, default 0)
 * @param {number} params.protectFrom - Start using protection items at this level (0 = never)
 * @param {boolean} params.blessedTea - Whether Blessed Tea is active (1% double jump)
 * @param {number} params.guzzlingBonus - Drink concentration multiplier (1.0 = no bonus, scales blessed tea)
 * @param {number} [params.blessedTeaBonus] - Blessed Tea double-jump chance as a decimal (default 1%)
 * @param {number} [params.perActionTimeOverride] - Per-action time in seconds measured from the
 *   game's buff maps. When supplied it replaces the formula below, so a tracker reading the live
 *   buff maps and a prediction built here share one time base.
 * @returns {Object} Enhancement statistics
 */
export function calculateEnhancement(params) {
    const {
        enhancingLevel,
        _houseLevel,
        toolBonus,
        speedBonus = 0,
        itemLevel,
        targetLevel,
        startLevel = 0,
        protectFrom = 0,
        blessedTea = false,
        guzzlingBonus = 1.0,
        blessedTeaBonus = BLESSED_TEA_BASE_CHANCE,
        perActionTimeOverride = 0,
    } = params;

    // Validate inputs
    if (targetLevel < 1 || targetLevel > 20) {
        throw new Error('Target level must be between 1 and 20');
    }
    if (protectFrom < 0 || protectFrom > targetLevel) {
        throw new Error('Protection level must be between 0 and target level');
    }

    // Calculate success rate multiplier
    const successMultiplier = calculateSuccessMultiplier({
        enhancingLevel,
        toolBonus,
        itemLevel,
    });

    // Build Markov Chain transition matrix (20×20) — shared with the worker pools
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    // Extract transient matrix Q (all states before target)
    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));

    // Fundamental matrix: M = (I - Q)^-1
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    // Expected attempts from startLevel to target.
    // This is the full row sum of the fundamental matrix: a failure below startLevel drops the
    // item back to states the run started above, and every visit there costs an attempt too.
    // Summing only from startLevel up would silently discount those.
    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([startLevel, i]);
    }

    // Expected protection item uses
    let protects = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([startLevel, i]);
            const failureChance = markov.get([i, i - 1]);
            protects += timesAtLevel * failureChance;
        }
    }

    // Action time calculation
    const baseActionTime = 12; // seconds
    let speedMultiplier;

    if (enhancingLevel > itemLevel) {
        // Above item level: Get speed bonus from level advantage + equipment + house
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        // Below item level: Only equipment + house speed bonus
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + speedBonus / 100;
    }

    // A caller that can read the game's own buff maps knows the real per-action time; prefer it
    // over the formula so predictions and live tracking never disagree about the time base.
    const perActionTime =
        perActionTimeOverride > 0
            ? perActionTimeOverride
            : Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
    const totalTime = perActionTime * attempts;

    return {
        attempts: attempts, // Keep exact decimal value for calculations
        attemptsRounded: Math.round(attempts), // Rounded for display
        protectionCount: protects, // Keep decimal precision
        perActionTime: perActionTime,
        totalTime: totalTime,
        successMultiplier: successMultiplier,

        // Detailed success rates for each level
        successRates: BASE_SUCCESS_RATES.slice(0, targetLevel).map((base, i) => {
            return {
                level: i + 1,
                baseRate: base,
                actualRate: Math.min(100, base * successMultiplier),
            };
        }),

        // Expected number of times each state is visited (from fundamental matrix M)
        visitCounts: Array.from({ length: targetLevel }, (_, i) => M.get([startLevel, i])),
    };
}
