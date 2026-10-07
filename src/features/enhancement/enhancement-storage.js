/**
 * Enhancement Tracker Storage
 * Handles persistence of enhancement sessions using IndexedDB
 *
 * Sessions belong to the character that ran them: the iron cow's overnight
 * enhancing run has nothing to do with the market cow's, and a shared key put
 * both in the same list. Keys are therefore scoped per character and derived at
 * every read and write — the user switches characters without reloading the
 * page, so a key resolved once at module load would be the wrong one afterwards.
 * The legacy global value is adopted by the main character exactly once.
 *
 * The sessions map lives in a persisted record (see `utils/persisted-record.js`)
 * so a read that cannot be made does not come back as "no sessions" and get
 * written over the stored ones on the next attempt.
 *
 * Two game tabs on one character both write this map — every attempt saves —
 * so every save merges with what is stored, by session id, rather than writing
 * one tab's memory whole (which put back sessions the other tab had deleted or
 * merged away, and dropped the ones it had started):
 *
 * - a session only the other tab has is kept, and joins this tab's list;
 * - a session both have goes to the copy with the later activity stamp, and on
 *   a tie the one with more attempts (a merge folds attempts in without moving
 *   the stamp); otherwise this tab's copy stands;
 * - a removal, from either tab, is a tombstone under its own key: the id and
 *   when it went. Tombstones are read fresh before every merge. One older than
 *   {@link TOMBSTONE_TTL_MS} is pruned by a sessions fold that reads the stored
 *   map without its id — never on age alone, since a stale writer (a closing
 *   tab, a departing character) can have put the session back meanwhile, and
 *   the tombstone is all that hides it. The fold drops graved ids from what it
 *   writes, so the stored copy goes first and the tombstone after.
 *
 * This tab's removals are the ids it has held — loaded, saved or adopted — and
 * no longer holds. The fold mutates the tracker's live map in place, so what
 * the tracker shows and what it saves next are the merged list.
 *
 * Both keys are `atomic` records: each fold runs inside its write's own
 * readwrite transaction, which IndexedDB serializes across tabs. A read and a
 * later write would let both tabs read the same old map and the second write
 * drop the first one's sessions.
 */

import dataManager from '../../core/data-manager.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { createCuratedRecord } from '../../utils/persisted-record.js';

const STORAGE_KEY = 'enhancementTracker_sessions';
const TOMBSTONE_KEY = 'enhancementTracker_sessionTombstones';
const CURRENT_SESSION_KEY = 'enhancementTracker_currentSession';
const STORAGE_STORE = 'settings'; // Use existing 'settings' store

/** How long a removed session's id is remembered: far longer than any tab stays open unreloaded */
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * When a session last moved — the same reading the tracker's "most recent" uses.
 * @param {Object} session
 * @returns {number}
 */
function activityOf(session) {
    return Math.max(
        session?.endTime || 0,
        session?.lastAttempt?.timestamp || 0,
        session?.lastUpdateTime || 0,
        session?.startTime || 0
    );
}

/**
 * Whether the stored copy of a session should replace this tab's.
 * @param {Object} stored
 * @param {Object} held
 * @returns {boolean}
 */
function storedIsNewer(stored, held) {
    const storedAt = activityOf(stored);
    const heldAt = activityOf(held);
    if (storedAt !== heldAt) return storedAt > heldAt;
    return (stored?.totalAttempts || 0) > (held?.totalAttempts || 0);
}

/**
 * Expired tombstones a sessions fold has found nothing left to hide: `{id: removedAt}`.
 * The tombstone fold drops them on both sides — the other tab's copy included.
 */
let prunedGraves = {};

/**
 * Tombstones from both sides, each id at its latest removal, less the ones a
 * sessions fold pruned (see {@link pruneExpiredGraves}). Age alone drops nothing.
 * @param {Object} stored - `{id: removedAt}`
 * @param {Object} memory - `{id: removedAt}`
 * @returns {Object}
 */
function mergeTombstones(stored, memory) {
    const out = {};
    for (const side of [stored, memory]) {
        if (!side || typeof side !== 'object') continue;
        for (const [id, at] of Object.entries(side)) {
            if (!Number.isFinite(at) || prunedGraves[id] >= at) continue;
            if (!(out[id] >= at)) out[id] = at;
        }
    }
    return out;
}

/**
 * The removed session ids. Curated with `keepMerging`, so both tabs' tombstones
 * are always folded together; written straight away, since a sessions write
 * landing before the tombstone that explains it would read as "the other tab
 * has not seen this one yet".
 */
const tombstoneRecord = createCuratedRecord({
    base: TOMBSTONE_KEY,
    store: STORAGE_STORE,
    empty: () => ({}),
    merge: mergeTombstones,
    keepMerging: true,
    atomic: true,
    immediate: true,
    label: 'EnhancementStorage',
});

/** Ids this tab has held since its last reset — a held id that disappears was removed here */
let knownIds = new Set();

/**
 * Tombstone every id this tab held and no longer holds, and save the tombstones.
 * @param {Object} sessions - This tab's sessions map
 */
function noteRemovals(sessions) {
    const now = Date.now();
    let removed = false;
    for (const id of knownIds) {
        if (sessions && Object.hasOwn(sessions, id)) continue;
        tombstoneRecord.get()[id] = now;
        knownIds.delete(id);
        removed = true;
    }
    if (removed) tombstoneRecord.save();
}

/**
 * Replace a held session's contents with the stored copy, keeping the object:
 * the tracker compares the current session by identity across its awaits.
 * @param {Object} held
 * @param {Object} stored
 */
function adoptInPlace(held, stored) {
    for (const key of Object.keys(held)) {
        if (!Object.hasOwn(stored, key)) delete held[key];
    }
    Object.assign(held, stored);
}

/**
 * Fold the stored sessions into `held` by id, dropping the ones in `graves`.
 * Mutates and returns `held`.
 * @param {Object} stored - The stored sessions map
 * @param {Object} held - A tab's sessions map
 * @param {Object} graves - `{id: removedAt}`
 * @returns {Object} `held`
 */
function foldSessions(stored, held, graves) {
    // Stored order first, then this tab's new ones — the order a plain map fold gives,
    // and the one the panel numbers sessions by
    const merged = new Map();
    if (stored && typeof stored === 'object' && stored !== held) {
        for (const [id, session] of Object.entries(stored)) {
            if (Object.hasOwn(graves, id) || session == null) continue;
            const mine = held[id];
            if (mine == null) {
                merged.set(id, session);
            } else {
                if (mine !== session && typeof mine === 'object' && storedIsNewer(session, mine)) {
                    adoptInPlace(mine, session);
                }
                merged.set(id, mine);
            }
        }
    }
    for (const [id, session] of Object.entries(held)) {
        if (!Object.hasOwn(graves, id) && !merged.has(id)) merged.set(id, session);
    }
    for (const id of Object.keys(held)) delete held[id];
    for (const [id, session] of merged) held[id] = session;
    return held;
}

/**
 * Fold the stored sessions into this tab's, by id (see the module header).
 * Mutates and returns `memory`, which is the tracker's live map.
 * @param {Object} stored - The stored sessions map
 * @param {Object} memory - This tab's sessions map
 * @returns {Object} `memory`
 */
function mergeSessions(stored, memory) {
    const held = memory && typeof memory === 'object' ? memory : {};
    noteRemovals(held);
    foldSessions(stored, held, tombstoneRecord.get());
    knownIds = new Set(Object.keys(held));
    pruneExpiredGraves(stored);
    return held;
}

/**
 * Prune the tombstones past {@link TOMBSTONE_TTL_MS} whose session the stored map,
 * as this fold read it, no longer holds. One it still holds — written back by a
 * stale tab after the removal — stays: this fold drops the session from what it
 * writes, and the next fold, finding it gone, prunes the tombstone.
 * @param {Object} stored - The stored sessions map this fold read
 */
function pruneExpiredGraves(stored) {
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    const graves = tombstoneRecord.get();
    let pruned = false;
    for (const [id, at] of Object.entries(graves)) {
        if (!(at < cutoff)) continue;
        if (stored && typeof stored === 'object' && Object.hasOwn(stored, id)) continue;
        if (!(prunedGraves[id] >= at)) prunedGraves[id] = at;
        delete graves[id];
        pruned = true;
    }
    if (pruned) tombstoneRecord.save();
}

/** The departing character's tombstones, captured when a switch resets the records */
let departingGraves = {};

/**
 * The fold for the departing character's last write, which a character switch
 * overtook: its held ids have been dropped for the arriving character's by then,
 * so this touches neither record. It still drops the departing character's
 * tombstoned sessions from the stored side, captured at the switch, so a
 * session deleted just before switching is not folded back out of storage.
 * @param {Object} stored
 * @param {Object} memory
 * @returns {Object}
 */
function mergeDepartingSessions(stored, memory) {
    return foldSessions(stored, memory && typeof memory === 'object' ? memory : {}, departingGraves);
}

/**
 * The sessions, as held in memory and folded into storage.
 *
 * Every session update used to write all sessions as one immediate blob into
 * the settings store — an enhancement run is a write per attempt, of a document
 * containing every session ever kept. The record delays its save, which
 * coalesces a run into one write, at the cost of storage lagging memory; the
 * record's memory holds the truth in the meantime so a load during the lag
 * cannot read back a stale blob.
 */
const sessionsRecord = createCuratedRecord({
    base: STORAGE_KEY,
    store: STORAGE_STORE,
    empty: () => ({}),
    merge: mergeSessions,
    mergeAfterReset: mergeDepartingSessions,
    keepMerging: true,
    // The fold runs inside the write's own transaction, so a save from the other
    // tab cannot land between this tab's read and its write
    atomic: true,
    // The other tab's removals, read fresh before every fold; a save that cannot
    // read them is skipped rather than folded against a stale set
    prepare: () => tombstoneRecord.load(),
    label: 'EnhancementStorage',
});
/** Whether the record's memory has been handed sessions since the last reset */
let sessionsHeld = false;
let pendingCurrentSessionId;
let hasPendingCurrentSessionId = false;

/**
 * Save all sessions to storage.
 *
 * Queued rather than awaited: the delayed write's promise resolves when it has
 * run, so awaiting it would stall every caller for the delay. A hidden tab or a
 * closing page lands the last one (see `utils/persisted-record.js`). The write
 * is skipped, and memory kept, when the tombstones cannot be read first.
 * Sessions this tab held and the map no longer has are tombstoned here.
 * @param {Object} sessions - Sessions object (keyed by session ID)
 * @returns {Promise<void>}
 */
export async function saveSessions(sessions) {
    sessionsHeld = true;
    noteRemovals(sessions);
    // Held from here on, stored or not: one removed before any fold has run is still this tab's removal
    knownIds = new Set(Object.keys(sessions || {}));
    sessionsRecord.set(sessions);
    sessionsRecord.save();
}

/**
 * Load all sessions from storage.
 *
 * Hands back what was last saved when a save is in flight; otherwise reads
 * storage, keeping whatever is already in memory when the read cannot be made.
 * @returns {Promise<Object>} Sessions object (keyed by session ID)
 */
export async function loadSessions() {
    if (sessionsHeld) return sessionsRecord.get();
    await sessionsRecord.load();
    return sessionsRecord.get();
}

/**
 * Whether the sessions have been read back from storage since the last reset.
 * False after a load that could not be made — the list in hand is then not
 * the whole story, and nothing should be pruned against it.
 * @returns {boolean}
 */
export function sessionsLoaded() {
    return sessionsRecord.isLoaded();
}

/** @returns {Promise<void>} The pending session and tombstone writes, for tests and shutdown */
export async function flushSessionWrites() {
    await sessionsRecord.flushed();
    await tombstoneRecord.flushed();
}

/**
 * Save current session ID
 * @param {string|null} sessionId - Current session ID (null if no active session)
 * @returns {Promise<void>}
 */
export async function saveCurrentSessionId(sessionId) {
    pendingCurrentSessionId = sessionId;
    hasPendingCurrentSessionId = true;
    writeScoped(CURRENT_SESSION_KEY, sessionId, STORAGE_STORE);
}

/**
 * Load current session ID
 * @returns {Promise<string|null>} Current session ID or null
 */
export async function loadCurrentSessionId() {
    if (hasPendingCurrentSessionId) return pendingCurrentSessionId;
    try {
        return await readScoped(CURRENT_SESSION_KEY, STORAGE_STORE, null, { migrate: 'adopt' });
    } catch (error) {
        console.error('[EnhancementStorage] Failed to load current session ID:', error);
        return null;
    }
}

/**
 * Delete a session
 * @param {Object} sessions - Sessions object
 * @param {string} sessionId - Session ID to delete
 * @returns {Promise<void>}
 */
export async function deleteSession(sessions, sessionId) {
    if (sessions[sessionId]) {
        delete sessions[sessionId];
        await saveSessions(sessions);
    }
}

/**
 * Archive old completed sessions (keep only recent N sessions)
 * @param {Object} sessions - Sessions object
 * @param {number} maxSessions - Maximum sessions to keep (default: 50)
 * @returns {Promise<void>}
 */
export async function archiveOldSessions(sessions, maxSessions = 50) {
    const sessionArray = Object.entries(sessions);

    // Skip if under limit
    if (sessionArray.length <= maxSessions) {
        return;
    }

    // Sort by start time (oldest first)
    sessionArray.sort(([, a], [, b]) => a.startTime - b.startTime);

    // Keep only the newest sessions
    const sessionsToKeep = sessionArray.slice(-maxSessions);
    const newSessions = Object.fromEntries(sessionsToKeep);

    await saveSessions(newSessions);
}

/**
 * Export session data as JSON string
 * @param {Object} session - Session object
 * @returns {string} JSON string
 */
export function exportSession(session) {
    return JSON.stringify(session, null, 2);
}

/**
 * Import session data from JSON string
 * @param {string} jsonStr - JSON string
 * @returns {Object|null} Session object or null if invalid
 */
export function importSession(jsonStr) {
    try {
        const session = JSON.parse(jsonStr);

        // Basic validation
        if (!session.id || !session.itemHrid) {
            return null;
        }

        return session;
    } catch {
        return null;
    }
}

/**
 * Drop the in-memory mirror of the queued writes — for tests, and for anything
 * that needs the next load to come from storage.
 */
export function resetPendingSessionCache() {
    // Before the record drops them: a departing write still waiting folds with these
    departingGraves = { ...tombstoneRecord.get() };
    sessionsRecord.reset();
    tombstoneRecord.reset();
    // Pruning is per character; one left unpruned is pruned again by its next fold
    prunedGraves = {};
    knownIds = new Set();
    sessionsHeld = false;
    pendingCurrentSessionId = undefined;
    hasPendingCurrentSessionId = false;
}

// The mirror holds one character's sessions. Switching characters without a
// reload would otherwise serve the departing character's list to the arriving
// one — and, worse, write it back under the arriving character's key.
dataManager.on('character_switching', () => resetPendingSessionCache());
