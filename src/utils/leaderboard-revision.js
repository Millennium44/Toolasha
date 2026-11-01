/**
 * The game stores each board under type + category + guild-type / game-mode /
 * trial filters, and drops a `leaderboard_updated` whose `leaderboardRevision`
 * is lower than the one it already holds for that board (a slow response
 * arriving after a newer one). A recorder that skipped the check would write
 * the older board's rows and ranks over the newer ones.
 */

const ANY = 'all';

/**
 * The game's key for the board a `leaderboard_updated` message describes.
 * @param {Object} data - `leaderboard_updated` message
 * @returns {string}
 */
export function leaderboardRevisionKey(data) {
    return [
        data?.leaderboardType,
        data?.leaderboardCategory,
        data?.guildTypeFilter || ANY,
        data?.gameModeFilter || ANY,
        data?.trialFilter || ANY,
    ].join(':');
}

/**
 * Remembers the newest revision seen per board and says whether a message is an older one.
 * @returns {{ isStale: (data: Object) => boolean, reset: () => void }}
 */
export function createRevisionGate() {
    const seen = new Map();
    return {
        /**
         * Whether the message is older than the last one seen for its board. A message
         * that is not stale is remembered as the newest.
         * @param {Object} data - `leaderboard_updated` message
         * @returns {boolean}
         */
        isStale(data) {
            const revision = Number(data?.leaderboardRevision) || 0;
            const key = leaderboardRevisionKey(data);
            const last = seen.get(key);
            if (last !== undefined && last > revision) return true;
            seen.set(key, revision);
            return false;
        },
        reset() {
            seen.clear();
        },
    };
}
