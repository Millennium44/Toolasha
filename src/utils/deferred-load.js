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
 * first paint. It is to keep asking until the database answers.
 *
 * Nothing here retries forever: a database that is not open after several
 * seconds is not going to open, and a feature quietly polling for the rest of
 * the session is worse than one that gave up and said so.
 */

import storage from '../core/storage.js';

/** Roughly five seconds of trying, front-loaded so the usual case is quick */
const DELAYS_MS = [0, 50, 150, 400, 800, 1500, 2500];

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
    for (const delay of DELAYS_MS) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));

        // `getJSON` warns and returns the default when the database is shut, so
        // the presence of a value is the only usable signal that it opened
        try {
            const saved = await storage.getJSON(key, store, null);
            if (saved !== null && saved !== undefined) {
                onLoaded(saved);
                return;
            }
            // An open database with nothing stored is a real answer: a first run
            if (storage.db) return;
        } catch (error) {
            console.error(`[DeferredLoad] Reading ${label} failed:`, error);
            return;
        }
    }
}
