/**
 * Running-action helpers
 *
 * The character's action list is a queue, not an execution-ordered array. A
 * repeating action that has run many times is requeued to the *front* of the
 * array with a *higher* ordinal, so "the current action" read as `actions[0]`,
 * `actions.find(a => !a.isDone)`, or the first match of a `for…of` routinely
 * returns an action that is queued *behind* the one actually running.
 * Execution order is the game's own queue order — party actions first, then
 * ascending `ordinal` (see `compareActionQueueOrder`) — so the running action
 * is the front unfinished one under that order.
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
 * `dataManager` now keeps its copy (`getCurrentActions()`) sorted by ordinal
 * on every write, so a whole-queue walk over it runs in execution order. The
 * raw `characterData.characterActions` login snapshot is not sorted, and a
 * position read still misses `isDone`, so "which action is running" still
 * comes here — `src/utils/action-queue-position-reads.test.js` fails the build
 * on a new `[0]` or first-unfinished `.find` over the queue.
 *
 * Stateless by design — it is bundled into several feature bundles (see the
 * allowlist in scripts/check-bundle-sharing.mjs) and every copy answers alike.
 */

/**
 * The game client's own action-queue comparator: actions in a party
 * (`partyID` non-zero) sort ahead of solo ones, then ascending `ordinal`. The
 * game sorts its list with this (a stable sort, no id tie-break) and runs the
 * front of it.
 *
 * Ordinal alone is not execution order. Dragging a queued action into the
 * first queued slot behind a running party fight gave it ordinal -4294967077
 * while the fight sat at 0; the game kept fighting and listed the fight first
 * because it has a party. Reading by ordinal alone judged the queued cooking
 * action as running ("Red Culinary Hat not equipped" during combat).
 *
 * A missing `partyID` or `ordinal` counts as 0 (solo; the game's own check is
 * `partyID !== 0`, and the wire always carries the field), so partial actions
 * and test fixtures sort by ordinal as before.
 *
 * @param {{partyID?: number, ordinal?: number}} a
 * @param {{partyID?: number, ordinal?: number}} b
 * @returns {number} Negative when `a` runs before `b`
 */
export function compareActionQueueOrder(a, b) {
    const aInParty = (a?.partyID ?? 0) !== 0;
    const bInParty = (b?.partyID ?? 0) !== 0;
    if (aInParty !== bInParty) return aInParty ? -1 : 1;
    return (a?.ordinal ?? 0) - (b?.ordinal ?? 0);
}

/**
 * The action the game is actually running, reported only when it matches
 * `predicate`, chosen by execution order (`compareActionQueueOrder`) rather
 * than array position.
 *
 * The queue is a single timeline: only one action executes at a time, in
 * ascending-ordinal order, whatever mix of types sits in it. So "the running
 * action" is found *first*, over every action regardless of type, and
 * `predicate` is then asked only whether that one action qualifies — it is
 * never used to narrow the candidate pool before ordinals are compared.
 * Filtering first and picking the lowest ordinal *within* the filtered set
 * (an earlier version of this function did exactly that) answers a different
 * question — "which matching action has the lowest ordinal", which is a
 * queued one whenever a non-matching action is what actually holds the
 * lowest ordinal. That produced `runningCombatAction` reporting a dungeon
 * queued behind a running crafting action as the fight in progress, which
 * armed the dungeon tracker's panel on a character that was crafting.
 *
 * @param {Array<{actionHrid?: string, isDone?: boolean, ordinal?: number}>} actions
 *   The character action queue (e.g. `dataManager.getCurrentActions()` or
 *   `characterData.characterActions`).
 * @param {(action: Object) => boolean} [predicate] - Whether the running
 *   action qualifies; defaults to every action, i.e. "the front of the whole
 *   queue". Never used to select among several matches — only one action is
 *   ever running.
 * @param {Object} [options]
 * @param {boolean} [options.includeFinished=false] - When no unfinished
 *   action exists at all, fall back to the lowest-ordinal finished one rather
 *   than null. Callers that must still name an action the instant it ends (a
 *   recorder folding a just-banked segment, an export of a finished
 *   character) want this; live header chips do not.
 * @returns {Object|null} The running action, or null when it does not exist
 *   or does not match `predicate` (including when a non-matching action is
 *   the one actually running).
 */
export function runningAction(actions, predicate = () => true, { includeFinished = false } = {}) {
    if (!Array.isArray(actions)) return null;

    const present = actions.filter((a) => a);
    if (present.length === 0) return null;

    const active = present.filter((a) => !a.isDone);
    const pool = active.length > 0 ? active : includeFinished ? present : active;
    if (pool.length === 0) return null;

    // First of equals wins, as the game's stable sort keeps them
    const running = pool.reduce((front, a) => (compareActionQueueOrder(a, front) < 0 ? a : front));
    return predicate(running) ? running : null;
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

/**
 * The difficulty tier the player last chose for a combat zone, read from
 * their own action queue — never guessed.
 *
 * A queued (not yet running) copy of the zone counts exactly as much as a
 * running one: both are the tier the player themselves picked the last time
 * they set this zone up, which is the only honest source available. There is
 * no persisted "last fought tier" history once a zone leaves the queue — the
 * game does not record one and this reads nothing that was invented for the
 * purpose (see the callers in `task-profit-display.js`).
 *
 * When the same zone appears more than once in the queue (rare — normally at
 * the same tier either way), the earliest one in execution order wins, same
 * tie-break as {@link runningAction}.
 *
 * @param {Array<{actionHrid?: string, difficultyTier?: number, ordinal?: number, partyID?: number}>} actions -
 *   The character action queue (e.g. `dataManager.getCurrentActions()`)
 * @param {string} zoneHrid - The combat zone's action hrid
 * @returns {number|null} The tier last set for this zone, or null when the
 *   zone is not anywhere in the queue
 */
export function lastUsedTierForZone(actions, zoneHrid) {
    if (!Array.isArray(actions) || !zoneHrid) return null;

    const matches = actions.filter((a) => a && a.actionHrid === zoneHrid);
    if (matches.length === 0) return null;

    const front = matches.reduce((f, a) => (compareActionQueueOrder(a, f) < 0 ? a : f));
    return Number(front.difficultyTier) || 0;
}
