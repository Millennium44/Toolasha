/**
 * Wilson score interval — how sure a simulated win rate is.
 *
 * A labyrinth room's clear chance is a proportion estimated by repeated trials,
 * so how much of it to believe depends entirely on how many trials there were.
 * Simulating for a fixed span of game time gets that backwards: the budget buys
 * trials at a rate set by how long each fight lasts, so a room that resolves in
 * five seconds is measured twenty times more finely than one that runs the full
 * timeout — and the slow ones are the marginal ones, where the decision is
 * closest and the precision matters most.
 *
 * Wilson rather than the textbook normal interval because the interesting cases
 * sit at the ends. A room that has lost every trial has p̂ = 0, and the normal
 * interval calls that zero ± zero: certainty from a sample that cannot support
 * it. Wilson keeps a sane interval there, which is what lets a hopeless room
 * stop early instead of grinding out trials to disprove what it already knows.
 */

/** 1.96 — the two-sided 95% normal quantile */
export const Z_95 = 1.959963984540054;

/**
 * Half-width of the Wilson score interval for a proportion.
 *
 * @param {number} successes - Trials won
 * @param {number} trials - Trials run
 * @param {number} [z=Z_95] - Normal quantile; the default reads as "95% sure"
 * @returns {number} Half-width in proportion units (0.01 = ±1 percentage point),
 *   or Infinity when there is nothing to go on
 */
export function wilsonHalfWidth(successes, trials, z = Z_95) {
    const n = Math.floor(Number(trials) || 0);
    if (n <= 0) return Infinity;
    const wins = Math.min(Math.max(0, Math.floor(Number(successes) || 0)), n);
    const p = wins / n;
    const z2 = z * z;
    return (z / (1 + z2 / n)) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
}

/**
 * The Wilson interval itself, for reporting rather than for stopping.
 * @param {number} successes - Trials won
 * @param {number} trials - Trials run
 * @param {number} [z=Z_95] - Normal quantile
 * @returns {{low: number, high: number, halfWidth: number}} Bounds clamped to 0..1
 */
export function wilsonInterval(successes, trials, z = Z_95) {
    const n = Math.floor(Number(trials) || 0);
    if (n <= 0) return { low: 0, high: 1, halfWidth: Infinity };
    const wins = Math.min(Math.max(0, Math.floor(Number(successes) || 0)), n);
    const p = wins / n;
    const z2 = z * z;
    const center = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half = wilsonHalfWidth(wins, n, z);
    return { low: Math.max(0, center - half), high: Math.min(1, center + half), halfWidth: half };
}

/**
 * Whether a run has learned enough to stop.
 *
 * The floor matters as much as the target: a run that opens with three straight
 * losses would otherwise satisfy any interval you asked for and stop having
 * seen almost nothing.
 *
 * @param {number} successes - Trials won
 * @param {number} trials - Trials run
 * @param {Object} [rule] - Stopping rule
 * @param {number} [rule.targetHalfWidth] - Interval half-width to reach, in
 *   proportion units; 0 or absent means precision never stops the run
 * @param {number} [rule.minTrials=50] - Never stop before this many
 * @param {number} [rule.maxTrials] - Always stop at this many
 * @returns {boolean}
 */
export function hasConverged(successes, trials, rule = {}) {
    const n = Math.floor(Number(trials) || 0);
    const minTrials = Number.isFinite(Number(rule.minTrials)) ? Number(rule.minTrials) : 50;
    const maxTrials = Number(rule.maxTrials);
    if (Number.isFinite(maxTrials) && maxTrials > 0 && n >= maxTrials) return true;
    if (n < Math.max(1, minTrials)) return false;

    const target = Number(rule.targetHalfWidth);
    if (!Number.isFinite(target) || target <= 0) return false;
    return wilsonHalfWidth(successes, n) <= target;
}

/**
 * Trials a proportion needs before its interval is tight enough — the answer to
 * "how long will this take", for the rooms whose answer is not yet obvious.
 * @param {number} p - Assumed proportion
 * @param {number} targetHalfWidth - Interval half-width to reach
 * @param {number} [z=Z_95] - Normal quantile
 * @returns {number} Trials, rounded up
 */
export function trialsNeeded(p, targetHalfWidth, z = Z_95) {
    if (!(targetHalfWidth > 0)) return Infinity;
    const q = Math.min(Math.max(Number(p) || 0, 0), 1);
    return Math.ceil((z * z * q * (1 - q)) / (targetHalfWidth * targetHalfWidth));
}
