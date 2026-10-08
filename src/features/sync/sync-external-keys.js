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

/** The save the latest change started, for a public call to wait on */
let lastSave = Promise.resolve(true);

/** Whether some change to the registry has not reached disk */
let unsaved = false;

/**
 * Write the registry as it now stands.
 *
 * Loaded first, so a registration made before the record was read cannot write
 * a smaller record over a bigger one: the load unions the stored prefixes into
 * memory and what is written is the union. Through the bulk path with
 * `bypassRestoreLatch` — this is sync bookkeeping, and a pull earlier in the
 * page may have latched the settings store.
 *
 * A failed save leaves the registry marked unsaved, so the next public call
 * tries again even when it changes nothing.
 *
 * @returns {Promise<boolean>} Whether the record on disk now matches the registry
 */
function persist() {
    const attempt = writing.then(async () => {
        try {
            if (!(await ensureExternalKeysLoaded())) {
                unsaved = true;
                return false;
            }
            const written = await storage.putAll(
                STORE,
                { [KEY_EXTERNAL_KEYS]: externalKeyRecord() },
                { bypassRestoreLatch: true }
            );
            unsaved = written !== 1;
            if (unsaved) console.warn('[Sync] The registered key prefixes were not saved.');
        } catch (error) {
            unsaved = true;
            console.warn('[Sync] Could not save the registered key prefixes:', error);
        }
        return !unsaved;
    });
    writing = attempt.then(() => {});
    lastSave = attempt;
    return attempt;
}

onExternalKeyPrefixesChange(() => {
    persist();
});

/**
 * Wait until the record on disk holds the registry as this call left it, and
 * add the answer to the call's result.
 *
 * The change itself stays in memory either way: it holds for this page, and
 * the next change saves it with everything else. But a caller asking to be
 * carried, or to stop being carried, has to be able to tell that a reload
 * would undo it — so an unsaved change answers `ok: false`, `saved: false`.
 *
 * @param {{ok: boolean}} result - What the registry call answered
 * @param {boolean} changed - Whether the call changed the registry (and so started a save)
 * @returns {Promise<Object>} The result, with `saved` and, when not saved, `ok: false` and `error`
 */
async function withSaved(result, changed) {
    let saved = true;
    if (changed) saved = await lastSave;
    else if (unsaved) saved = await persist();
    if (saved) return { ...result, saved };
    return {
        ...result,
        ok: false,
        saved,
        error:
            result.error ||
            'the change holds on this page but could not be saved, so a reload would undo it. Try again.',
    };
}

/**
 * Wait for every pending write of the record.
 * @returns {Promise<void>}
 */
export function externalKeysSettled() {
    return writing;
}

/**
 * Wait for every pending write of the record, and say whether the registry is
 * on disk — retrying the write once more when an earlier one failed.
 *
 * For the sync's own paths that learn prefixes from a download: a pull that
 * applied keys under a prefix this device could not save would find them
 * unowned after a reload, and its next push would drop them from the gist.
 *
 * @returns {Promise<boolean>} True when the record on disk holds the registry
 */
export async function ensureExternalKeysSaved() {
    await writing;
    if (!unsaved) return true;
    return persist();
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
 * Resolves once the registration is saved. Should it not be — the remembered
 * record unreadable, or the write refused — the registration still holds for
 * this page and the answer says `ok: false, saved: false`: a reload would drop
 * it until the next call saves it.
 *
 * @param {{owner: string, prefixes: string[]}} registration - Who is asking, and for which key prefixes
 * @returns {Promise<{ok: boolean, saved?: boolean, accepted: string[], added: string[],
 *   rejected: Array<{prefix: *, reason: string}>, error?: string}>} What was taken, what was new, whether it is
 *   saved, and what was refused and why
 */
export async function registerSyncKeys(registration) {
    await ensureExternalKeysLoaded();
    const { owner, prefixes } = registration && typeof registration === 'object' ? registration : {};
    const result = addExternalKeyPrefixes(owner, prefixes);
    if (result.error) {
        console.warn('[Sync] Key registration refused:', result.error);
        return result;
    }
    if (result.rejected.length > 0) console.warn('[Sync] Key registration refused in part:', result.rejected);
    return withSaved(result, result.added.length > 0);
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
 * device does not know which prefixes there are to withdraw. Resolves once the
 * removal is saved; when the write fails, the removal still holds for this page
 * (the keys stop travelling now) and the answer says `ok: false, saved: false`,
 * because a reload would bring the prefixes back until a later call saves it.
 *
 * @param {{owner: string, prefixes?: string[]}} registration - Whose prefixes, and which
 * @returns {Promise<{ok: boolean, saved?: boolean, removed: string[],
 *   rejected: Array<{prefix: string, reason: string}>, error?: string}>} What was withdrawn, whether it is saved,
 *   and what could not be recorded
 */
export async function unregisterSyncKeys(registration) {
    if (!(await ensureExternalKeysLoaded())) {
        const error = 'the saved registrations could not be read; nothing was removed. Try again.';
        console.warn('[Sync] Key unregistration refused:', error);
        return { ok: false, removed: [], rejected: [], error };
    }
    const { owner, prefixes } = registration && typeof registration === 'object' ? registration : {};
    const result = removeExternalKeyPrefixes(owner, prefixes);
    if (result.error) {
        console.warn('[Sync] Key unregistration refused:', result.error);
        return result;
    }
    if (result.rejected.length > 0) console.warn('[Sync] Key unregistration refused in part:', result.rejected);
    return withSaved(result, result.removed.length > 0);
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
    lastSave = Promise.resolve(true);
    unsaved = false;
}

export default {
    ensureExternalKeysSaved,
    registerSyncKeys,
    unregisterSyncKeys,
    registeredSyncKeys,
    ensureExternalKeysLoaded,
    externalKeysSettled,
};
