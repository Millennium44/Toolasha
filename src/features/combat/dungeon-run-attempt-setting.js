/**
 * Whether failed and canceled dungeon runs are recorded.
 *
 * Its own module so the tracker, its panel and the chat annotations can all
 * ask without importing one another (each is mocked in the others' tests).
 */

import config from '../../core/config.js';

/** The setting that opts in to recording failed and canceled runs. */
export const RECORD_FAILED_RUNS_SETTING = 'dungeonTracker_recordFailedRuns';

/**
 * Whether failed and canceled runs are recorded.
 * @returns {boolean} True when the player opted in
 */
export function recordingAttempts() {
    return config.getSetting?.(RECORD_FAILED_RUNS_SETTING) === true;
}
