/**
 * Which of your characters are iron cows.
 *
 * The game only ever tells this script about the character you are logged into:
 * `character.gameMode` arrives with the init payload and describes that one
 * account slot. Nothing anywhere can be asked "what mode is my other alt in".
 *
 * The known-characters registry that "Copy Settings to All Characters" reads
 * (`known_character_ids`) records an id and a name and nothing else, so a copy
 * aimed at iron cows had no way to know which ids qualify — and guessing from a
 * character's *name* is exactly the sort of cleverness that copies a market
 * character's settings onto the wrong slot.
 *
 * So the mode is written down when it is known, once per login, into a small
 * id → mode map beside the rest of the settings. A character that has not been
 * played since this shipped simply has no entry, and everything below treats
 * that as *unknown* rather than as *not an iron cow*: the copy skips it and
 * says so by name, because silently missing a target is worse than asking
 * somebody to log in once.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';

/** id → the `gameMode` string the game reported the last time it was played */
export const CHARACTER_MODES_KEY = 'toolasha_characterGameModes';

const STORE = 'settings';

/**
 * Whether a stored game mode is one of the iron cow variants.
 *
 * Substring rather than equality: the game ships `ironcow` and
 * `legacy_ironcow`, and both are characters without a marketplace.
 *
 * @param {*} mode - A `character.gameMode` value, or anything at all
 * @returns {boolean} True for an iron cow of any vintage
 */
export function isIronCowGameMode(mode) {
    return typeof mode === 'string' && mode.toLowerCase().includes('ironcow');
}

/**
 * Every game mode recorded so far.
 * @returns {Promise<Object<string, string>>} id → mode, empty when nothing is known
 */
export async function getCharacterGameModes() {
    try {
        const stored = await storage.getJSON(CHARACTER_MODES_KEY, STORE, null);
        return stored && typeof stored === 'object' ? stored : {};
    } catch (error) {
        console.error('[CharacterModes] Reading recorded game modes failed:', error);
        return {};
    }
}

/**
 * Write down the mode of the character being played, if the game has said yet.
 *
 * Called on boot and on every character switch. A no-op before login and a
 * no-op when the recorded value already matches, so the common case costs one
 * read and no write.
 *
 * @returns {Promise<{id: string, mode: string}|null>} What was recorded, or null
 */
export async function recordCurrentCharacterGameMode() {
    try {
        const id = String(dataManager.getCurrentCharacterId?.() || '');
        const mode = dataManager.getCurrentCharacterGameMode?.() || '';
        if (!id || !mode) return null;

        const modes = await getCharacterGameModes();
        if (modes[id] === mode) return { id, mode };

        modes[id] = mode;
        await storage.setJSON(CHARACTER_MODES_KEY, modes, STORE, true);
        return { id, mode };
    } catch (error) {
        console.error('[CharacterModes] Recording the current game mode failed:', error);
        return null;
    }
}

/**
 * Split the known characters into "iron cows", "not iron cows" and "no idea".
 *
 * Pure, because this is the part worth testing: which slots a copy is about to
 * be written into is not something to find out by watching IndexedDB.
 *
 * @param {Array<{id: string, name: string}>} characters - From the known-characters registry
 * @param {Object<string, string>} modes - id → recorded game mode
 * @param {string} [currentId] - The character being played, which is never a target
 * @returns {{targets: Array<Object>, unknown: Array<Object>, others: Array<Object>}}
 */
export function selectIronCowTargets(characters, modes, currentId = '') {
    const targets = [];
    const unknown = [];
    const others = [];
    const recorded = modes || {};

    for (const character of characters || []) {
        if (!character?.id || String(character.id) === String(currentId)) continue;
        const mode = recorded[character.id];
        if (!mode) unknown.push(character);
        else if (isIronCowGameMode(mode)) targets.push(character);
        else others.push(character);
    }

    return { targets, unknown, others };
}

/**
 * A character's display name, falling back to its id.
 * @param {{id: string, name: string}} character
 * @returns {string}
 */
export function characterLabel(character) {
    return character?.name && character.name !== character.id ? character.name : `Character ${character?.id}`;
}

/**
 * What to tell somebody after copying to the iron cows.
 *
 * The unknowns are named rather than counted: "1 character's mode unknown" is a
 * shrug, and "Bessie" is something a person can act on.
 *
 * @param {number} count - How many characters were written to
 * @param {Array<{id: string, name: string}>} unknown - Characters with no recorded mode
 * @returns {string} The message
 */
export function describeIronCowCopy(count, unknown = []) {
    const copied = `Settings copied to ${count} iron cow character${count === 1 ? '' : 's'}.`;
    if (!unknown.length) return copied;

    const names = unknown.map(characterLabel).join(', ');
    return (
        `${copied}\n\n${unknown.length} character${unknown.length === 1 ? "'s" : "s'"} game mode is unknown ` +
        `(${names}) — log in on each one once and Toolasha will record it.`
    );
}
