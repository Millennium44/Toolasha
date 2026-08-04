/**
 * Where the three alchemy trackers put their sessions.
 *
 * Transmute, decompose and coinify each recorded the same way and each had the
 * same problem: a completed action wrote *every session ever kept*, immediately,
 * through `storage.setJSON(key, sessions, store, true)`. An alchemy action takes
 * a couple of seconds, the array is never pruned, and the write was not even
 * debounced — so the cost of recording one attempt was the whole history, several
 * hundred times an hour, growing for as long as the account existed.
 *
 * The persistence was identical in all three files, so it is one file now, and
 * the sessions are stored one record per day. A day's record holds the runs
 * started that day — usually one or two — which is what a completed action now
 * writes.
 *
 * The write stays immediate, because that is what it was: a session is the
 * record of a run that may be interrupted by a closed tab, and per-day records
 * make an immediate write cheap enough that there is no reason to defer it.
 */

import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';

const STORAGE_STORE = 'alchemyHistory';

/**
 * Before login there is no character to scope to, and the pre-scoping trackers
 * wrote to the bare key. That value is adopted by this id so nothing recorded
 * under it is lost.
 */
export const NO_CHARACTER = 'default';

/**
 * A per-day session store for one alchemy tracker.
 *
 * @param {string} baseKey - The legacy single-array key, e.g. `transmuteSessions`
 * @param {string} label - Module name for log lines
 * @returns {Object} The store, as `createChunkedHistory` returns it
 */
export function createAlchemySessionStore(baseKey, label) {
    return createChunkedHistory({
        storeName: STORAGE_STORE,
        // `transmuteSessionsRec_` rather than `transmuteSessions_`, so a record
        // key can never be mistaken for the legacy key of a character whose id
        // happens to start with `Rec`
        prefix: `${baseKey}Rec`,
        legacyKey: (charId) => (charId === NO_CHARACTER ? baseKey : `${baseKey}_${charId}`),
        groupOf: (session) => timeChunkId(session?.startTime, 'day'),
        // Oldest first, which is the order the trackers appended in
        compare: (a, b) => (a?.startTime || 0) - (b?.startTime || 0),
        immediate: true,
        label,
    });
}

export default { createAlchemySessionStore, NO_CHARACTER };
