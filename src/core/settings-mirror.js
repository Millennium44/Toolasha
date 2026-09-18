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

    // The guarantee: at least one *real* character settings map, not just
    // bookkeeping or an empty shell. Anything short of this is either a fresh
    // install (nothing lost) or a wipe (the one thing that must never
    // overwrite a good mirror) — collectMirrorable cannot tell those apart,
    // and does not need to: both refuse the write the same way.
    const hasRealCharacterMap = Object.keys(payload).some((key) => {
        const value = payload[key];
        return isCharacterMapKey(key) && value && typeof value === 'object' && Object.keys(value).length > 0;
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
 * Mirror the live settings to GM storage, if the cadence allows it and the
 * live store looks trustworthy. Safe to call often — it self-throttles.
 *
 * @param {boolean} [force=false] - Skip the cadence check (the initial mirror, and tests)
 * @returns {Promise<boolean>} Whether a write actually landed
 */
async function maybeMirror(force = false) {
    if (!gmAvailable()) return false;
    if (!force && Date.now() - lastWriteAttempt < MIRROR_INTERVAL_MS) return false;
    lastWriteAttempt = Date.now();

    try {
        const payload = await collectMirrorable();
        if (!payload) return false;

        // Union, live wins — see "Why the write merges rather than replaces".
        const data = { ...(readMirrorData() || {}), ...payload };

        GM_setValue(MIRROR_KEY, JSON.stringify({ writtenAt: Date.now(), data }));
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
    return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Reset the cadence throttle. Test-only — production never needs to forget
 * that it just wrote.
 * @returns {void}
 */
function _resetCadenceForTests() {
    lastWriteAttempt = 0;
}

export default {
    startMirroring,
    stopMirroring,
    maybeMirror,
    getMirroredEntry,
    MIRROR_KEY,
    MIRROR_INTERVAL_MS,
    _resetCadenceForTests,
};
