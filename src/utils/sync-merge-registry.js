/**
 * Which storage keys a sync pull may combine instead of overwrite.
 *
 * Cross-device sync applies a downloaded payload by writing whole storage keys
 * (`utils/full-backup.js#importEverything`). For a setting or a curated list
 * that is exactly right — one side has to win, and the newest copy is the one
 * the user last touched. For a *history* it is a data-loss bug: two devices
 * that both opened treasure chests, both filled market listings, both recorded
 * XP samples each hold entries the other has never seen, and whole-key writes
 * throw one set away at database granularity.
 *
 * Those histories already know how to fold two copies together — they had to,
 * because two tabs on one machine do a slower version of the same thing to
 * each other (see `utils/persisted-record.js`). This registry is how the sync
 * feature reaches those folds without importing them.
 *
 * **Why a registry and not imports.** Sync lives in the `ui` bundle; the
 * merges live in `market`, `combat`, `guild` and friends. A direct import
 * would inline those feature modules into the UI bundle — a second copy of
 * each, with its own module state — which `scripts/check-bundle-sharing.mjs`
 * exists to catch. So this module lives in `utils` (shared by every bundle,
 * one instance), each owning feature calls `registerSyncMerge()` at import
 * time, and sync only ever asks `mergeForKey()`.
 *
 * **Why import-time registration is enough.** Every bundle is loaded before
 * the script finishes booting, and the earliest pull is the staggered startup
 * pull twenty seconds in — so by the time anything asks, every registration
 * has run. A merge that is somehow missing is not a failure: the key simply
 * falls back to the whole-key write it used before.
 *
 * **Direction.** A merge is called `merge(local, incoming)`: this device's
 * copy is the base, the downloaded copy folds on top. Every registered merge
 * follows the codebase's `(base, fresh)` convention, so an entry both sides
 * have resolves to the incoming one — which for an additive history means the
 * same entry twice over, and for a counter means the max (those merges take
 * the larger of each count rather than the later argument). The point is the
 * union, not the precedence.
 */

/** @typedef {(local: *, incoming: *) => *} SyncMerge */

/**
 * @typedef {Object} SyncMergeRegistration
 * @property {string} store - Object store the key lives in
 * @property {(key: string) => boolean} match - Whether this registration owns a key
 * @property {SyncMerge} merge - Folds the incoming value onto the local one
 * @property {string} label - For logging and for the apply summary
 */

/** @type {Array<SyncMergeRegistration>} */
const registrations = [];

/**
 * A matcher for a per-character (or per-guild, or per-name) storage key.
 *
 * `character-key.js` builds `${base}_${characterId}`, and the pre-scoping
 * value lived at the bare `base` — which is still there on accounts that
 * never triggered the one-time adoption, and is still worth merging.
 * @param {string} base - The unscoped key
 * @returns {(key: string) => boolean} Matcher
 */
export function scopedKeyMatcher(base) {
    const prefix = `${base}_`;
    return (key) => key === base || key.startsWith(prefix);
}

/**
 * Declare that a storage key can be merged rather than overwritten on a pull.
 *
 * Exactly one of `key`, `base`, `prefix` or `match` says which keys are meant:
 *
 * - `key` — one exact key (a global record such as `playerXP`)
 * - `base` — a scoped base, matching `base` and `base_<id>` alike
 * - `prefix` — a raw `startsWith` test, for keys with a freer shape
 * - `match` — anything else, as a predicate
 *
 * @param {Object} options - The registration
 * @param {string} options.store - Object store name, as passed to `storage.set`
 * @param {string} [options.key] - Exact key
 * @param {string} [options.base] - Scoped key base
 * @param {string} [options.prefix] - Raw key prefix
 * @param {(key: string) => boolean} [options.match] - Key predicate
 * @param {SyncMerge} options.merge - `(local, incoming) => merged`
 * @param {string} [options.label] - Name for logs and the apply summary
 * @returns {() => void} Unregister, mostly for tests
 */
export function registerSyncMerge({ store, key, base, prefix, match, merge, label }) {
    if (!store) throw new Error('[SyncMergeRegistry] registerSyncMerge needs a store');
    if (typeof merge !== 'function') throw new Error('[SyncMergeRegistry] registerSyncMerge needs a merge()');

    let matcher = match;
    if (!matcher && typeof key === 'string') matcher = (candidate) => candidate === key;
    if (!matcher && typeof base === 'string') matcher = scopedKeyMatcher(base);
    if (!matcher && typeof prefix === 'string') matcher = (candidate) => candidate.startsWith(prefix);
    if (typeof matcher !== 'function') {
        throw new Error('[SyncMergeRegistry] registerSyncMerge needs one of key, base, prefix or match');
    }

    const registration = {
        store,
        match: matcher,
        merge,
        label: label || key || base || prefix || store,
    };
    registrations.push(registration);

    return () => {
        const index = registrations.indexOf(registration);
        if (index !== -1) registrations.splice(index, 1);
    };
}

/**
 * The merge for one storage key, if it has one.
 *
 * First registration wins, so a feature that registers a narrow key before a
 * broad prefix gets the narrow one.
 * @param {string} store - Object store name
 * @param {string} key - Storage key
 * @returns {SyncMergeRegistration|null} The registration, or null for a key that must be written whole
 */
export function mergeForKey(store, key) {
    if (!store || typeof key !== 'string') return null;
    for (const registration of registrations) {
        if (registration.store !== store) continue;
        try {
            if (registration.match(key)) return registration;
        } catch (error) {
            console.error(`[SyncMergeRegistry] Matcher for ${registration.label} threw:`, error);
        }
    }
    return null;
}

/**
 * Every registration, for diagnostics and for the settings panel's "what does
 * a pull combine?" answer.
 * @returns {Array<{store: string, label: string}>} Registered merges
 */
export function listSyncMerges() {
    return registrations.map(({ store, label }) => ({ store, label }));
}

/**
 * Drop every registration. Tests only — the real lifetime is the page's.
 * @returns {void}
 */
export function clearSyncMerges() {
    registrations.length = 0;
}

export default { registerSyncMerge, mergeForKey, listSyncMerges, clearSyncMerges, scopedKeyMatcher };
