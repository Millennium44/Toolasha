/**
 * Time remaining on a long run.
 *
 * A percentage answers "how far in", which is not the question anyone staring at
 * an upgrade analysis is asking. The runs here are minutes long and vary by an
 * order of magnitude with the mode, the candidate count and the machine, so the
 * only honest source for the estimate is the run itself.
 *
 * ## Why two rates rather than one
 *
 * Elapsed over fraction — the whole run's average pace — is stable and slow to
 * notice that things changed: an analysis that spends its first third on cheap
 * candidates and the rest on expensive ones keeps promising a finish it has
 * already fallen behind. The pace over the last few updates notices immediately
 * and is jumpy enough to be useless on its own, since one slow candidate makes
 * it claim another ten minutes. Averaging the two gives an estimate that moves
 * when the run's character changes without lurching on every step.
 *
 * ## Why it says nothing at first
 *
 * The first second of a run is mostly workers starting, and a percent or two of
 * one is a rounding error being multiplied by a hundred. An estimate drawn from
 * either is wrong by a factor of several — and the wrong one is the one people
 * remember. It reads "estimating…" until there is enough of the run to divide by.
 */

/**
 * Round an estimate to something worth reading, and say it.
 *
 * Quantised because a number that ticks 2m14s, 2m11s, 2m16s reads as precision
 * that is not there — the estimate is not good to the second and should not
 * claim to be. Coarser the further out it is, for the same reason.
 *
 * @param {number} remainingMs - Milliseconds remaining
 * @returns {string} e.g. `40s`, `2m 30s`, `1h 10m`
 */
export function formatEta(remainingMs) {
    const seconds = Math.max(0, (Number(remainingMs) || 0) / 1000);
    if (seconds < 10) return 'a few seconds';

    const step = seconds < 60 ? 5 : seconds < 600 ? 15 : 60;
    const rounded = Math.round(seconds / step) * step;

    if (rounded < 60) return `${rounded}s`;

    const minutes = Math.floor(rounded / 60);
    const secs = rounded % 60;
    if (minutes < 60) return secs ? `${minutes}m ${secs}s` : `${minutes}m`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Track a run's pace and estimate what is left of it.
 *
 * One tracker per run — it starts its clock when it is made, so it is built
 * where the run starts rather than kept on the panel.
 *
 * @param {Object} [options] - Overrides
 * @param {Function} [options.now] - Clock, for tests
 * @param {number} [options.smoothing] - EWMA weight on the newest pace reading
 * @param {number} [options.minElapsedMs] - Stay quiet until the run is this old
 * @param {number} [options.minFraction] - Stay quiet until this much is done
 * @returns {{update: Function, updateRemaining: Function, elapsedMs: Function}} Tracker
 */
export function createEtaTracker({
    now = () => Date.now(),
    smoothing = 0.3,
    minElapsedMs = 1500,
    minFraction = 0.02,
} = {}) {
    const start = now();
    let lastAt = start;
    let lastFraction = 0;
    let recentRate = null;
    // `updateRemaining`'s shown estimate and when it was taken
    let shownMs = null;
    let shownAt = start;

    return {
        /** @returns {number} Milliseconds since the run started */
        elapsedMs: () => now() - start,

        /**
         * Report an estimate the run worked out itself (see `createWorkEstimator`) and get it back smoothed.
         *
         * The shown figure counts down with the clock between reports, and each new report moves it only
         * `smoothing` of the way towards the new reading, so one slow candidate or a round of work being added
         * moves the estimate without making it jump. Quiet ("estimating…") while the run has nothing to go on or
         * is younger than `minElapsedMs`; empty once finished.
         *
         * @param {number|null} remainingMs - The run's own estimate, null while it has none
         * @param {number} fraction - How much is done, 0 to 1 (only to tell finished from not)
         * @returns {{elapsedMs: number, remainingMs: number|null, text: string}}
         */
        updateRemaining(remainingMs, fraction) {
            const at = now();
            const elapsedMs = at - start;
            if (Number(fraction) >= 1) return { elapsedMs, remainingMs: 0, text: '' };
            const raw = Number(remainingMs);
            if (remainingMs == null || !Number.isFinite(raw) || raw < 0) {
                return { elapsedMs, remainingMs: null, text: 'estimating…' };
            }
            if (shownMs === null) {
                shownMs = raw;
            } else {
                const counted = Math.max(0, shownMs - (at - shownAt));
                shownMs = counted + smoothing * (raw - counted);
            }
            shownAt = at;
            if (elapsedMs < minElapsedMs) return { elapsedMs, remainingMs: null, text: 'estimating…' };
            return { elapsedMs, remainingMs: shownMs, text: `~${formatEta(shownMs)} left` };
        },

        /**
         * Report progress and get the estimate back.
         *
         * @param {number} fraction - How much is done, 0 to 1
         * @returns {{elapsedMs: number, remainingMs: number|null, text: string}}
         *   `remainingMs` is null while there is not enough to go on, and `text`
         *   is empty once finished so a completed bar does not read "0s left"
         */
        update(fraction) {
            const at = now();
            const done = Math.max(0, Math.min(1, Number(fraction) || 0));
            const elapsedMs = at - start;

            const stepMs = at - lastAt;
            const stepFraction = done - lastFraction;
            // Only real forward movement carries pace; a repeated percentage
            // would otherwise read as the run having stalled
            if (stepMs > 0 && stepFraction > 0) {
                const instant = stepFraction / stepMs;
                recentRate = recentRate === null ? instant : recentRate + smoothing * (instant - recentRate);
                lastAt = at;
                lastFraction = done;
            }

            if (done >= 1) return { elapsedMs, remainingMs: 0, text: '' };
            if (!recentRate || elapsedMs < minElapsedMs || done < minFraction) {
                return { elapsedMs, remainingMs: null, text: 'estimating…' };
            }

            const rate = (recentRate + done / elapsedMs) / 2;
            const remainingMs = (1 - done) / rate;
            return { elapsedMs, remainingMs, text: `~${formatEta(remainingMs)} left` };
        },
    };
}

/**
 * Time left on a run whose pieces of work cost different amounts, learned from the pieces already done.
 *
 * A plain average over items says a combat-level candidate (three sims) costs what a house room (one) does,
 * and that the 4× re-sims of a close call cost what a first-pass sim did, so the estimate drifts by the share
 * of each kind still to come. Here every piece has a `kind` and a number of `units` — its expected cost before
 * anything is measured: sim hours over the first pass's hours (party size and zone are the same for every sim
 * in one run, so they cancel). Each finished piece teaches its kind a cost per unit; a kind not seen yet uses
 * the run's average, and a kind seen once is pulled towards that average by `priorWeight` units until more of
 * it has run.
 *
 * Remaining time is the expected cost of everything still planned, plus what is left of each piece running,
 * divided by how many run at once. Nothing is said until one piece has finished.
 *
 * @param {Object} [options]
 * @param {Function} [options.now] - Clock, for tests
 * @param {number} [options.lanes=1] - Pieces run at once
 * @param {number} [options.priorWeight=1] - Units of the run's average a kind's own figure is blended with
 * @returns {{add: Function, start: Function, finish: Function, complete: Function, remainingMs: Function,
 *   rateMs: Function}}
 */
export function createWorkEstimator({ now = () => Date.now(), lanes = 1, priorWeight = 1 } = {}) {
    const pending = new Map();
    const running = new Set();
    const learned = new Map();
    const overall = { ms: 0, units: 0 };
    const width = Math.max(1, Math.floor(Number(lanes)) || 1);

    const take = (kind, units) => {
        const left = (pending.get(kind) || 0) - units;
        if (left > 1e-9) pending.set(kind, left);
        else pending.delete(kind);
    };
    const record = (kind, units, ms) => {
        if (!(units > 0) || !(ms >= 0)) return;
        const seen = learned.get(kind) || { ms: 0, units: 0 };
        seen.ms += ms;
        seen.units += units;
        learned.set(kind, seen);
        overall.ms += ms;
        overall.units += units;
    };
    /** Milliseconds one unit of `kind` is expected to take, null before anything has finished */
    const rateMs = (kind) => {
        if (!overall.units) return null;
        const average = overall.ms / overall.units;
        const seen = learned.get(kind);
        if (!seen) return average;
        return (seen.ms + average * priorWeight) / (seen.units + priorWeight);
    };

    return {
        /**
         * Plan work not started yet.
         * @param {string} kind - What sort of work ('baseline', a candidate type, 'food')
         * @param {number} [units=1] - Expected cost of one piece
         * @param {number} [count=1] - How many such pieces
         */
        add(kind, units = 1, count = 1) {
            const total = Number(units) * Number(count);
            if (total > 0) pending.set(kind, (pending.get(kind) || 0) + total);
        },
        /**
         * A planned piece starts.
         * @param {string} kind
         * @param {number} [units=1]
         * @returns {Object} Token for `finish`
         */
        start(kind, units = 1) {
            take(kind, units);
            const token = { kind, units, startedAt: now() };
            running.add(token);
            return token;
        },
        /**
         * A started piece ends.
         * @param {Object} token - From `start`
         * @param {boolean} [measured=true] - False for a piece Stop cut short: its time teaches nothing
         */
        finish(token, measured = true) {
            if (!token || !running.delete(token)) return;
            if (measured) record(token.kind, token.units, now() - token.startedAt);
        },
        /**
         * A planned piece that was never `start`ed ended, `ms` after the last one of its run did.
         * @param {string} kind
         * @param {number} units
         * @param {number} ms
         */
        complete(kind, units, ms) {
            take(kind, units);
            record(kind, units, ms);
        },
        /** @returns {number|null} Milliseconds left, null before any piece has finished */
        remainingMs() {
            if (!overall.units) return null;
            let total = 0;
            for (const [kind, units] of pending) total += units * rateMs(kind);
            const at = now();
            for (const token of running)
                total += Math.max(0, token.units * rateMs(token.kind) - (at - token.startedAt));
            return total / width;
        },
        rateMs,
    };
}
