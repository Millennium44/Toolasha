/**
 * Attempt-count percentiles for finished enhancement runs
 *
 * A finished run is one draw from a distribution the calculator already models
 * — mean, variance and physical minimum, all read off the same Markov chain the
 * "Expected Attempts" figure comes from. One draw against a heavy-tailed
 * distribution is only honest as a percentile: "took 63 against a predicted 41"
 * sounds like the model missed, when a run that long or longer happens 8% of
 * the time and the model said exactly that.
 *
 * Nothing here is a new model. The tail is read off the same shifted-gamma fit
 * `costPercentiles` and `costExceedanceProbability` already use — with a cost of
 * one coin per attempt, the cost distribution *is* the attempt distribution —
 * so the percentile shown for a finished run and the p10/p90 quoted before it
 * started can never disagree about what the spread was.
 */

import { costStats, costExceedanceProbability } from '../../utils/enhancement-calculator.js';

/**
 * The chance a run takes as many attempts as this one did, or more.
 *
 * Null rather than a number when the prediction does not carry its variance —
 * sessions recorded before the distribution was stored have only a mean, and a
 * percentile computed against today's recomputed chain would be measured
 * against stats the run was not played with.
 *
 * @param {Object} prediction - Session predictions; needs `expectedAttemptsExact`
 *   (or `expectedAttempts`), `attemptsVariance` and `minAttempts`
 * @param {number} observedAttempts - Attempts the run actually took
 * @returns {number|null} P(attempts ≥ observed) in [0, 1], or null when the
 *   prediction has no distribution to read it from
 */
export function attemptTailProbability(prediction, observedAttempts) {
    const mean = Number(prediction?.expectedAttemptsExact ?? prediction?.expectedAttempts);
    const variance = Number(prediction?.attemptsVariance);
    const minimum = Number(prediction?.minAttempts);
    const observed = Number(observedAttempts);

    if (!Number.isFinite(mean) || !Number.isFinite(variance) || !Number.isFinite(minimum)) return null;
    if (!Number.isFinite(observed) || observed < 0) return null;

    // One coin per attempt makes the fitted cost distribution the attempt
    // distribution itself — same shift, same gamma, same tail
    const distribution = costStats(
        { attempts: mean, attemptsVariance: variance, minAttempts: minimum },
        {
            costPerAttempt: 1,
        }
    );

    // Every possible run takes at least the physical minimum
    if (observed <= distribution.minimum) return 1;

    return costExceedanceProbability(distribution, observed);
}

/**
 * A tail probability as words a player can read.
 * @param {number} tail - P(attempts ≥ observed), in [0, 1]
 * @returns {string} e.g. `8%`, `<1%`, `>99%`
 */
export function formatTailPercent(tail) {
    const percent = tail * 100;
    if (percent < 1) return '<1%';
    if (percent > 99) return '>99%';
    return `${Math.round(percent)}%`;
}

/**
 * The whole observation as one sentence.
 *
 * Phrased as "runs take that many or more" so it reads honestly from both
 * sides: an unlucky run gets a small percentage, a lucky one a large one, and
 * neither is a claim that the prediction was wrong.
 *
 * @param {number} expectedAttempts - What the chain predicted, rounded for display
 * @param {number} observedAttempts - What the run took
 * @param {number} tail - P(attempts ≥ observed), from {@link attemptTailProbability}
 * @returns {string}
 */
export function describeAttemptOutcome(expectedAttempts, observedAttempts, tail) {
    return (
        `Predicted ${Math.round(expectedAttempts)} attempts, took ${Math.round(observedAttempts)} — ` +
        `${formatTailPercent(tail)} of runs take that many or more.`
    );
}
