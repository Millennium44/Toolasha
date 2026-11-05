/**
 * Stored forecasts that were written while release 3.76.0 scaled enhanced gear about 50x too strongly.
 *
 * See Millennium44/Toolasha#808 (the fix) and #809 (this follow-up). 3.76.0 read the game's
 * enhancement table as fractions, so every skilling and enhancing forecast made on it was far
 * too high for enhanced gear. A forecast saved with the figure stays wrong, and a calibration
 * ledger that pairs it with what the run really paid reads the bug as a model that "ran hot".
 *
 * Readers leave these records out; nothing here deletes, rewrites or migrates a stored record,
 * and no record changes shape. The worst failure is a reader dropping a record that was NOT from
 * 3.76.0, so every test below is narrow on purpose: an exact version string, and a closed time
 * window only where a record carries no version. A record this cannot place is counted.
 *
 * Combat is not affected (the combat stats and the Combat Sim read the table correctly), so a
 * combat pair written on 3.76.0 is kept.
 */

/** The release that carried the bug. Dev builds stamp `<version>.<timestamp>` and are not matched */
export const BAD_ENHANCEMENT_SCALE_VERSION = '3.76.0';

/** When 3.76.0 went live (2026-11-05 13:23:42 UTC) */
export const BAD_ENHANCEMENT_SCALE_FROM_MS = Date.UTC(2026, 10, 5, 13, 23, 42);

/**
 * When the fix went live (2026-11-05 17:02:36 UTC). A page opened before this keeps running the
 * bad script until it is reloaded, so a forecast a little after this can still be bad; the window
 * only ever under-reaches, which leaves a stale record counted (the mild failure).
 */
export const BAD_ENHANCEMENT_SCALE_TO_MS = Date.UTC(2026, 10, 5, 17, 2, 36);

/**
 * Whether a time falls inside the window 3.76.0 was live.
 * @param {*} ms - Epoch milliseconds
 * @returns {boolean} False for anything that is not a finite number
 */
function inWindow(ms) {
    return (
        typeof ms === 'number' &&
        Number.isFinite(ms) &&
        ms >= BAD_ENHANCEMENT_SCALE_FROM_MS &&
        ms <= BAD_ENHANCEMENT_SCALE_TO_MS
    );
}

/**
 * A profit-calibration pair (the `calibration_<id>` ledger) forecast by 3.76.0. The pair carries
 * `v`, the version of the script that made the forecast. Combat pairs are never matched.
 * @param {Object|null|undefined} record - A ledger pair
 * @returns {boolean} True only for `v === '3.76.0'` on a non-combat pair
 */
export function isBadEnhancementScaleRecord(record) {
    if (!record || typeof record !== 'object') return false;
    if (record.actionType === 'combat') return false;
    return record.v === BAD_ENHANCEMENT_SCALE_VERSION;
}

/**
 * An enhancement-calibration observation (the `calibrationEnhancing_<id>` ledger). It carries no
 * version, so the only marker is `t`, the session's own end time. A session that began before the
 * release and ended inside the window is left out although its forecast was sound, and one that
 * began inside and ended after is kept although it was not: both are the mild failure.
 * @param {Object|null|undefined} observation - An enhancement observation
 * @returns {boolean} True when `t` falls inside the window
 */
export function isBadEnhancementScaleObservation(observation) {
    if (!observation || typeof observation !== 'object') return false;
    return inWindow(observation.t);
}

/**
 * An alchemy session whose success rate was stamped by 3.76.0. The stamp's own time,
 * `predictedAt`, is when the prediction was made (the session's start), so it is reliable; a
 * session with no stamp time cannot be placed and is kept.
 * @param {Object|null|undefined} session - A transmute, decompose or coinify session
 * @returns {boolean} True when `predictedAt` falls inside the window
 */
export function isBadEnhancementScaleAlchemySession(session) {
    if (!session || typeof session !== 'object') return false;
    return inWindow(session.predictedAt);
}

/**
 * The profit-calibration pairs without the 3.76.0 ones. A new array; the input is not touched.
 * @param {Array<Object>|null} records - A ledger, or null before it has loaded
 * @returns {Array<Object>|null} The kept pairs, or null when the ledger has not loaded
 */
export function withoutBadEnhancementScaleRecords(records) {
    if (!Array.isArray(records)) return records;
    return records.filter((record) => !isBadEnhancementScaleRecord(record));
}

/**
 * The enhancement observations without the ones inside the window. A new array.
 * @param {Array<Object>|null} observations - The observations, or null before they have loaded
 * @returns {Array<Object>|null} The kept observations, or null when not loaded
 */
export function withoutBadEnhancementScaleObservations(observations) {
    if (!Array.isArray(observations)) return observations;
    return observations.filter((observation) => !isBadEnhancementScaleObservation(observation));
}
