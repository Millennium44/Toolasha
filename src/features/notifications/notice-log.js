/**
 * Notice log
 *
 * Every notice the script has emitted, in order, per character.
 *
 * A notification is by construction a thing you were not there for. The toast
 * lasts ten seconds, the desktop bubble eight, and the tab title carries one
 * bit — so a player who was away for an afternoon, or who was looking at
 * another window, has no way at all to find out what they missed. Worse, the
 * two features either side of this one make that gap wider on purpose:
 * digesting replaces N toasts with one summary, and quiet hours suppress the
 * desktop channel outright. Both of those are only defensible because the
 * individual notices still land here.
 *
 * So this is the record of last resort, and it is written to *before* any
 * delivery decision is taken. A notice that was digested is in it. A notice
 * that arrived at three in the morning during quiet hours is in it. A notice
 * that reached no channel at all — permission refused, no DOM yet — is in it,
 * flagged as undelivered, which is the only way that failure is ever visible.
 *
 * ## Bounded, per character, one key
 *
 * Two hundred entries, oldest dropped. The bound is the feature: an unbounded
 * log in IndexedDB is a slow leak that nobody notices until the store is full,
 * and nobody has ever scrolled back past two hundred notifications. One storage
 * key per character rather than one per entry, because the whole log is read
 * and written as a unit and a key-per-entry store would spend the `settings`
 * key budget on it.
 *
 * ## Why the state is on `globalThis`
 *
 * Same reason as the notification service, which is the only thing that writes
 * here: the production build copies a `src/features/**` module into every
 * bundle that imports it, and three private logs would mean the panel showing a
 * third of what happened. See the service's module comment.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';

/** Entries kept per character; the oldest fall off the end */
export const MAX_ENTRIES = 200;

/** A notice's text is truncated to this before it is stored */
export const MAX_TEXT_LENGTH = 200;

/** Storage key prefix, one key per character */
const KEY_PREFIX = 'noticeLog_';

/** Where the cross-bundle state lives; see the module comment */
const GLOBAL_STATE_KEY = '__toolashaNoticeLog';

/** Used when the game has not said who we are yet */
const UNKNOWN_CHARACTER = 'unknown';

/**
 * The one log every copy of this module shares.
 * @returns {{characterId: string|null, entries: Array<Object>, seenAt: number, loading: Promise|null, dirty: boolean}} State
 */
function state() {
    const host = typeof globalThis === 'undefined' ? {} : globalThis;
    if (!host[GLOBAL_STATE_KEY]) {
        host[GLOBAL_STATE_KEY] = {
            characterId: null,
            loadedFor: null,
            entries: [],
            seenAt: 0,
            loading: null,
            dirty: false,
        };
    }
    return host[GLOBAL_STATE_KEY];
}

/**
 * Who the log currently belongs to.
 * @returns {string} Character id, or a placeholder before the game has said
 */
function currentCharacterId() {
    try {
        return String(dataManager.getCurrentCharacterId?.() || UNKNOWN_CHARACTER);
    } catch (error) {
        console.error('[NoticeLog] Could not read the current character:', error);
        return UNKNOWN_CHARACTER;
    }
}

/**
 * The storage key for one character.
 * @param {string} characterId - Whose log
 * @returns {string} Key in the settings store
 */
export function noticeLogKey(characterId) {
    return `${KEY_PREFIX}${characterId}`;
}

/**
 * Load this character's log from storage, once.
 *
 * Idempotent and re-entrant: the first caller starts the read and everyone
 * after it awaits the same promise, so the panel opening mid-load does not
 * produce two half-loaded copies.
 *
 * What it does *not* do is replace what is in memory. A notification can fire
 * before the feature that reads the log has initialised — the alert features
 * start when the websocket does, and this reads IndexedDB — so by the time the
 * read lands there may already be entries. Those are the newest ones there are;
 * dropping them to install the saved ones would lose exactly the notices the
 * player has not seen yet. The saved entries go *underneath* instead, and the
 * merge is by timestamp.
 *
 * A character switch reloads from the other character's key, discarding what is
 * held — which is correct, because that log belongs to the character that was
 * being played and has already been persisted.
 *
 * @returns {Promise<void>} Resolves once the entries are in memory
 */
export async function loadNoticeLog() {
    const shared = state();
    const characterId = currentCharacterId();

    if (shared.loading) await shared.loading;
    if (shared.loadedFor === characterId) return;

    const switched = shared.characterId !== null && shared.characterId !== characterId;
    if (switched) shared.entries = [];
    shared.characterId = characterId;

    shared.loading = (async () => {
        try {
            const saved = await storage.getJSON(noticeLogKey(characterId), 'settings', null);
            if (saved && Array.isArray(saved.entries)) {
                const merged = [...saved.entries, ...shared.entries];
                merged.sort((a, b) => (a?.at || 0) - (b?.at || 0));
                // Trimmed on the way in as well as on the way out: a log written
                // by a build with a larger bound must not stay over it forever
                shared.entries = merged.slice(-MAX_ENTRIES);
                shared.seenAt = Math.max(shared.seenAt, Number(saved.seenAt) || 0);
            }
        } catch (error) {
            // A store that cannot be read leaves what is in memory standing, and
            // the log is marked loaded anyway — refusing to persist forever
            // because one read failed would lose more than it protects
            console.error('[NoticeLog] Could not read the notice log:', error);
        } finally {
            shared.loadedFor = characterId;
            shared.loading = null;
            if (shared.dirty) await persist();
        }
    })();

    await shared.loading;
}

/**
 * Write the log back.
 *
 * Not immediate: `storage.set` debounces per key, and a burst of notices — the
 * exact case digesting exists for — would otherwise be a burst of IndexedDB
 * transactions for a record nobody is reading yet.
 *
 * @returns {Promise<void>} When the write has been handed to storage
 */
async function persist() {
    const shared = state();
    if (!shared.characterId) return;
    // Nothing is written before the saved log has been read back. A notice can
    // arrive first — the websocket is talking while IndexedDB is still
    // answering — and persisting one entry at that moment would overwrite two
    // hundred with it. The load merges and then writes.
    if (shared.loadedFor !== shared.characterId) return;

    try {
        await storage.setJSON(
            noticeLogKey(shared.characterId),
            { entries: shared.entries, seenAt: shared.seenAt },
            'settings'
        );
        shared.dirty = false;
    } catch (error) {
        console.error('[NoticeLog] Could not save the notice log:', error);
    }
}

/**
 * Record one notice.
 *
 * Synchronous in the part that matters — the entry is in memory and countable
 * before this returns — with the write to storage left running. A notification
 * must never wait on IndexedDB to be shown.
 *
 * @param {Object} notice - What happened
 * @param {string} notice.key - The event key it was announced under
 * @param {string} notice.category - Category key from notice-policy
 * @param {string} notice.subject - What it was about, e.g. an item or buff name
 * @param {string} notice.text - The message the player would have read
 * @param {string} notice.urgency - `critical` or `normal`
 * @param {string[]} [notice.channels] - Where it actually went; empty means nowhere
 * @param {number} [notice.at] - Epoch ms, injectable for tests
 * @returns {Object} The entry as stored
 */
export function appendNotice({ key, category, subject, text, urgency, channels = [], at = Date.now() }) {
    const shared = state();
    if (!shared.characterId) shared.characterId = currentCharacterId();

    const entry = {
        at,
        key: String(key ?? ''),
        category: String(category ?? 'other'),
        subject: String(subject ?? ''),
        text: String(text ?? '').slice(0, MAX_TEXT_LENGTH),
        urgency: urgency === 'critical' ? 'critical' : 'normal',
        channels: Array.isArray(channels) ? [...channels] : [],
    };

    shared.entries.push(entry);
    if (shared.entries.length > MAX_ENTRIES) {
        shared.entries.splice(0, shared.entries.length - MAX_ENTRIES);
    }
    shared.dirty = true;

    // Deliberately not awaited: see the doc comment. The load is kicked off
    // from here as well as from the feature's `initialize`, so a script whose
    // panel never starts still ends up with a log that survives a reload
    if (shared.loadedFor !== shared.characterId && !shared.loading) loadNoticeLog();
    else persist();
    return entry;
}

/**
 * The log, newest first.
 * @param {number} [limit] - How many at most
 * @returns {Array<Object>} Entries
 */
export function readNotices(limit = MAX_ENTRIES) {
    const entries = state().entries;
    return entries.slice(Math.max(0, entries.length - limit)).reverse();
}

/**
 * How many notices there are in total.
 * @returns {number} Entry count
 */
export function noticeCount() {
    return state().entries.length;
}

/**
 * How many notices have arrived since the log was last read.
 *
 * This is the number the session briefing puts on its "while you were away"
 * line, and the number the overlay tile shows. Read-marks rather than a session
 * boundary, because the question a returning player is asking is "what have I
 * not seen", and a page reload does not answer it.
 *
 * @returns {number} Unread entries
 */
export function unreadNoticeCount() {
    const shared = state();
    return shared.entries.filter((entry) => entry.at > shared.seenAt).length;
}

/**
 * How many notices arrived after a moment.
 * @param {number} since - Epoch ms
 * @returns {number} Entries newer than that
 */
export function noticesSince(since) {
    return state().entries.filter((entry) => entry.at > since).length;
}

/**
 * Mark everything as read.
 * @param {number} [at] - Epoch ms, injectable for tests
 * @returns {void}
 */
export function markNoticesSeen(at = Date.now()) {
    const shared = state();
    shared.seenAt = at;
    shared.dirty = true;
    persist();
}

/**
 * Throw the log away, for this character.
 * @returns {Promise<void>} When the empty log has been written
 */
export async function clearNotices() {
    const shared = state();
    if (!shared.characterId) shared.characterId = currentCharacterId();
    // Emptying it is authoritative: there is nothing left for a later load to
    // merge underneath, so the write is allowed even if the read never happened
    shared.loadedFor = shared.characterId;
    shared.entries = [];
    shared.seenAt = Date.now();
    await persist();
}

/**
 * Forget everything held in memory, without touching storage. For tests.
 * @returns {void}
 */
export function _resetNoticeLog() {
    const host = typeof globalThis === 'undefined' ? {} : globalThis;
    delete host[GLOBAL_STATE_KEY];
}

// `loadNoticeLog()` only clears `entries` once it actually runs — from
// notice-log-panel.js's `initialize()`, which fires on `character_switched`,
// deferred, well after this switch has begun. Until then `shared.characterId`
// still equals the departing character's id, so `loadNoticeLog()`'s own
// staleness check would not even fire if something called it early. The
// overlay's 1s redraw is on its own timer and can land in that gap, at which
// point unreadNoticeCount()/noticeCount() would answer for the character that
// just left, under the arriving character's name on the Notices tile.
//
// Clearing `entries` here, at `character_switching`, closes that without
// risking the entries the departing character has not yet had persisted:
// `data-manager.js` awaits `storage.flushAll()` before ever emitting
// `character_switching`, so every debounced `persist()` this module has
// queued has already been written by the time this runs. `characterId` is
// left as the departing id — the same "switched" comparison
// `loadNoticeLog()` makes when it eventually runs for the arriving character
// still needs it to be the *old* one to notice the change.
//
// `loadedFor` is cleared with it, and that is not cosmetic. `persist()` writes
// under `characterId` and only refuses when `loadedFor` disagrees with it.
// Leaving both as the departing id while `entries` is empty arms every write
// path that can still run in this gap — `appendNotice()` for a notice the
// websocket delivers mid-switch, `markNoticesSeen()` if the panel is opened —
// to write `{entries: []}` over the departing character's saved two hundred.
// The flushAll() above only guarantees nothing is *already* in flight; it says
// nothing about a write started after this runs. With `loadedFor` null those
// writes bail, and `appendNotice()` takes its load-first branch instead, which
// merges under the arriving character's log where the notice belongs.
dataManager.on?.('character_switching', () => {
    const shared = state();
    shared.entries = [];
    shared.loadedFor = null;
});
