/**
 * Efficiency Utilities Module
 * Calculations for game mechanics (efficiency, buffs, time)
 */

/**
 * Calculate actual action count from efficiency percentage
 * Uses floor + modulo system
 *
 * @param {number} efficiencyPercent - Efficiency percentage (e.g., 150 for 150%)
 * @returns {Object} { guaranteed: number, chanceForMore: number, min: number, max: number }
 *
 * @example
 * calculateEfficiency(150)
 * // Returns: { guaranteed: 2, chanceForMore: 50, min: 2, max: 3 }
 * // Means: Always 2 actions, plus 50% chance for 3rd
 */
export function calculateEfficiency(efficiencyPercent) {
    // Base action + floor of efficiency/100
    const guaranteed = 1 + Math.floor(efficiencyPercent / 100);

    // Chance for one more action
    const chanceForMore = efficiencyPercent % 100;

    return {
        guaranteed,
        chanceForMore,
        min: guaranteed,
        max: guaranteed + (chanceForMore > 0 ? 1 : 0),
    };
}

/**
 * Calculate expected output from efficiency
 * @param {number} efficiencyPercent - Efficiency percentage
 * @param {number} baseOutput - Base output per action (default: 1)
 * @returns {number} Expected output (weighted average)
 *
 * @example
 * calculateExpectedOutput(150, 1)
 * // Returns: 2.5
 * // Because: 50% chance of 2, 50% chance of 3 = average 2.5
 */
export function calculateExpectedOutput(efficiencyPercent, baseOutput = 1) {
    const eff = calculateEfficiency(efficiencyPercent);
    const expectedActions = eff.guaranteed + eff.chanceForMore / 100;
    return expectedActions * baseOutput;
}

/**
 * Calculate action time with speed buffs
 * @param {number} baseTime - Base action time in seconds
 * @param {number} speedPercent - Total speed bonus percentage (e.g., 30 for 30%)
 * @returns {number} Modified action time in seconds
 *
 * @example
 * calculateActionTime(6, 30)
 * // Returns: 4.615
 * // Formula: 6 / (1 + 0.30) = 4.615s
 */
export function calculateActionTime(baseTime, speedPercent) {
    return baseTime / (1 + speedPercent / 100);
}

/**
 * Calculate total time for multiple actions
 * @param {number} actionTime - Time per action in seconds
 * @param {number} actionCount - Number of actions
 * @param {number} efficiencyPercent - Efficiency percentage (default: 0)
 * @returns {number} Total time in seconds
 *
 * @example
 * calculateTotalTime(5, 100, 0)
 * // Returns: 500 (5s × 100 actions)
 *
 * calculateTotalTime(5, 100, 50)
 * // Returns: ~333.33 (efficiency reduces effective action count)
 */
export function calculateTotalTime(actionTime, actionCount, efficiencyPercent = 0) {
    if (efficiencyPercent > 0) {
        const expectedOutput = calculateExpectedOutput(efficiencyPercent);
        // Divide by expected output per action to get actual actions needed
        const actualActionsNeeded = actionCount / expectedOutput;
        return actionTime * actualActionsNeeded;
    }

    return actionTime * actionCount;
}

/**
 * Calculate actions needed to reach target with efficiency
 * @param {number} targetCount - Target output count
 * @param {number} efficiencyPercent - Efficiency percentage
 * @returns {Object} { min: number, max: number, expected: number }
 *
 * @example
 * calculateActionsForTarget(100, 150)
 * // Returns: { min: 34, max: 100, expected: 40 }
 */
export function calculateActionsForTarget(targetCount, efficiencyPercent) {
    const expectedOutput = calculateExpectedOutput(efficiencyPercent);
    const expectedActions = Math.ceil(targetCount / expectedOutput);

    const eff = calculateEfficiency(efficiencyPercent);
    const minOutput = eff.min;
    const maxOutput = eff.max;

    return {
        min: Math.ceil(targetCount / maxOutput), // Best case (always max output)
        max: Math.ceil(targetCount / minOutput), // Worst case (always min output)
        expected: expectedActions, // Average case
    };
}

/**
 * Calculate XP per hour
 * @param {number} xpPerAction - XP gained per action
 * @param {number} actionTime - Time per action in seconds
 * @returns {number} XP per hour
 *
 * @example
 * calculateXpPerHour(50, 5)
 * // Returns: 36000
 * // Because: (50 XP / 5s) × 3600s = 36,000 XP/hour
 */
export function calculateXpPerHour(xpPerAction, actionTime) {
    return (xpPerAction / actionTime) * 3600;
}

/**
 * Calculate level progress percentage
 * @param {number} currentXp - Current XP in level
 * @param {number} xpNeeded - Total XP needed for level
 * @returns {number} Percentage (0-100)
 */
export function calculateLevelProgress(currentXp, xpNeeded) {
    if (xpNeeded === 0) return 100;
    return Math.min(100, (currentXp / xpNeeded) * 100);
}

/**
 * Stack additive bonuses (most game bonuses)
 * @param {number[]} bonuses - Array of bonus percentages
 * @returns {number} Total stacked bonus percentage
 *
 * @example
 * stackAdditive([10, 20, 5])
 * // Returns: 35
 * // Because: 10% + 20% + 5% = 35%
 */
export function stackAdditive(...bonuses) {
    return bonuses.reduce((total, bonus) => total + bonus, 0);
}

/**
 * Stack multiplicative bonuses (rare in MWI)
 * @param {number[]} bonuses - Array of bonus percentages
 * @returns {number} Total stacked bonus percentage
 *
 * @example
 * stackMultiplicative([10, 20])
 * // Returns: 32
 * // Because: 1.10 × 1.20 = 1.32 (32% total)
 */
export function stackMultiplicative(...bonuses) {
    const multiplier = bonuses.reduce((total, bonus) => total * (1 + bonus / 100), 1);
    return (multiplier - 1) * 100;
}

export default {
    calculateEfficiency,
    calculateExpectedOutput,
    calculateActionTime,
    calculateTotalTime,
    calculateActionsForTarget,
    calculateXpPerHour,
    calculateLevelProgress,
    stackAdditive,
    stackMultiplicative,
};
