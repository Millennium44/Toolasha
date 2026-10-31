/**
 * What the labyrinth recorders need to know before they consume a raw game frame: whether the
 * frame came from this character's connection, and whether the fight on screen is a labyrinth one.
 */

import dataManager from '../../core/data-manager.js';
import { runningAction } from '../../utils/combat-actions.js';

/** The action type a labyrinth action carries */
const LABYRINTH_ACTION_TYPE = '/action_types/labyrinth';

/** The labyrinth is named in the header in the player's own language */
const LABYRINTH_HEADER = /labyrinth|迷宫|迷宮/i;

/**
 * Whether a raw frame came from the socket belonging to the current character. Permissive when
 * dataManager cannot tell, as the other trackers are.
 * @param {Object} [context] - Delivery context from the WebSocket hook
 * @returns {boolean} False only when dataManager knows the frame is stale
 */
export function isFromActiveSocket(context) {
    return typeof dataManager.isFromActiveSocket !== 'function' || dataManager.isFromActiveSocket(context);
}

/**
 * Whether the fight on screen is a labyrinth fight.
 *
 * Identified by the running action over the whole queue: the labyrinth's only action is
 * `/actions/labyrinth/explore` with type `/action_types/labyrinth` (it is not a combat action),
 * which does not depend on the game's display language. A labyrinth run stays active while you
 * fight a regular zone, but then the running action is the zone's, so this says no. Only when no
 * action is known (the queue not loaded yet) is the header text read as a fallback.
 * @returns {boolean}
 */
export function isLabyrinthFightActive() {
    try {
        const action = runningAction(dataManager.getCurrentActions?.() || []);
        if (action?.actionHrid) {
            const type = dataManager.getActionDetails?.(action.actionHrid)?.type;
            return type === LABYRINTH_ACTION_TYPE || /^\/actions\/labyrinth(\/|$)/.test(action.actionHrid);
        }
    } catch {
        // fall through to the header
    }
    const row = document.querySelector("div[class*='Header_actionName']");
    return !!row && LABYRINTH_HEADER.test(row.textContent || '');
}
