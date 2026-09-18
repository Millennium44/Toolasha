/**
 * Storage Persistence
 *
 * Asks the browser to mark this origin's storage as "persistent", so the
 * browser's own storage-pressure eviction is less likely to silently wipe
 * IndexedDB the way an unrelated browser crash did on 2026-09-17 — Chrome
 * recreated the origin's whole `indexeddb.leveldb` from nothing two minutes
 * after the crash, taking every character's settings, history and ledgers
 * with it. `navigator.storage.persist()` cannot prevent a crash, but a
 * persisted origin is explicitly exempted from Chrome's least-recently-used
 * eviction, which is the mechanism most likely to remove data quietly, with
 * nothing on screen to explain it.
 *
 * Best-effort only. The browser grants or refuses by its own heuristics (site
 * engagement, bookmarks, notifications, installed-PWA status…) and a refusal
 * is completely normal — most sites never get it on the first ask. This must
 * never read as an error to the player: no toast, no modal, nothing above
 * `console.info`.
 */

import storage from './storage.js';

/**
 * Where the last-attempt timestamp is kept, so a refusal is not re-asked every
 * load.
 *
 * Carries the `toolasha_local_` prefix on purpose: persistence is a property
 * of one browser on one machine, not of the account, so this stamp must never
 * travel with a settings sync. `toolasha_local_` is what `sync-ownership.js`'s
 * `OWNED_KEY_PREFIXES`, `sync-payload.js`'s `LOCAL_ONLY_KEY_PREFIXES` and
 * `settings-storage.js`'s `DEVICE_LOCAL_KEY_PREFIXES` already exclude a pull,
 * an upload and an export by, so this key rides the same existing machinery
 * rather than needing a rule of its own.
 */
const LAST_ATTEMPT_KEY = 'toolasha_local_persistStorageAttemptedAt';

/**
 * The pre-rename key. Before this stamp carried `toolasha_local_`, it was
 * plain `toolasha_persistStorageAttemptedAt` — synced like any other owned
 * key, which meant a sync pull could carry one device's "already asked" stamp
 * onto another and suppress its own request for up to a day. Read once as a
 * fallback so a device upgrading to the renamed key does not lose its stamp
 * and re-ask the browser the very next load.
 */
const LEGACY_LAST_ATTEMPT_KEY = 'toolasha_persistStorageAttemptedAt';

/**
 * How often to retry after the browser has not (yet) granted persistence.
 *
 * The call itself is cheap, but re-asking on every page load would just be a
 * permission-style check on a hot path for something that essentially never
 * changes minute to minute. A day is short enough that a player who crosses
 * whatever engagement threshold Chrome uses gets the grant within a day of
 * qualifying, and long enough that this is, in practice, at most one real ask
 * per day no matter how many times the page reloads.
 */
const RETRY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Read the last-attempt stamp, migrating the pre-rename key once if the
 * renamed one has never been written.
 *
 * A device that already has the legacy stamp gets it copied onto the new key
 * (and the old one removed) so this runs at most once per device; a device
 * that has neither has genuinely never attempted this before and gets `0`,
 * same as the original behaviour.
 *
 * @returns {Promise<number>} The last-attempt timestamp, or `0` if none
 * @private
 */
async function readLastAttempt() {
    const current = await storage.get(LAST_ATTEMPT_KEY, 'settings', null);
    if (current !== null) return current;

    const legacy = await storage.get(LEGACY_LAST_ATTEMPT_KEY, 'settings', null);
    if (legacy === null) return 0;

    try {
        await storage.set(LAST_ATTEMPT_KEY, legacy, 'settings', true);
        await storage.delete(LEGACY_LAST_ATTEMPT_KEY, 'settings');
    } catch (error) {
        console.debug('[StoragePersistence] Could not migrate the legacy persistence-attempt stamp:', error);
    }
    return legacy;
}

/**
 * Ask the browser to persist this origin's storage, once, quietly.
 *
 * No-ops when the API is missing (older browsers, some embedded webviews),
 * when persistence is already granted, and when the last attempt — granted or
 * not — was within {@link RETRY_INTERVAL_MS}. Never throws: every failure
 * mode, including the attempt-flag read/write itself, is caught and logged at
 * `debug` at most.
 *
 * @returns {Promise<void>}
 */
async function requestPersistence() {
    try {
        if (typeof navigator === 'undefined') return;
        if (typeof navigator.storage?.persisted !== 'function' || typeof navigator.storage?.persist !== 'function') {
            return;
        }

        if (await navigator.storage.persisted()) return;

        const lastAttempt = await readLastAttempt();
        if (Date.now() - lastAttempt < RETRY_INTERVAL_MS) return;

        // Recorded before the ask, not after: a refusal is a normal answer and
        // must not leave the flag unset, or a refused origin gets re-asked
        // every load forever instead of once a day.
        await storage.set(LAST_ATTEMPT_KEY, Date.now(), 'settings', true);

        const granted = await navigator.storage.persist();
        console.info(`[StoragePersistence] navigator.storage.persist() ${granted ? 'granted' : 'declined'}`);
    } catch (error) {
        console.debug('[StoragePersistence] Could not request persistent storage:', error);
    }
}

export default { requestPersistence };
