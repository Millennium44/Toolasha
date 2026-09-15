/**
 * Shared by the three alchemy history trackers (transmute, decompose,
 * coinify) to decide whether their action is the one actually running, from
 * the full action queue rather than a partial `actions_updated` delta.
 *
 * `actions_updated` messages are a partial update — only the actions that
 * changed, whether added, reordered or finished — not a snapshot of the
 * queue. Scanning `data.endCharacterActions` for this alchemy type breaks in
 * ways the full queue does not:
 * - queuing an unrelated action (e.g. cooking) behind a running transmute
 *   produces an update with no transmute row in it at all, even though the
 *   transmute keeps running — so a delta-only read has to treat that as "no
 *   session", ending one that is still in progress
 * - queuing a second transmute for a different item behind the running one
 *   puts the QUEUED item's row in the delta, not the running one's, so a
 *   `.find` over it switches the session to an item that has not started yet
 * - a just-finished (`isDone`) row can still appear in the delta and reads as
 *   "present"
 *
 * The queue itself is insertion order, not execution order — a repeating
 * action requeued to the front carries a HIGHER ordinal (see
 * `utils/combat-actions.js`) — so `runningAction`, not `.find`, is what picks
 * the action the game is actually executing. `alchemy-action-protection.js`
 * already reads the queue this same way for the same reason.
 */

import { runningAction } from '../../utils/combat-actions.js';

/**
 * The alchemy action of `actionHrid` that is actually running right now.
 *
 * @param {Array<Object>} actions - The full queue, e.g. `dataManager.getCurrentActions()`
 * @param {string} actionHrid - The alchemy action hrid to match
 * @returns {Object|null} The running action, or null when a different action
 *   (or nothing) holds the front of the queue
 */
export function runningAlchemyAction(actions, actionHrid) {
    return runningAction(actions, (a) => a.actionHrid === actionHrid);
}
