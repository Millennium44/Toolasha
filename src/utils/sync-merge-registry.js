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
 *
 * That incoming-wins order is a contract, not a habit: an upload folds with
 * either side as the incoming one — the gist, or this device when only this
 * device moved — and relies on the second argument taking what the fold
 * cannot combine. A merge must never swap its arguments to change who wins.
 * A record whose PULL must keep this device's copy on a tie declares
 * `localWinsOnPull` instead, and the pull alone folds through `mergeForPull`.
 */

/**
 * @typedef {(local: *, incoming: *, context?: {forUpload?: boolean}) => *} SyncMerge
 * `context.forUpload` is set when the fold builds an automatic upload rather
 * than a local apply. A merge that caps or prunes by this device's live
 * settings must keep everything then — the gist is every device's copy, and
 * one device's retention choice is not the others'. Constant, build-wide caps
 * fold identically everywhere and may ignore it.
 */

/**
 * @typedef {Object} SyncMergeRegistration
 * @property {string} store - Object store the key lives in
 * @property {(key: string) => boolean} match - Whether this registration owns a key
 * @property {SyncMerge} merge - Folds the incoming value onto the local one; ties go to `incoming`
 * @property {SyncMerge} mergeForPull - The fold a pull applies: the registration's own `pull` fold when it
 *   has one; else `merge`, or with `localWinsOnPull` the same fold with this device's copy as the side that
 *   wins ties
 * @property {string} label - For logging and for the apply summary
 * @property {boolean} capsLocally - This device keeps the history shorter by its own setting, so a push
 *   that replaces the gist can cut entries the gist holds. Only such a registration can report a trim
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
 * @param {SyncMerge} options.merge - `(local, incoming) => merged`, ties to `incoming`
 * @param {boolean} [options.localWinsOnPull] - A pull keeps this device's copy where the fold ties
 *   (`mergeForPull` folds with the arguments turned round); uploads still use `merge`
 * @param {SyncMerge} [options.pull] - The fold a pull applies, when it must differ from `merge`: a record
 *   this device compacts or prunes as it records, whose union with the gist would hand back what it dropped.
 *   Called `(local, incoming)` like `merge`; takes precedence over `localWinsOnPull`
 * @param {string} [options.label] - Name for logs and the apply summary
 * @param {boolean} [options.capsLocally] - The fold caps the history by a setting of this device (and keeps
 *   everything for `forUpload`). Opt-in: only a flagged registration can make a pressed Push warn about a trim
 * @returns {() => void} Unregister, mostly for tests
 */
export function registerSyncMerge({
    store,
    key,
    base,
    prefix,
    match,
    merge,
    localWinsOnPull = false,
    pull,
    label,
    capsLocally = false,
}) {
    if (!store) throw new Error('[SyncMergeRegistry] registerSyncMerge needs a store');
    if (typeof merge !== 'function') throw new Error('[SyncMergeRegistry] registerSyncMerge needs a merge()');

    let matcher = match;
    if (!matcher && typeof key === 'string') matcher = (candidate) => candidate === key;
    if (!matcher && typeof base === 'string') matcher = scopedKeyMatcher(base);
    if (!matcher && typeof prefix === 'string') matcher = (candidate) => candidate.startsWith(prefix);
    if (typeof matcher !== 'function') {
        throw new Error('[SyncMergeRegistry] registerSyncMerge needs one of key, base, prefix or match');
    }

    // What was claimed, not just what it was called. Two claims can share a
    // label without being the same claim — `base: 'rec'` and `prefix: 'rec'`
    // both default their label to 'rec', and two match-only claims on one
    // store both default to the store name — and deduping on the label alone
    // would silently drop the second one (and hand its caller a remover that
    // deletes the *first*). The signature mirrors the matcher priority above;
    // a bare `match` is identified by its source, which is identical across
    // bundle copies of one module and different for genuinely different code.
    let claim;
    if (typeof match === 'function') claim = `match:${String(match)}`;
    else if (typeof key === 'string') claim = `key:${key}`;
    else if (typeof base === 'string') claim = `base:${base}`;
    else claim = `prefix:${prefix}`;

    const registration = {
        store,
        match: matcher,
        merge,
        mergeForPull:
            typeof pull === 'function'
                ? pull
                : localWinsOnPull
                  ? (local, incoming, context) => merge(incoming, local, context)
                  : merge,
        label: label || key || base || prefix || store,
        capsLocally: capsLocally === true,
        claim,
    };

    // The packaged build carries some registering modules in more than one
    // bundle, and each copy makes this exact call with the same claim. This
    // registry is shared, so the second registration is a duplicate: first-wins
    // makes it harmless, but every matching key would trip the overlap report
    // below and drown it in false positives. Same store + same label + same
    // claim is the same registration — hand back a remover for the copy that
    // already stands.
    const existing = registrations.find(
        (r) => r.store === registration.store && r.label === registration.label && r.claim === registration.claim
    );
    if (existing) {
        return () => {
            const index = registrations.indexOf(existing);
            if (index !== -1) registrations.splice(index, 1);
        };
    }

    registrations.push(registration);

    return () => {
        const index = registrations.indexOf(registration);
        if (index !== -1) registrations.splice(index, 1);
    };
}

/** Overlaps already reported, so one bad pair does not log per key */
const reportedOverlaps = new Set();

/**
 * The merge for one storage key, if it has one.
 *
 * **The contract is that matchers do not overlap.** First registration wins,
 * and registration order is import order — which is bundle order, decided by
 * the build rather than by anything a feature controls. So two registrations
 * that both match a key do not resolve to "the narrow one" or "the specific
 * one"; they resolve to whichever bundle happened to load first, and that can
 * change when a module moves. A key must be owned by exactly one registration.
 *
 * An overlap is a bug in the registrations, not a case to handle, so it is
 * reported rather than resolved — once per pair of labels, since a payload has
 * thousands of keys and the same pair would otherwise fill the console.
 *
 * @param {string} store - Object store name
 * @param {string} key - Storage key
 * @returns {SyncMergeRegistration|null} The registration, or null for a key that must be written whole
 */
export function mergeForKey(store, key) {
    if (!store || typeof key !== 'string') return null;

    let found = null;
    for (const registration of registrations) {
        if (registration.store !== store) continue;
        try {
            if (!registration.match(key)) continue;
        } catch (error) {
            console.error(`[SyncMergeRegistry] Matcher for ${registration.label} threw:`, error);
            continue;
        }

        if (!found) {
            found = registration;
            continue;
        }

        const pair = `${store}|${found.label}|${registration.label}`;
        if (!reportedOverlaps.has(pair)) {
            reportedOverlaps.add(pair);
            console.warn(
                `[SyncMergeRegistry] "${found.label}" and "${registration.label}" both claim ${store}/${key}. ` +
                    'Matchers must not overlap — which one wins is bundle import order, not intent.'
            );
        }
        break;
    }
    return found;
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
 * @typedef {Object} SyncRetention
 * @property {string} store - Object store the keys live in
 * @property {string} prefix - Raw key prefix the rule owns
 * @property {(key: string) => {group: string, order: number, end?: number}|null} parse - Which window a key
 *   belongs to and where it sorts in it (larger is newer); null for a key the rule does not judge. `end` is the
 *   latest moment the key can hold, when that is later than `order` (a month key's last day); defaults to `order`
 * @property {number} [keep] - How many of the newest keys each window keeps
 * @property {{span: number, now: () => number}} [maxAge] - Keys whose `end` is more than `span` before the
 *   window's reference moment are dropped; the reference is `now()`, capped at the newest `end` in the window
 */

/** @type {Array<SyncRetention>} */
const retentions = [];

/**
 * Declare that a family of keys is kept to a rolling window by its owner, so
 * sync must neither upload nor write back a key that falls outside it.
 *
 * A key this device deleted by retention is simply absent from its payload,
 * and absence is not a deletion to sync: the upload merge keeps every key only
 * the gist holds, and a pull writes every key this device lacks. So a pruned
 * key never left the gist, came back on every pull, was pruned again by its
 * owner, and the next pull brought it back once more — a "Reload now" after
 * every exchange. A retention rule is the owner's own window, applied by sync
 * to both sides' keys together: a key outside it is dropped from the upload
 * and from the download, so it leaves the gist at the next merged push and is
 * never written here again.
 *
 * Window membership is decided over the union of the two sides' keys, so a
 * device that has the newer keys pushes the other side's older ones out
 * rather than keeping both.
 *
 * A rule is a count (`keep`), an age (`maxAge`), or both. An age rule is for an owner that prunes by date, not
 * by count: it keeps a row for a number of days whether it has written one a day or one a week, so a count of
 * keys cannot say what it keeps. Its reference moment is the clock, but never later than the newest key in the
 * window: a device that has been idle (or whose clock is ahead) keeps more than the owner's own pruning would,
 * never less, and a rule only deletes what its owner would delete anyway.
 *
 * @param {Object} options - The rule
 * @param {string} options.store - Object store name
 * @param {string} options.prefix - Raw key prefix
 * @param {(key: string) => {group: string, order: number, end?: number}|null} options.parse - Window, order and
 *   latest moment of a key
 * @param {number} [options.keep] - Newest keys kept per window
 * @param {{span: number, now: () => number}} [options.maxAge] - Age cutoff, in the units `parse` returns
 * @returns {() => void} Unregister, mostly for tests
 */
export function registerSyncRetention({ store, prefix, parse, keep, maxAge }) {
    if (!store || typeof prefix !== 'string' || !prefix) {
        throw new Error('[SyncMergeRegistry] registerSyncRetention needs a store and a prefix');
    }
    if (typeof parse !== 'function') throw new Error('[SyncMergeRegistry] registerSyncRetention needs a parse()');
    const hasAge = Boolean(maxAge) && Number.isFinite(maxAge.span) && typeof maxAge.now === 'function';
    if (keep !== undefined && (!Number.isInteger(keep) || keep < 1)) {
        throw new Error('[SyncMergeRegistry] registerSyncRetention needs a positive keep');
    }
    if (keep === undefined && !hasAge) {
        throw new Error('[SyncMergeRegistry] registerSyncRetention needs a keep or a maxAge');
    }
    // One rule per store and prefix: a bundle copy of the owning module makes
    // the same call again, and the first stands
    const existing = retentions.find((rule) => rule.store === store && rule.prefix === prefix);
    const rule = existing || { store, prefix, parse, keep, maxAge: hasAge ? maxAge : undefined };
    if (!existing) retentions.push(rule);
    return () => {
        const index = retentions.indexOf(rule);
        if (index !== -1) retentions.splice(index, 1);
    };
}

/**
 * The keys of one store that a retention rule puts outside its window, judged
 * over every key given — pass both sides' keys together.
 *
 * Keys no rule owns, and keys a rule's `parse` declines, are never dropped.
 *
 * @param {string} store - Object store name
 * @param {Iterable<string>} keys - Every key in play (this device's and the other side's)
 * @returns {Set<string>} The keys to leave out
 */
export function retentionDrops(store, keys) {
    const dropped = new Set();
    const rules = retentions.filter((rule) => rule.store === store);
    if (rules.length === 0) return dropped;

    for (const rule of rules) {
        /** group → [{key, order}] */
        const groups = new Map();
        for (const key of new Set(keys)) {
            if (typeof key !== 'string' || !key.startsWith(rule.prefix)) continue;
            let parsed = null;
            try {
                parsed = rule.parse(key);
            } catch (error) {
                console.error(`[SyncMergeRegistry] Retention parse for ${rule.prefix} threw:`, error);
            }
            if (!parsed || typeof parsed.group !== 'string' || !Number.isFinite(parsed.order)) continue;
            if (!groups.has(parsed.group)) groups.set(parsed.group, []);
            const end = Number.isFinite(parsed.end) ? parsed.end : parsed.order;
            groups.get(parsed.group).push({ key, order: parsed.order, end });
        }
        for (const members of groups.values()) {
            if (rule.maxAge) {
                let newest = -Infinity;
                for (const { end } of members) newest = Math.max(newest, end);
                const floor = Math.min(rule.maxAge.now(), newest) - rule.maxAge.span;
                for (const { key, end } of members) if (end < floor) dropped.add(key);
            }
            if (rule.keep === undefined || members.length <= rule.keep) continue;
            // Newest first; equal orders by key, so both devices drop the same ones
            members.sort((a, b) => b.order - a.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            for (const { key } of members.slice(rule.keep)) dropped.add(key);
        }
    }
    return dropped;
}

/**
 * Drop every registration. Tests only — the real lifetime is the page's.
 * @returns {void}
 */
export function clearSyncMerges() {
    registrations.length = 0;
    reportedOverlaps.clear();
    retentions.length = 0;
}

export default {
    registerSyncMerge,
    mergeForKey,
    listSyncMerges,
    clearSyncMerges,
    scopedKeyMatcher,
    registerSyncRetention,
    retentionDrops,
};
