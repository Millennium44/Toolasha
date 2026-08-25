/**
 * Custom Inventory Tabs — Data Module
 * Manages tab configuration storage and CRUD operations.
 * All mutating helpers return new objects (never mutate in place).
 */

import { createCuratedRecord, mergeById } from '../../../utils/persisted-record.js';
import { registerSyncMerge } from '../../../utils/sync-merge-registry.js';

const STORAGE_KEY = 'inventoryTabs_config';
const STORE = 'settings';
const CONFIG_VERSION = 1;

export const LINEBREAK_HRID = '__linebreak__';

/**
 * Generate a unique ID
 * @returns {string}
 */
export function makeId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Build the character-scoped storage key
 * @param {string} characterId
 * @returns {string}
 */
function getStorageKey(characterId) {
    return `${characterId}_${STORAGE_KEY}`;
}

/**
 * Return a blank config
 * @returns {Object}
 */
function defaultConfig() {
    return { version: CONFIG_VERSION, tabs: [], selectedTabId: null };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Fold a stored config under the one in memory — only consulted before this
 * character's config has been read back (see `createCuratedRecord`): tabs by
 * id, memory's copy of a tab winning, memory's selection when it has one.
 * @param {Object} stored - The config as read back
 * @param {Object} memory - The config as held
 * @returns {Object} The merged config
 */
function mergeConfigs(stored, memory) {
    const theirs = stored && typeof stored === 'object' ? stored : {};
    const ours = memory && typeof memory === 'object' ? memory : {};
    return {
        ...defaultConfig(),
        ...theirs,
        ...ours,
        tabs: mergeById((tab) => tab?.id)(theirs.tabs, ours.tabs),
        selectedTabId: ours.selectedTabId ?? theirs.selectedTabId ?? null,
    };
}

/**
 * A pull folds the gist's config into the one on disk instead of replacing it.
 *
 * The key is character-scoped with the id FIRST (`<charId>_inventoryTabs_config`),
 * so the registry's `base` matcher cannot say it and a predicate does. Local
 * wins per tab id and the union keeps everything either side has: without
 * per-tab timestamps, "which side is newer" is unknowable, and a pull that
 * replaced the key wholesale was reverting days of tab work to whatever the
 * gist last saw. The cost is bounded and honest - a tab deleted here can come
 * back from a device that still carries it, until that device pushes.
 */
registerSyncMerge({
    store: STORE,
    match: (key) => key === STORAGE_KEY || key.endsWith(`_${STORAGE_KEY}`),
    // The registry hands (local, incoming); mergeConfigs favours its second
    // argument per tab, and local is the side a pull must not erase
    merge: (local, incoming) => mergeConfigs(incoming, local),
    label: 'Custom inventory tabs',
});

/**
 * One curated record per character, under the exact key the config has always
 * lived at (`<charId>_inventoryTabs_config`, built here rather than through
 * character-key.js, so `scoped: false`). A read that cannot be made leaves the
 * config in hand rather than blanking it, and no write goes out over a store
 * that could not be read first; once the config has been read back, what the
 * panel holds is the config and a removed tab stays removed.
 * @type {Map<string, Object>}
 */
const records = new Map();

/**
 * @param {string} characterId
 * @returns {Object} The character's record
 */
function recordFor(characterId) {
    let record = records.get(characterId);
    if (!record) {
        record = createCuratedRecord({
            base: getStorageKey(characterId),
            store: STORE,
            scoped: false,
            empty: defaultConfig,
            merge: mergeConfigs,
            label: 'CustomTabs',
        });
        records.set(characterId, record);
    }
    return record;
}

/**
 * Load the tab config for a character.
 *
 * A readable load returns what is stored; one that cannot be made returns the
 * config last held for this character (the default when there is none) and
 * leaves the next save merging rather than overwriting.
 * @param {string} characterId
 * @returns {Promise<Object>} { version, tabs, selectedTabId }
 */
export async function loadConfig(characterId) {
    if (!characterId) return defaultConfig();
    const record = recordFor(characterId);
    const previous = record.get();
    record.set(defaultConfig());
    const readable = await record.load();
    if (!readable) record.set(previous);
    const saved = record.get();
    const config = !saved || !Array.isArray(saved.tabs) ? defaultConfig() : { ...defaultConfig(), ...saved };
    record.set(config);
    return config;
}

/**
 * Persist the tab config for a character
 * @param {string} characterId
 * @param {Object} config
 * @returns {Promise<boolean|undefined>} Whether the write landed
 */
export async function saveConfig(characterId, config) {
    if (!characterId) return;
    const record = recordFor(characterId);
    record.set(config);
    return record.save();
}

/** @returns {Promise<*>} The pending writes, for tests and shutdown */
export function flushConfigWrites() {
    return Promise.all([...records.values()].map((record) => record.flushed()));
}

// ---------------------------------------------------------------------------
// Deep-clone helper (structuredClone with fallback)
// ---------------------------------------------------------------------------

function clone(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// CRUD helpers — all return a new config object
// ---------------------------------------------------------------------------

/**
 * Add a tab (at root level or inside a parent)
 * @param {Object} config
 * @param {string|null} parentId - null for root level
 * @param {string} name
 * @returns {Object} { config, tabId }
 */
export function addTab(config, parentId, name) {
    const c = clone(config);
    const tab = {
        id: makeId(),
        name,
        color: null,
        open: false,
        items: [],
        children: [],
    };
    if (!parentId) {
        c.tabs.push(tab);
    } else {
        const result = _findNode(c.tabs, parentId);
        if (result) {
            result.tab.children.push(tab);
            result.tab.open = true;
        } else {
            c.tabs.push(tab);
        }
    }
    return { config: c, tabId: tab.id };
}

/**
 * Remove a tab (and all its descendants)
 * @param {Object} config
 * @param {string} tabId
 * @returns {Object} new config
 */
export function removeTab(config, tabId) {
    const c = clone(config);
    _removeFromArray(c.tabs, tabId);
    if (c.selectedTabId === tabId) c.selectedTabId = null;
    return c;
}

/**
 * Rename a tab
 * @param {Object} config
 * @param {string} tabId
 * @param {string} name
 * @returns {Object} new config
 */
export function renameTab(config, tabId, name) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) result.tab.name = name;
    return c;
}

/**
 * Set a tab's accent color
 * @param {Object} config
 * @param {string} tabId
 * @param {string|null} color
 * @returns {Object} new config
 */
export function setTabColor(config, tabId, color) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) result.tab.color = color;
    return c;
}

/**
 * Move a tab to a new position within its parent's children (or root)
 * @param {Object} config
 * @param {string} tabId
 * @param {number} newIndex - target index in the parent's children array
 * @returns {Object} new config
 */
export function moveTab(config, tabId, newIndex) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;

    const arr = result.parent ? result.parent.children : c.tabs;
    const oldIndex = arr.findIndex((t) => t.id === tabId);
    if (oldIndex === -1) return c;

    const [removed] = arr.splice(oldIndex, 1);
    const clampedIndex = Math.max(0, Math.min(newIndex, arr.length));
    arr.splice(clampedIndex, 0, removed);
    return c;
}

/**
 * Add an item to a tab (no-op if already present)
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function addItem(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && !result.tab.items.includes(itemHrid)) {
        result.tab.items.push(itemHrid);
    }
    return c;
}

/**
 * Insert an item at a specific index in a tab's items array (no-op if already present)
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @param {number} index - Position to insert at (clamped to array bounds)
 * @returns {Object} new config
 */
export function insertItem(config, tabId, itemHrid, index) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && !result.tab.items.includes(itemHrid)) {
        const clamped = Math.max(0, Math.min(index, result.tab.items.length));
        result.tab.items.splice(clamped, 0, itemHrid);
    }
    return c;
}

/**
 * Move an item from one tab to another (atomic remove + insert)
 * @param {Object} config
 * @param {string} sourceTabId - Tab to remove from
 * @param {string} targetTabId - Tab to insert into
 * @param {string} itemHrid
 * @param {number} [insertIndex] - Position in target tab (appends if omitted)
 * @returns {Object} new config
 */
export function moveItem(config, sourceTabId, targetTabId, itemHrid, insertIndex) {
    if (sourceTabId === targetTabId) return config;
    const c = clone(config);
    // Remove from source
    const source = _findNode(c.tabs, sourceTabId);
    if (source) {
        source.tab.items = source.tab.items.filter((h) => h !== itemHrid);
    }
    // Insert into target
    const target = _findNode(c.tabs, targetTabId);
    if (target && !target.tab.items.includes(itemHrid)) {
        if (insertIndex !== undefined) {
            const clamped = Math.max(0, Math.min(insertIndex, target.tab.items.length));
            target.tab.items.splice(clamped, 0, itemHrid);
        } else {
            target.tab.items.push(itemHrid);
        }
    }
    return c;
}

/**
 * Append a line break sentinel to a tab's items array.
 * Multiple line breaks are allowed, so no duplicate check is performed.
 * @param {Object} config
 * @param {string} tabId
 * @returns {Object} new config
 */
export function addLineBreak(config, tabId) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) result.tab.items.push(LINEBREAK_HRID);
    return c;
}

/**
 * Reorder an item within a tab's items array
 * @param {Object} config
 * @param {string} tabId
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {Object} new config
 */
export function reorderItem(config, tabId, fromIndex, toIndex) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;
    const items = result.tab.items;
    if (fromIndex < 0 || fromIndex >= items.length) return c;
    const clamped = Math.max(0, Math.min(toIndex, items.length - 1));
    const [removed] = items.splice(fromIndex, 1);
    items.splice(clamped, 0, removed);
    return c;
}

/**
 * Remove an item from a tab
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function removeItem(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) {
        result.tab.items = result.tab.items.filter((h) => h !== itemHrid);
    }
    return c;
}

/**
 * Remove a single item at a specific index from a tab.
 * Preferred over removeItem when duplicates may exist (e.g. line breaks).
 * @param {Object} config
 * @param {string} tabId
 * @param {number} index
 * @returns {Object} new config
 */
export function removeItemAtIndex(config, tabId, index) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result && index >= 0 && index < result.tab.items.length) {
        result.tab.items.splice(index, 1);
    }
    return c;
}

/**
 * Toggle a tree node open/closed
 * @param {Object} config
 * @param {string} tabId
 * @param {boolean} open
 * @returns {Object} new config
 */
export function setTabOpen(config, tabId, open) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (result) result.tab.open = open;
    return c;
}

/**
 * Set the open state on every tab in the tree (including nested children).
 * @param {Object} config
 * @param {boolean} open
 * @returns {Object} new config
 */
export function setAllTabsOpen(config, open) {
    const c = clone(config);
    const walk = (tabs) => {
        for (const tab of tabs) {
            tab.open = open;
            if (tab.children?.length) walk(tab.children);
        }
    };
    walk(c.tabs);
    return c;
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Depth-first search for a tab by ID
 * @param {Object} config
 * @param {string} tabId
 * @returns {{ tab: Object, parent: Object|null } | null}
 */
export function findTab(config, tabId) {
    return _findNode(config.tabs, tabId);
}

/**
 * Collect all assigned itemHrids across every tab
 * @param {Object} config
 * @returns {Set<string>}
 */
export function getAssignedItemSet(config) {
    const set = new Set();
    _walkTabs(config.tabs, (tab) => {
        for (const hrid of tab.items) {
            if (hrid !== LINEBREAK_HRID) set.add(hrid);
        }
    });
    return set;
}

/**
 * Collect itemHrids from a tab and all its descendants
 * @param {Object} tab - A single TabNode
 * @returns {Set<string>}
 */
export function collectTabItems(tab) {
    const set = new Set();
    _walkTabs([tab], (t) => {
        for (const hrid of t.items) set.add(hrid);
    });
    return set;
}

/**
 * Collect itemHrids from every tab that appears above a tab in the panel's
 * top-to-bottom display order (depth-first pre-order). The tab itself, its
 * descendants, and everything below it are not included.
 * @param {Object} config
 * @param {string} tabId
 * @returns {Set<string>}
 */
export function collectItemsAboveTab(config, tabId) {
    const set = new Set();
    let found = false;
    const walk = (tabs) => {
        for (const tab of tabs) {
            if (found) return;
            if (tab.id === tabId) {
                found = true;
                return;
            }
            for (const hrid of tab.items) {
                if (hrid !== LINEBREAK_HRID) set.add(hrid);
            }
            if (tab.children.length > 0) walk(tab.children);
        }
    };
    walk(config.tabs);
    return set;
}

// ---------------------------------------------------------------------------
// Loadout binding helpers
// ---------------------------------------------------------------------------

/**
 * Strip the +N enhancement suffix from an HRID to get the base item
 * @param {string} hrid - e.g. "/items/sword+3"
 * @returns {string} e.g. "/items/sword"
 */
export function getBaseHrid(hrid) {
    const plusIdx = hrid.lastIndexOf('+');
    if (plusIdx === -1) return hrid;
    const suffix = hrid.substring(plusIdx + 1);
    return /^\d+$/.test(suffix) ? hrid.substring(0, plusIdx) : hrid;
}

/**
 * Record which items were added from a loadout
 * @param {Object} config
 * @param {string} tabId
 * @param {string} loadoutName
 * @param {string[]} items - HRIDs added from this loadout
 * @returns {Object} new config
 */
export function addLoadoutBinding(config, tabId, loadoutName, items) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result) return c;
    if (!result.tab.loadoutBindings) result.tab.loadoutBindings = {};
    const existing = result.tab.loadoutBindings[loadoutName] || [];
    // Merge new items into the binding (avoid duplicates)
    const merged = new Set(existing);
    for (const h of items) merged.add(h);
    result.tab.loadoutBindings[loadoutName] = [...merged];
    return c;
}

/**
 * Remove a specific item from all loadout bindings in a tab
 * Called when the user manually removes an item via the UI
 * @param {Object} config
 * @param {string} tabId
 * @param {string} itemHrid
 * @returns {Object} new config
 */
export function removeItemFromBindings(config, tabId, itemHrid) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings) return c;
    for (const [name, items] of Object.entries(result.tab.loadoutBindings)) {
        result.tab.loadoutBindings[name] = items.filter((h) => h !== itemHrid);
        // Clean up empty bindings
        if (result.tab.loadoutBindings[name].length === 0) {
            delete result.tab.loadoutBindings[name];
        }
    }
    return c;
}

/**
 * Check whether any other loadout binding on the tab still references an item
 * @param {Object} tab
 * @param {string} excludeLoadoutName - Binding to skip (the one being synced)
 * @param {string} itemHrid
 * @returns {boolean}
 */
function isBoundElsewhere(tab, excludeLoadoutName, itemHrid) {
    for (const [name, items] of Object.entries(tab.loadoutBindings || {})) {
        if (name === excludeLoadoutName) continue;
        if (items.includes(itemHrid)) return true;
    }
    return false;
}

/**
 * Sync a tab's loadout binding against a new snapshot.
 * Matches items by base HRID to detect enhancement level changes.
 * Items still referenced by another binding on the same tab are preserved.
 * @param {Object} config
 * @param {string} tabId
 * @param {string} loadoutName
 * @param {string[]} newSnapshotItems - Current items from the loadout snapshot
 * @returns {{ config: Object, changed: boolean }}
 */
export function syncLoadoutBinding(config, tabId, loadoutName, newSnapshotItems) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings?.[loadoutName]) {
        return { config: c, changed: false };
    }

    const tab = result.tab;
    const oldBound = tab.loadoutBindings[loadoutName];
    const oldByBase = new Map(oldBound.map((h) => [getBaseHrid(h), h]));
    const newByBase = new Map(newSnapshotItems.map((h) => [getBaseHrid(h), h]));
    let changed = false;

    // Enhancement level changed → swap in items[]
    for (const [base, newHrid] of newByBase) {
        const oldHrid = oldByBase.get(base);
        if (oldHrid && oldHrid !== newHrid) {
            const idx = tab.items.indexOf(oldHrid);
            if (idx === -1) continue;
            if (isBoundElsewhere(tab, loadoutName, oldHrid)) {
                // Another loadout on this tab still uses the old item — keep it
                // and add the new one alongside
                if (!tab.items.includes(newHrid)) {
                    tab.items.push(newHrid);
                    changed = true;
                }
            } else if (tab.items.includes(newHrid)) {
                tab.items.splice(idx, 1);
                changed = true;
            } else {
                tab.items[idx] = newHrid;
                changed = true;
            }
        }
    }

    // Items removed from loadout → remove from items[] unless another binding
    // on this tab still references them
    for (const [base, oldHrid] of oldByBase) {
        if (newByBase.has(base)) continue;
        if (isBoundElsewhere(tab, loadoutName, oldHrid)) continue;
        const filtered = tab.items.filter((h) => h !== oldHrid);
        if (filtered.length !== tab.items.length) {
            tab.items = filtered;
            changed = true;
        }
    }

    // Items added to loadout → append to items[]
    for (const [base, newHrid] of newByBase) {
        if (!oldByBase.has(base) && !tab.items.includes(newHrid)) {
            tab.items.push(newHrid);
            changed = true;
        }
    }

    // Update binding to reflect new state
    tab.loadoutBindings[loadoutName] = [...newSnapshotItems];
    return { config: c, changed };
}

/**
 * Remove orphaned bindings (loadout no longer exists) and their exclusive items.
 * Items that appear in other remaining bindings are preserved.
 * @param {Object} config
 * @param {string} tabId
 * @param {Set<string>} currentSnapshotNames - Set of loadout names that currently exist
 * @returns {{ config: Object, changed: boolean }}
 */
export function cleanOrphanedBindings(config, tabId, currentSnapshotNames) {
    const c = clone(config);
    const result = _findNode(c.tabs, tabId);
    if (!result || !result.tab.loadoutBindings) return { config: c, changed: false };

    const tab = result.tab;
    const orphanedNames = Object.keys(tab.loadoutBindings).filter((n) => !currentSnapshotNames.has(n));
    if (orphanedNames.length === 0) return { config: c, changed: false };

    // Collect items still tracked by non-orphaned bindings
    const stillBound = new Set();
    for (const [name, items] of Object.entries(tab.loadoutBindings)) {
        if (!orphanedNames.includes(name)) {
            items.forEach((h) => stillBound.add(h));
        }
    }

    // Remove orphaned bindings and their exclusive items
    for (const orphanName of orphanedNames) {
        const orphanItems = tab.loadoutBindings[orphanName] || [];
        for (const hrid of orphanItems) {
            if (!stillBound.has(hrid)) {
                tab.items = tab.items.filter((h) => h !== hrid);
            }
        }
        delete tab.loadoutBindings[orphanName];
    }

    return { config: c, changed: true };
}

// ---------------------------------------------------------------------------
// Internal tree traversal helpers
// ---------------------------------------------------------------------------

/**
 * Find a node by id in a tab tree, returning { tab, parent }
 * @param {Array} tabs
 * @param {string} id
 * @param {Object|null} parent
 * @returns {{ tab: Object, parent: Object|null } | null}
 */
function _findNode(tabs, id, parent = null) {
    for (const tab of tabs) {
        if (tab.id === id) return { tab, parent };
        if (tab.children.length > 0) {
            const found = _findNode(tab.children, id, tab);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Remove a node by id from a tab tree (mutates the array)
 * @param {Array} tabs
 * @param {string} id
 * @returns {boolean} true if removed
 */
function _removeFromArray(tabs, id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx !== -1) {
        tabs.splice(idx, 1);
        return true;
    }
    for (const tab of tabs) {
        if (_removeFromArray(tab.children, id)) return true;
    }
    return false;
}

/**
 * Walk all tabs depth-first, calling fn(tab) on each
 * @param {Array} tabs
 * @param {Function} fn
 */
function _walkTabs(tabs, fn) {
    for (const tab of tabs) {
        fn(tab);
        if (tab.children.length > 0) _walkTabs(tab.children, fn);
    }
}
