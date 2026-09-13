/**
 * A small persisted map keyed by player name.
 *
 * The class override and the per-player colour are both facts about *another*
 * player, chosen by the person watching: "Estevao is the tank", "draw Estevao
 * in orange". Neither belongs to the character logged in — the same party seen
 * from an alt is the same party — so the map is account-wide and keyed by the
 * player's name, lowercased, because a fight view and a payload do not always
 * agree on case.
 *
 * ## The one race that matters here
 *
 * The map is read from IndexedDB lazily, and the read can land after the user
 * has already chosen something in the menu. A read that simply replaced the
 * in-memory map would undo that choice, and a write made before the read landed
 * would replace every stored entry with the handful known so far. So a write
 * waits for the read first, and the read never overwrites a name that was
 * written while it was in flight.
 *
 * There is no character identity to capture around the awaits: nothing here is
 * scoped to the viewer, so a character switch mid-read changes nothing it
 * holds.
 *
 * ## Bounded
 *
 * KikiMeter's equivalent maps grow without limit. This one keeps the most
 * recently written `max` names and drops the oldest past that.
 */

import storage from '../core/storage.js';

/**
 * The key a name is stored under.
 * @param {string} name - A player name as displayed
 * @returns {string} Trimmed and lowercased, or '' for nothing usable
 */
export function nameKey(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase();
}

/**
 * Build one persisted name-keyed map.
 *
 * @param {Object} definition - What and where
 * @param {string} definition.key - Storage key
 * @param {string} [definition.storeName] - Storage store
 * @param {number} [definition.max] - Most names kept
 * @param {Function} [definition.isValid] - `(value) => boolean`; invalid values are never stored or adopted
 * @returns {{get: Function, set: Function, load: Function, names: Function, reset: Function}}
 */
export function createNameKeyedStore({ key, storeName = 'settings', max = 500, isValid = () => true }) {
    /** nameKey → `{value, at}` */
    let entries = {};
    let loading = null;
    /** Names written since the current read began, which that read must not overwrite */
    let touched = new Set();

    function load() {
        if (loading) return loading;
        const pending = (async () => {
            try {
                const stored = await storage.get(key, storeName, null);
                if (!stored || typeof stored !== 'object') return;
                for (const [name, entry] of Object.entries(stored)) {
                    if (touched.has(name) || !entry || !isValid(entry.value)) continue;
                    entries[name] = { value: entry.value, at: Number(entry.at) || 0 };
                }
                prune();
            } catch (error) {
                console.error(`[NameKeyedStore] Reading ${key} failed:`, error);
            }
        })();
        loading = pending;
        return pending;
    }

    function prune() {
        const names = Object.keys(entries);
        if (names.length <= max) return;
        names
            .sort((a, b) => entries[a].at - entries[b].at)
            .slice(0, names.length - max)
            .forEach((name) => delete entries[name]);
    }

    /**
     * @param {string} name - Player name
     * @returns {*} The stored value, or null. The first call starts the read.
     */
    function get(name) {
        if (!loading) load();
        return entries[nameKey(name)]?.value ?? null;
    }

    /**
     * Store a value, or clear it with null. In memory at once; on disk after the read.
     * @param {string} name - Player name
     * @param {*} value - The value, or null to forget the name
     * @returns {Promise<void>}
     */
    async function set(name, value) {
        const k = nameKey(name);
        if (!k) return;
        if (value !== null && value !== undefined && !isValid(value)) return;

        touched.add(k);
        if (value === null || value === undefined) delete entries[k];
        else entries[k] = { value, at: Date.now() };
        prune();

        await load();
        try {
            await storage.set(key, { ...entries }, storeName);
        } catch (error) {
            console.error(`[NameKeyedStore] Saving ${key} failed:`, error);
        }
    }

    return {
        get,
        set,
        load,
        /** @returns {string[]} Every stored name key */
        names: () => Object.keys(entries),
        /** Forget everything in memory — for tests */
        reset: () => {
            entries = {};
            loading = null;
            touched = new Set();
        },
    };
}
