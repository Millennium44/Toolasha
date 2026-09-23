/**
 * Expected-vs-actual successes for one alchemy session.
 *
 * Every session the three trackers save is stamped with `predictedRate` —
 * the model's predicted success rate at the moment the session started (see
 * `alchemy-success-stamp.js`). That number already answers "how many
 * successes should this session have produced": `attempts × predictedRate`.
 * This is that one multiplication, plus the formatting the history viewers
 * need around it, kept in one place instead of three.
 *
 * This is deliberately simpler than `alchemy-measured-rate.js`, which pools
 * every session sharing an exact item+catalyst+enhancement combination and
 * runs a Wilson interval over the pool to say whether the sample can
 * contradict the forecast. A single session is one draw from that
 * distribution, not a pool, and does not carry enough attempts on its own to
 * support that verdict — attaching one anyway would show a false confidence
 * a handful of attempts cannot earn. What a single session's number IS good
 * for is a plain comparison against what the model said going in, which is
 * all this computes.
 *
 * @param {Object} session - A tracker session
 * @param {number} session.totalAttempts
 * @param {number} session.totalSuccesses
 * @param {number|null|undefined} session.predictedRate - 0..1, or absent on
 *   sessions recorded before this was stamped
 * @returns {{expected: number, delta: number}|null} `expected` and
 *   `successes - expected`, or null when there is no predicted rate to
 *   compare against — never 0, which would read as "none expected"
 */
export function computeExpectedSuccesses(session) {
    const predictedRate = Number(session?.predictedRate);
    if (!Number.isFinite(predictedRate) || predictedRate <= 0) return null;

    const attempts = Math.max(0, Number(session?.totalAttempts) || 0);
    const successes = Math.max(0, Number(session?.totalSuccesses) || 0);
    const expected = attempts * predictedRate;

    return { expected, delta: successes - expected };
}

/**
 * The "Expected" cell text: the predicted count and how far actual successes
 * came from it, or an em dash when the session has no stamped rate to
 * compare against.
 *
 * @param {{expected: number, delta: number}|null} result - From {@link computeExpectedSuccesses}
 * @returns {string}
 */
export function formatExpectedSuccesses(result) {
    if (!result) return '—';
    const sign = result.delta >= 0 ? '+' : '';
    return `${result.expected.toFixed(1)} (${sign}${result.delta.toFixed(1)})`;
}

/**
 * Pool `computeExpectedSuccesses` across a set of sessions, for a totals
 * row. Sessions without a stamped rate are excluded from both sides of the
 * comparison — folding them in as "0 expected" would understate the model's
 * prediction rather than say the comparison could not be made for them.
 *
 * @param {Array<Object>} sessions
 * @returns {{expected: number, actual: number, delta: number, countedSessions: number, excludedSessions: number}}
 */
export function poolExpectedSuccesses(sessions) {
    let expected = 0;
    let actual = 0;
    let countedSessions = 0;
    let excludedSessions = 0;

    for (const session of sessions || []) {
        const result = computeExpectedSuccesses(session);
        if (!result) {
            excludedSessions++;
            continue;
        }
        expected += result.expected;
        actual += Math.max(0, Number(session.totalSuccesses) || 0);
        countedSessions++;
    }

    return { expected, actual, delta: actual - expected, countedSessions, excludedSessions };
}

/**
 * The pooled totals-row cell text, mirroring {@link formatExpectedSuccesses}.
 * @param {{expected: number, actual: number, delta: number, countedSessions: number}} pooled - From {@link poolExpectedSuccesses}
 * @returns {string}
 */
export function formatPooledExpectedSuccesses(pooled) {
    if (!pooled || pooled.countedSessions === 0) return '—';
    const sign = pooled.delta >= 0 ? '+' : '';
    return `${pooled.actual} vs ${pooled.expected.toFixed(1)} (${sign}${pooled.delta.toFixed(1)})`;
}
