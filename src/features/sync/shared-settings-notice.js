/**
 * Tell the player what the device-wide settings carry-over decided.
 *
 * Cross-device sync, the colour palette, number formatting and the quiet-hours
 * clock used to be stored per character, so every alt needed its own token
 * pasted in and its own 28 swatches re-picked. They are now one device-wide map,
 * seeded once from whatever the characters already held
 * (`settingsStorage.migrateSharedSettings`). When they disagreed the carry-over
 * had to choose, or decline to — and neither may happen silently, because the
 * value in force afterwards is the one every character now uses.
 *
 * Core cannot reach the toast helper (Core loads before Utils), so the record is
 * written to storage there and shown from here, once, then cleared.
 */

import settingsStorage from '../../core/settings-storage.js';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { showToast } from '../../utils/toast.js';

/**
 * How many settings are named before the rest are counted.
 *
 * A palette is 28 swatches. Two characters themed differently can genuinely
 * disagree on all of them, and 28 sentences in a toast is a wall nobody reads —
 * the settings panel is where the actual values are. Naming a few and counting
 * the rest keeps the message something a player can act on.
 */
const NAME_LIMIT = 3;

/**
 * A setting's panel label, for a message the player has to act on.
 * @param {string} settingId
 * @returns {string}
 */
function labelFor(settingId) {
    return getSettingDefinition(settingId)?.label ?? settingId;
}

/**
 * The labels of some conflicts, with the rest counted rather than listed.
 * @param {Array<{id: string}>} conflicts
 * @returns {string}
 */
function nameSome(conflicts) {
    const named = conflicts.slice(0, NAME_LIMIT).map((conflict) => `"${labelFor(conflict.id)}"`);
    const rest = conflicts.length - named.length;
    return rest > 0 ? `${named.join(', ')} and ${rest} more` : named.join(', ');
}

/**
 * Every character named across a set of conflicts, in the order first seen.
 * @param {Array<{characters: string[]}>} conflicts
 * @returns {string}
 */
function charactersIn(conflicts) {
    return [...new Set(conflicts.flatMap((conflict) => conflict.characters ?? []))].join(', ');
}

/**
 * What to tell the player to do about the ones nothing was decided for.
 *
 * "Copy sync setup to this device's other characters" carries the sync section
 * and nothing else, so it is the right advice for a token and the wrong advice
 * for a colour. Re-picking the value on the character that has it works for
 * both, because any save of a shared id writes it device-wide.
 *
 * @param {Array<{id: string}>} conflicts - The unresolved ones
 * @returns {string}
 */
function adviceFor(conflicts) {
    const syncOnly = conflicts.every((conflict) => conflict.id?.startsWith('sync_'));
    return syncOnly
        ? 'open the alt whose value you want and press "Copy sync setup to this device\'s other characters".'
        : 'open the alt whose values you want and re-pick them there — saving one now sets it for every character.';
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

        const resolved = record.conflicts.filter((conflict) => conflict.resolved);
        const unresolved = record.conflicts.filter((conflict) => !conflict.resolved);

        const parts = [
            'Colours, number formatting, quiet hours and cross-device sync settings are now shared by every ' +
                'character on this device.',
        ];
        if (resolved.length > 0) {
            const winners = [...new Set(resolved.map((conflict) => conflict.winner).filter(Boolean))].join(', ');
            parts.push(
                `${nameSome(resolved)} differed between your characters; this device now uses ${winners}'s. ` +
                    'The other values are still on the characters that had them.'
            );
        }
        if (unresolved.length > 0) {
            parts.push(
                `${nameSome(unresolved)} differed between ${charactersIn(unresolved)} and none of them is the ` +
                    `character you are on, so they were left alone — ${adviceFor(unresolved)}`
            );
        }

        showToast(parts.join(' '), { kind: 'warn' });
        await settingsStorage.clearSharedScopeConflicts();
        return true;
    } catch (error) {
        console.error('[SyncSharedSettings] Showing the carry-over notice failed:', error);
        return false;
    }
}
