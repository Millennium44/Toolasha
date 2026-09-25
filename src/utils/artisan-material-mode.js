/**
 * Artisan material rounding
 *
 * Artisan Tea makes a recipe's per-craft input fractional (4 × 0.9 = 3.6), while a
 * single craft consumes whole units. Every surface that sizes a run's inputs for
 * buying has to round that fraction the same way, under the "Missing materials:
 * Artisan requirement mode" setting — a surface that averages while the player
 * asked for the worst case leaves the last craft of the run short.
 *
 * Kept apart from `material-calculator.js` so the crafting plan can use it without
 * importing the loadout and enhancement machinery that module carries.
 */

import config from '../core/config.js';

export const ARTISAN_MATERIAL_MODE = {
    EXPECTED: 'expected',
    WORST_CASE: 'worst-case',
    HYBRID: 'hybrid',
};

// Below this many actions the per-craft ceiling has not had room to average out, so hybrid mode
// keeps worst-case rounding; at or above it the expected value is within a unit or two of reality.
const HYBRID_WORST_CASE_MAX_ACTIONS = 100;

function normalizeArtisanMode(mode) {
    if (mode === ARTISAN_MATERIAL_MODE.WORST_CASE || mode === ARTISAN_MATERIAL_MODE.HYBRID) {
        return mode;
    }
    return ARTISAN_MATERIAL_MODE.EXPECTED;
}

/**
 * The artisan requirement mode the player has chosen.
 * @returns {string} One of {@link ARTISAN_MATERIAL_MODE}; anything unrecognised reads as expected value
 */
export function getArtisanMaterialMode() {
    return normalizeArtisanMode(config.getSettingValue('actions_artisanMaterialMode', ARTISAN_MATERIAL_MODE.EXPECTED));
}

/**
 * Whether a run of this many crafts is billed at each craft's rounded-up input.
 * @param {string} artisanMode - From {@link getArtisanMaterialMode}
 * @param {number} numActions - Crafts in the run
 * @returns {boolean} True for worst-case, and for hybrid below the threshold
 */
export function usesWorstCaseRounding(artisanMode, numActions) {
    // Unbounded queues are never below the threshold, so hybrid resolves to expected value there.
    return (
        artisanMode === ARTISAN_MATERIAL_MODE.WORST_CASE ||
        (artisanMode === ARTISAN_MATERIAL_MODE.HYBRID && numActions < HYBRID_WORST_CASE_MAX_ACTIONS)
    );
}

/**
 * Units of one recipe input a run of crafts needs.
 * @param {number} basePerAction - The recipe's printed count for the input
 * @param {number} artisanBonus - Artisan reduction as a decimal (0.1 for 10%)
 * @param {number} numActions - Whole crafts in the run
 * @param {string} artisanMode - From {@link getArtisanMaterialMode}
 * @returns {number} Whole units
 */
export function artisanInputTotal(basePerAction, artisanBonus, numActions, artisanMode) {
    const materialsPerAction = basePerAction * (1 - artisanBonus);
    if (usesWorstCaseRounding(artisanMode, numActions)) {
        return ceilUnits(materialsPerAction) * numActions;
    }
    return ceilUnits(materialsPerAction * numActions);
}

/**
 * Round a unit count up, ignoring the IEEE residue a fractional product leaves.
 *
 * `3 × (1 − 0.2) × 100` evaluates to `240.00000000000003`, and a bare
 * `Math.ceil` bills 241 for a run the bag covers with 240. The tolerance is
 * far above any accumulated product error and far below the smallest real
 * excess a whole-unit recipe count times a tea percentage can produce.
 *
 * @param {number} units - Possibly fractional units
 * @returns {number} Whole units; an unbounded run stays unbounded
 */
function ceilUnits(units) {
    if (!Number.isFinite(units)) return units;
    return Math.ceil(units - Math.abs(units) * 1e-12 - 1e-12);
}
