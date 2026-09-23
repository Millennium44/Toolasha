/**
 * Which generation of the alchemy trackers recorded a session.
 *
 * The trackers' counting has been corrected more than once, and a stored
 * session carries the numbers its tracker produced at the time — nothing is
 * rewritten afterwards. A reader that wants to set older sessions apart (mark
 * them, leave them out of a total, keep them out of calibration) needs to know
 * which rules a session was counted under, and the stamp below is the only
 * place that is written down.
 *
 * Every session the transmute, coinify and decompose trackers start carries
 * `trackerVersion`. A session without the field was recorded before it
 * existed.
 *
 * ## Versions
 *
 * - (absent) — recorded before the first-message fixes. A run's first
 *   `action_completed` had no baseline: a batch of efficiency repeats packed
 *   into it was read as one attempt and at most one success, and a transmute
 *   self-return in it was read as a failure that charged the input twice.
 * - 2 — the first-message fixes: a session started from the queue seeds its
 *   item ledger from the inventory and its attempt baseline from the queued
 *   action's `currentCount`, so the first message is measured like the rest
 *   (transmute self-return, coinify and decompose first batch).
 * - 3 — the session-boundary fixes. A new queue action for the same item (the
 *   next queued copy, or a restart with another catalyst or count) counts its
 *   first batch from its own `currentCount`; a page loaded mid-run seeds from
 *   the queue instead of flooring its first message; stacks moved by
 *   `items_updated` (a market sale or purchase) are re-baselined rather than
 *   read as the action's output; a seeded catalyst stack that did not move is
 *   recorded as nothing spent; an enhanced decompose records its Enhancing
 *   Essence; the predicted-rate stamp takes the catalyst from the running
 *   action rather than the open panel; and a message with no baseline is
 *   floored at one attempt per visible success rather than one per changed stack.
 * - 4 — reload resume. Each session carries a `resumePoint` (queue action id,
 *   `currentCount`, measured stack totals); a page loaded while the same queue
 *   action is still running resumes that session and reads the gap — batches
 *   the game completed while no socket was open — against it, so a reload no
 *   longer splits the run or drops the batch in the gap.
 *
 * The stamp is carried through a JSON backup and import untouched. A read-time
 * reload merge keeps it only when every part carries it, at the lowest
 * version among them: a merged record is only as trustworthy as its oldest part.
 */

/** The version the trackers stamp on every session they start now. */
export const ALCHEMY_TRACKER_VERSION = 4;

/** The first version whose sessions count a run's first message correctly. */
export const FIRST_MESSAGE_FIX_VERSION = 2;

/** The first version whose sessions carry the session-boundary fixes. */
export const SESSION_BOUNDARY_FIX_VERSION = 3;

/** The first version whose sessions resume across a page reload. */
export const RELOAD_RESUME_VERSION = 4;

/**
 * The version a session was recorded under.
 *
 * @param {Object} session - A stored alchemy session
 * @returns {number|null} The version, or null for a session recorded before the stamp existed
 */
export function sessionTrackerVersion(session) {
    const version = session?.trackerVersion;
    return Number.isInteger(version) && version > 0 ? version : null;
}

/**
 * Whether a session was recorded before a given tracker version.
 *
 * @param {Object} session - A stored alchemy session
 * @param {number} [minVersion] - The version it has to reach; the first-message fixes by default
 * @returns {boolean} True when the session predates `minVersion`, including every unstamped session
 */
export function isPreFixSession(session, minVersion = FIRST_MESSAGE_FIX_VERSION) {
    const version = sessionTrackerVersion(session);
    return version === null || version < minVersion;
}

/**
 * The stamp a record merged from two parts may carry.
 *
 * @param {Object} a - One part
 * @param {Object} b - The other
 * @returns {number|null} The lower of the two versions, or null when either part has none
 */
export function mergedTrackerVersion(a, b) {
    const va = sessionTrackerVersion(a);
    const vb = sessionTrackerVersion(b);
    if (va === null || vb === null) return null;
    return Math.min(va, vb);
}

export default {
    ALCHEMY_TRACKER_VERSION,
    FIRST_MESSAGE_FIX_VERSION,
    SESSION_BOUNDARY_FIX_VERSION,
    RELOAD_RESUME_VERSION,
    sessionTrackerVersion,
    isPreFixSession,
    mergedTrackerVersion,
};
