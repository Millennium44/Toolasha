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

/** Most steps the Steps box allows: each one is another simulation per ability. */
export const MAX_LEVEL_STEPS = 5;

/**
 * A Steps value as a whole number from 1 to MAX_LEVEL_STEPS (blank, zero, negative or NaN mean 1).
 * @param {*} steps
 * @returns {number}
 */
export function normalizeLevelSteps(steps) {
    const whole = Math.floor(Number(steps));
    if (!Number.isFinite(whole) || whole < 1) return 1;
    return Math.min(MAX_LEVEL_STEPS, whole);
}

/**
 * Every level one ability is offered at in the "+Levels" and "Next multiple of" modes.
 * One step is the single level those modes have always offered; more steps add the next
 * levels on the same stride (+5, +10, +15 or 65, 70, 75). The first level is clamped to
 * `cap` as ever, later ones stop once the cap has been reached, so nothing past it is offered.
 *
 * @param {number} level - Current ability level
 * @param {string} type - 'increment' or 'next_multiple'
 * @param {number} size - The +Levels amount, or the multiple (blank, <= 0 or NaN fall back to 5)
 * @param {number} steps - How many levels to offer (see normalizeLevelSteps)
 * @param {number} [cap=Infinity] - Highest level the game allows
 * @returns {number[]} Ascending target levels, all above `level` and at most `cap`
 */
export function abilityStepLevels(level, type, size, steps, cap = Infinity) {
    let stride;
    let first;
    if (type === 'next_multiple') {
        const whole = Math.floor(Number(size));
        stride = Number.isFinite(whole) && whole > 0 ? whole : DEFAULT_LEVEL_STEP;
        first = nextMultipleLevel(level, stride);
    } else {
        stride = size > 0 ? size : DEFAULT_LEVEL_STEP;
        first = level + stride;
    }
    const out = [];
    for (let i = 0; i < normalizeLevelSteps(steps); i++) {
        const target = Math.min(first + i * stride, cap);
        if (target <= level) break;
        out.push(target);
        if (target >= cap) break;
    }
    return out;
}

/** Help text for the Steps box. */
export const LEVEL_STEPS_TITLE =
    `How many levels to try per ability (1 to ${MAX_LEVEL_STEPS}): +5 with 3 steps tries +5, +10 and +15. ` +
    'Each step is one more simulation per ability, so the search takes longer.';

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
