/**
 * Combat action helpers
 *
 * The character's action list is a queue, not an execution-ordered array. A
 * repeating action that has run many times is requeued to the *front* of the
 * array with a *higher* ordinal, so `actions.find(a => combat && !a.isDone)` —
 * "first combat action in array order" — routinely returns a zone that is
 * queued behind the one actually running. Execution order is ascending
 * `ordinal`, so the running action is the lowest-ordinal unfinished one.
 *
 * Reading the wrong action here has bitten three readers with the same bug:
 * the boss-ETA chip printed a queued normal zone's boss cadence on a dungeon
 * ("9 to boss" on a 50-wave dungeon), the battle counter showed "Battle #N"
 * instead of "Wave N", and — worst — the sim-accuracy recorder stamped a
 * dungeon recording with a queued normal zone's hrid, mis-filing the data.
 */

/**
 * The combat action the game is actually running, chosen by execution order
 * (lowest ordinal) rather than array position.
 *
 * @param {Array<{actionHrid?: string, isDone?: boolean, ordinal?: number}>} actions
 *   The character action queue (e.g. `dataManager.getCurrentActions()` or
 *   `characterData.characterActions`).
 * @param {Object} [options]
 * @param {boolean} [options.includeFinished=false] - When no unfinished combat
 *   action exists, fall back to the lowest-ordinal finished one rather than
 *   returning null. Callers that must still name a zone the instant combat ends
 *   (the accuracy recorder folding a just-banked segment) want this; the live
 *   header chips do not.
 * @returns {Object|null} The running combat action, or null when none qualifies.
 */
export function runningCombatAction(actions, { includeFinished = false } = {}) {
    if (!Array.isArray(actions)) return null;

    const combat = actions.filter((a) => a && String(a.actionHrid || '').startsWith('/actions/combat/'));
    if (combat.length === 0) return null;

    const active = combat.filter((a) => !a.isDone);
    const pool = active.length > 0 ? active : includeFinished ? combat : active;
    if (pool.length === 0) return null;

    return pool.reduce((lowest, a) => ((a.ordinal ?? 0) < (lowest.ordinal ?? 0) ? a : lowest));
}
