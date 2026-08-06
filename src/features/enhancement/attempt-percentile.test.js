/**
 * The percentile read of a finished enhancement run.
 *
 * The tail must agree with the distribution the calculator quotes before a run
 * starts — same shifted-gamma fit, same parameters — so the fixtures here are
 * checked against `costExceedanceProbability` directly, and one case against a
 * chain whose distribution is known exactly (a single geometric level).
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import { calculateEnhancement, costStats, costExceedanceProbability } from '../../utils/enhancement-calculator.js';
import { attemptTailProbability, formatTailPercent, describeAttemptOutcome } from './attempt-percentile.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

/** A geometric single-level chain: mean 2, variance 2, minimum 1 attempt. */
const geometric = { expectedAttemptsExact: 2, attemptsVariance: 2, minAttempts: 1 };

describe('attemptTailProbability', () => {
    test('refuses a prediction that carries no distribution', () => {
        // A session recorded before the variance was stored has only a mean
        expect(attemptTailProbability({ expectedAttempts: 41 }, 63)).toBeNull();
        expect(attemptTailProbability(null, 63)).toBeNull();
        expect(attemptTailProbability(geometric, NaN)).toBeNull();
        expect(attemptTailProbability(geometric, -1)).toBeNull();
    });

    test('the physical minimum is certain to be reached', () => {
        // Every run takes at least one attempt, so "1 or more" is everybody
        expect(attemptTailProbability(geometric, 1)).toBe(1);
        expect(attemptTailProbability(geometric, 0)).toBe(1);
    });

    test('is monotone: longer runs are rarer', () => {
        const tails = [2, 4, 8, 16].map((observed) => attemptTailProbability(geometric, observed));
        for (let i = 1; i < tails.length; i++) {
            expect(tails[i]).toBeLessThan(tails[i - 1]);
        }
        expect(tails[tails.length - 1]).toBeGreaterThanOrEqual(0);
    });

    test('reads the same fitted distribution the cost percentiles use', () => {
        // One coin per attempt: the tail must be exactly what the cost model
        // says, or the pre-run p90 and the post-run percentile could disagree
        const expected = costExceedanceProbability(
            costStats({ attempts: 2, attemptsVariance: 2, minAttempts: 1 }, { costPerAttempt: 1 }),
            5
        );
        expect(attemptTailProbability(geometric, 5)).toBeCloseTo(expected, 12);
    });

    test('works off a real chain result end to end', () => {
        // Level at item level, no bonuses: +0 → +2 has mean 20/3, var 260/9
        const result = calculateEnhancement({
            enhancingLevel: 50,
            itemLevel: 50,
            toolBonus: 0,
            speedBonus: 0,
            targetLevel: 2,
        });
        const prediction = {
            expectedAttemptsExact: result.attempts,
            attemptsVariance: result.attemptsVariance,
            minAttempts: result.minAttempts,
        };

        const atMean = attemptTailProbability(prediction, result.attempts);
        // Right-skewed distribution: more than half of runs finish below the mean
        expect(atMean).toBeGreaterThan(0.2);
        expect(atMean).toBeLessThan(0.5);

        // A run three standard deviations out is rare but not impossible
        const deepTail = attemptTailProbability(prediction, result.attempts + 3 * result.attemptsStdDev);
        expect(deepTail).toBeGreaterThan(0);
        expect(deepTail).toBeLessThan(0.05);
    });
});

describe('formatTailPercent', () => {
    test('rounds to whole percent and caps the extremes', () => {
        expect(formatTailPercent(0.083)).toBe('8%');
        expect(formatTailPercent(0.5)).toBe('50%');
        expect(formatTailPercent(0.004)).toBe('<1%');
        expect(formatTailPercent(0.999)).toBe('>99%');
        expect(formatTailPercent(1)).toBe('>99%');
    });
});

describe('describeAttemptOutcome', () => {
    test('says the observation as one sentence', () => {
        expect(describeAttemptOutcome(41, 63, 0.08)).toBe(
            'Predicted 41 attempts, took 63 — 8% of runs take that many or more.'
        );
    });

    test('reads honestly for a lucky run too', () => {
        expect(describeAttemptOutcome(41, 25, 0.9)).toBe(
            'Predicted 41 attempts, took 25 — 90% of runs take that many or more.'
        );
    });
});
