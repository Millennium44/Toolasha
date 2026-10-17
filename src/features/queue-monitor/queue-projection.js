/**
 * Queue projection - how much of a snapshot's counted time is still ahead.
 */

/**
 * Seconds of counted queue time still ahead of a snapshot, `elapsedSeconds` after it was taken, or null once
 * nothing can be said.
 *
 * Wall-clock time only burns down known time that comes before the first untimed row (a counted
 * fight, an action with no rate) or endless row. While the timed prefix before an untimed row is still
 * running, the countdown is the prefix left plus the timed work behind the untimed row, which cannot start
 * before it ends. Once the prefix has elapsed the untimed row is running for an unknown time, so the tail
 * behind it has no start time either: null, meaning "no estimate", never zero. `totalQueueSeconds` already
 * leaves untimed work out and stops at the first endless action.
 *
 * @param {Object} snapshot - From queue-snapshot.js
 * @param {number} elapsedSeconds - Seconds since the snapshot was taken
 * @returns {number|null} Remaining counted seconds (never negative), or null when an untimed row is running
 *   and the time left behind it is unknown
 */
export function remainingQueueSeconds(snapshot, elapsedSeconds) {
    const total = Math.max(0, Number(snapshot?.totalQueueSeconds) || 0);
    const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
    const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];

    // No rows to place the untimed boundary with: treat the whole total as running now
    let before = actions.length ? 0 : total;
    let untimedRow = false;
    for (const action of actions) {
        if (action.isInfinite) break;
        if (action.estimatedSeconds === null || action.estimatedSeconds === undefined) {
            untimedRow = true;
            break;
        }
        before += action.estimatedSeconds;
    }
    before = Math.min(before, total);

    // The untimed row has started: how long it runs is unknown, and so is when anything behind it begins
    if (untimedRow && elapsed >= before) return null;

    return Math.max(0, before - elapsed) + (total - before);
}
