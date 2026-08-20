// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Mechanics the engine met and did not understand.
 *
 * A game update that adds an ability effect type, a combat style, or a damage
 * type used to end the entire simulation in a thrown error — one new mechanic
 * on one monster and every number the panel shows is gone. Skipping the single
 * thing the engine cannot model is worth far more than that: the run finishes,
 * and the result carries a note naming the mechanic so the UI can say the
 * numbers understate rather than quietly presenting them as complete.
 *
 * Two levels of deduplication, for two different audiences. `warnedTypes`
 * spans the process so the console gets one line per unknown type no matter how
 * many hundred thousand times the sim hits it. `collected` is per simulation
 * and is what ends up on the SimResult.
 */

/** Unknown types already logged to the console, for the life of the process. */
const warnedTypes = new Set();

/** Warnings raised by the simulation currently running. */
let collected = new Map();

/**
 * Record an unknown mechanic the engine skipped.
 * @param {string} category - What kind of thing it is, e.g. "ability effect type"
 * @param {*} value - The unrecognized value
 * @param {string} [detail] - Optional context, e.g. the ability hrid
 */
export function recordUnknown(category, value, detail = '') {
    const key = `${category}:${String(value)}`;
    if (collected.has(key)) return;

    const suffix = detail ? ` (${detail})` : '';
    const message = `Unknown ${category} "${String(value)}" skipped${suffix} — results may understate`;
    collected.set(key, message);

    if (!warnedTypes.has(key)) {
        warnedTypes.add(key);
        console.warn('[CombatSim]', message);
    }
}

/** Start a fresh warning set for a new simulation. */
export function resetSimWarnings() {
    collected = new Map();
}

/**
 * Warnings raised since the last reset.
 * @returns {string[]} One message per distinct unknown mechanic
 */
export function getSimWarnings() {
    return [...collected.values()];
}

/**
 * Forget which types have been logged, so the next one warns again. Only the
 * console dedupe is affected; tests use it to assert the once-per-type rule.
 */
export function resetWarnedTypes() {
    warnedTypes.clear();
}
