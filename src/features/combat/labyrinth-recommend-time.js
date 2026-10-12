/**
 * Labyrinth "Recommend by Time" — the search
 *
 * Picks the highest room level whose expected seconds per clear (failed runs
 * included — the `expectedSeconds` every clear-rate result already carries) is
 * within a target. Pure and dependency-free so the selection rules can be
 * tested without the sim graph; the caller supplies the probe.
 *
 * Why not a plain binary search: win rate falls monotonically with room level,
 * but expected seconds does not. A clear that takes N attempts has a time that
 * moves with the integer attempt count and the integer progress per success,
 * so seconds can step down as the level rises before climbing. The search
 * therefore brackets the boundary (exponential probing out from the current
 * level, then bisection) and then sweeps upward from the highest pass it found
 * for a bounded number of levels, stopping after a streak of misses. A pass
 * hiding further out than the sweep reaches is not found — the bound is what
 * keeps a combat sweep (each probe a full simulation) affordable.
 *
 * Adapted from the "Recommend by Time" mode of the Labyrinth Win Rate
 * Calculator userscript (MIT); see docs/THIRD-PARTY-LICENSES.md.
 */

/** Target time the panel starts at, in seconds */
export const DEFAULT_RECOMMEND_TARGET_SECONDS = 300;
export const MIN_RECOMMEND_TARGET_SECONDS = 1;
export const MAX_RECOMMEND_TARGET_SECONDS = 100000;

/** Cap on how far a miss can read, so an unreachable room still compares */
const MAX_OVERSHOOT_PCT = 1e6;

/**
 * Clamp a typed target to 1..100000 whole seconds.
 * @param {*} value - Raw input
 * @param {number} [fallback] - Used when the value is not a number
 * @returns {number}
 */
export function normalizeTargetSeconds(value, fallback = DEFAULT_RECOMMEND_TARGET_SECONDS) {
    const n = Math.floor(Number(value));
    const base = Number.isFinite(n) && n > 0 ? n : Math.floor(Number(fallback)) || DEFAULT_RECOMMEND_TARGET_SECONDS;
    return Math.min(MAX_RECOMMEND_TARGET_SECONDS, Math.max(MIN_RECOMMEND_TARGET_SECONDS, base));
}

/**
 * The question a recommendation answers, as a string. A record made under one
 * basis or target must never be read as the answer to another.
 * @param {'winRate'|'seconds'} basis
 * @param {number} target - Win % or seconds
 * @returns {string}
 */
export function recommendationBasisKey(basis, target) {
    return basis === 'seconds' ? `seconds=${target}` : `winRate=${target}`;
}

/**
 * Search the room-level offset window for the highest level within a time.
 *
 * @param {Object} params
 * @param {(delta: number) => Promise<{seconds: number}|{cancelled: true}|null>} params.evaluate
 *   Probe one level offset (room level = effective level + delta)
 * @param {number} params.minDelta - Lowest offset allowed (negative)
 * @param {number} params.maxDelta - Highest offset allowed
 * @param {number} params.targetSeconds - Time limit
 * @param {number} [params.sweepSteps] - How far above the bracketed pass to keep looking
 * @param {number} [params.failStreak] - Consecutive misses that end the sweep
 * @param {number} [params.minStep] - First exponential step
 * @param {number} [params.maxStep] - Largest exponential step
 * @returns {Promise<{delta: number, seconds: number, qualifies: boolean}|null>}
 *   Null when cancelled or when no level could be evaluated
 */
export async function findHighestLevelWithinSeconds({
    evaluate,
    minDelta,
    maxDelta,
    targetSeconds,
    sweepSteps = 14,
    failStreak = 5,
    minStep = 4,
    maxStep = 64,
}) {
    const lo = Math.min(minDelta, maxDelta);
    const hi = Math.max(minDelta, maxDelta);
    const samples = new Map();
    let cancelled = false;

    const probe = async (rawDelta) => {
        const delta = Math.max(lo, Math.min(hi, Math.floor(rawDelta)));
        if (samples.has(delta)) return samples.get(delta);
        if (cancelled) return null;
        const outcome = await evaluate(delta);
        if (outcome?.cancelled) {
            cancelled = true;
            return null;
        }
        // Rounded the way the panel displays it, so a level shown as 300s is not
        // rejected by a 300.4 behind the display
        const seconds = outcome && Number.isFinite(outcome.seconds) ? Math.round(outcome.seconds) : Infinity;
        const sample = outcome ? { delta, seconds, ok: seconds <= targetSeconds } : null;
        samples.set(delta, sample);
        return sample;
    };

    const base = await probe(Math.max(lo, Math.min(hi, 0)));
    if (cancelled) return null;
    if (!base) return null;

    // Highest offset known to pass, and the lowest known to fail above it
    let pass = null;
    let fail = null;

    if (base.ok) {
        pass = base.delta;
        let step = minStep;
        while (pass < hi) {
            const next = await probe(pass + step);
            if (cancelled) return null;
            if (!next) {
                fail = Math.min(hi, pass + step);
                break;
            }
            if (next.ok) {
                pass = next.delta;
                step = Math.min(maxStep, step * 2);
            } else {
                fail = next.delta;
                break;
            }
        }
    } else {
        fail = base.delta;
        let step = minStep;
        while (fail > lo) {
            const next = await probe(fail - step);
            if (cancelled) return null;
            if (next?.ok) {
                pass = next.delta;
                break;
            }
            fail = next ? next.delta : Math.max(lo, fail - step);
            step = Math.min(maxStep, step * 2);
        }
        // The exponential steps skip levels; on a non-monotone curve a pass can sit in a gap just
        // under the base, or just above it, so scan the nearest skipped levels on both sides before
        // calling it a miss
        const scanFor = async (from, dir) => {
            let steps = 0;
            for (let delta = from; delta >= lo && delta <= hi && steps < sweepSteps; delta += dir) {
                if (samples.has(delta)) continue;
                const sample = await probe(delta);
                if (cancelled) return null;
                steps++;
                if (sample?.ok) return delta;
            }
            return null;
        };
        if (pass === null) pass = await scanFor(base.delta - 1, -1);
        if (cancelled) return null;
        if (pass === null) pass = await scanFor(base.delta + 1, 1);
        if (cancelled) return null;
        if (pass !== null) fail = null;
    }

    if (pass !== null && fail !== null) {
        while (fail - pass > 1) {
            const mid = Math.floor((pass + fail) / 2);
            const sample = await probe(mid);
            if (cancelled) return null;
            if (sample?.ok) pass = mid;
            else fail = mid;
        }
    }

    // The guard against a non-monotone curve: a pass can sit above a miss
    if (pass !== null) {
        let streak = 0;
        let steps = 0;
        let delta = pass + 1;
        while (delta <= hi && steps < sweepSteps) {
            const sample = await probe(delta);
            if (cancelled) return null;
            steps++;
            if (sample?.ok) {
                pass = delta;
                streak = 0;
            } else {
                streak++;
                if (streak >= failStreak) break;
            }
            delta++;
        }
    }

    // Highest qualifying level wins; otherwise the smallest overshoot, ties
    // (including every level being unreachable) going to the lower, safer level
    let best = null;
    for (const sample of samples.values()) {
        if (!sample?.ok) continue;
        if (!best || sample.delta > best.delta) best = sample;
    }
    if (best) return { delta: best.delta, seconds: best.seconds, qualifies: true };

    let closest = null;
    let closestOver = Infinity;
    for (const sample of samples.values()) {
        if (!sample) continue;
        const over = Number.isFinite(sample.seconds)
            ? Math.min(MAX_OVERSHOOT_PCT, ((sample.seconds - targetSeconds) / targetSeconds) * 100)
            : MAX_OVERSHOOT_PCT;
        if (
            !closest ||
            over < closestOver - 1e-9 ||
            (Math.abs(over - closestOver) <= 1e-9 && sample.delta < closest.delta)
        ) {
            closest = sample;
            closestOver = over;
        }
    }
    return closest ? { delta: closest.delta, seconds: closest.seconds, qualifies: false } : null;
}
