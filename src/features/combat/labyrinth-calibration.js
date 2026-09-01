/**
 * Labyrinth calibration — stored predictions against outcomes
 *
 * The recorder now stamps each attempt with the clear chance that was on screen
 * when the fight was recorded, plus a sim-model marker. That turns the pool into
 * a calibration set: every attempt is a probability the sim committed to and a
 * yes/no the game answered with, which supports two readings the per-room
 * record cannot give — whether 30% rooms clear about 30% of the time (the
 * reliability bands), and how sharp the predictions are overall (the Brier
 * score).
 *
 * Cohorts matter here more than anywhere, and there are two of them to keep
 * apart. A prediction made before the sim switched to full monster abilities
 * came from a different *model*. A prediction made before the fingerprint
 * learned about combat skill levels came from a different *character* — the
 * gear-only fingerprint pooled fights from either side of a level-up, and the
 * replay reported the resulting gap as the sim over-crediting damage. Attempts
 * failing either test are excluded from every figure — counted, never pooled,
 * never deleted.
 *
 * Pure: attempts in, numbers out. The recorder owns the pool and the panel owns
 * the drawing.
 */

import { FINGERPRINT_VERSION, isCurrentFingerprintVersion } from './labyrinth-fingerprint.js';

/**
 * Below this many judged fights a reliability reading is noise, and the panel
 * says "too few to call" rather than quoting a Brier score.
 *
 * Higher than the replay's five-fight floor because this is a harder
 * question: a rate needs only enough fights to divide, where a calibration
 * reading has to separate a miscalibrated sim from the spread a correct one
 * produces, and Σ p(1−p) over a handful of attempts leaves almost any observed
 * count inside one standard deviation.
 */
export const MIN_CALIBRATION_FIGHTS = 20;

/**
 * The probability bands the reliability report buckets attempts into. Uneven on
 * purpose: the tails are where most rooms live and where a miscalibration is
 * cheapest to see, while 30–70% needs the width to gather any sample at all.
 */
export const CALIBRATION_BANDS = [
    { low: 0, high: 0.1, label: '0–10%' },
    { low: 0.1, high: 0.3, label: '10–30%' },
    { low: 0.3, high: 0.7, label: '30–70%' },
    { low: 0.7, high: 0.9, label: '70–90%' },
    { low: 0.9, high: 1, label: '90–100%' },
];

/**
 * Split recorded attempts into the cohort a reading may use and the ones it
 * may only count.
 *
 * Two tests, and an attempt has to pass both.
 *
 * `model.fullKit`: attempts recorded since the sim switched every path to full
 * monster abilities carry it, older records do not. Their predictions came from
 * a different model.
 *
 * `fingerprintVersion`: attempts carry the version they were fingerprinted
 * under, and only the current one passes. A v1 record was pooled by gear alone,
 * so a level-up moved the sim's answer without moving its fingerprint; a v2
 * record was pooled by gear and levels, so an ability swap or a house room did
 * the same. Either way, comparing one against a sim of the character you are
 * now is comparing against a different character.
 *
 * The excluded halves are returned rather than dropped, so a caller can count
 * each in a note and say which kind of exclusion it is looking at. `legacy` is
 * their union, which is what a caller wanting a single "excluded" count reads.
 *
 * @param {Array<Object>} attempts - From the recorder
 * @param {Object} [options]
 * @param {number} [options.fingerprintVersion] - Version to measure against
 * @returns {{current: Array<Object>, legacy: Array<Object>,
 *   legacyModel: Array<Object>, legacyFingerprint: Array<Object>}}
 */
export function splitModelCohorts(attempts, { fingerprintVersion = FINGERPRINT_VERSION } = {}) {
    const current = [];
    const legacy = [];
    const legacyModel = [];
    const legacyFingerprint = [];
    for (const attempt of attempts || []) {
        if (!attempt?.model?.fullKit) {
            legacy.push(attempt);
            legacyModel.push(attempt);
            continue;
        }
        if (!isCurrentFingerprintVersion(attempt, fingerprintVersion)) {
            legacy.push(attempt);
            legacyFingerprint.push(attempt);
            continue;
        }
        current.push(attempt);
    }
    return { current, legacy, legacyModel, legacyFingerprint };
}

/**
 * Which reliability band a probability falls into.
 * @param {number} p - 0..1
 * @returns {number} Index into {@link CALIBRATION_BANDS}, or -1 when p is not a probability
 */
export function calibrationBandIndex(p) {
    if (!Number.isFinite(p) || p < 0 || p > 1) return -1;
    for (let i = 0; i < CALIBRATION_BANDS.length; i++) {
        // Half-open bands, with the last closed so p = 1 has a home
        if (p < CALIBRATION_BANDS[i].high || i === CALIBRATION_BANDS.length - 1) return i;
    }
    return -1;
}

/**
 * The reliability report over one cohort of attempts.
 *
 * Only attempts carrying a stored prediction contribute — an attempt recorded
 * before its room was simmed has no claim to check. Per band: expected clears
 * (the sum of the stored probabilities), observed clears, and the count. The
 * Brier score is the mean of (p − outcome)²; the spread is the variance-based
 * one, Σ p(1−p), whose square root says how far observed is allowed to wander
 * from expected when every prediction is right — which is what `sigma` reads
 * the gap against.
 *
 * `enough` is the honest-degradation flag: below {@link MIN_CALIBRATION_FIGHTS}
 * judged fights the arithmetic still runs (the numbers are the numbers) but no
 * caller may present it as a verdict. It exists so a cohort thinned by a
 * fingerprint migration says "too few to call" rather than tempting a caller to
 * widen the cohort until the figure looks solid — which would mean pooling the
 * pre-migration records this split exists to keep out.
 *
 * @param {Array<Object>} attempts - One cohort, e.g. `splitModelCohorts().current`
 * @returns {{count: number, unpredicted: number, expected: number, observed: number,
 *   brier: number|null, variance: number, sd: number|null, sigma: number|null,
 *   enough: boolean, bands: Array<{label: string, low: number, high: number,
 *   count: number, expected: number, observed: number}>}}
 */
export function calibrationReport(attempts) {
    const bands = CALIBRATION_BANDS.map((band) => ({ ...band, count: 0, expected: 0, observed: 0 }));
    let count = 0;
    let unpredicted = 0;
    let expected = 0;
    let observed = 0;
    let brierSum = 0;
    let variance = 0;

    for (const attempt of attempts || []) {
        // Null is "no prediction stored", and Number(null) is 0 — a rate a room
        // can genuinely have — so the absence is rejected before the coercion
        const stored = attempt?.predicted;
        const p = stored === null || stored === undefined ? NaN : Number(stored);
        const index = calibrationBandIndex(p);
        if (index < 0) {
            unpredicted++;
            continue;
        }
        const outcome = attempt.cleared ? 1 : 0;
        count++;
        expected += p;
        observed += outcome;
        brierSum += (p - outcome) ** 2;
        variance += p * (1 - p);
        const band = bands[index];
        band.count++;
        band.expected += p;
        band.observed += outcome;
    }

    const sd = variance > 0 ? Math.sqrt(variance) : null;
    return {
        count,
        unpredicted,
        expected,
        observed,
        brier: count > 0 ? brierSum / count : null,
        variance,
        sd,
        sigma: sd ? (observed - expected) / sd : null,
        enough: count >= MIN_CALIBRATION_FIGHTS,
        bands,
    };
}

export default {
    CALIBRATION_BANDS,
    MIN_CALIBRATION_FIGHTS,
    splitModelCohorts,
    calibrationBandIndex,
    calibrationReport,
};
