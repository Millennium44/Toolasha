/**
 * Keeping a live meter session through a page refresh.
 *
 * The combat and trial meters hold their tallies in memory, so a refresh
 * mid-run used to start every table from zero. This saves the tally a tracker
 * hands it — throttled, one IndexedDB write per {@link LIVE_SESSION_PERSIST_MS}
 * at most while it keeps changing — and reads it back so the tracker can adopt
 * it once the stream proves it is the same run. Deciding *whether* it is the
 * same run is the tracker's business; this module only stores, ages and scopes.
 *
 * ## What bounds the loss
 *
 * The throttle interval. A write is also started from `beforeunload`,
 * `pagehide` and `visibilitychange`→hidden, and it opens its IndexedDB
 * transaction synchronously inside the handler (`storage.set(…, true)` reaches
 * `db.transaction()` without an await while the connection is open), but no
 * browser promises such a transaction commits before the document is thrown
 * away. So the unload write narrows the gap when it lands and the interval is
 * the bound when it does not.
 *
 * `pagehide` is listened to in the capture phase: at the target, capture
 * listeners run before bubbling ones, so this write is started before the
 * entrypoint's own `pagehide` listener closes the connection
 * (`storage.closeForTeardown`). A write that finds the connection already
 * closing is queued by the storage module rather than lost outright.
 *
 * ## Why the keys are device-local
 *
 * Every key carries `toolasha_local_`, which the backup and the sync strip in
 * every store (`utils/full-backup.js` `DEVICE_LOCAL_KEY_PREFIXES`). A session
 * twenty minutes from useless has no business on another device.
 *
 * Shape and the twenty-minute window are KikiMeter's SessionPersist
 * (ZhuLiMoon, MIT); the code is Toolasha's own.
 */

import config from '../core/config.js';
import storage from '../core/storage.js';

/** The setting that turns saving and restoring off */
export const LIVE_SESSION_SETTING = 'combatSessionRestore';

/** Older than this, a saved session describes a run the player has long left */
export const LIVE_SESSION_MAX_AGE_MS = 20 * 60_000;

/** At most one write per this interval while a session keeps changing; the loss bound */
export const LIVE_SESSION_PERSIST_MS = 4000;

/** Bumped when a saved payload's shape stops being readable by the code adopting it */
export const LIVE_SESSION_VERSION = 1;

/** Prefix every live-session key carries, so backups and sync leave it on this device */
export const LIVE_SESSION_KEY_PREFIX = 'toolasha_local_live';

/**
 * A live-session storage key, scoped to one character.
 * @param {string} kind - What is saved, e.g. `Damage`
 * @param {string|number|null|undefined} characterId - The character it belongs to
 * @returns {string|null} The key, or null when there is no character to scope it to
 */
export function liveSessionKey(kind, characterId) {
    if (characterId === null || characterId === undefined || characterId === '') return null;
    return `${LIVE_SESSION_KEY_PREFIX}${kind}_${characterId}`;
}

/**
 * Whether live sessions are saved and restored.
 * @returns {boolean}
 */
export function liveSessionRestoreEnabled() {
    try {
        return config.getSetting(LIVE_SESSION_SETTING, true) !== false;
    } catch {
        return true;
    }
}

/**
 * Whether a saved payload may be adopted at all, before any question of which run it is.
 * @param {Object|null} saved - As read back
 * @param {Object} expected - What it must match
 * @param {string} expected.kind - The payload kind
 * @param {string|number|null} expected.characterId - The character looking at it now
 * @param {number} [expected.now] - Clock
 * @param {number} [expected.maxAgeMs] - Oldest a save may be
 * @returns {boolean}
 */
export function isRestorable(saved, { kind, characterId, now = Date.now(), maxAgeMs = LIVE_SESSION_MAX_AGE_MS } = {}) {
    if (!saved || typeof saved !== 'object') return false;
    if (saved.v !== LIVE_SESSION_VERSION || saved.kind !== kind) return false;
    if (!Number.isFinite(saved.savedAt)) return false;
    // A save stamped ahead of the clock is a clock that moved, and its age is unknowable
    if (now - saved.savedAt > maxAgeMs || saved.savedAt - now > 60_000) return false;
    if (characterId === null || characterId === undefined) return false;
    return String(saved.characterId ?? '') === String(characterId);
}

/**
 * Read a saved session back.
 * @param {string|null} key - From {@link liveSessionKey}
 * @param {string} storeName - Object store
 * @returns {Promise<Object|null>} The payload, or null when absent, unreadable, or restore is off
 */
export async function loadLiveSession(key, storeName) {
    if (!key || !liveSessionRestoreEnabled()) return null;
    try {
        const saved = await storage.get(key, storeName, null);
        return saved && typeof saved === 'object' ? saved : null;
    } catch (error) {
        console.error('[LiveSessionPersist] Reading a saved session failed:', error);
        return null;
    }
}

/**
 * Add one tally into another, field by field.
 *
 * For folding a saved session's tallies together with what the stream has
 * already measured since the reload. Numbers add, except `min` and `max`,
 * which keep the extreme; nested objects merge the same way; anything else
 * (a name, a null range) is taken only where the target has nothing.
 *
 * @param {Object|null} target - Mutated, or null to start one
 * @param {Object|null} source - Not mutated
 * @returns {Object} The target
 */
export function mergeCounts(target, source) {
    const out = target && typeof target === 'object' ? target : {};
    for (const [key, value] of Object.entries(source || {})) {
        const held = out[key];
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) continue;
            if (key === 'min') out[key] = Number.isFinite(held) ? Math.min(held, value) : value;
            else if (key === 'max') out[key] = Number.isFinite(held) ? Math.max(held, value) : value;
            else out[key] = (Number.isFinite(held) ? held : 0) + value;
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = mergeCounts(held && typeof held === 'object' ? held : {}, value);
        } else if (held === undefined || held === null) {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Report a write's failure without letting it become an unhandled rejection.
 * @param {Promise<*>|*} pending - The storage call
 * @param {string} label - Owner, for the log
 */
async function settle(pending, label) {
    try {
        await pending;
    } catch (error) {
        console.error(`[LiveSessionPersist] ${label}: saving the live session failed:`, error);
    }
}

/**
 * A throttled writer for one tracker's live session.
 *
 * `keyFor` is read when a change is noted and again when it is written; a key
 * that moved in between (a character switch) drops the write, because what is
 * in memory by then is no longer the session the change belonged to.
 *
 * @param {Object} options - Wiring
 * @param {string} options.storeName - Object store
 * @param {Function} options.keyFor - `() => string|null`, the key for the session in memory now
 * @param {Function} options.serialize - `() => Object|null`; null skips the write
 * @param {string} options.kind - Stamped on the payload, checked by {@link isRestorable}
 * @param {string} [options.label] - Owner, for logs
 * @param {number} [options.intervalMs] - Throttle
 * @returns {{note: Function, flush: Function, discard: Function, start: Function, stop: Function,
 *   isStarted: Function}} The writer
 */
export function createLiveSessionPersister({
    storeName,
    keyFor,
    serialize,
    kind,
    label = kind,
    intervalMs = LIVE_SESSION_PERSIST_MS,
}) {
    let timer = null;
    let dirtyKey = null;
    let started = false;

    const currentKey = () => {
        try {
            return keyFor() || null;
        } catch {
            return null;
        }
    };

    const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };

    /** Write the noted change now, if there is one and it is still this session's */
    const flush = () => {
        clearTimer();
        const key = dirtyKey;
        dirtyKey = null;
        if (!key || key !== currentKey() || !liveSessionRestoreEnabled()) return;

        let payload;
        try {
            payload = serialize();
        } catch (error) {
            console.error(`[LiveSessionPersist] ${label}: building the live session failed:`, error);
            return;
        }
        if (!payload) return;

        const savedAt = Date.now();
        // Called, not awaited, first: the transaction has to be opened inside
        // an unload handler's own task to have any chance of committing
        settle(storage.set(key, { ...payload, kind, v: LIVE_SESSION_VERSION, savedAt }, storeName, true), label);
    };

    const onHidden = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
    };

    return {
        /** Something in the session changed; write it within the interval */
        note() {
            if (!started) return;
            const key = currentKey();
            if (!key) return;
            dirtyKey = key;
            // Armed by the first unwritten change, so no change waits longer than the interval
            if (!timer) timer = setTimeout(flush, intervalMs);
        },

        flush,

        /** Delete the saved session: the run it described was ended on purpose */
        discard() {
            clearTimer();
            dirtyKey = null;
            const key = currentKey();
            if (!started || !key) return;
            settle(storage.delete(key, storeName), label);
        },

        /** Begin listening for the page going away */
        start() {
            if (started) return;
            started = true;
            if (typeof window !== 'undefined') {
                window.addEventListener('beforeunload', flush, true);
                window.addEventListener('pagehide', flush, true);
            }
            if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);
        },

        /**
         * Stop listening.
         * @param {Object} [options]
         * @param {boolean} [options.flush=true] - Write a pending change first
         */
        stop({ flush: flushFirst = true } = {}) {
            if (!started) return;
            if (flushFirst) flush();
            clearTimer();
            dirtyKey = null;
            started = false;
            if (typeof window !== 'undefined') {
                window.removeEventListener('beforeunload', flush, true);
                window.removeEventListener('pagehide', flush, true);
            }
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
        },

        /** @returns {boolean} Whether it is listening */
        isStarted() {
            return started;
        },
    };
}
