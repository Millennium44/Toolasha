/**
 * Lab Sim: which loadout each skilling room is simulated with, per character.
 *
 * The record is `{ '/skills/woodcutting': '<loadout name>', ... }` under
 * `labSimSkillingLoadouts_<characterId>` in `settings`. An empty string means
 * "current gear", so an entry is never deleted, only set.
 */
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

export const SKILLING_LOADOUTS_KEY = 'labSimSkillingLoadouts';

/**
 * Whether a value is a usable assignment map.
 * @param {*} value - A stored value
 * @returns {boolean} True for a plain object
 */
function isMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Fold a downloaded assignment map onto this device's. Skills only one side has
 * assigned are kept; where both have one, the incoming (newer) choice wins.
 * @param {*} local - This device's stored value
 * @param {*} incoming - The downloaded value
 * @returns {*} The combined map
 */
export function mergeSkillingLoadouts(local, incoming) {
    if (!isMap(incoming)) return isMap(local) ? local : incoming;
    if (!isMap(local)) return incoming;
    return { ...local, ...incoming };
}

registerSyncMerge({
    store: 'settings',
    base: SKILLING_LOADOUTS_KEY,
    merge: mergeSkillingLoadouts,
    label: 'Lab Sim skill loadouts',
    // The Skilling tab's in-memory copy is replaced by the pull hook (`_adoptPulledSkillLoadouts`) and every write
    // folds the stored map under it, so a pulled copy is never written back over
    liveSafe: true,
});
