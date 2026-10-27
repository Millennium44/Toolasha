/**
 * Queue projection - how much of a snapshot's counted time is still ahead.
 */

/**
 * Counted queue time still ahead of a snapshot, `elapsedSeconds` after it was taken.
 *
 * When every row is timed the figure is the total burned down by wall-clock time. When a row has no
 * estimate (a counted fight, an action with no rate) the known timed work is only a floor: the untimed row
 * runs for an unknown time and the work behind it cannot be dated, so the figure is `max(0, known - elapsed)`
 * and `isLowerBound` is true. A lower bound of zero means "nothing known is left", never "finished".
 * `totalQueueSeconds` already leaves untimed work out and stops at the first endless action.
 *
 * @param {Object} snapshot - From queue-snapshot.js
 * @param {number} elapsedSeconds - Seconds since the snapshot was taken
 * @returns {{seconds: number, isLowerBound: boolean}} Counted seconds left (never negative), and whether
 *   untimed work means the real time left is at least that long
 */
export function queueTimeLeft(snapshot, elapsedSeconds) {
    const total = Math.max(0, Number(snapshot?.totalQueueSeconds) || 0);
    const elapsed = Math.max(0, Number(elapsedSeconds) || 0);
    const actions = Array.isArray(snapshot?.actions) ? snapshot.actions : [];

    let untimedRow = false;
    for (const action of actions) {
        if (action.isInfinite) break;
        if (action.estimatedSeconds === null || action.estimatedSeconds === undefined) {
            untimedRow = true;
            break;
        }
    }

    return {
        seconds: Math.max(0, total - elapsed),
        isLowerBound: untimedRow || Boolean(snapshot?.hasUnknownAction),
    };
}

/**
 * Seconds of counted queue time still ahead (see `queueTimeLeft`); callers that must not treat a lower
 * bound as exact use `queueTimeLeft` and read `isLowerBound`.
 *
 * @param {Object} snapshot - From queue-snapshot.js
 * @param {number} elapsedSeconds - Seconds since the snapshot was taken
 * @returns {number} Remaining counted seconds (never negative)
 */
export function remainingQueueSeconds(snapshot, elapsedSeconds) {
    return queueTimeLeft(snapshot, elapsedSeconds).seconds;
}
