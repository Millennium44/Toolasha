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
 * @returns {{update: Function, elapsedMs: Function}} Tracker
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

    return {
        /** @returns {number} Milliseconds since the run started */
        elapsedMs: () => now() - start,

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
