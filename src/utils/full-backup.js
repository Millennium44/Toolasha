/**
 * Full Database Backup/Restore
 *
 * Whole-database export/import across every IndexedDB object store the
 * script defines, unlike `settings-storage.js#exportSettings` which only
 * covers the 'settings' store. Used to back up and restore everything —
 * dungeon runs, XP history, market listings, combat stats, etc.
 */

import storage from '../core/storage.js';

const FORMAT_VERSION = 1;

/**
 * List every object store name currently defined in the database.
 * @returns {Promise<Array<string>>} Store names
 */
export async function listBackupStores() {
    return storage.listStores();
}

/**
 * Export every key/value pair from every object store in the database.
 * @returns {Promise<{formatVersion: number, exportedAt: string, stores: Record<string, Record<string, *>>}>}
 *   Backup payload
 */
export async function exportEverything() {
    const storeNames = await listBackupStores();
    const stores = {};

    for (const storeName of storeNames) {
        stores[storeName] = await storage.getAll(storeName);
    }

    return {
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        stores,
    };
}

/**
 * Restore key/value pairs from a previously exported backup payload.
 *
 * Writes go through `storage.putAll()` (one transaction per store, no
 * debouncing) rather than `storage.set()`, since importing hundreds of keys
 * through the debounced path would mean hundreds of pending per-key timers.
 * @param {{formatVersion: number, stores: Record<string, Record<string, *>>}} payload - Backup payload,
 *   as produced by `exportEverything()`
 * @param {{storeNames?: Array<string>}} [options] - Restore options
 * @param {Array<string>} [options.storeNames] - Restrict restore to these store names.
 *   Defaults to every store present in the payload.
 * @returns {Promise<{restored: Record<string, number>}>} Number of keys restored per store
 */
export async function importEverything(payload, options = {}) {
    if (!payload || payload.formatVersion !== FORMAT_VERSION) {
        throw new Error(`[FullBackup] Unsupported or missing formatVersion (expected ${FORMAT_VERSION})`);
    }

    const payloadStores = payload.stores || {};
    const targetStoreNames = options.storeNames ?? Object.keys(payloadStores);

    const availableStores = await listBackupStores();
    const availableStoreSet = new Set(availableStores);

    const restored = {};

    for (const storeName of targetStoreNames) {
        if (!Object.prototype.hasOwnProperty.call(payloadStores, storeName)) {
            continue;
        }

        if (!availableStoreSet.has(storeName)) {
            console.warn(`[FullBackup] Skipping unknown store in backup payload: ${storeName}`);
            continue;
        }

        const count = await storage.putAll(storeName, payloadStores[storeName]);
        restored[storeName] = count;
    }

    return { restored };
}

export default {
    listBackupStores,
    exportEverything,
    importEverything,
};
