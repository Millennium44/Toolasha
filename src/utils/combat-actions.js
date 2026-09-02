/**
 * Running-action helpers
 *
 * The character's action list is a queue, not an execution-ordered array. A
 * repeating action that has run many times is requeued to the *front* of the
 * array with a *higher* ordinal, so "the current action" read as `actions[0]`,
 * `actions.find(a => !a.isDone)`, or the first match of a `for…of` routinely
 * returns an action that is queued *behind* the one actually running.
 * Execution order is ascending `ordinal`, so the running action is the
 * lowest-ordinal unfinished one.
 *
 * Reading the queue by position has bitten reader after reader with the same
 * bug: the boss-ETA chip printed a queued normal zone's cadence on a dungeon,
 * the battle counter showed "Battle #N" instead of "Wave N", the sim-accuracy
 * recorder stamped a dungeon recording with a queued zone's hrid, the dungeon
 * tracker read a queued copy's tier, drop luck attributed drops to the wrong
 * zone, the alchemy and enhancing panels read a queued action's item, and the
 * task panel took queue[0] as "active". Every "which action is running"
 * question goes through here.
 *
 * Stateless by design — it is bundled into several feature bundles (see the
 * allowlist in scripts/check-bundle-sharing.mjs) and every copy answers alike.
 */

/**
 * The action the game is actually running, among those matching `predicate`,
 * chosen by execution order (lowest ordinal) rather than array position.
 *
 * @param {Array<{actionHrid?: string, isDone?: boolean, ordinal?: number}>} actions
 *   The character action queue (e.g. `dataManager.getCurrentActions()` or
 *   `characterData.characterActions`).
 * @param {(action: Object) => boolean} [predicate] - Which actions qualify;
 *   defaults to every action, i.e. "the front of the whole queue".
 * @param {Object} [options]
 * @param {boolean} [options.includeFinished=false] - When no unfinished match
 *   exists, fall back to the lowest-ordinal finished one rather than null.
 *   Callers that must still name an action the instant it ends (a recorder
 *   folding a just-banked segment, an export of a finished character) want
 *   this; live header chips do not.
 * @returns {Object|null} The running matching action, or null when none qualifies.
 */
export function runningAction(actions, predicate = () => true, { includeFinished = false } = {}) {
    if (!Array.isArray(actions)) return null;

    const matching = actions.filter((a) => a && predicate(a));
    if (matching.length === 0) return null;

    const active = matching.filter((a) => !a.isDone);
    const pool = active.length > 0 ? active : includeFinished ? matching : active;
    if (pool.length === 0) return null;

    return pool.reduce((lowest, a) => ((a.ordinal ?? 0) < (lowest.ordinal ?? 0) ? a : lowest));
}

/**
 * The combat action the game is actually running — `runningAction` narrowed
 * to `/actions/combat/` hrids.
 *
 * @param {Array<Object>} actions - The character action queue
 * @param {Object} [options] - As for {@link runningAction}
 * @returns {Object|null}
 */
export function runningCombatAction(actions, options) {
    return runningAction(actions, (a) => String(a.actionHrid || '').startsWith('/actions/combat/'), options);
}
