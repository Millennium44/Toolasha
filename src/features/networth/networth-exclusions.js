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

/** @type {Array<{type: string, value: string}>|null} In-memory cache */
let cache = null;

/** Which character `cache` belongs to — a mismatch means it must be reloaded */
let cacheCharId = null;

/**
 * The current character id, `'default'` before login.
 * @returns {string}
 */
function currentCharId() {
    return dataManager.getCurrentCharacterId() || 'default';
}

/**
 * Get the character-scoped storage key.
 * @returns {string}
 */
function getStorageKey() {
    return `${STORAGE_KEY_PREFIX}_${currentCharId()}`;
}

/**
 * Load exclusions from storage into memory.
 *
 * Reloaded whenever the character has changed since the cache was filled, not
 * only when it is empty: the feature is torn down and reinitialized on every
 * character switch (`character_switching` / `character_switched`), but this
 * module has no listener of its own, so `cache !== null` alone kept serving
 * the departed character's list to whoever logged in next — reading it, and
 * writing it back merged with anything the new character excluded, silently
 * carried one character's exclusions onto another's (a real risk with several
 * ironclad/ironcow characters open in the same browser).
 *
 * @returns {Promise<Array<{type: string, value: string}>>}
 */
async function loadExclusions() {
    const charId = currentCharId();
    if (cache === null || cacheCharId !== charId) {
        cache = (await storage.getJSON(getStorageKey(), 'settings', [])) || [];
        cacheCharId = charId;
    }
    return cache;
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
    return cache ?? [];
}

/**
 * Check whether a given type/value pair is currently excluded.
 * @param {string} type - 'assetType' | 'category' | 'item' | 'houseRoom' | 'ability' | 'guildShrine' | 'loadout'
 * @param {string} value - HRID or loadout name
 * @returns {boolean}
 */
export function isExcluded(type, value) {
    const list = cache ?? [];
    return list.some((e) => e.type === type && e.value === value);
}

/**
 * Add an exclusion if it does not already exist. Persists to storage.
 * @param {string} type
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function addExclusion(type, value) {
    const list = await loadExclusions();
    if (!list.some((e) => e.type === type && e.value === value)) {
        list.push({ type, value });
        cache = list;
        // Fire-and-forget: persist in background so the UI updates instantly
        storage.setJSON(getStorageKey(), list, 'settings');
    }
}

/**
 * Remove an exclusion. Persists to storage.
 * @param {string} type
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function removeExclusion(type, value) {
    const list = await loadExclusions();
    const idx = list.findIndex((e) => e.type === type && e.value === value);
    if (idx !== -1) {
        list.splice(idx, 1);
        cache = list;
        // Fire-and-forget: persist in background so the UI updates instantly
        storage.setJSON(getStorageKey(), list, 'settings');
    }
}

/**
 * Remove all exclusions. Persists to storage.
 * @returns {Promise<void>}
 */
export async function clearExclusions() {
    cache = [];
    cacheCharId = currentCharId();
    storage.setJSON(getStorageKey(), [], 'settings');
}
