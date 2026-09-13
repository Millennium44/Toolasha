/**
 * Holding a labyrinth run as one session.
 *
 * The damage and damage-taken trackers key a session on the roster plus
 * `combatStartTime` (`sessionKeyFor` in each), because the same party starting
 * a new zone is a new run. Inside a labyrinth that rule fires on every room:
 * each room is its own `combatStartTime`, so a run that should read as one
 * long farm instead resets its tables at every door.
 *
 * `labyrinth_updated` is the one message that already knows better — it names
 * the run with `startedAt` and says when it ends with `isActive`, the same
 * flag `labyrinth-room-logs.js` and `combat-battle-counter.js` already read.
 * This holds just enough of it to answer one question: while a run is active,
 * what session key should override the roster-based one.
 */

/**
 * A fresh tracker of whether a labyrinth run is active, and its key.
 * @returns {{active: boolean, key: string|null}}
 */
export function newLabyrinthSessionState() {
    return { active: false, key: null };
}

/**
 * Fold one `labyrinth_updated` message into the state.
 *
 * @param {Object} state - From `newLabyrinthSessionState`, mutated
 * @param {Object} data - The `labyrinth_updated` payload
 */
export function noteLabyrinthUpdate(state, data) {
    const labyrinth = data?.labyrinth;
    if (!labyrinth || labyrinth.isActive === false) {
        state.active = false;
        state.key = null;
        return;
    }
    state.active = true;
    // Recomputed on every update rather than latched on the first one: it is
    // read from the same field every room's message carries, so there is
    // nothing to preserve by not recomputing it, and no room in which
    // `startedAt` is expected to change while `isActive` stays true.
    state.key = `labyrinth|${labyrinth.startedAt || ''}`;
}

/**
 * The session key a `new_battle` should use.
 *
 * @param {Object} state - From `newLabyrinthSessionState`
 * @param {string|null} fallbackKey - What the roster-based `sessionKeyFor` returned
 * @returns {string|null} The labyrinth key while a run is active, else `fallbackKey`
 */
export function labyrinthSessionKey(state, fallbackKey) {
    return state?.active && state.key ? state.key : fallbackKey;
}
