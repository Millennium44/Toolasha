/**
 * Deferred load
 *
 * Reading from storage that is not open yet.
 *
 * A module that loads its saved state at import time is racing the database.
 * IndexedDB opens asynchronously and the bootstrap opens it after the libraries
 * are evaluated, so a `storage.getJSON` at module scope reliably returns the
 * default — and reliably logs "Database not available" while doing it. The
 * feature then runs on defaults for the rest of the session and looks like it
 * simply forgot everything.
 *
 * The fix is not to load later, because the overlay reads that state on its
 * first paint. It is to wait for the database rather than to ask it early.
 *
 * This used to poll — read, wait, read again, for about five seconds — because
 * a shut database is indistinguishable from an empty one from the outside. The
 * storage module now says when it has finished starting up, so there is one
 * thing to wait on and no guessing about how long.
 */

import storage from '../core/storage.js';

/**
 * Read a key once storage can answer.
 *
 * @param {string} key - Storage key
 * @param {string} store - Object store
 * @param {Function} onLoaded - Called with the value, only when one was found
 * @param {string} [label] - What to call this in the log
 * @returns {Promise<void>}
 */
export async function loadWhenReady(key, store, onLoaded, label = key) {
    try {
        await storage.ready;
        const saved = await storage.getJSON(key, store, null);
        if (saved !== null && saved !== undefined) onLoaded(saved);
    } catch (error) {
        console.error(`[DeferredLoad] Reading ${label} failed:`, error);
    }
}
