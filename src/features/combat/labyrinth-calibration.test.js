/**
 * The calibration set is per-attempt: a stored prediction and a yes/no outcome.
 * These pin the cohort split (legacy attempts counted, never pooled), the band
 * edges, and the Brier and sigma arithmetic.
 */

import { describe, test, expect } from 'vitest';
import {
    CALIBRATION_BANDS,
    MIN_CALIBRATION_FIGHTS,
    splitModelCohorts,
    calibrationBandIndex,
    calibrationReport,
} from './labyrinth-calibration.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

const attempt = (predicted, cleared, over = {}) => ({
    predicted,
    cleared,
    model: { fullKit: true, version: '4.0.0' },
    fingerprintVersion: FINGERPRINT_VERSION,
    ...over,
});

/** An attempt recorded before the model marker existed */
const legacyAttempt = (predicted, cleared) => ({ predicted, cleared });

/** Recorded under the current sim model but the gear-only fingerprint */
const oldFingerprintAttempt = (predicted, cleared) => ({
    predicted,
    cleared,
    model: { fullKit: true, version: '4.0.0' },
});

describe('splitModelCohorts', () => {
    test('attempts without the marker are the legacy cohort, kept apart', () => {
        const { current, legacy } = splitModelCohorts([
            attempt(0.5, true),
            legacyAttempt(0.5, false),
            attempt(0.2, false),
        ]);
        expect(current).toHaveLength(2);
        expect(legacy).toHaveLength(1);
        expect(legacy[0].model).toBeUndefined();
    });

    test('a marker without fullKit is not the current model either', () => {
        const { current, legacy } = splitModelCohorts([attempt(0.5, true, { model: { fullKit: false } })]);
        expect(current).toHaveLength(0);
        expect(legacy).toHaveLength(1);
    });

    test('handles an empty pool', () => {
        const empty = { current: [], legacy: [], legacyModel: [], legacyFingerprint: [] };
        expect(splitModelCohorts([])).toEqual(empty);
        expect(splitModelCohorts(null)).toEqual(empty);
    });

    test('an attempt from an older fingerprint is legacy however current its model', () => {
        const { current, legacy, legacyModel, legacyFingerprint } = splitModelCohorts([
            attempt(0.5, true),
            oldFingerprintAttempt(0.5, false),
        ]);
        expect(current).toHaveLength(1);
        expect(legacy).toHaveLength(1);
        // Named apart: this one is excluded by its fingerprint, not its model
        expect(legacyModel).toHaveLength(0);
        expect(legacyFingerprint).toHaveLength(1);
    });

    test('the two exclusions are counted separately and never double-counted', () => {
        const { legacy, legacyModel, legacyFingerprint } = splitModelCohorts([
            legacyAttempt(0.5, true),
            oldFingerprintAttempt(0.5, true),
            attempt(0.5, true),
        ]);
        expect(legacyModel).toHaveLength(1);
        expect(legacyFingerprint).toHaveLength(1);
        // `legacy` is their union, which is what a single "excluded" count reads
        expect(legacy).toHaveLength(legacyModel.length + legacyFingerprint.length);
    });

    test('a future fingerprint version is no more poolable than a past one', () => {
        // The split asks whether the version MATCHES, not whether it is older:
        // a record written by a newer build that synced across is not evidence
        // about a fingerprint this build cannot compute
        const { current, legacyFingerprint } = splitModelCohorts([
            attempt(0.5, true, { fingerprintVersion: FINGERPRINT_VERSION + 1 }),
        ]);
        expect(current).toHaveLength(0);
        expect(legacyFingerprint).toHaveLength(1);
    });
});

describe('calibrationBandIndex', () => {
    test('bands are half-open, so a boundary belongs to the band above it', () => {
        expect(calibrationBandIndex(0)).toBe(0);
        expect(calibrationBandIndex(0.099)).toBe(0);
        expect(calibrationBandIndex(0.1)).toBe(1);
        expect(calibrationBandIndex(0.3)).toBe(2);
        expect(calibrationBandIndex(0.7)).toBe(3);
        expect(calibrationBandIndex(0.9)).toBe(4);
    });

    test('a certain clear still has a band', () => {
        expect(calibrationBandIndex(1)).toBe(CALIBRATION_BANDS.length - 1);
    });

    test('a non-probability has none', () => {
        expect(calibrationBandIndex(null)).toBe(-1);
        expect(calibrationBandIndex(NaN)).toBe(-1);
        expect(calibrationBandIndex(-0.1)).toBe(-1);
        expect(calibrationBandIndex(1.2)).toBe(-1);
    });
});

describe('calibrationReport', () => {
    test('each band accumulates its count, expected clears and observed clears', () => {
        const report = calibrationReport([
            attempt(0.05, false),
            attempt(0.05, false),
            attempt(0.8, true),
            attempt(0.85, false),
        ]);
        const low = report.bands[0];
        expect(low).toMatchObject({ count: 2, observed: 0 });
        expect(low.expected).toBeCloseTo(0.1, 10);

        const high = report.bands[3]; // 70–90%
        expect(high).toMatchObject({ count: 2, observed: 1 });
        expect(high.expected).toBeCloseTo(1.65, 10);

        expect(report.count).toBe(4);
        expect(report.expected).toBeCloseTo(1.75, 10);
        expect(report.observed).toBe(1);
    });

    test('the Brier score is the mean of (p − outcome)²', () => {
        // (0.8, clear) → 0.04; (0.8, loss) → 0.64; (0.2, loss) → 0.04
        const report = calibrationReport([attempt(0.8, true), attempt(0.8, false), attempt(0.2, false)]);
        expect(report.brier).toBeCloseTo((0.04 + 0.64 + 0.04) / 3, 10);
    });

    test('sigma reads the gap against the variance-based spread, Σ p(1−p)', () => {
        // 25 coin-toss rooms, all lost: expected 12.5, variance 6.25, sd 2.5
        const report = calibrationReport(Array.from({ length: 25 }, () => attempt(0.5, false)));
        expect(report.variance).toBeCloseTo(6.25, 10);
        expect(report.sd).toBeCloseTo(2.5, 10);
        expect(report.sigma).toBeCloseTo(-5, 10);
    });

    test('attempts without a stored prediction are counted, not scored', () => {
        const report = calibrationReport([attempt(null, true), attempt(0.5, true)]);
        expect(report.count).toBe(1);
        expect(report.unpredicted).toBe(1);
        expect(report.observed).toBe(1);
    });

    test('an empty cohort reads as nothing, not as NaN', () => {
        const report = calibrationReport([]);
        expect(report.count).toBe(0);
        expect(report.brier).toBeNull();
        expect(report.sd).toBeNull();
        expect(report.sigma).toBeNull();
    });
});

describe('cohort exclusion end to end', () => {
    test('a legacy record is excluded from the headline figures and counted for the note', () => {
        const pool = [
            attempt(0.5, true),
            attempt(0.5, false),
            // A legacy fight with a prediction from the old model must not move
            // the expected total, however confident it looks
            legacyAttempt(0.95, true),
        ];
        const { current, legacy } = splitModelCohorts(pool);
        const report = calibrationReport(current);

        expect(report.count).toBe(2);
        expect(report.expected).toBeCloseTo(1, 10);
        expect(report.observed).toBe(1);
        expect(legacy).toHaveLength(1);
    });

    test('a level-up cohort is not rescued by pooling the fights that came before it', () => {
        // What the migration is for. Forty fights on the old fingerprint would
        // make a confident reading; three on the new one must not borrow them.
        const pool = [
            ...Array.from({ length: 40 }, () => oldFingerprintAttempt(0.5, false)),
            attempt(0.5, true),
            attempt(0.5, false),
            attempt(0.5, true),
        ];
        const { current, legacyFingerprint } = splitModelCohorts(pool);
        const report = calibrationReport(current);

        expect(report.count).toBe(3);
        expect(legacyFingerprint).toHaveLength(40);
        // Too few to call, rather than a verdict built on the old character
        expect(report.enough).toBe(false);
    });

    test('the current cohort reports a verdict once it is big enough to be one', () => {
        const report = calibrationReport(Array.from({ length: MIN_CALIBRATION_FIGHTS }, () => attempt(0.5, true)));
        expect(report.count).toBe(MIN_CALIBRATION_FIGHTS);
        expect(report.enough).toBe(true);
    });

    test('one fight short is still too few', () => {
        const report = calibrationReport(Array.from({ length: MIN_CALIBRATION_FIGHTS - 1 }, () => attempt(0.5, true)));
        expect(report.enough).toBe(false);
    });

    test('an attempt with no stored prediction does not count toward "enough"', () => {
        // `predicted: null` is rejected before coercion — Number(null) is 0,
        // which is a rate a room can genuinely have — so these are unpredicted,
        // not a band-zero cohort padding the count toward a verdict
        const report = calibrationReport(Array.from({ length: MIN_CALIBRATION_FIGHTS }, () => attempt(null, true)));
        expect(report.count).toBe(0);
        expect(report.unpredicted).toBe(MIN_CALIBRATION_FIGHTS);
        expect(report.enough).toBe(false);
    });
});
