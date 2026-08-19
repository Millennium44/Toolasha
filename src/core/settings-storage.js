/**
 * Settings Storage Module
 * Handles persistence of settings to chrome.storage.local
 */

import storage from './storage.js';
import { settingsGroups } from './settings-schema.js';

/**
 * Whether a schema type stores its state as a boolean (.isTrue)
 * @param {string} type - Setting type from the schema
 * @returns {boolean}
 */
/**
 * The one value a stored or built setting entry carries: `.value` when it
 * has one, else `.isTrue`.
 * @param {Object} entry - A settings-map entry
 * @returns {*} Its value
 */
function valueOf(entry) {
    if (!entry || typeof entry !== 'object') return undefined;
    return Object.hasOwn(entry, 'value') ? entry.value : entry.isTrue;
}

function isBooleanType(type) {
    return type === 'checkbox' || type === 'checkboxWithButton';
}

/**
 * Schema defaults that changed after release, and the value they changed from.
 *
 * A changed schema default only reaches a fresh install. The saved map is
 * written whole — every setting the schema had at save time is in it, chosen or
 * not — so an existing user holds the *old* default as an explicit stored
 * value, and the merge below faithfully restores it forever. That is right for
 * a setting the user actually picked and wrong for one they never touched, and
 * storage cannot tell the two apart.
 *
 * So each entry is rewritten exactly once, guarded by a persisted flag: an old
 * default is nudged to the new one on the first load that sees it, and after
 * that the user's value is theirs. Someone who deliberately re-picks the old
 * value keeps it, because the flag has already been set.
 *
 * `from` is the value being replaced — anything else stays put, since a user
 * who chose a third option was never sitting on the old default.
 */
const DEFAULT_REWRITES = [
    // Replaying the live fight runs the real combat engine hundreds of times
    // mid-fight; it should be opt-in rather than something every player pays for
    { id: 'labyrinthLiveCombatSim', field: 'isTrue', from: true, to: false },
    // Routing unrevealed rooms as clearable sends players through rooms that
    // turn out to need a shroud they did not bring
    { id: 'labyrinthPathUnknownMode', field: 'value', from: 'clearable', to: 'shroud' },
];

/** Bump the suffix when a new batch is added to DEFAULT_REWRITES */
const DEFAULT_REWRITE_FLAG_KEY = 'settings_default_rewrites_v1';

class SettingsStorage {
    constructor() {
        this.storageKey = 'script_settingsMap'; // Legacy global key (used as template)
        this.storageArea = 'settings';
        this.currentCharacterId = null;
        this.currentCharacterName = null;
        this.knownCharactersKey = 'known_character_ids';
        /**
         * Whether the last `loadSettings()` could actually read the store.
         * `storage.getJSON` answers a read that could not be made with the
         * default, which a loader takes for "nothing saved yet" — and the
         * next whole-map write would then put the schema defaults over the
         * user's settings. `false` says the map that came back is defaults
         * standing in for settings that could not be read, not settings.
         */
        this.lastLoadReadable = true;
    }

    /**
     * Set the current character ID and name.
     * Must be called after character_initialized event.
     * @param {string} characterId
     * @param {string} [characterName]
     */
    setCharacterId(characterId, characterName) {
        this.currentCharacterId = characterId;
        if (characterName) this.currentCharacterName = characterName;
    }

    /**
     * Get the storage key for current character
     * Falls back to global key if no character ID set
     * @returns {string} Storage key
     */
    getCharacterStorageKey() {
        if (this.currentCharacterId) {
            return `${this.storageKey}_${this.currentCharacterId}`;
        }
        return this.storageKey; // Fallback to global key
    }

    /**
     * The setting IDs the *previous* build saved, before any merging.
     *
     * The saved map is written whole, so its keys are a fingerprint of the
     * schema of whatever script wrote it — including the upstream fork, which
     * uses the same storage keys. Diffing the current schema against this is
     * how a first run tells "arrived from another build of Toolasha, with
     * settings worth respecting" from "genuinely fresh install".
     *
     * @returns {Promise<Array<string>|null>} Stored IDs, or null when nothing
     *   has ever been saved
     */
    async storedSettingIds() {
        const saved = await storage.getJSON(this.getCharacterStorageKey(), this.storageArea, null);
        return saved ? Object.keys(saved) : null;
    }

    /**
     * Load all settings from storage
     * Merges saved values with defaults from settings-schema
     * @returns {Promise<Object>} Settings map
     */
    async loadSettings() {
        const characterKey = this.getCharacterStorageKey();
        // Probe first: "absent" and "could not be read" must not look alike
        // here, because the migration below treats absent as "first run for
        // this character" and writes, and the caller treats the result as
        // the settings to save back
        const probed = await storage.tryGet(characterKey, this.storageArea);
        this.lastLoadReadable = probed !== null;
        let saved = null;

        if (probed !== null) {
            saved = await storage.getJSON(characterKey, this.storageArea, null);

            // Migration: If this is a character-specific key and it doesn't exist
            // Copy from global template (old 'script_settingsMap' key)
            if (this.currentCharacterId && !saved) {
                const globalTemplate = await storage.getJSON(this.storageKey, this.storageArea, null);
                if (globalTemplate) {
                    // Copy global template to this character
                    saved = globalTemplate;
                    await storage.setJSON(characterKey, saved, this.storageArea, true);
                }

                // Add character to known characters list
                await this.addToKnownCharacters(this.currentCharacterId, this.currentCharacterName);
            }

            saved = await this.applyDefaultRewrites(saved, characterKey);
        } else {
            console.warn(`[SettingsStorage] ${characterKey} could not be read; answering with schema defaults`);
        }

        const settings = {};

        // Build default settings from config
        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                // Set default value
                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                // Copy other properties
                if (settingDef.options && typeof settingDef.options !== 'function') {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        // Merge saved settings
        if (saved) {
            for (const [settingId, savedValue] of Object.entries(saved)) {
                if (settings[settingId]) {
                    // Merge saved boolean values
                    if (savedValue.hasOwnProperty('isTrue')) {
                        settings[settingId].isTrue = savedValue.isTrue;
                    }
                    // Merge saved non-boolean values
                    if (savedValue.hasOwnProperty('value')) {
                        if (isBooleanType(settings[settingId].type)) {
                            // Migration: checkboxWithButton settings once persisted
                            // their boolean in .value instead of .isTrue
                            if (!savedValue.hasOwnProperty('isTrue')) {
                                settings[settingId].isTrue = !!savedValue.value;
                            }
                        } else {
                            settings[settingId].value = savedValue.value;
                        }
                    }
                }
            }

            // Migrate: formatting_useKMBFormat changed from checkbox to select
            const fmtSaved = saved['formatting_useKMBFormat'];
            if (fmtSaved && fmtSaved.hasOwnProperty('isTrue') && !fmtSaved.hasOwnProperty('value')) {
                settings['formatting_useKMBFormat'].value = fmtSaved.isTrue ? 'compact' : 'full';
            }
        }

        return settings;
    }

    /**
     * Rewrite stored values still sitting on a superseded schema default, once.
     *
     * See DEFAULT_REWRITES for why this is needed at all. The flag is stored
     * per character, beside that character's settings, so each save file is
     * nudged exactly once — and is set even when there is nothing to rewrite
     * (a fresh install, which already has the new defaults), so a later change
     * of mind is never second-guessed.
     *
     * @param {Object|null} saved - The stored settings map, or null when none
     * @param {string} characterKey - Storage key the map was loaded from
     * @returns {Promise<Object|null>} The map to merge, rewrites applied
     */
    async applyDefaultRewrites(saved, characterKey) {
        const flagKey = `${DEFAULT_REWRITE_FLAG_KEY}_${characterKey}`;
        try {
            if (await storage.get(flagKey, this.storageArea, false)) return saved;

            let next = saved;
            for (const { id, field, from, to } of DEFAULT_REWRITES) {
                const entry = saved?.[id];
                if (!entry || entry[field] !== from) continue;
                // Copy rather than mutate the loaded map, so a caller holding
                // the same object does not see it change underneath them
                next = next === saved ? { ...saved } : next;
                next[id] = { ...entry, [field]: to };
            }

            if (next !== saved) {
                await storage.setJSON(characterKey, next, this.storageArea, true);
            }
            await storage.set(flagKey, true, this.storageArea, true);
            return next;
        } catch (error) {
            // A failed rewrite must not cost the user their settings; the flag
            // stays unset, so the next load tries again
            console.error('[SettingsStorage] Default rewrite failed:', error);
            return saved;
        }
    }

    /**
     * Build default settings from schema without touching storage
     * Used during early initialization before character ID is known
     * @returns {Object} Settings map with schema defaults only
     */
    buildDefaults() {
        const settings = {};

        for (const group of Object.values(settingsGroups)) {
            for (const [settingId, settingDef] of Object.entries(group.settings)) {
                settings[settingId] = {
                    id: settingId,
                    desc: settingDef.label,
                    type: settingDef.type || 'checkbox',
                };

                if (isBooleanType(settingDef.type)) {
                    settings[settingId].isTrue = settingDef.default ?? false;
                } else {
                    settings[settingId].value = settingDef.default ?? '';
                }

                if (settingDef.options) {
                    settings[settingId].options = settingDef.options;
                }
                if (settingDef.min !== undefined) {
                    settings[settingId].min = settingDef.min;
                }
                if (settingDef.max !== undefined) {
                    settings[settingId].max = settingDef.max;
                }
                if (settingDef.step !== undefined) {
                    settings[settingId].step = settingDef.step;
                }
            }
        }

        return settings;
    }

    /**
     * Save all settings to storage
     * @param {Object} settings - Settings map
     * @returns {Promise<void>}
     */
    async saveSettings(settings) {
        const characterKey = this.getCharacterStorageKey();
        await storage.setJSON(characterKey, settings, this.storageArea, true);
    }

    /**
     * Save a settings map that was never read back, without writing over what
     * the user had.
     *
     * For a map built from schema defaults because the store could not be
     * read, a key still at its default says nothing about the user's choice,
     * so the stored entry keeps it; a key moved off its default is a choice
     * made this session and wins. Refuses outright when the store cannot be
     * read now either — a blind write of defaults is the accident this exists
     * to prevent. A store with nothing under the key is written whole.
     *
     * @param {Object} settings - Settings map, as `loadSettings()` shapes it
     * @returns {Promise<boolean>} Whether a write landed
     */
    async saveSettingsKeepingStored(settings) {
        const characterKey = this.getCharacterStorageKey();
        const probed = await storage.tryGet(characterKey, this.storageArea);
        if (probed === null) {
            console.warn(`[SettingsStorage] Settings not saved: ${characterKey} could not be read first`);
            return false;
        }

        let stored = probed.found ? probed.value : null;
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch {
                stored = null;
            }
        }
        if (!stored || typeof stored !== 'object') {
            await storage.setJSON(characterKey, settings, this.storageArea, true);
            return true;
        }

        const defaults = this.buildDefaults();
        const merged = { ...stored };
        for (const [settingId, entry] of Object.entries(settings || {})) {
            const untouched = settingId in defaults && valueOf(entry) === valueOf(defaults[settingId]);
            if (!(settingId in merged) || !untouched) merged[settingId] = entry;
        }
        await storage.setJSON(characterKey, merged, this.storageArea, true);
        return true;
    }

    /**
     * Add character to known characters list, storing name alongside ID.
     * Migrates old flat-array format ([id, id]) to object format ([{id, name}]).
     * @param {string} characterId
     * @param {string} characterName
     * @returns {Promise<void>}
     */
    async addToKnownCharacters(characterId, characterName) {
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        const list = this._normalizeKnownCharacters(raw);
        const existing = list.find((c) => c.id === characterId);
        if (existing) {
            if (characterName && existing.name !== characterName) {
                existing.name = characterName;
                await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
            }
        } else {
            list.push({ id: characterId, name: characterName || characterId });
            await storage.setJSON(this.knownCharactersKey, list, this.storageArea, true);
        }
    }

    /**
     * Normalise stored known-characters to [{id, name}] regardless of legacy format.
     * @param {Array} raw
     * @returns {Array<{id: string, name: string}>}
     * @private
     */
    _normalizeKnownCharacters(raw) {
        if (!Array.isArray(raw)) return [];
        return raw.map((entry) =>
            typeof entry === 'object' && entry !== null
                ? { id: String(entry.id), name: entry.name || String(entry.id) }
                : { id: String(entry), name: String(entry) }
        );
    }

    /**
     * Get list of known characters as [{id, name}] objects.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async getKnownCharacters() {
        const raw = await storage.getJSON(this.knownCharactersKey, this.storageArea, []);
        return this._normalizeKnownCharacters(raw);
    }

    /**
     * Sync current settings to a specified subset of characters.
     * @param {Object} settings - Current settings to copy
     * @param {string[]} targetIds - IDs to sync to (omit to sync to all others)
     * @returns {Promise<number>} Number of characters synced
     */
    async syncSettingsToAllCharacters(settings, targetIds) {
        const knownCharacters = await this.getKnownCharacters();
        let syncedCount = 0;

        const targets = targetIds
            ? knownCharacters.filter((c) => targetIds.includes(c.id))
            : knownCharacters.filter((c) => c.id !== this.currentCharacterId);

        for (const character of targets) {
            if (character.id === this.currentCharacterId) continue;
            const characterKey = `${this.storageKey}_${character.id}`;
            await storage.setJSON(characterKey, settings, this.storageArea, true);
            syncedCount++;
        }

        return syncedCount;
    }

    /**
     * Copy another character's whole settings map onto the current character.
     *
     * The inverse of the sync buttons: they push this character's settings out,
     * this pulls another character's settings in — the one-click "make this new
     * alt like my main" a fresh character wants. The map is written whole, the
     * same shape a normal save uses, so the caller only has to reload config.
     *
     * @param {string} sourceId - The character to copy settings from
     * @returns {Promise<boolean>} True when a map was found and written
     */
    async copySettingsFromCharacter(sourceId) {
        if (!sourceId || !this.currentCharacterId || String(sourceId) === String(this.currentCharacterId)) {
            return false;
        }
        const sourceMap = await storage.getJSON(`${this.storageKey}_${sourceId}`, this.storageArea, null);
        if (!sourceMap || typeof sourceMap !== 'object' || Object.keys(sourceMap).length === 0) {
            return false;
        }
        await storage.setJSON(this.getCharacterStorageKey(), sourceMap, this.storageArea, true);
        return true;
    }

    /**
     * The known characters, other than the current one, that actually have
     * settings saved — the only ones worth offering as a copy source.
     * @returns {Promise<Array<{id: string, name: string}>>}
     */
    async charactersWithSettings() {
        const known = await this.getKnownCharacters();
        const withSettings = [];
        for (const character of known) {
            if (String(character.id) === String(this.currentCharacterId)) continue;
            const map = await storage.getJSON(`${this.storageKey}_${character.id}`, this.storageArea, null);
            if (map && typeof map === 'object' && Object.keys(map).length > 0) {
                withSettings.push(character);
            }
        }
        return withSettings;
    }

    /**
     * Get a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} defaultValue - Default value if not found
     * @returns {Promise<*>} Setting value
     */
    async getSetting(settingId, defaultValue = null) {
        const settings = await this.loadSettings();
        const setting = settings[settingId];

        if (!setting) {
            return defaultValue;
        }

        // Return boolean for checkbox settings
        if (isBooleanType(setting.type)) {
            return setting.isTrue ?? defaultValue;
        }

        // Return value for other settings
        return setting.value ?? defaultValue;
    }

    /**
     * Set a single setting value
     * @param {string} settingId - Setting ID
     * @param {*} value - New value
     * @returns {Promise<void>}
     */
    async setSetting(settingId, value) {
        const settings = await this.loadSettings();
        if (!this.lastLoadReadable) {
            // The map in hand is defaults standing in for settings that could
            // not be read; writing it back would put them over the user's
            console.warn(`[SettingsStorage] Setting '${settingId}' not saved: settings could not be read first`);
            return;
        }

        if (!settings[settingId]) {
            console.warn(`Setting '${settingId}' not found`);
            return;
        }

        // Update value
        if (isBooleanType(settings[settingId].type)) {
            settings[settingId].isTrue = value;
        } else {
            settings[settingId].value = value;
        }

        await this.saveSettings(settings);
    }

    /**
     * Reset all settings to defaults
     * @returns {Promise<void>}
     */
    async resetToDefaults() {
        // Clear per-character settings so loadSettings() returns defaults
        const characterKey = this.getCharacterStorageKey();
        await storage.delete(characterKey, this.storageArea);
    }

    /**
     * Export all settings as JSON (full dump of settings store)
     * Includes global keys and current character's keys.
     * Excludes transient cache data.
     * @returns {Promise<string>} JSON string
     */
    async exportSettings() {
        const allData = await storage.getAll(this.storageArea);

        // Exclude transient cache keys
        const EXCLUDE_PREFIXES = ['marketplace_cache'];
        const exported = {};

        for (const [key, value] of Object.entries(allData)) {
            if (EXCLUDE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
            exported[key] = value;
        }

        return JSON.stringify(exported, null, 2);
    }

    /**
     * Import settings from JSON
     * Only imports global keys and keys matching the current character ID.
     * Character-specific keys for other characters are skipped.
     * @param {string} jsonString - JSON string
     * @returns {Promise<{imported: number, skipped: number}>} Import result
     */
    async importSettings(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            const currentCharId = this.currentCharacterId;
            let imported = 0;
            let skipped = 0;

            const knownCharacters = new Set((await this.getKnownCharacters()).map((character) => character.id));
            if (data[this.knownCharactersKey]) {
                for (const character of this._normalizeKnownCharacters(data[this.knownCharactersKey])) {
                    knownCharacters.add(character.id);
                }
            }

            for (const [key, value] of Object.entries(data)) {
                const charIdMatch =
                    key.match(/_([0-9a-f]{24})$/i) ||
                    key.match(/_(\d{10,})$/) ||
                    this._matchKnownCharacterSuffix(key, knownCharacters);

                if (charIdMatch) {
                    const keyCharId = charIdMatch[1];
                    if (currentCharId && keyCharId !== String(currentCharId)) {
                        skipped++;
                        continue;
                    }
                }

                await storage.setJSON(key, value, this.storageArea, true);
                imported++;
            }

            return { imported, skipped };
        } catch (error) {
            console.error('[Settings Storage] Import failed:', error);
            return null;
        }
    }

    /**
     * Check if a key ends with a known character ID suffix
     * @param {string} key - Storage key
     * @param {Set<string>} knownIds - Set of known character ID strings
     * @returns {Array|null} Match array with captured ID at index 1, or null
     * @private
     */
    _matchKnownCharacterSuffix(key, knownIds) {
        const lastUnderscore = key.lastIndexOf('_');
        if (lastUnderscore === -1) return null;
        const suffix = key.substring(lastUnderscore + 1);
        if (knownIds.has(suffix)) {
            return [key, suffix];
        }
        return null;
    }
}

const settingsStorage = new SettingsStorage();

export default settingsStorage;
