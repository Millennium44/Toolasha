/**
 * Where the Iron Bell Farming panel's own state lives.
 *
 * Two things, both per character: the manual ticks for the one plan stage
 * nothing can measure, and the last costed loop so the panel has a figure to
 * draw the instant it opens. Neither is ever read back as fact — the ticks can
 * only add to what the character's state already derived, and the snapshot is
 * replaced the moment a refresh finishes.
 *
 * Every key goes through {@link characterKey}'s helpers. An iron cow's plan is
 * not the main's plan, and a bare key would show each of them the other's.
 */

import { readScoped, writeScoped } from '../../utils/character-key.js';

// The panel's display name changed to "Iron Bell Farming", but these two keys
// are kept exactly as they were (ironCowFarmOverrides / ironCowFarmSnapshot) —
// renaming them would orphan the stage ticks and the last costed loop that
// existing users already have stored under them.

/** Unscoped key for the manual stage ticks; the real key carries the character id */
export const OVERRIDES_KEY = 'ironCowFarmOverrides';

/** Unscoped key for the last costed loop */
export const SNAPSHOT_KEY = 'ironCowFarmSnapshot';

/**
 * This character's manual stage ticks.
 * @returns {Promise<Object>} Stage id → true
 */
export async function loadOverrides() {
    try {
        // 'discard': there is no legacy global to inherit, and a tick made by
        // another character says nothing about this one's levels.
        const stored = await readScoped(OVERRIDES_KEY, 'settings', {}, { migrate: 'discard' });
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
        const clean = {};
        for (const [id, value] of Object.entries(stored)) {
            if (value === true) clean[id] = true;
        }
        return clean;
    } catch (error) {
        console.error('[IronCow] Loading the stage ticks failed:', error);
        return {};
    }
}

/**
 * Turn one stage's manual tick on or off.
 * @param {string} stageId - Which stage
 * @param {boolean} ticked - On or off
 * @returns {Promise<Object>} The new tick map
 */
export async function setOverride(stageId, ticked) {
    const overrides = await loadOverrides();
    if (ticked) overrides[stageId] = true;
    else delete overrides[stageId];
    try {
        await writeScoped(OVERRIDES_KEY, overrides, 'settings');
    } catch (error) {
        console.error('[IronCow] Saving the stage ticks failed:', error);
    }
    return overrides;
}

/**
 * The last costed loop, for drawing before a refresh finishes.
 * @returns {Promise<Object|null>} The snapshot
 */
export async function loadSnapshot() {
    try {
        const stored = await readScoped(SNAPSHOT_KEY, 'settings', null, { migrate: 'discard' });
        return stored && typeof stored === 'object' ? stored : null;
    } catch (error) {
        console.error('[IronCow] Loading the last loop failed:', error);
        return null;
    }
}

/**
 * Remember the loop just costed.
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @returns {Promise<void>}
 */
export async function saveSnapshot(loop) {
    try {
        await writeScoped(SNAPSHOT_KEY, loop || null);
    } catch (error) {
        console.error('[IronCow] Saving the last loop failed:', error);
    }
}

export default { OVERRIDES_KEY, SNAPSHOT_KEY, loadOverrides, setOverride, loadSnapshot, saveSnapshot };
