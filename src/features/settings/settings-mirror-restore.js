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

import config from '../../core/config.js';
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
 * session, but does not hold that call up: the dialog is shown, not awaited.
 * A player who walks away from it must not leave the whole feature layer
 * dormant behind an unanswered prompt, so this resolves as soon as the offer
 * is showing (or immediately, when there is nothing to offer) and the
 * player's eventual answer is handled by a detached continuation — see
 * {@link handleChoice}. An answer that arrives after the caller's own
 * `loadSettings()` has already run has to reach the settings map through the
 * same normal path explicitly: {@link SettingsStorage#importSettings}, then
 * `config.loadSettings()` again so every feature already listening for
 * `onSettingsLoaded` resyncs to the restored values, exactly as a character
 * switch does.
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

        // Not awaited: showing the dialog is as far as this call goes. The
        // player's answer — however long it takes — is handled below without
        // holding up whoever called maybeOffer().
        askChoice({
            title: 'Restore your settings?',
            message:
                `${characterName || 'This character'} has no saved Toolasha settings on this browser, but a ` +
                'backup copy from an earlier session is available (kept outside the page, so it survives things ' +
                'like a browser crash wiping local data). Restore it, or start fresh with defaults?',
            choices: [
                { value: 'restore', label: 'Restore my settings', tone: 'primary' },
                { value: 'skip', label: 'Start fresh' },
            ],
        })
            .then((choice) => handleChoice(choice, characterId, characterKey, mirrored))
            .catch((error) => {
                console.error('[SettingsMirrorRestore] Could not offer to restore settings:', error);
            });
    } catch (error) {
        console.error('[SettingsMirrorRestore] Could not offer to restore settings:', error);
    }
}

/**
 * Act on the player's eventual answer to the restore dialog. Runs detached
 * from `maybeOffer()`, arbitrarily long after startup (or a character switch)
 * has already moved on.
 *
 * @param {string|null} choice - What `askChoice` resolved to
 * @param {string|number} characterId - The character the offer was made for
 * @param {string} characterKey - That character's settings-map storage key
 * @param {Object} mirrored - The mirrored settings-map entry to restore
 * @returns {Promise<void>}
 * @private
 */
async function handleChoice(choice, characterId, characterKey, mirrored) {
    if (choice !== 'restore') return;

    // The dialog can be left open for as long as the player leaves it open,
    // and a trip out to character select and into a different character is
    // exactly the thing a player does when their settings look wrong.
    // `importSettings` filters by `settingsStorage.currentCharacterId`, which
    // the arriving character's own load has moved by then, so the accepted
    // restore would quietly count this map as "belongs to another character"
    // and skip it — a Restore click that reports success and writes nothing.
    // Re-asserting the id instead would be worse: the singleton is what every
    // concurrent save reads, so pointing it back at the departed character
    // files the character the player is now looking at under the wrong key.
    // Leave it alone and say what happened.
    if (String(settingsStorage.currentCharacterId) !== String(characterId)) {
        console.warn(
            `[SettingsMirrorRestore] Restore for ${characterId} abandoned: the active character changed to ` +
                `${settingsStorage.currentCharacterId} while the dialog was open`
        );
        return;
    }

    const result = await settingsStorage.importSettings(JSON.stringify({ [characterKey]: mirrored }));
    if (!result) {
        console.error('[SettingsMirrorRestore] Restore import failed');
        return;
    }

    // Re-checked, not merely asserted once above: importSettings() itself
    // awaits (a known-characters read, one storage write per key), a second
    // window in which a switch can land. Reloading now would pull this
    // character's just-imported map into the arriving character's live
    // session — the same wrong-character mistake the check above exists to
    // avoid, just later.
    if (String(settingsStorage.currentCharacterId) !== String(characterId)) {
        console.warn(
            `[SettingsMirrorRestore] Restore for ${characterId} imported, but the active character changed to ` +
                `${settingsStorage.currentCharacterId} before the reload; not reloading here`
        );
        return;
    }

    // The normal settings-load path: reload the map that was just imported
    // and let it reconcile through migrations and default rewrites exactly
    // like any other imported map, then resync every listener the way a
    // character switch does.
    await config.loadSettings();
    config.applyColorSettings();
}

export default { maybeOffer };
