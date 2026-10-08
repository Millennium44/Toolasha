/**
 * Another script's keys in this sync: the public registration call, and the
 * device-local record that makes a registration outlive the page.
 *
 * The registry itself — validation, and the in-memory list `ownsKey` reads —
 * lives in `sync-ownership.js`, so `ownsKey` stays a pure synchronous function.
 * This module is the part that touches storage.
 *
 * ## Why it is remembered
 *
 * The other script loads whenever its userscript manager runs it, and may
 * register after this script's startup pull or first push. A registration held
 * only in memory would leave those first exchanges without its keys: the pull
 * would drop them from the download and the push would leave them out of the
 * upload. So every prefix this device learns — registered here, or read from a
 * payload — is written to `toolasha_sync_externalKeys` (device-local, under the
 * sync's own bookkeeping prefix, never uploaded as a key), and every payload
 * build and apply loads that record before it reads ownership. From the second
 * page load on, the other script's keys are carried from the first exchange
 * whether or not it has registered yet.
 *
 * ## How the registry reaches other devices
 *
 * Not through that key — through the payload's own `externalKeys` field (see
 * `sync-payload.js`), learned by every apply and every merged upload. See the
 * section "Keys another script opts in" in `sync-ownership.js` for why a device
 * that never runs the other script must know the prefixes too.
 */

import storage from '../../core/storage.js';
import {
    addExternalKeyPrefixes,
    removeExternalKeyPrefixes,
    externalKeyPrefixes,
    externalKeyRecord,
    learnExternalKeyPrefixes,
    onExternalKeyPrefixesChange,
    _resetExternalKeyPrefixes,
} from './sync-ownership.js';

/** Where this device remembers every registered prefix. Device-local: `toolasha_sync_` never uploads */
export const KEY_EXTERNAL_KEYS = 'toolasha_sync_externalKeys';

const STORE = 'settings';

/** The load in flight or done; null until the first attempt, and again after a failed one */
let loading = null;

/** Writes of the record, one after another */
let writing = Promise.resolve();

/**
 * Read the remembered registry into memory, once per page.
 *
 * A read that could not be made (the database not open yet, a failed
 * transaction) is not taken as "nothing registered": the next call tries again,
 * and nothing is written over the record until a read has succeeded.
 *
 * @returns {Promise<boolean>} Whether the record has been read
 */
export function ensureExternalKeysLoaded() {
    if (!loading) {
        loading = (async () => {
            try {
                await storage.ready;
                const read = await storage.tryGet(KEY_EXTERNAL_KEYS, STORE);
                if (!read) throw new Error('the record could not be read');
                // Trusted: valid when it was written, and never cut down on the
                // way in, or the next save would write a smaller record
                if (read.found) learnExternalKeyPrefixes(read.value, { notify: false, trusted: true });
                return true;
            } catch (error) {
                console.warn('[Sync] Could not load the registered key prefixes; retrying on the next sync:', error);
                loading = null;
                return false;
            }
        })();
    }
    return loading;
}

/**
 * Write the registry as it now stands.
 *
 * Loaded first, so a registration made before the record was read cannot write
 * a smaller record over a bigger one: the load unions the stored prefixes into
 * memory and what is written is the union. Through the bulk path with
 * `bypassRestoreLatch` — this is sync bookkeeping, and a pull earlier in the
 * page may have latched the settings store.
 *
 * @returns {Promise<void>}
 */
function persist() {
    writing = writing.then(async () => {
        try {
            if (!(await ensureExternalKeysLoaded())) return;
            const written = await storage.putAll(
                STORE,
                { [KEY_EXTERNAL_KEYS]: externalKeyRecord() },
                { bypassRestoreLatch: true }
            );
            if (written !== 1) console.warn('[Sync] The registered key prefixes were not saved.');
        } catch (error) {
            console.warn('[Sync] Could not save the registered key prefixes:', error);
        }
    });
    return writing;
}

onExternalKeyPrefixesChange(() => {
    persist();
});

/**
 * Wait for every pending write of the record.
 * @returns {Promise<void>}
 */
export function externalKeysSettled() {
    return writing;
}

/*
 * The three calls below are asynchronous: each waits for this device's
 * remembered record to load first, so it answers about — and changes — the
 * whole registry, not just what this page has heard of so far. Called before
 * the load, `unregisterKeys({owner})` would otherwise see no prefixes, report
 * nothing removed and leave the saved ones syncing.
 */

/**
 * Ask for some of another script's keys in the `settings` store to travel with
 * this sync. Exposed as `window.Toolasha.sync.registerKeys`.
 *
 * Each prefix must be a string of at least 6 characters, may not overlap any
 * key this script owns or sit in its `toolasha` namespace, may not overlap a
 * prefix registered under a different owner, and at most 32 are held across
 * every owner. Registering is additive and idempotent: call it on every page
 * load with the same list. {@link unregisterSyncKeys} withdraws a prefix.
 *
 * Should the remembered record be unreadable, the registration still holds for
 * this page and is saved by the next change that finds it readable.
 *
 * @param {{owner: string, prefixes: string[]}} registration - Who is asking, and for which key prefixes
 * @returns {Promise<{ok: boolean, accepted: string[], added: string[], rejected: Array<{prefix: *, reason: string}>,
 *   error?: string}>} What was taken, what was new, and what was refused and why
 */
export async function registerSyncKeys(registration) {
    await ensureExternalKeysLoaded();
    const { owner, prefixes } = registration && typeof registration === 'object' ? registration : {};
    const result = addExternalKeyPrefixes(owner, prefixes);
    if (result.error || result.rejected.length > 0) {
        console.warn('[Sync] Key registration refused in part:', result.error || result.rejected);
    }
    return result;
}

/**
 * Withdraw some of an owner's prefixes, or all of them when none are named.
 * Exposed as `window.Toolasha.sync.unregisterKeys`.
 *
 * The removal is remembered and carried in the payload, so the other devices
 * drop the prefix too instead of teaching it back. Keys already stored under it
 * stay where they are on every device; they just stop travelling.
 *
 * Refused outright when the remembered record cannot be read: without it this
 * device does not know which prefixes there are to withdraw, and a removal it
 * could not save would be undone by the next page load.
 *
 * @param {{owner: string, prefixes?: string[]}} registration - Whose prefixes, and which
 * @returns {Promise<{ok: boolean, removed: string[], rejected: Array<{prefix: string, reason: string}>,
 *   error?: string}>} What was withdrawn, and what could not be recorded
 */
export async function unregisterSyncKeys(registration) {
    if (!(await ensureExternalKeysLoaded())) {
        const error = 'the saved registrations could not be read; nothing was removed. Try again.';
        console.warn('[Sync] Key unregistration refused:', error);
        return { ok: false, removed: [], rejected: [], error };
    }
    const { owner, prefixes } = registration && typeof registration === 'object' ? registration : {};
    const result = removeExternalKeyPrefixes(owner, prefixes);
    if (result.error || result.rejected.length > 0) {
        console.warn('[Sync] Key unregistration refused in part:', result.error || result.rejected);
    }
    return result;
}

/**
 * Every registered prefix, by owner. Exposed as `window.Toolasha.sync.registeredKeys`.
 * @returns {Promise<Record<string, string[]>>} Prefixes by owner
 */
export async function registeredSyncKeys() {
    await ensureExternalKeysLoaded();
    return externalKeyPrefixes();
}

/**
 * Test seam: forget the registry and the load, as a fresh page would.
 * @returns {void}
 */
export function _resetExternalKeys() {
    _resetExternalKeyPrefixes();
    loading = null;
    writing = Promise.resolve();
}

export default {
    registerSyncKeys,
    unregisterSyncKeys,
    registeredSyncKeys,
    ensureExternalKeysLoaded,
    externalKeysSettled,
};
