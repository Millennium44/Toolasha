/**
 * Shared rules for the upgrade finders' "Next multiple of" ability-level mode.
 * Used by the upgrade advisor (candidate generation) and by both sims' per-ability
 * Targets prefill, so the three can never disagree about what an ability goes to.
 */

/** Step used when the box is blank, zero, negative or not a number — the same default "+Levels" falls back to. */
export const DEFAULT_LEVEL_STEP = 5;

/**
 * The next multiple of `step` strictly above `level`, capped at `cap`.
 * An ability already on a multiple goes up a full step (70 -> 75), never stays put.
 * A result that is not above `level` (at or past the cap) means "nothing to upgrade".
 *
 * @param {number} level - Current ability level
 * @param {number} step - Step (blank, <= 0 or NaN fall back to 5; fractions truncate)
 * @param {number} [cap=Infinity] - Highest level the game allows
 * @returns {number} Target level
 */
export function nextMultipleLevel(level, step, cap = Infinity) {
    const whole = Math.floor(Number(step));
    const size = Number.isFinite(whole) && whole > 0 ? whole : DEFAULT_LEVEL_STEP;
    const current = Math.max(0, Math.floor(Number(level)) || 0);
    return Math.min(cap, (Math.floor(current / size) + 1) * size);
}

/**
 * What the shared level box should show for each "Ability Lv" mode.
 * @param {string} type - 'increment' | 'target' | 'next_multiple'
 * @returns {{value: string, placeholder: string, title: string}}
 */
export function abilityLevelBoxHints(type) {
    if (type === 'target') {
        return { value: '', placeholder: 'e.g. 80', title: 'Absolute target level for all abilities' };
    }
    if (type === 'next_multiple') {
        return {
            value: String(DEFAULT_LEVEL_STEP),
            placeholder: String(DEFAULT_LEVEL_STEP),
            title: 'Step size: each ability goes to the next multiple of this above its level (70 goes to 75, not 70)',
        };
    }
    return { value: String(DEFAULT_LEVEL_STEP), placeholder: '+5', title: 'Number of levels to add to each ability' };
}
