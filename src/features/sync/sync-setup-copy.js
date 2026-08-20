/**
 * Copy this character's sync setup onto the device's other characters.
 *
 * Settings are stored per character (`script_settingsMap_<characterId>`), so a
 * player with a main and an iron cow on the same browser has to paste the same
 * GitHub token into two settings panels by hand — and a typo in either one is a
 * sync that silently never runs. This copies the whole Cross-Device Sync group
 * across in one click.
 *
 * Only the sync group travels. The gist id itself does not need to: it lives
 * under a device-wide key (`toolasha_sync_gistId` in the settings store, with no
 * character suffix), so every character on this browser already shares the one
 * this device is linked to.
 *
 * Nothing here talks to the network or to the game. It reads the settings map in
 * hand and writes IndexedDB, which is where the token already was.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import settingsStorage from '../../core/settings-storage.js';
import { settingsGroups } from '../../core/settings-schema.js';
import { showToast } from '../../utils/toast.js';

/** The sync group's setting ids, taken from the schema so it cannot drift */
export const SYNC_SETTING_IDS = Object.keys(settingsGroups.sync?.settings ?? {});

/**
 * The current character's sync settings, as stored settings-map entries.
 * @returns {Object} Entries by setting id
 */
export function syncSetupEntries() {
    const entries = {};
    for (const id of SYNC_SETTING_IDS) {
        const entry = config.settingsMap?.[id];
        if (entry && typeof entry === 'object') entries[id] = { ...entry };
    }
    return entries;
}

/**
 * Whether there is a sync setup here worth copying: the switch is on and a
 * token has been pasted. Copying an empty token to three characters is not a
 * favour, it is three characters that now look configured and are not.
 * @returns {boolean}
 */
function isConfiguredHere() {
    if (!config.getSetting('sync_enabled', false)) return false;
    return String(config.getSetting('sync_token', '') ?? '').trim().length > 0;
}

/**
 * Write this character's sync settings onto every other character on this
 * device that has settings saved, and say what happened.
 *
 * @returns {Promise<{ok: boolean, copied: number, skipped: string[], message: string}>}
 */
export async function copySyncSetupToOtherCharacters() {
    if (!isConfiguredHere()) {
        const message = 'Set sync up on this character first — turn it on and paste your GitHub token.';
        showToast(message, { kind: 'warn' });
        return { ok: false, copied: 0, skipped: [], message };
    }

    try {
        const characterId = dataManager.getCurrentCharacterId?.();
        if (characterId) {
            settingsStorage.setCharacterId(characterId, dataManager.getCurrentCharacterName?.());
        }

        const { copied, skipped } = await settingsStorage.copySettingEntriesToOtherCharacters(syncSetupEntries());

        if (copied.length === 0) {
            const message = skipped.length
                ? `No other character has settings saved yet (${skipped.map((c) => c.name).join(', ')}). ` +
                  'Open Toolasha on it once, then copy again.'
                : 'No other characters found on this device.';
            showToast(message, { kind: 'warn' });
            return { ok: false, copied: 0, skipped: skipped.map((c) => c.name), message };
        }

        const plural = copied.length === 1 ? '' : 's';
        let message =
            `Sync setup copied to ${copied.length} character${plural} (${copied.map((c) => c.name).join(', ')}). ` +
            'The token stays on this device — nothing was uploaded.';
        if (skipped.length) {
            message += ` Skipped ${skipped.map((c) => c.name).join(', ')} — no settings saved yet.`;
        }
        showToast(message);
        return { ok: true, copied: copied.length, skipped: skipped.map((c) => c.name), message };
    } catch (error) {
        console.error('[SyncSetupCopy] Copying the sync setup failed:', error);
        const message = 'Copying the sync setup failed — see the console.';
        showToast(message, { kind: 'error' });
        return { ok: false, copied: 0, skipped: [], message };
    }
}
