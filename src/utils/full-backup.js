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
 * Export the whole database as JSON text, one store at a time.
 *
 * The object form held every store's values live at once and then handed the
 * lot to `JSON.stringify`, so peak memory was the entire database as objects
 * plus the entire database as a string — on an account with a year of history
 * that is where a backup runs out of room and the tab dies. Here each store is
 * read, serialized, and released before the next is read, so what is held is
 * the finished text plus one store.
 *
 * @returns {Promise<string>} The backup file's contents
 */
export async function exportEverythingJSON() {
    const storeNames = await listBackupStores();

    const parts = [
        `{"formatVersion":${FORMAT_VERSION},`,
        `"exportedAt":${JSON.stringify(new Date().toISOString())},`,
        '"stores":{',
    ];

    let first = true;
    for (const storeName of storeNames) {
        const entries = await storage.getAll(storeName);
        parts.push(`${first ? '' : ','}${JSON.stringify(storeName)}:${JSON.stringify(entries)}`);
        first = false;
    }

    parts.push('}}');
    return parts.join('');
}

/**
 * Export every key/value pair from every object store in the database.
 *
 * The object form, for callers that want to inspect the payload rather than
 * write it to a file. Anything writing it to a file should prefer
 * `exportEverythingJSON()`, which never materializes both forms at once.
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
 * @returns {Promise<{restored: Record<string, number>, expected: Record<string, number>,
 *   failed: Array<{store: string, expected: number, written: number}>, complete: boolean}>}
 *   What landed, what was meant to, and whether every store wrote its full count
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
    const expected = {};
    const failed = [];
    const written = new Set();

    // Land everything already queued before the restore overwrites it: a
    // debounced write that fires afterwards is the pre-restore value going
    // straight back on top of the restored one
    await storage.beginRestore?.();

    for (const storeName of targetStoreNames) {
        if (!Object.prototype.hasOwnProperty.call(payloadStores, storeName)) {
            continue;
        }

        if (!availableStoreSet.has(storeName)) {
            console.warn(`[FullBackup] Skipping unknown store in backup payload: ${storeName}`);
            continue;
        }

        const entries = payloadStores[storeName] || {};
        const want = Object.keys(entries).length;
        const count = await storage.putAll(storeName, entries);
        restored[storeName] = count;
        expected[storeName] = want;

        // One key the store refuses aborts the whole transaction and takes
        // every healthy key with it, so a shortfall is not "most of it landed"
        // — it is usually "none of this store landed". Saying so is what stops
        // a caller recording the restore as done.
        if (count !== want) {
            console.error(`[FullBackup] Store ${storeName} restored ${count} of ${want} keys — the rest did not land`);
            failed.push({ store: storeName, expected: want, written: count });
        } else if (want > 0) {
            written.add(storeName);
        }
    }

    // Only stores that wrote their full count are latched: a store that wrote
    // nothing has not been restored, and refusing its writes would break a
    // feature for nothing.
    if (written.size > 0) storage.finishRestore?.(written);

    return { restored, expected, failed, complete: failed.length === 0 };
}

export default {
    listBackupStores,
    exportEverything,
    exportEverythingJSON,
    importEverything,
};
