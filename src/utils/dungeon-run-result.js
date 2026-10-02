/**
 * How a stored dungeon run ended.
 *
 * A clear carries no `result` at all — every run stored before failed and
 * canceled attempts could be recorded is a clear, and reads as one without a
 * migration. A recorded failure carries `result: 'fail'` (the party or solo
 * player died) and a voluntary withdrawal `result: 'cancel'`.
 *
 * Pure and import-free so either bundle can use it.
 */

/** A run the party lost: wiped, or a solo player died. */
export const RUN_RESULT_FAIL = 'fail';

/** A run the party walked away from: fled or canceled. Not a failure. */
export const RUN_RESULT_CANCEL = 'cancel';

/**
 * The shortest failed or canceled attempt worth recording. A ready-check that
 * falls through posts "Key counts" and then "Battle ended" a second later;
 * that is a start that never happened, not an attempt that cost time.
 */
export const MIN_RECORDED_ATTEMPT_MS = 10_000;

/**
 * Whether a stored run is a clear: no result (every legacy record) or an
 * explicit 'clear'. Anything else, including a value no version writes, is not.
 * @param {Object} run - Stored run
 * @returns {boolean} True for a clear
 */
export function isClearRun(run) {
    const result = run?.result;
    return result === undefined || result === null || result === 'clear';
}

/**
 * Whether a stored run is a failed attempt.
 * @param {Object} run - Stored run
 * @returns {boolean} True for a fail
 */
export function isFailedRun(run) {
    return run?.result === RUN_RESULT_FAIL;
}

/**
 * Whether a stored run is a canceled attempt.
 * @param {Object} run - Stored run
 * @returns {boolean} True for a cancel
 */
export function isCanceledRun(run) {
    return run?.result === RUN_RESULT_CANCEL;
}

/**
 * Whether a `result` value is one a stored run may carry.
 * @param {*} result - The value
 * @returns {boolean} True for absent, 'clear', 'fail' or 'cancel'
 */
export function isKnownRunResult(result) {
    return (
        result === undefined ||
        result === null ||
        result === 'clear' ||
        result === RUN_RESULT_FAIL ||
        result === RUN_RESULT_CANCEL
    );
}

/**
 * Failure figures over a set of stored runs.
 *
 * The fail rate is fails over clears plus fails: a cancel is a choice, not a
 * failure, and counts on neither side. The time per clear is every attempt's
 * time, cancels included because walking away still cost the time spent,
 * divided by the clears it bought. The clear-only figures (average, fastest,
 * slowest) are computed elsewhere from clears alone and are never touched by
 * this.
 *
 * @param {Array<Object>} runs - Stored runs, clears and attempts mixed
 * @returns {{clears: number, fails: number, cancels: number, failRate: number|null,
 *   timePerClearMs: number}} `failRate` is null with no clears or fails;
 *   `timePerClearMs` is 0 with no clears
 */
export function summarizeAttempts(runs) {
    let clears = 0;
    let fails = 0;
    let cancels = 0;
    let totalMs = 0;
    for (const run of runs || []) {
        const duration = Number(run?.duration || run?.totalTime || 0);
        const ms = Number.isFinite(duration) && duration > 0 ? duration : 0;
        if (isClearRun(run)) clears++;
        else if (isFailedRun(run)) fails++;
        else if (isCanceledRun(run)) cancels++;
        else continue;
        totalMs += ms;
    }
    const outcomes = clears + fails;
    return {
        clears,
        fails,
        cancels,
        failRate: outcomes > 0 ? fails / outcomes : null,
        timePerClearMs: clears > 0 ? Math.floor(totalMs / clears) : 0,
    };
}
