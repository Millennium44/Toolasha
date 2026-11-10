/**
 * Networth Exclusions
 * Manages the list of assets to exclude from net worth calculation.
 * Persisted per character to IndexedDB (settings store).
 *
 * Exclusion types:
 *   assetType   - entire section ('houses', 'abilities', 'abilityBooks', 'guildShrines', 'listings', 'equipped')
 *   category    - all items in an inventory category ('/item_categories/food', etc.)
 *   item        - all stacks of a specific item type ('/items/...')
 *   houseRoom   - one specific house room ('/house_rooms/...')
 *   ability     - one specific ability ('/abilities/...')
 *   guildShrine - one specific guild shrine buff ('/guild_buffs/...')
 *   loadout     - all equipment items in a named loadout snapshot
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';

const STORAGE_KEY_PREFIX = 'networth_exclusions';

// A read keeps the state object it started with. Switching character or clearing
// the list replaces the owner, so an old read cannot republish or save over it.
let state = null;

// A rapid A -> B -> A switch can skip B's feature initialization entirely.
// Retire the old owner on teardown, not only when a getter notices a new ID.
dataManager.on?.('character_switching', () => {
    // Keep a loaded list: a failed pre-switch flush may still have its edits
    // queued, and a coalesced return must not reload older disk state over them.
    if (state) state = { ...state, loading: null };
});

/**
 * The current character id, `'default'` before login.
 * @returns {string}
 */
function currentCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * Keep the storage family explicit and derive it from the captured owner.
 * @param {string} charId
 * @returns {string}
 */
function storageKey(charId) {
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

/**
 * The current character's cache and any read already filling it.
 * @returns {{charId: string, list: Array|null, loading: Promise|null}}
 */
function currentState() {
    const charId = currentCharId();
    if (!state || state.charId !== charId) {
        state = { charId, list: null, loading: null };
    }
    return state;
}

/**
 * Load one owner's exclusions, sharing the read between concurrent callers.
 *
 * The returned list belongs to that owner even if a switch or clear happens
 * during the read. Mutations check that owner again before touching the list.
 * @param {Object} owner - State returned by currentState()
 * @returns {Promise<Array<{type: string, value: string}>|null>} Null when unreadable
 */
async function loadExclusions(owner = currentState()) {
    if (owner.list !== null) return owner.list;
    if (!owner.loading) {
        owner.loading = (async () => {
            try {
                // getJSON folds a failed read into its default. Treating that
                // default as an empty list would erase saved rows on the next edit.
                const key = storageKey(owner.charId);
                const probe = await storage.tryGet(key, 'settings');
                const list = probe ? (probe.found ? storage.parseJSON(probe.value, key, null) : []) : null;
                if (!Array.isArray(list)) {
                    console.warn('[NetworthExclusions] Exclusions could not be read; edits were not saved');
                    return null;
                }
                owner.list = list;
                return list;
            } finally {
                owner.loading = null;
            }
        })();
    }
    return owner.loading;
}

/**
 * Initialize exclusions — call at feature startup to warm the cache.
 * @returns {Promise<void>}
 */
export async function initExclusions() {
    await loadExclusions();
}

/**
 * Get all current exclusions synchronously (may be empty before initExclusions completes).
 * @returns {Array<{type: string, value: string}>}
 */
export function getExclusions() {
    return currentState().list ?? [];
}

/**
 * Check whether a given type/value pair is currently excluded.
 * @param {string} type - 'assetType' | 'category' | 'item' | 'houseRoom' | 'ability' | 'guildShrine' | 'loadout'
 * @param {string} value - HRID or loadout name
 * @returns {boolean}
 */
export function isExcluded(type, value) {
    const list = getExclusions();
    return list.some((e) => e.type === type && e.value === value);
}

/**
 * Add an exclusion if it does not already exist. Persists to storage.
 * @param {string} type
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function addExclusion(type, value) {
    const owner = currentState();
    const list = await loadExclusions(owner);
    if (owner !== currentState()) {
        console.warn('[NetworthExclusions] Exclusion not saved: the list was replaced while loading');
        return;
    }
    if (!list) return;
    if (!list.some((e) => e.type === type && e.value === value)) {
        list.push({ type, value });
        // Fire-and-forget: persist in background so the UI updates instantly
        storage.setJSON(storageKey(owner.charId), list, 'settings');
    }
}

/**
 * Remove an exclusion. Persists to storage.
 * @param {string} type
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function removeExclusion(type, value) {
    const owner = currentState();
    const list = await loadExclusions(owner);
    if (owner !== currentState()) {
        console.warn('[NetworthExclusions] Exclusion not removed: the list was replaced while loading');
        return;
    }
    if (!list) return;
    const idx = list.findIndex((e) => e.type === type && e.value === value);
    if (idx !== -1) {
        list.splice(idx, 1);
        // Fire-and-forget: persist in background so the UI updates instantly
        storage.setJSON(storageKey(owner.charId), list, 'settings');
    }
}

/**
 * Remove all exclusions. Persists to storage.
 * @returns {Promise<void>}
 */
export async function clearExclusions() {
    const owner = currentState();
    state = { charId: owner.charId, list: [], loading: null };
    storage.setJSON(storageKey(owner.charId), state.list, 'settings');
}
