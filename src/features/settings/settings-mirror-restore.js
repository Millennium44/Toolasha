/**
 * Settings Mirror Restore
 *
 * Offers to bring a character's settings back from the GM-side mirror
 * (`core/settings-mirror.js`) when the live IndexedDB map for that character
 * is missing — the state left behind by the kind of whole-origin wipe a
 * browser crash caused on 2026-09-17.
 *
 * Never restores automatically. A character with no live settings map cannot,
 * on its own, be told apart from a genuinely new character that has simply
 * never been played on this browser before — treating "no settings" as "must
 * be a wipe" would ambush a brand-new player with a restore dialog on their
 * first login. The dialog only appears when there is something concrete to
 * offer: the mirror actually holds a map for this exact character.
 */

import storage from '../../core/storage.js';
import settingsStorage from '../../core/settings-storage.js';
import settingsMirror from '../../core/settings-mirror.js';
import { askChoice } from '../../utils/choice-dialog.js';

/**
 * Offer to restore this character's settings from the mirror, if the live
 * map is missing and the mirror has one. Quietly does nothing otherwise: a
 * character that already has a settings map (or one that could not be read
 * right now) is never touched, and a character the mirror has never heard of
 * gets no dialog at all.
 *
 * Meant to run before this character's own `config.loadSettings()` for the
 * session. An accepted restore writes the map through
 * {@link SettingsStorage#importSettings} — the same path a settings file
 * "arrived from elsewhere" takes — so the very next `loadSettings()` call
 * reconciles it through migrations and default rewrites exactly like any
 * other imported map. No second reload happens here; the caller's own
 * `loadSettings()` is the normal load path this restore lands through.
 *
 * @param {string|number} characterId
 * @param {string} [characterName]
 * @returns {Promise<void>}
 */
async function maybeOffer(characterId, characterName) {
    if (!characterId) return;
    try {
        // Matches config.loadSettings()'s own first move — set before the
        // probe below so importSettings() (which filters by this) sees the
        // same character it is about to restore for.
        settingsStorage.setCharacterId(characterId, characterName);

        const characterKey = `${settingsStorage.storageKey}_${characterId}`;

        // "Absent", not merely "unreadable": tryGet tells the two apart, and
        // an unreadable store must never be treated as safe to restore over —
        // it may hold real settings the read simply could not reach right now.
        const probed = await storage.tryGet(characterKey, settingsStorage.storageArea);
        if (probed === null || probed.found) return;

        const mirrored = settingsMirror.getMirroredEntry(characterKey);
        if (!mirrored || Object.keys(mirrored).length === 0) return;

        const choice = await askChoice({
            title: 'Restore your settings?',
            message:
                `${characterName || 'This character'} has no saved Toolasha settings on this browser, but a ` +
                'backup copy from an earlier session is available (kept outside the page, so it survives things ' +
                'like a browser crash wiping local data). Restore it, or start fresh with defaults?',
            choices: [
                { value: 'restore', label: 'Restore my settings', tone: 'primary' },
                { value: 'skip', label: 'Start fresh' },
            ],
        });

        if (choice !== 'restore') return;

        const result = await settingsStorage.importSettings(JSON.stringify({ [characterKey]: mirrored }));
        if (!result) {
            console.error('[SettingsMirrorRestore] Restore import failed');
        }
    } catch (error) {
        console.error('[SettingsMirrorRestore] Could not offer to restore settings:', error);
    }
}

export default { maybeOffer };
