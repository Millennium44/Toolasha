/**
 * Named overlay layouts
 *
 * An overlay arrangement is worth an hour of fiddling, and there is more than
 * one of them worth having: the tiles you want while grinding a dungeon are not
 * the tiles you want while running the marketplace, and the only way to keep
 * both was to export one to a file and import it back an hour later.
 *
 * So layouts get names. Saving one writes the arrangement exactly as
 * `_exportLayout` writes a file — through `toOPanelConfig` — and switching reads
 * it back through `fromOPanelConfig`, which is the same code path an import
 * already takes. That is deliberate: a second way of applying a layout is a
 * second set of bugs about tiles arriving unplaced, and the import path has
 * already learned the awkward parts (native coordinates left alone, OPanel's
 * refitted).
 *
 * Everything lives under one key holding a map of name to saved file, rather
 * than a key per layout. A map is one read, one write and one place to look
 * when a name goes missing; a key per layout means a listing has to enumerate
 * the whole store and guess which keys are layouts by their prefix.
 *
 * The map operations are pure and exported separately from the storage calls,
 * because renaming, overwriting and deleting are where the mistakes live and
 * none of them need IndexedDB to be tested.
 */

import storage from '../../core/storage.js';

/** The one key the whole map lives under */
export const LAYOUTS_KEY = 'overlayLayouts';

/** Which object store — the same one the overlay's own settings use */
const STORE = 'settings';

/** Long enough to be descriptive, short enough to fit the dropdown */
export const MAX_NAME_LENGTH = 40;

/**
 * A name as it will be stored.
 *
 * Trimmed and capped rather than rejected on length, so a pasted name is
 * shortened instead of losing the whole save. Whitespace-only is not a name.
 *
 * @param {string} name - What the player typed
 * @returns {string} The stored form, or '' when there is nothing usable
 */
export function normalizeName(name) {
    if (typeof name !== 'string') return '';
    return name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

/**
 * The saved names, in the order they should be offered.
 *
 * Sorted rather than kept in insertion order: a dropdown you scan for a name
 * you already know is easier alphabetical, and insertion order is invisible
 * from the outside anyway.
 *
 * @param {Object} map - The stored map
 * @returns {string[]} Names
 */
export function layoutNames(map) {
    if (!map || typeof map !== 'object') return [];
    return Object.keys(map).sort((a, b) => a.localeCompare(b));
}

/**
 * The map with one layout added or replaced.
 *
 * Returns a new object rather than mutating, so a caller holding the old map
 * still holds the old map — which is what makes "save failed, nothing changed"
 * true rather than merely intended.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name; normalized here
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Object} A new map, unchanged when the name is unusable
 */
export function putLayout(map, name, file) {
    const key = normalizeName(name);
    if (!key || !file) return { ...(map || {}) };
    return { ...(map || {}), [key]: { savedAt: Date.now(), file } };
}

/**
 * The map with one layout gone.
 *
 * @param {Object} map - The stored map
 * @param {string} name - Layout name
 * @returns {Object} A new map, unchanged when the name is not in it
 */
export function removeLayout(map, name) {
    const key = normalizeName(name);
    const next = { ...(map || {}) };
    delete next[key];
    return next;
}

/**
 * Every saved layout.
 *
 * An unreadable or absent map reads as no layouts rather than as an error: the
 * overlay still has to draw its settings popover, and a control that throws
 * takes the popover with it.
 *
 * @returns {Promise<Object>} `{ [name]: {savedAt, file} }`
 */
export async function loadLayouts() {
    try {
        const map = await storage.getJSON(LAYOUTS_KEY, STORE, null);
        return map && typeof map === 'object' ? map : {};
    } catch (error) {
        console.error('[OverlayLayouts] Reading the saved layouts failed:', error);
        return {};
    }
}

/**
 * Write the whole map back.
 *
 * @param {Object} map - The map to store
 * @returns {Promise<boolean>} Whether it was written
 */
async function writeLayouts(map) {
    try {
        await storage.setJSON(LAYOUTS_KEY, map, STORE, true);
        return true;
    } catch (error) {
        console.error('[OverlayLayouts] Saving the layouts failed:', error);
        return false;
    }
}

/**
 * Save an arrangement under a name, replacing one of the same name.
 *
 * @param {string} name - Layout name
 * @param {Object} file - What `toOPanelConfig` produced
 * @returns {Promise<Object>} The map as it now stands
 */
export async function saveLayout(name, file) {
    const current = await loadLayouts();
    const next = putLayout(current, name, file);
    // The map that is actually stored, so a failed write leaves the dropdown
    // showing what exists rather than a name that only ever lived in memory
    return (await writeLayouts(next)) ? next : current;
}

/**
 * Forget a saved layout.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object>} The map as it now stands
 */
export async function deleteLayout(name) {
    const current = await loadLayouts();
    const next = removeLayout(current, name);
    return (await writeLayouts(next)) ? next : current;
}

/**
 * One saved layout's file, ready for `fromOPanelConfig`.
 *
 * @param {string} name - Layout name
 * @returns {Promise<Object|null>} The saved file, or null when there is no such layout
 */
export async function getLayout(name) {
    const map = await loadLayouts();
    return map[normalizeName(name)]?.file || null;
}
