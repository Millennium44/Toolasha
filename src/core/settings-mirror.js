/**
 * Settings Mirror
 *
 * Copies the settings half of the `settings` IndexedDB store into
 * Tampermonkey's own extension-scoped storage (`GM_setValue`/`GM_getValue`),
 * which lives outside the page origin and so survives exactly the kind of
 * whole-origin wipe a browser crash caused on 2026-09-17 — Chrome recreated
 * the origin's `indexeddb.leveldb` from nothing two minutes after the crash,
 * taking every character's `script_settingsMap_*` key with it. Histories
 * (alchemy log, combat stats, the treasure ledger…) rebuild themselves by
 * playing; a hand-typed settings choice does not, which is the part worth a
 * second copy living somewhere a page-origin wipe cannot reach.
 *
 * Deliberately narrow: only the settings maps and the small bookkeeping that
 * makes them load correctly are mirrored (see {@link isMirroredKey}), never a
 * history store, a toggle for this behaviour, or anything touching sync.
 *
 * ## Cadence
 *
 * Mirrored on a timer ({@link MIRROR_INTERVAL_MS}), not on every settings
 * write. A settings save already happens on close to every keystroke of a
 * debounced text field and every drag of a number input; mirroring on each
 * one would put a synchronous `GM_setValue` call on that hot path for a
 * safety net that only ever matters once in a great while. Ten minutes keeps
 * the mirror within one short session of "what the player actually has"
 * without turning routine settings tweaks into extra writes. A first mirror
 * also runs 30 seconds after {@link startMirroring} — long enough that the
 * character's settings load has certainly finished, short enough that a
 * session that ends early (closing the tab, a crash) still very likely got
 * one mirror in.
 *
 * ## Cross-tab cost
 *
 * `lastWriteAttempt` is per-tab, so left alone every open tab would run its
 * own ten-minute timer and pay the full cost independently — one
 * `JSON.stringify` of every character's settings map (70-100 KB each) plus a
 * `GM_setValue` of the result, times however many tabs are open. Two things
 * cut that down for the periodic (non-forced) pass:
 *
 * - **Cross-tab cadence.** {@link MIRROR_META_KEY} holds a small
 *   `{writtenAt, fingerprint}` record, separate from the ~1 MB
 *   {@link MIRROR_KEY} payload so checking it costs a read of a few dozen
 *   bytes, not the whole mirror. A tab whose own timer fires first checks
 *   this before doing anything else; if another tab mirrored inside the
 *   interval, this tab adopts that cadence and returns without touching the
 *   live store at all.
 * - **Change fingerprint.** When the cadence does allow a pass, the payload
 *   collected from the live store is hashed ({@link fingerprintPayload}, a
 *   cheap non-cryptographic hash — the point is a fast integer compare, not
 *   avoiding the read) and compared against the fingerprint from the last
 *   real write. An unchanged fingerprint skips the `JSON.stringify` of the
 *   full merged payload and the `GM_setValue` of it — the two actually
 *   expensive steps — while still refreshing the meta record's `writtenAt`
 *   so other tabs keep deferring.
 *
 * Worst case per tab per hour is now one full stringify+write (the settings
 * genuinely changed) plus up to five cheap meta reads that found nothing to
 * do (one per ten-minute tick) — down from up to six full stringify+writes
 * before this, once per open tab.
 *
 * A forced call ({@link maybeMirror}'s `force` parameter — the one-time
 * initial mirror, and tests) skips both of these and always attempts a
 * write once {@link collectMirrorable} has vouched for the payload. Forcing
 * still updates {@link MIRROR_META_KEY} on a real write, so a forced write
 * in one tab still shortens the cadence other tabs see.
 *
 * ## Never mirroring a wipe
 *
 * The rule that matters most: a mirror write must never replace a good
 * mirror with data read from an empty or unreadable live store, or the
 * mirror stops being a safety net and becomes a second way to lose the same
 * data. {@link collectMirrorable} enforces the ordering this depends on —
 * read the live store first, and only once that read has produced at least
 * one real, non-empty per-character settings map does a write happen at all.
 * Two distinct failure shapes both refuse the write, not just the empty one:
 *
 * - The listing itself fails (`storage.tryGetAllKeys` returns `null`, not an
 *   array) — the store could not be read at all, e.g. IndexedDB not yet open.
 * - The listing succeeds but nothing in it looks like a real character
 *   settings map — either a genuinely fresh install (nothing to mirror yet,
 *   which is fine) or a store that has just been wiped (the case this whole
 *   module exists for, and the one case a write must never happen for).
 *
 * Either way {@link collectMirrorable} returns `null` and {@link maybeMirror}
 * skips the write outright — whatever GM storage already holds is left
 * exactly as it was.
 *
 * ## Why the write merges rather than replaces
 *
 * "The live store has at least one real settings map" is not the same as "the
 * live store has every settings map it used to have", and a whole-payload
 * replacement treated them as the same thing. The case that matters is the one
 * this module exists for: after a wipe the player logs in as one character and
 * accepts the restore, so the live store now holds exactly one real map — and
 * the very next mirror pass would have written that single map over the
 * mirror, taking every *other* character's backup with it, before those
 * characters were ever logged in to be offered their own restore. A partial
 * live store has the same shape whenever one key's read fails mid-pass, or the
 * mirror arrives on a second browser profile through the extension's own
 * storage sync. So a pass adds to and updates the mirror, never subtracts from
 * it: keys the live store no longer has keep whatever was last mirrored for
 * them. Nothing is lost by keeping a stale entry — a deliberate reset writes a
 * fresh defaults map straight back to the same key (`settings-ui.js` follows
 * `settingsStorage.resetToDefaults()` with `config.resetToDefaults()`), so the
 * next pass mirrors the reset rather than the map it replaced.
 */

import storage from './storage.js';

/** Where the mirror lives in GM (extension-scoped) storage. */
const MIRROR_KEY = 'toolasha_settingsMirror_v1';

/**
 * Small cross-tab coordination record — `{writtenAt, fingerprint}` — kept
 * separate from {@link MIRROR_KEY}'s full payload so every tab's cadence
 * check is a read of a few dozen bytes rather than the whole mirror. See the
 * "Cross-tab cost" section of the file doc.
 */
const MIRROR_META_KEY = 'toolasha_settingsMirror_meta_v1';

/** How often {@link maybeMirror} is allowed to actually write — see file doc. */
const MIRROR_INTERVAL_MS = 10 * 60 * 1000;

/** Delay before the first mirror after {@link startMirroring} — see file doc. */
const INITIAL_MIRROR_DELAY_MS = 30 * 1000;

/** The per-character settings map key template, and its account-wide counterpart. */
const SETTINGS_MAP_PREFIX = 'script_settingsMap';
const SHARED_SETTINGS_KEY = 'script_settingsMap_shared';

/**
 * Bookkeeping kept alongside the settings maps — mirrored for completeness,
 * not read back by the restore offer (see `features/settings/settings-mirror-
 * restore.js`, which restores only the settings map itself and lets it
 * reconcile through the normal migration path, the same as any map that
 * "arrived from elsewhere").
 */
const BOOKKEEPING_PREFIXES = ['settings_key_migrations_applied_', 'settings_default_rewrites_'];
const BOOKKEEPING_EXACT_KEYS = ['settings_shared_scope_v3', 'known_character_ids'];

/** Module-level so repeated calls (a timer tick, a manual trigger) self-throttle. */
let lastWriteAttempt = 0;
let intervalId = null;
let initialTimeoutId = null;

function gmAvailable() {
    return typeof GM_getValue !== 'undefined' && typeof GM_setValue !== 'undefined';
}

/**
 * Whether a storage key belongs in the mirror at all.
 * @param {string} key
 * @returns {boolean}
 */
function isMirroredKey(key) {
    if (BOOKKEEPING_EXACT_KEYS.includes(key)) return true;
    if (BOOKKEEPING_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
    return key === SETTINGS_MAP_PREFIX || key.startsWith(`${SETTINGS_MAP_PREFIX}_`);
}

/**
 * A key that holds one character's actual settings map — not the account-wide
 * shared map, and not one of the bookkeeping keys beside it.
 * @param {string} key
 * @returns {boolean}
 */
function isCharacterMapKey(key) {
    return (key === SETTINGS_MAP_PREFIX || key.startsWith(`${SETTINGS_MAP_PREFIX}_`)) && key !== SHARED_SETTINGS_KEY;
}

/**
 * Read every mirrorable key off the live store, or `null` when the live store
 * cannot vouch for itself as real data right now. See file doc for why both
 * failure shapes below matter.
 *
 * @returns {Promise<Object|null>} key → value, or `null` meaning "do not mirror this pass"
 */
async function collectMirrorable() {
    const keys = await storage.tryGetAllKeys('settings');
    if (!Array.isArray(keys)) return null; // Listing failed outright — never guess

    const relevant = keys.filter(isMirroredKey);
    const payload = {};
    for (const key of relevant) {
        const probed = await storage.tryGet(key, 'settings');
        if (!probed || !probed.found) continue; // Vanished or unreadable mid-pass — leave it out, don't abort the rest
        payload[key] = probed.value;
    }

    // A localStorage-era migration can still leave a character's settings map
    // stored as a JSON *string* rather than the object every current writer
    // (`storage.setJSON` → `set`) stores. Normalize it the same way the
    // settings loader itself reads one back, so it is recognized as real data
    // below instead of silently never being mirrored. A value that does not
    // parse to an object (or fails to parse at all) is left exactly as read —
    // still correctly excluded from `hasRealCharacterMap` below.
    for (const key of Object.keys(payload)) {
        if (!isCharacterMapKey(key) || typeof payload[key] !== 'string') continue;
        const parsed = storage.parseJSON(payload[key], key, null);
        if (parsed && typeof parsed === 'object') payload[key] = parsed;
    }

    // The guarantee: at least one *real* character settings map, not just
    // bookkeeping or an empty shell. Anything short of this is either a fresh
    // install (nothing lost) or a wipe (the one thing that must never
    // overwrite a good mirror) — collectMirrorable cannot tell those apart,
    // and does not need to: both refuse the write the same way.
    const hasRealCharacterMap = Object.keys(payload).some((key) => {
        const value = payload[key];
        // Not an array: a settings map is id → record, and `Object.keys` on a
        // non-empty array is happy to report length for something that is not
        // a settings map at all — the one thing this check exists to refuse.
        if (!isCharacterMapKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
        return Object.keys(value).length > 0;
    });
    if (!hasRealCharacterMap) return null;

    return payload;
}

/**
 * The mirror's current `data` map, or `null` when there is none (or it cannot
 * be read/parsed). Callers must already have checked {@link gmAvailable}.
 * @returns {Object|null}
 */
function readMirrorData() {
    try {
        const raw = GM_getValue(MIRROR_KEY, null);
        if (!raw) return null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const data = parsed?.data;
        return data && typeof data === 'object' ? data : null;
    } catch (error) {
        console.error('[SettingsMirror] Could not read mirror:', error);
        return null;
    }
}

/**
 * The small cross-tab coordination record, or `null` when there is none (or
 * it cannot be read/parsed). An unreadable/garbled record is treated the
 * same as "no record" — it must never be mistaken for "just wrote", which
 * would wedge every tab's cadence check open forever.
 * @returns {{writtenAt: number, fingerprint: string|null}|null}
 */
function readMirrorMeta() {
    try {
        const raw = GM_getValue(MIRROR_META_KEY, null);
        if (!raw) return null;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.writtenAt !== 'number') return null;
        return parsed;
    } catch (error) {
        console.error('[SettingsMirror] Could not read mirror meta:', error);
        return null;
    }
}

/**
 * Persist the cross-tab coordination record. Best-effort: a failure here
 * must not block the mirror write it accompanies, so it only logs.
 * @param {number} writtenAt
 * @param {string|null} fingerprint
 * @returns {void}
 */
function writeMirrorMeta(writtenAt, fingerprint) {
    try {
        GM_setValue(MIRROR_META_KEY, JSON.stringify({ writtenAt, fingerprint }));
    } catch (error) {
        console.error('[SettingsMirror] Could not write mirror meta:', error);
    }
}

/**
 * Whether GM storage holds a mirror payload at all.
 *
 * The fingerprint skip says "the payload has not changed since the last
 * write", which is only a reason to skip if that write actually produced a
 * mirror in *this* GM store. Two ways it did not: a manager whose
 * `GM_setValue` reports success and stores nothing (the meta record, a few
 * dozen bytes, lands where the ~1 MB payload does not), and a meta record
 * that arrived here through the extension's own storage sync while the
 * payload — far too large for a synced value — did not. Both leave a
 * fingerprint that matches forever and no mirror to show for it, so the
 * safety net silently never exists. A truthiness check on the raw value is
 * the cheap half of {@link readMirrorData}: the read, without the parse.
 * @returns {boolean}
 */
function mirrorExists() {
    try {
        return Boolean(GM_getValue(MIRROR_KEY, null));
    } catch (error) {
        console.error('[SettingsMirror] Could not check for an existing mirror:', error);
        return false;
    }
}

/**
 * A cheap fingerprint of a mirrorable payload — cheap in that comparing two
 * of these is a string equality check rather than a deep object diff, not
 * that computing one avoids looking at the payload: there is no way to know
 * a settings map changed without reading it. A collision would at worst skip
 * a write that should have landed, which the next pass with an actual change
 * corrects, so a fast 32-bit hash (FNV-1a) is enough.
 *
 * What this costs, weighed and accepted: a large account serializes on the
 * order of a megabyte here every {@link MIRROR_INTERVAL_MS}, whether or not
 * anything changed, because the only way to find out is to look. It is one
 * pass per browser session rather than per tab — a tab that sees a recent
 * meta stamp returns before reaching this — and it buys skipping the much
 * larger merge, stringify and `GM_setValue` below. Making it cheaper means
 * trusting something other than the bytes (a stored size, an mtime, a cached
 * per-key hash) to say a map is unchanged, which is a weaker guarantee than
 * the thing it guards. Left as is deliberately; do not re-raise it as a
 * finding without a measurement showing this pass is actually hurting.
 *
 * @param {Object} payload - From {@link collectMirrorable}
 * @returns {string} A short opaque fingerprint
 */
function fingerprintPayload(payload) {
    let hash = 0x811c9dc5;
    for (const key of Object.keys(payload).sort()) {
        const chunk = `${key}=${JSON.stringify(payload[key])}|`;
        for (let i = 0; i < chunk.length; i++) {
            hash ^= chunk.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
    }
    return (hash >>> 0).toString(36);
}

/**
 * Mirror the live settings to GM storage, if the cadence allows it and the
 * live store looks trustworthy. Safe to call often — it self-throttles, both
 * within this tab and, for the periodic (non-forced) pass, across tabs — see
 * the file doc's "Cross-tab cost" section.
 *
 * @param {boolean} [force=false] - Skip the cadence and change-fingerprint
 *   checks (the initial mirror, and tests). Anti-poisoning — refusing a
 *   payload {@link collectMirrorable} would not vouch for — always applies.
 * @returns {Promise<boolean>} Whether a write actually landed
 */
async function maybeMirror(force = false) {
    if (!gmAvailable()) return false;

    if (!force) {
        // Cheapest check first: this tab's own memory, no GM read at all.
        if (Date.now() - lastWriteAttempt < MIRROR_INTERVAL_MS) return false;

        // Next cheapest: a few dozen bytes of meta rather than the mirror's
        // full payload. Another tab may have mirrored inside the interval —
        // if so, adopt its cadence instead of also reading the live store.
        // A stamp in the future is never this tab's own — GM storage is
        // extension-scoped and travels between profiles and devices through
        // the extension's own sync, so the record can carry another machine's
        // clock. Deferring to it would hold every pass off until real time
        // caught up with that clock: minutes for a little skew, days for a
        // badly set one, with no mirror written the whole while. Treat it the
        // same as no record — the write below restamps it with this machine's
        // clock, which also unwedges every other tab here.
        const meta = readMirrorMeta();
        const sinceMetaWrite = meta ? Date.now() - meta.writtenAt : Infinity;
        if (sinceMetaWrite >= 0 && sinceMetaWrite < MIRROR_INTERVAL_MS) {
            lastWriteAttempt = meta.writtenAt;
            return false;
        }
    }
    lastWriteAttempt = Date.now();

    try {
        const payload = await collectMirrorable();
        if (!payload) return false;

        if (!force) {
            const fingerprint = fingerprintPayload(payload);
            const meta = readMirrorMeta();
            if (meta && meta.fingerprint === fingerprint && mirrorExists()) {
                // Nothing has changed since the last real write. Refresh the
                // cadence stamp so other tabs still see this pass happened,
                // without paying for the full stringify + GM_setValue below.
                writeMirrorMeta(Date.now(), fingerprint);
                return false;
            }
        }

        // Union, live wins — see "Why the write merges rather than replaces".
        const data = { ...(readMirrorData() || {}), ...payload };

        GM_setValue(MIRROR_KEY, JSON.stringify({ writtenAt: Date.now(), data }));
        writeMirrorMeta(Date.now(), fingerprintPayload(payload));
        return true;
    } catch (error) {
        console.error('[SettingsMirror] Mirror write failed:', error);
        return false;
    }
}

/**
 * Start the periodic mirror. Call once, at startup. A no-op when GM storage
 * is not available (e.g. a manager without the grant, or a non-Tampermonkey
 * context) — nothing here ever falls back to a page-origin store, since a
 * page-origin store is exactly what this exists to survive without.
 * @returns {void}
 */
function startMirroring() {
    if (!gmAvailable()) return;
    stopMirroring();

    initialTimeoutId = setTimeout(() => {
        maybeMirror(true).catch((error) => console.error('[SettingsMirror] Initial mirror failed:', error));
    }, INITIAL_MIRROR_DELAY_MS);

    intervalId = setInterval(() => {
        maybeMirror().catch((error) => console.error('[SettingsMirror] Scheduled mirror failed:', error));
    }, MIRROR_INTERVAL_MS);
}

/**
 * Stop the periodic mirror. Exposed for tests; production code runs this for
 * the life of the page.
 * @returns {void}
 */
function stopMirroring() {
    if (initialTimeoutId !== null) clearTimeout(initialTimeoutId);
    if (intervalId !== null) clearInterval(intervalId);
    initialTimeoutId = null;
    intervalId = null;
}

/**
 * Read one character's mirrored settings map, if the mirror has one.
 * @param {string} characterKey - e.g. `script_settingsMap_12345`
 * @returns {Object|null} The mirrored entry, or `null`
 */
function getMirroredEntry(characterKey) {
    if (!gmAvailable()) return null;
    const entry = readMirrorData()?.[characterKey];
    if (entry && typeof entry === 'object') return entry;
    // Defensive: collectMirrorable() normalizes a legacy string-shaped map
    // before it is ever written, but parse here too in case an older mirror
    // (written before that normalization existed) still holds one.
    if (typeof entry === 'string') {
        const parsed = storage.parseJSON(entry, characterKey, null);
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    return null;
}

/**
 * Reset the cadence throttle — both this tab's own and, when GM storage is
 * available, the cross-tab meta record — so the next call behaves as if no
 * mirror has ever run. Test-only — production never needs to forget that it
 * just wrote.
 * @returns {void}
 */
function _resetCadenceForTests() {
    lastWriteAttempt = 0;
    if (!gmAvailable()) return;
    try {
        GM_setValue(MIRROR_META_KEY, JSON.stringify({ writtenAt: 0, fingerprint: null }));
    } catch (error) {
        console.error('[SettingsMirror] Could not reset mirror meta (tests only):', error);
    }
}

export default {
    startMirroring,
    stopMirroring,
    maybeMirror,
    getMirroredEntry,
    MIRROR_KEY,
    MIRROR_META_KEY,
    MIRROR_INTERVAL_MS,
    _resetCadenceForTests,
};
