/**
 * Scroll Planner storage
 *
 * - The last plan used is account-wide (`scrollPlanner_lastPlan`), so it can be loaded on any
 *   character, and it travels with the sync.
 * - An in-progress run is per character (`scrollPlanner_run_<characterId>`): it describes that
 *   character's inventory. It stays on the device that started it (see LOCAL_ONLY_KEY_PREFIXES in
 *   sync-payload.js), the way a dungeon run in progress does — a run pulled from another device
 *   would put a progress bar up and open an item menu here unasked.
 *
 * The character id is always passed in by the caller, captured before its first await, so a
 * character switch during a write can never land one character's run under another's key.
 */

import storage from '../../../core/storage.js';

const STORE_NAME = 'settings';

/** Last plan used, itemHrid -> quantity */
export const LAST_PLAN_KEY = 'scrollPlanner_lastPlan';

/** Base of the per-character run key */
export const RUN_KEY_BASE = 'scrollPlanner_run';

/**
 * @param {string} characterId
 * @returns {string} The run key for that character
 */
export function runKey(characterId) {
    return `${RUN_KEY_BASE}_${characterId}`;
}

/**
 * @returns {Promise<Object|null>} Last plan used (itemHrid -> quantity), or null
 */
export async function loadLastPlan() {
    return storage.getJSON(LAST_PLAN_KEY, STORE_NAME, null);
}

/**
 * @param {Object<string, number>} plan
 * @returns {Promise<boolean>}
 */
export async function saveLastPlan(plan) {
    return storage.setJSON(LAST_PLAN_KEY, plan, STORE_NAME, true);
}

/**
 * @param {string} characterId
 * @returns {Promise<Object|null>} Saved in-progress run for this character, or null
 */
export async function loadRun(characterId) {
    if (!characterId) {
        return null;
    }
    return storage.getJSON(runKey(characterId), STORE_NAME, null);
}

/**
 * @param {string} characterId
 * @param {Object} run
 * @returns {Promise<boolean>}
 */
export async function saveRun(characterId, run) {
    if (!characterId) {
        return false;
    }
    return storage.setJSON(runKey(characterId), run, STORE_NAME, true);
}

/**
 * @param {string} characterId
 * @returns {Promise<boolean>}
 */
export async function clearRun(characterId) {
    if (!characterId) {
        return false;
    }
    return storage.delete(runKey(characterId), STORE_NAME);
}
