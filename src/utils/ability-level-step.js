/**
 * Shared rules for the upgrade finders' level steps: the "+Levels" and "Next multiple of" modes and the
 * Steps box. Used by the upgrade advisor (ability levels, combat skill levels, house rooms, guild shrines,
 * equipment enhancement) and by both sims' per-ability Targets prefill, so they can never disagree about
 * what a level goes to.
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
 * Every level one ability (or combat skill) is offered at in the "+Levels" and "Next multiple of" modes.
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
export function stepLevels(level, type, size, steps, cap = Infinity) {
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

/** The ability finder's name for {@link stepLevels}, kept for its callers. */
export const abilityStepLevels = stepLevels;

/**
 * The levels one step at a time above `level`: +1, +2, ... +steps, stopping at `cap`. The House and Guild
 * Shrine Steps box: one step is the single "one level up" those sets have always offered.
 *
 * @param {number} level - Current level
 * @param {number} steps - How many levels to offer (see normalizeLevelSteps)
 * @param {number} [cap=Infinity] - Highest level the game allows
 * @returns {number[]} Ascending target levels, all above `level` and at most `cap`
 */
export function singleStepLevels(level, steps, cap = Infinity) {
    const current = Math.max(0, Math.floor(Number(level)) || 0);
    const out = [];
    for (let i = 1; i <= normalizeLevelSteps(steps); i++) {
        if (current + i > cap) break;
        out.push(current + i);
    }
    return out;
}

/**
 * Help text for a Steps box.
 * @param {string} [noun='ability'] - What one row is about ('ability', 'combat skill')
 * @param {string} [extra=''] - Anything else the box should say, appended
 * @returns {string}
 */
export function levelStepsTitle(noun = 'ability', extra = '') {
    return (
        `How many levels to try per ${noun} (1 to ${MAX_LEVEL_STEPS}): +5 with 3 steps tries +5, +10 and +15. ` +
        `Each step is one more simulation per ${noun}, so the search takes longer.` +
        (extra ? ` ${extra}` : '')
    );
}

/** Help text for the Ability Lv Steps box. */
export const LEVEL_STEPS_TITLE = levelStepsTitle('ability');

/**
 * Help text for the House and Guild Shrine Steps boxes, which step one level at a time.
 * @param {string} noun - 'room' or 'shrine'
 * @returns {string}
 */
export const SINGLE_STEPS_TITLE = (noun) =>
    `How many levels to try per ${noun} (1 to ${MAX_LEVEL_STEPS}): 3 steps tries +1, +2 and +3, each its own row ` +
    `costed from the level the ${noun} is at now, never past the max. Each step is one more simulation per ${noun}. ` +
    'With more than 1 step the Lv box is not used; the Targets grid, while open, replaces the steps.';

/** Help text for the Equipment Steps box */
export const ENHANCEMENT_STEPS_TITLE =
    `How many enhancement breakpoints (or levels) to try per item (1 to ${MAX_LEVEL_STEPS}). 1 tries only the next breakpoint ` +
    '(+5 → +7 on most gear, as always). 3 tries each of the next three breakpoints: +7, +10 and +12 from +5, ' +
    'never past the max enhancement level. Set the box beside it to Levels to step one level at a time instead ' +
    '(+6, +7 and +8 from +5). Each extra step is one more simulation per item.';

/**
 * What a level box should show for each "+Levels / Target Lv / Next mult. of" mode.
 * @param {string} type - 'increment' | 'target' | 'next_multiple'
 * @param {string} [noun='ability'] - What the box levels ('ability', 'combat skill')
 * @returns {{value: string, placeholder: string, title: string}}
 */
export function levelBoxHints(type, noun = 'ability') {
    const plural = noun.endsWith('y') ? `${noun.slice(0, -1)}ies` : `${noun}s`;
    if (type === 'target') {
        return { value: '', placeholder: 'e.g. 80', title: `Absolute target level for all ${plural}` };
    }
    if (type === 'next_multiple') {
        return {
            value: String(DEFAULT_LEVEL_STEP),
            placeholder: String(DEFAULT_LEVEL_STEP),
            title: `Step size: each ${noun} goes to the next multiple of this above its level (70 goes to 75, not 70)`,
        };
    }
    return { value: String(DEFAULT_LEVEL_STEP), placeholder: '+5', title: `Number of levels to add to each ${noun}` };
}

/**
 * What the Ability Lv level box should show for each mode.
 * @param {string} type - 'increment' | 'target' | 'next_multiple'
 * @returns {{value: string, placeholder: string, title: string}}
 */
export function abilityLevelBoxHints(type) {
    return levelBoxHints(type, 'ability');
}
