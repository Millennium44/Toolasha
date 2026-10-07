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
 * Whether a parsed backup value can contain a map of stores or record keys.
 * Values inside a record remain unrestricted, including arrays of history.
 * @param {*} value
 * @returns {boolean}
 */
function isRecordMap(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Key prefixes that are device-local in EVERY store, not just the one that
 * happens to use them today.
 *
 * `toolasha_local_` currently holds the preserved chat history
 * (`features/chat/chat-history-persistence.js`), which is every chat tab's
 * markup — whispers and private messages included. The maintainer chose to keep
 * that on disk; a backup file is the thing people paste into a Discord thread
 * when they want help, and the sync uploads to a GitHub gist, so it is kept out
 * of both.
 *
 * Scoped to every store rather than to `settings` on purpose. The chat record
 * lives in `settings` only because a new object store would mean a `dbVersion`
 * bump — a constraint that can lift, and `buildPayloadJSON('everything')` walks
 * every store `listStores()` reports. A store-scoped rule would then let the
 * same record out through the same upload without a line of it changing here.
 * The prefix means "never leaves this device" wherever it is written.
 *
 * `toolasha_sync_` is the sync's own bookkeeping: which gist, how far this
 * device has got with it, its last-exchange baseline and whether the gist
 * holds changes not applied here. True only of the machine that wrote it — a
 * backup restored on another machine, or on this one after it has synced
 * since, would hand the sync a position it never reached, and the next push
 * could overwrite the gist with a copy that never saw what was there.
 */
export const DEVICE_LOCAL_KEY_PREFIXES = ['toolasha_local_', 'toolasha_sync_'];

/**
 * Storage keys left out of every export, scoped to the store they live in.
 *
 * The guild trial diagnostic trace (`features/guild/guild-trial-trace.js`) is
 * opt-in and deliberately large — its own header comment says a full trial's
 * trace can run 10-15MB gzipped by itself, several times the rest of an
 * account's data combined — and it carries raw combat data with participant
 * names in it. It already has its own dedicated export (`exportTrace()`) for
 * when someone actually wants to share one; there is no reason for it to also
 * ride along in an ordinary backup or sync, silently inflating both past the
 * point a gist can hold. The literal prefixes are duplicated from that file
 * rather than imported from it — a feature reaching down into a util it is
 * built on is the wrong direction, so the two are kept in step by hand.
 *
 * `settings` names the device-local prefix as well, redundantly with
 * {@link DEVICE_LOCAL_KEY_PREFIXES}: it is the list `core/settings-storage.js`
 * is pinned against, and that module cannot import this one (Core loads before
 * Utils), so the store the chat record actually lives in stays named here.
 *
 * `labyrinth`'s `labyrinthTickCaptureAutosave_` is the raw tick capture's
 * autosave (`features/combat/labyrinth-tick-capture.js`) — a held capture can
 * run to several MB (8000 ticks) and is device-local recovery state for a
 * crash or a cancelled Save dialog, not history worth keeping in a backup or
 * syncing to a gist. It is also the same reasoning `trialTraceChunk_` above
 * already established for this list: large, transient, single-device.
 *
 * `combatExport`'s `guild_trial_inputs_` holds the Trial Input Capture library
 * (`features/guild/guild-trial-simulation-inputs.js`): up to eight saved
 * guild/week captures per character, each allowed up to 20 MB of opened
 * profiles and trial loadouts. Its setting promises to keep them on this
 * browser, and `combatExport` otherwise syncs whole, so one large capture
 * could push the gist past its size cap and fail every push. The capture panel
 * has its own JSON export and import for moving a capture to another device.
 */
export const EXCLUDED_STORE_KEY_PREFIXES = {
    guildHistory: ['trialTraceManifest', 'trialTraceChunk_'],
    combatExport: ['guild_trial_inputs_'],
    labyrinth: ['labyrinthTickCaptureAutosave_'],
    settings: [...DEVICE_LOCAL_KEY_PREFIXES],
};

/**
 * Records whose removals live under a companion key, scoped to their store.
 *
 * The enhancement tracker (`features/enhancement/enhancement-storage.js`) keeps
 * the ids of deleted sessions in `enhancementTracker_sessionTombstones`, and
 * every load drops a stored session whose id is there. A restore writes whole
 * keys and leaves the rest alone, so a backup made before a session was deleted
 * — or before tombstones existed at all — put the session back under the
 * sessions key while this device's tombstone went on hiding it. Restoring a
 * record therefore restores its tombstones with it (see
 * {@link reconcileRestoredTombstones}). Literal key names, duplicated from that
 * module for the same reason {@link EXCLUDED_STORE_KEY_PREFIXES} duplicates its
 * prefixes: a util does not import the features built on it.
 */
const TOMBSTONE_COMPANIONS = {
    settings: [{ record: 'enhancementTracker_sessions', tombstones: 'enhancementTracker_sessionTombstones' }],
};

/**
 * Make every restored record's tombstones agree with it: the tombstones the
 * payload carries for it, or this device's when it carries none, without the
 * ids the restored record holds. A record keyed per character
 * (`<record>_<id>`) pairs with `<tombstones>_<id>`.
 *
 * Read after the restore hold has landed the write queue, so this device's
 * tombstones are current. One that cannot be read is written empty: the
 * restored sessions showing is the point, and a tombstone only ever hides.
 * @param {string} storeName
 * @param {Record<string, *>} entries - What the restore is about to write; not mutated
 * @returns {Promise<Record<string, *>>} `entries`, or a copy with tombstone keys set
 */
async function reconcileRestoredTombstones(storeName, entries) {
    const rules = TOMBSTONE_COMPANIONS[storeName];
    if (!rules) return entries;
    let out = entries;
    for (const { record, tombstones } of rules) {
        for (const key of Object.keys(entries)) {
            if (key !== record && !key.startsWith(`${record}_`)) continue;
            const graveKey = `${tombstones}${key.slice(record.length)}`;
            let graves;
            if (Object.hasOwn(entries, graveKey)) {
                graves = entries[graveKey];
            } else {
                const probed = typeof storage.tryGet === 'function' ? await storage.tryGet(graveKey, storeName) : null;
                // Nothing stored, so nothing to hide the restored record behind
                if (probed && !probed.found) continue;
                graves = probed?.value;
            }
            const restored = entries[key] && typeof entries[key] === 'object' ? entries[key] : {};
            const kept = {};
            for (const [id, at] of Object.entries(graves && typeof graves === 'object' ? graves : {})) {
                if (!Object.hasOwn(restored, id)) kept[id] = at;
            }
            if (out === entries) out = { ...entries };
            out[graveKey] = kept;
        }
    }
    return out;
}

/**
 * Drop every key in `entries` whose store excludes it.
 * @param {string} storeName
 * @param {Record<string, *>} entries
 * @returns {Record<string, *>} `entries` itself when it has nothing to drop, otherwise a
 *   filtered copy; `entries` is never mutated
 */
export function stripExcludedKeys(storeName, entries) {
    const prefixes = [...DEVICE_LOCAL_KEY_PREFIXES, ...(EXCLUDED_STORE_KEY_PREFIXES[storeName] || [])];

    // Scanned before anything is allocated: every store now has prefixes to
    // check, and this runs one store at a time precisely so a backup never
    // holds two copies of one. A store with nothing to drop hands its own
    // object straight back.
    const keys = Object.keys(entries || {});
    if (!keys.some((key) => prefixes.some((prefix) => key.startsWith(prefix)))) return entries;

    const kept = {};
    for (const key of keys) {
        if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
        kept[key] = entries[key];
    }
    return kept;
}

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
        const entries = stripExcludedKeys(storeName, await storage.getAll(storeName));
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
        stores[storeName] = stripExcludedKeys(storeName, await storage.getAll(storeName));
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

    const payloadStores = payload.stores;
    if (!isRecordMap(payloadStores)) {
        throw new Error('[FullBackup] Invalid stores: expected an object mapping store names to records');
    }
    const targetStoreNames = options.storeNames ?? Object.keys(payloadStores);

    const availableStores = await listBackupStores();
    const availableStoreSet = new Set(availableStores);

    // Validate the entire selection before writing its first store. A broken
    // later store must not leave the earlier ones overwritten, and strings or
    // arrays must not be mistaken for maps of numeric record keys. Unknown and
    // unselected stores are not imported, so their contents do not block this
    // device's restore.
    for (const storeName of targetStoreNames) {
        if (!Object.prototype.hasOwnProperty.call(payloadStores, storeName) || !availableStoreSet.has(storeName)) {
            continue;
        }
        if (!isRecordMap(payloadStores[storeName])) {
            throw new Error(`[FullBackup] Invalid records for store ${storeName}: expected an object`);
        }
    }

    const restored = {};
    const expected = {};
    const failed = [];
    const written = new Set();

    // Land everything already queued before the restore overwrites it: a
    // debounced write that fires afterwards is the pre-restore value going
    // straight back on top of the restored one. From here until endRestore,
    // timers that fire hold their write instead — the latch below only goes up
    // after every store is written, and a 3-second debounce can fire inside a
    // multi-store restore.
    try {
        await storage.beginRestore?.();

        for (const storeName of targetStoreNames) {
            if (!Object.prototype.hasOwnProperty.call(payloadStores, storeName)) {
                continue;
            }

            if (!availableStoreSet.has(storeName)) {
                console.warn(`[FullBackup] Skipping unknown store in backup payload: ${storeName}`);
                continue;
            }

            // Excluded on export (below) and just as much on import: an old
            // build's payload, or one from before a key was added to the
            // exclusion list, can still carry one of these, and writing it here
            // would plant it on this device exactly as if it had been recorded
            // locally.
            const entries = await reconcileRestoredTombstones(
                storeName,
                stripExcludedKeys(storeName, payloadStores[storeName])
            );
            const want = Object.keys(entries).length;
            // The restore is the one writer the latch is not protecting against
            // — it is what the latch is protecting. A second pull in the same
            // session would otherwise be refused by the first one's latch.
            const count = await storage.putAll(storeName, entries, { bypassRestoreLatch: true });
            restored[storeName] = count;
            expected[storeName] = want;

            // One key the store refuses aborts the whole transaction and takes
            // every healthy key with it, so a shortfall is not "most of it
            // landed" — it is usually "none of this store landed". Saying so is
            // what stops a caller recording the restore as done.
            if (count !== want) {
                console.error(
                    `[FullBackup] Store ${storeName} restored ${count} of ${want} keys — the rest did not land`
                );
                failed.push({ store: storeName, expected: want, written: count });
            } else if (want > 0) {
                written.add(storeName);
            }
        }
    } finally {
        try {
            // Protect completed stores even if a later store threw. Otherwise
            // endRestore flushes queued pre-restore values straight over them.
            // A store that wrote nothing has nothing restored to protect.
            if (written.size > 0) storage.finishRestore?.(written);
        } finally {
            // Always release the hold, including a failed beginRestore flush.
            await storage.endRestore?.();
        }
    }

    return { restored, expected, failed, complete: failed.length === 0 };
}

export default {
    listBackupStores,
    exportEverything,
    exportEverythingJSON,
    importEverything,
};
