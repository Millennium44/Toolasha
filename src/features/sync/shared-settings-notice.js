/**
 * Tell the player what the account-wide settings carry-over decided.
 *
 * The Cross-Device Sync group used to be stored per character, so every alt
 * needed its own GitHub token pasted in by hand. It is now one device-wide map,
 * seeded once from whatever the characters already held
 * (`settingsStorage.migrateSharedSettings`). When they disagreed the carry-over
 * had to choose, or decline to — and neither may happen silently, because the
 * value in force afterwards is the one every character will sync with.
 *
 * Core cannot reach the toast helper (Core loads before Utils), so the record is
 * written to storage there and shown from here, once, then cleared.
 */

import settingsStorage from '../../core/settings-storage.js';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { showToast } from '../../utils/toast.js';

/**
 * A setting's panel label, for a message the player has to act on.
 * @param {string} settingId
 * @returns {string}
 */
function labelFor(settingId) {
    return getSettingDefinition(settingId)?.label ?? settingId;
}

/**
 * One conflict, as a sentence.
 * @param {{id: string, resolved: boolean, winner: ?string, characters: string[]}} conflict
 * @returns {string}
 */
function describe(conflict) {
    const where = conflict.characters.join(', ');
    if (conflict.resolved) {
        return `"${labelFor(conflict.id)}" differed between ${where}; this device now uses ${conflict.winner}'s.`;
    }
    return (
        `"${labelFor(conflict.id)}" differed between ${where} and none of them is the character you are on, ` +
        'so it was left alone — open the alt whose value you want and press "Copy sync setup to my other characters".'
    );
}

/**
 * Show the carry-over's conflict record once, then forget it.
 *
 * Nothing was lost either way: every character still holds its own value, so a
 * choice made here can always be re-made from the alt that lost.
 *
 * @returns {Promise<boolean>} Whether a notice was shown
 */
export async function showSharedSettingsNotice() {
    try {
        const record = await settingsStorage.sharedScopeConflicts();
        if (!record) return false;

        const message =
            'Your cross-device sync settings are now shared by every character on this device. ' +
            record.conflicts.map(describe).join(' ');
        showToast(message, { kind: 'warn' });
        await settingsStorage.clearSharedScopeConflicts();
        return true;
    } catch (error) {
        console.error('[SyncSharedSettings] Showing the carry-over notice failed:', error);
        return false;
    }
}
