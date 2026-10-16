/**
 * Queue projection - how much of a snapshot's counted time is still ahead.
 */

/**
 * Seconds of counted queue time still ahead of a snapshot, `elapsedSeconds` after it was taken.
 *
 * Wall-clock time only burns down known time that comes before the first untimed row (a counted
 * fight, an action with no rate) or endless row: while that row runs, the timed work behind it
 * has not started, so it is left whole. `totalQueueSeconds` already leaves untimed work out and
 * stops at the first endless action.
 *
 * @param {Object} snapshot - From queue-snapshot.js
 * @param {number} elapsedSeconds - Seconds since the snapshot was taken
 * @returns {number} Remaining counted seconds, never negative
 */
export function remainingQueueSeconds(snapshot, elapsedSeconds) {
    const total = Math.max(0, Number(snapshot?.totalQueueSeconds) || 0);
    const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
    const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];

    // No rows to place the untimed boundary with: treat the whole total as running now
    let before = actions.length ? 0 : total;
    for (const action of actions) {
        if (action.isInfinite || action.estimatedSeconds === null || action.estimatedSeconds === undefined) break;
        before += action.estimatedSeconds;
    }
    before = Math.min(before, total);

    return Math.max(0, before - elapsed) + (total - before);
}
