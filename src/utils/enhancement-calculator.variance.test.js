/**
 * Tests for the spread side of the enhancement chain.
 *
 * The mean attempt count has fixtures in enhancement-calculator.test.js. This file pins the
 * second moment — `absorptionVariance`, the cost model built on it, and the fitted percentiles —
 * because that half was only ever checked by an uncommitted Monte Carlo, and a variance that is
 * quietly wrong reads as a confident number rather than as an error.
 *
 * Every fixture below is solved by hand from the transition probabilities, using the
 * second-moment recursion
 *
 *   s = 1 + 2·Q·m + Q·s,        var_i = s_i − m_i²
 *
 * which is a different route to the answer than the implementation's (2M − I)·t − t∘t. Two
 * derivations that agree is evidence; one derivation restated is not.
 *
 * The chain, at success multiplier 1 (enhancing level exactly at item level, no tool bonus):
 *   +1 succeeds 50% of the time, +2 and +3 succeed 45%.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import {
    calculateEnhancement,
    buildEnhancementMarkov,
    absorptionVariance,
    costStats,
    costPercentiles,
    costExceedanceProbability,
    BASE_SUCCESS_RATES,
} from './enhancement-calculator.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

/** Level exactly at item level and no tool bonus, so the success multiplier is exactly 1. */
const base = {
    enhancingLevel: 50,
    itemLevel: 50,
    toolBonus: 0,
    speedBonus: 0,
};

describe('absorptionVariance against hand-solved chains', () => {
    test('a single level is a geometric wait, so the variance is q/p²', () => {
        // Target +1 only. One transient state, success 1/2, failure returns to itself.
        // T ~ Geometric(1/2): mean 1/p = 2, var = q/p² = (1/2)/(1/4) = 2.
        //
        // The same through the fundamental matrix: Q = [1/2], M = (I − Q)^-1 = [2], t = [2].
        // (2M − I)·t = (4 − 1)·2 = 6, and 6 − 2² = 2.
        const result = calculateEnhancement({ ...base, targetLevel: 1 });

        expect(result.attempts).toBeCloseTo(2, 9);
        expect(result.attemptsVariance).toBeCloseTo(2, 9);
        expect(result.attemptsStdDev).toBeCloseTo(Math.SQRT2, 9);
    });

    test('+0 → +2 matches the hand-solved second moment', () => {
        // Transient states {0, 1}, absorbing 2. Failure anywhere drops to 0.
        //   Q = [[1/2, 1/2],
        //        [11/20,  0]]
        //   det(I − Q) = (1/2)(1) − (−1/2)(−11/20) = 1/2 − 11/40 = 9/40
        //   M = (40/9)·[[1, 1/2], [11/20, 1/2]] = [[40/9, 20/9], [22/9, 20/9]]
        //   t = M·1 = [60/9, 42/9] = [20/3, 14/3]
        //
        // Second moments, from s = 1 + 2·Q·m + Q·s:
        //   s0 = 1 + (m0 + m1) + (s0 + s1)/2
        //   s1 = 1 + (11/10)·m0 + (11/20)·s0        (a success from +1 absorbs, contributing 0)
        // Substituting m0 = 20/3, m1 = 14/3:
        //   s1 = 25/3 + (11/20)·s0
        //   s0/2 = 1 + 34/3 + (1/2)(25/3 + (11/20)s0)  ⇒  s0·(9/40) = 33/2  ⇒  s0 = 220/3
        //   var0 = 220/3 − (20/3)² = 660/9 − 400/9 = 260/9 ≈ 28.8889
        const result = calculateEnhancement({ ...base, targetLevel: 2 });

        expect(result.attempts).toBeCloseTo(20 / 3, 9);
        expect(result.attemptsVariance).toBeCloseTo(260 / 9, 9);
        expect(result.attemptsStdDev).toBeCloseTo(Math.sqrt(260 / 9), 9);
    });

    test('starting at +1 has its own variance, read off the same matrix', () => {
        // Same chain, started from +1.
        //   s1 = 25/3 + (11/20)·s0 = 25/3 + (11/20)(220/3) = 25/3 + 121/3 = 146/3
        //   var1 = 146/3 − (14/3)² = 438/9 − 196/9 = 242/9 ≈ 26.8889
        //
        // Slightly less spread than starting from +0 — one fewer coin flip — but not much, because
        // a failure at +1 throws the run all the way back to +0 either way.
        const result = calculateEnhancement({ ...base, targetLevel: 2, startLevel: 1 });

        expect(result.attempts).toBeCloseTo(14 / 3, 9);
        expect(result.attemptsVariance).toBeCloseTo(242 / 9, 9);
    });

    test('a protected three-level chain matches the hand-solved system', () => {
        // Target +3, protecting from +2, so a failure at +2 falls to +1 and everything below
        // falls to +0. Success rates 1/2, 9/20, 9/20.
        //
        // Means:  m0 = 1 + (1/2)m0 + (1/2)m1        ⇒ m0 = 2 + m1
        //         m2 = 1 + (11/20)m1
        //         m1 = 1 + (11/20)m0 + (9/20)m2
        //            = 1 + (11/20)(2 + m1) + (9/20)(1 + (11/20)m1)
        //            = 51/20 + (319/400)m1          ⇒ m1·(81/400) = 1020/400
        //         m1 = 1020/81 = 340/27,  m0 = 394/27,  m2 = 214/27
        //
        // Second moments, s = 1 + 2·Q·m + Q·s:
        //         s0 = 1 + (m0 + m1) + (s0 + s1)/2                  ⇒ s0 = 1522/27 + s1
        //         s2 = 1 + (11/10)m1 + (11/20)s1 = 401/27 + (11/20)s1
        //         s1 = 1 + (626/27) + (11/20)s0 + (9/20)s2
        //            ⇒ s1·(301/400) = 16669/540 + (11/20)s0
        //            substituting s0:  s1·(81/400) = 33411/540  ⇒ s1 = 222740/729
        //         s0 = 1522/27 + 222740/729 = 263834/729
        //         var0 = 263834/729 − (394/27)² = (263834 − 155236)/729 = 108598/729 ≈ 148.9684
        const result = calculateEnhancement({ ...base, targetLevel: 3, protectFrom: 2 });

        expect(result.attempts).toBeCloseTo(394 / 27, 9);
        expect(result.attemptsVariance).toBeCloseTo(108598 / 729, 6);
    });

    test('the protected chain started at +2 matches its own hand-solved variance', () => {
        //         s2 = 401/27 + (11/20)(222740/729) = 133334/729
        //         var2 = 133334/729 − (214/27)² = (133334 − 45796)/729 = 87538/729 ≈ 120.0796
        //
        // Worth reading: the mean from +2 is 214/27 ≈ 7.9 attempts, and the standard deviation is
        // about 11. The run that "takes eight tries" routinely takes thirty.
        const result = calculateEnhancement({ ...base, targetLevel: 3, protectFrom: 2, startLevel: 2 });

        expect(result.attempts).toBeCloseTo(214 / 27, 9);
        expect(result.attemptsVariance).toBeCloseTo(87538 / 729, 6);
        expect(result.attemptsStdDev).toBeGreaterThan(result.attempts);
    });

    test('it reads any object exposing .get([i, j]), not just a math.js matrix', () => {
        // The worker pools hand it whatever their math build produced; the contract is the accessor
        const rows = [
            [40 / 9, 20 / 9],
            [22 / 9, 20 / 9],
        ];
        const M = { get: ([i, j]) => rows[i][j] };

        expect(absorptionVariance(M, 2, 0)).toBeCloseTo(260 / 9, 9);
        expect(absorptionVariance(M, 2, 1)).toBeCloseTo(242 / 9, 9);
    });

    test('the default start level is +0', () => {
        const rows = [
            [40 / 9, 20 / 9],
            [22 / 9, 20 / 9],
        ];
        const M = { get: ([i, j]) => rows[i][j] };

        expect(absorptionVariance(M, 2)).toBeCloseTo(absorptionVariance(M, 2, 0), 12);
    });
});

describe('degenerate chains have no spread', () => {
    test('a certain success takes exactly one attempt, every time', () => {
        // 4000 levels above the item is a ×3 multiplier, so +1 clamps to 100%
        const result = calculateEnhancement({ ...base, enhancingLevel: 4050, targetLevel: 1 });

        expect(result.attempts).toBeCloseTo(1, 9);
        expect(result.attemptsVariance).toBe(0);
        expect(result.attemptsStdDev).toBe(0);
    });

    test('a chain of certain successes is deterministic at every level', () => {
        const result = calculateEnhancement({ ...base, enhancingLevel: 4050, targetLevel: 5 });

        expect(result.attempts).toBeCloseTo(5, 9);
        expect(result.attemptsVariance).toBe(0);
        expect(result.attempts).toBeCloseTo(result.minAttempts, 9);
    });

    test('variance is never negative, however the arithmetic rounds', () => {
        // A near-deterministic run is where the subtraction cancels hardest
        for (const targetLevel of [1, 2, 3, 5, 10]) {
            const result = calculateEnhancement({ ...base, enhancingLevel: 4050, targetLevel });
            expect(result.attemptsVariance).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('variance responds to the chain the way it should', () => {
    test('a longer climb is both slower and more uncertain', () => {
        let previousMean = -Infinity;
        let previousVariance = -Infinity;

        for (const targetLevel of [1, 2, 3, 4, 5, 6]) {
            const result = calculateEnhancement({ ...base, targetLevel });
            expect(result.attempts).toBeGreaterThan(previousMean);
            expect(result.attemptsVariance).toBeGreaterThan(previousVariance);
            previousMean = result.attempts;
            previousVariance = result.attemptsVariance;
        }
    });

    test('protection cuts the spread far harder than it cuts the mean', () => {
        // This is the whole argument for buying protection, and it is invisible in the mean alone
        const bare = calculateEnhancement({ ...base, targetLevel: 6 });
        const protectedRun = calculateEnhancement({ ...base, targetLevel: 6, protectFrom: 2 });

        expect(protectedRun.attempts).toBeLessThan(bare.attempts);
        expect(protectedRun.attemptsVariance).toBeLessThan(bare.attemptsVariance);

        const meanRatio = protectedRun.attempts / bare.attempts;
        const varianceRatio = protectedRun.attemptsVariance / bare.attemptsVariance;
        expect(varianceRatio).toBeLessThan(meanRatio);
    });

    test('the standard deviation of an unprotected climb is on the order of its mean', () => {
        // The claim the module's own comment makes: a run averaging N attempts is not a run that
        // takes N attempts. If this ever stops holding, the fitted cost distribution below is
        // being fed something it was not designed for.
        const result = calculateEnhancement({ ...base, targetLevel: 8 });
        const ratio = result.attemptsStdDev / result.attempts;

        expect(ratio).toBeGreaterThan(0.5);
        expect(ratio).toBeLessThan(2);
    });
});

describe('Monte Carlo cross-check of the closed form', () => {
    /** Deterministic PRNG, so a failure here is reproducible rather than a flake. */
    function mulberry32(seed) {
        let a = seed;
        return function next() {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /**
     * Walk the chain to absorption and report the sample mean and variance of the step count.
     * @param {Object} markov - Transition matrix from buildEnhancementMarkov
     * @param {number} targetLevel - Absorbing state
     * @param {number} samples - Runs to simulate
     * @param {number} seed - PRNG seed
     * @returns {{mean: number, variance: number}}
     */
    function simulate(markov, targetLevel, samples, seed) {
        const random = mulberry32(seed);

        // Cumulative transition rows, so a draw is one linear scan
        const cumulative = [];
        for (let i = 0; i < targetLevel; i++) {
            const row = [];
            let running = 0;
            for (let j = 0; j <= targetLevel; j++) {
                running += markov.get([i, j]);
                row.push(running);
            }
            cumulative.push(row);
        }

        let sum = 0;
        let sumOfSquares = 0;
        for (let run = 0; run < samples; run++) {
            let state = 0;
            let steps = 0;
            while (state !== targetLevel) {
                const draw = random();
                const row = cumulative[state];
                let next = 0;
                while (next < targetLevel && draw > row[next]) next++;
                state = next;
                steps++;
            }
            sum += steps;
            sumOfSquares += steps * steps;
        }

        const mean = sum / samples;
        return { mean, variance: sumOfSquares / samples - mean * mean };
    }

    const chain = (options) =>
        buildEnhancementMarkov(mathjs, {
            baseSuccessRates: BASE_SUCCESS_RATES,
            successMultiplier: 1,
            ...options,
        });

    test('simulating +0 → +2 reproduces the closed-form mean and variance', () => {
        // 200k runs puts the sampling error on the variance near half a percent; the 5% band is
        // wide enough that only a real formula change trips it, and the seed makes it repeatable.
        const sampled = simulate(chain({ targetLevel: 2 }), 2, 200_000, 12345);

        expect(sampled.mean).toBeCloseTo(20 / 3, 1);
        expect(Math.abs(sampled.variance - 260 / 9) / (260 / 9)).toBeLessThan(0.05);
    });

    test('simulating the protected three-level chain reproduces it too', () => {
        const expectedVariance = 108598 / 729;
        const sampled = simulate(chain({ targetLevel: 3, protectFrom: 2 }), 3, 200_000, 12345);

        expect(sampled.mean).toBeCloseTo(394 / 27, 0);
        expect(Math.abs(sampled.variance - expectedVariance) / expectedVariance).toBeLessThan(0.05);
    });
});

describe('costStats', () => {
    const attempts = { attempts: 10, attemptsVariance: 25, minAttempts: 3 };

    test('cost is the attempt count scaled and shifted', () => {
        const cost = costStats(attempts, { costPerAttempt: 1000, fixedCost: 50_000 });

        expect(cost.expected).toBe(60_000);
        // var(a + bX) = b²·var(X) — the shift drops out
        expect(cost.variance).toBe(25 * 1000 * 1000);
        expect(cost.stdDev).toBe(5000);
        expect(cost.minimum).toBe(53_000);
    });

    test('the fixed cost moves the mean and the floor but never the spread', () => {
        const cheap = costStats(attempts, { costPerAttempt: 1000, fixedCost: 0 });
        const dear = costStats(attempts, { costPerAttempt: 1000, fixedCost: 1_000_000 });

        expect(dear.expected - cheap.expected).toBe(1_000_000);
        expect(dear.minimum - cheap.minimum).toBe(1_000_000);
        expect(dear.variance).toBe(cheap.variance);
        expect(dear.stdDev).toBe(cheap.stdDev);
    });

    test('a negative per-attempt cost still yields a positive standard deviation', () => {
        // A "cost" can come out negative when the caller nets revenue into it; a signed stdDev
        // would poison every band drawn from it
        const cost = costStats(attempts, { costPerAttempt: -1000 });

        expect(cost.stdDev).toBe(5000);
        expect(cost.variance).toBe(25_000_000);
    });

    test('missing, unparseable, or negative inputs collapse to zero rather than NaN', () => {
        expect(costStats(null)).toEqual({ expected: 0, variance: 0, stdDev: 0, minimum: 0 });
        expect(costStats({ attempts: 'lots' }, { costPerAttempt: 'some' })).toEqual({
            expected: 0,
            variance: 0,
            stdDev: 0,
            minimum: 0,
        });
        expect(costStats({ attempts: 4, attemptsVariance: -9, minAttempts: -2 }, { costPerAttempt: 10 })).toEqual({
            expected: 40,
            variance: 0,
            stdDev: 0,
            minimum: 0,
        });
    });
});

describe('costPercentiles', () => {
    const run = () => calculateEnhancement({ ...base, targetLevel: 5 });
    const priced = () => costStats(run(), { costPerAttempt: 1000, fixedCost: 50_000 });

    test('percentiles come out in order', () => {
        const percentiles = costPercentiles(priced());

        expect(percentiles.p10).toBeLessThan(percentiles.p50);
        expect(percentiles.p50).toBeLessThan(percentiles.p90);
    });

    test('the order holds across the whole range, not just the three quoted', () => {
        const cost = priced();
        const probabilities = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];
        const { values } = costPercentiles(cost, probabilities);

        for (let i = 1; i < values.length; i++) {
            expect(values[i].cost).toBeGreaterThan(values[i - 1].cost);
        }
    });

    test('nothing is quoted below the cheapest run physically possible', () => {
        const cost = priced();
        const { values } = costPercentiles(cost, [0.001, 0.01, 0.1]);

        // 5 levels at 1000 each plus the 50k item; a normal fit would put p10 below zero here
        expect(cost.minimum).toBe(55_000);
        for (const entry of values) {
            expect(entry.cost).toBeGreaterThanOrEqual(cost.minimum);
        }
    });

    test('the fit is skewed right, as an enhancement run is', () => {
        const percentiles = costPercentiles(priced());
        const cost = priced();

        // The median sits below the mean and the upper tail is the longer one
        expect(percentiles.p50).toBeLessThan(cost.expected);
        expect(percentiles.p90 - percentiles.p50).toBeGreaterThan(percentiles.p50 - percentiles.p10);
    });

    test('a near-symmetric fit puts the median on the mean', () => {
        // Large shape (spread²/variance) is where the gamma tends to a normal, so the
        // Wilson–Hilferty median should land on the mean. Shape 5000 here.
        const cost = { expected: 100_000, minimum: 0, variance: (100_000 * 100_000) / 5000 };
        const percentiles = costPercentiles(cost);

        expect(percentiles.p50 / cost.expected).toBeCloseTo(1, 3);
        // and symmetric about it, to the same order
        const below = cost.expected - percentiles.p10;
        const above = percentiles.p90 - cost.expected;
        expect(above / below).toBeCloseTo(1, 1);
    });

    test('the median approaches the mean as the spread shrinks', () => {
        const ratios = [50, 500, 5000].map((shape) => {
            const cost = { expected: 100_000, minimum: 0, variance: (100_000 * 100_000) / shape };
            return Math.abs(costPercentiles(cost).p50 / cost.expected - 1);
        });

        expect(ratios[1]).toBeLessThan(ratios[0]);
        expect(ratios[2]).toBeLessThan(ratios[1]);
    });

    test('a run with no spread costs what it costs at every percentile', () => {
        const cost = costStats({ attempts: 2, attemptsVariance: 0, minAttempts: 2 }, { costPerAttempt: 1000 });
        const percentiles = costPercentiles(cost, [0.01, 0.1, 0.5, 0.9, 0.99]);

        for (const entry of percentiles.values) {
            expect(entry.cost).toBe(cost.expected);
        }
    });

    test('a deterministic enhancement quotes one price end to end', () => {
        const certain = calculateEnhancement({ ...base, enhancingLevel: 4050, targetLevel: 5 });
        const cost = costStats(certain, { costPerAttempt: 1000, fixedCost: 50_000 });
        const percentiles = costPercentiles(cost);

        expect(cost.variance).toBe(0);
        expect(percentiles.p10).toBe(percentiles.p90);
        expect(percentiles.p50).toBeCloseTo(55_000, 6);
    });

    test('probabilities outside (0, 1) fall back to the mean instead of ±∞', () => {
        const percentiles = costPercentiles(priced(), [0, 1, 0.5]);

        expect(percentiles.p0).toBe(priced().expected);
        expect(percentiles.p100).toBe(priced().expected);
        expect(percentiles.p50).toBeLessThan(percentiles.p0);
    });

    test('named fields exist only for the probabilities that were asked for', () => {
        const percentiles = costPercentiles(priced(), [0.25, 0.75]);

        expect(percentiles.p25).toBeDefined();
        expect(percentiles.p75).toBeDefined();
        expect(percentiles.p10).toBeUndefined();
        expect(percentiles.p50).toBeUndefined();
        expect(percentiles.values.map((v) => v.p)).toEqual([0.25, 0.75]);
    });
});

describe('costExceedanceProbability', () => {
    const priced = () => costStats(calculateEnhancement({ ...base, targetLevel: 5 }), { costPerAttempt: 1000 });

    test('it inverts costPercentiles: the chance of exceeding pN is 1 − N', () => {
        // The two read the same fitted distribution from opposite ends. If they ever disagree,
        // one of them has been re-derived and the other has not.
        const cost = priced();
        const percentiles = costPercentiles(cost, [0.1, 0.5, 0.9]);

        for (const p of [0.1, 0.5, 0.9]) {
            const quoted = percentiles[`p${p * 100}`];
            expect(costExceedanceProbability(cost, quoted)).toBeCloseTo(1 - p, 5);
        }
    });

    test('it falls monotonically as the threshold rises', () => {
        const cost = priced();
        let previous = Infinity;

        for (const threshold of [0, 20_000, 60_000, 120_000, 250_000, 1_000_000]) {
            const probability = costExceedanceProbability(cost, threshold);
            expect(probability).toBeLessThanOrEqual(previous);
            previous = probability;
        }
    });

    test('a threshold at or below the cheapest possible run is certain to be exceeded', () => {
        const cost = priced();

        expect(costExceedanceProbability(cost, cost.minimum)).toBe(1);
        expect(costExceedanceProbability(cost, cost.minimum - 1)).toBe(1);
        expect(costExceedanceProbability(cost, 0)).toBe(1);
    });

    test('a deterministic run answers yes or no, not a probability', () => {
        const cost = costStats({ attempts: 2, attemptsVariance: 0, minAttempts: 2 }, { costPerAttempt: 1000 });

        expect(costExceedanceProbability(cost, 1999)).toBe(1);
        expect(costExceedanceProbability(cost, 2000)).toBe(0);
        expect(costExceedanceProbability(cost, 2001)).toBe(0);
    });

    test('the answer always stays a probability', () => {
        const cost = priced();

        for (const threshold of [-5_000_000, 0, 1, 1e12, Infinity]) {
            const probability = costExceedanceProbability(cost, threshold);
            expect(probability).toBeGreaterThanOrEqual(0);
            expect(probability).toBeLessThanOrEqual(1);
        }
    });

    test('a near-symmetric fit is a coin flip at its own mean', () => {
        const cost = { expected: 100_000, minimum: 0, variance: (100_000 * 100_000) / 5000 };

        expect(costExceedanceProbability(cost, cost.expected)).toBeCloseTo(0.5, 2);
    });

    test('an enhancement run is more likely than not to come in under its mean', () => {
        // The practical consequence of the right skew, and the reason quoting only the mean
        // misleads in both directions at once
        const cost = priced();

        expect(costExceedanceProbability(cost, cost.expected)).toBeLessThan(0.5);
    });
});

describe('buildEnhancementMarkov survives the worker blob round trip', () => {
    /**
     * Rebuild the function the way enhancement-worker-manager does: interpolate its source into a
     * script and evaluate that. `new Function` gives it exactly the worker's scope — the module's
     * imports and module-scope constants are not in it.
     */
    function reconstruct() {
        return new Function(
            'math',
            'options',
            `const buildEnhancementMarkov = ${buildEnhancementMarkov.toString()};
             return buildEnhancementMarkov(math, options);`
        );
    }

    test('the serialised source compiles outside the module', () => {
        expect(() => reconstruct()).not.toThrow();
    });

    const shapes = [
        ['plain climb', { targetLevel: 5, successMultiplier: 1 }],
        ['with protection', { targetLevel: 6, successMultiplier: 1, protectFrom: 3 }],
        ['with blessed tea', { targetLevel: 6, successMultiplier: 1, blessedTea: true, blessedTeaBonus: 0.05 }],
        [
            'blessed tea and guzzling',
            { targetLevel: 8, successMultiplier: 1.2, blessedTea: true, blessedTeaBonus: 0.02, guzzlingBonus: 1.5 },
        ],
        ['clamped success', { targetLevel: 4, successMultiplier: 3 }],
    ];

    test.each(shapes)('the rebuilt chain is entry-for-entry the module chain (%s)', (_label, overrides) => {
        const options = { baseSuccessRates: BASE_SUCCESS_RATES, ...overrides };
        const direct = buildEnhancementMarkov(mathjs, options);
        const viaWorker = reconstruct()(mathjs, options);

        for (let i = 0; i < 20; i++) {
            for (let j = 0; j < 20; j++) {
                expect(viaWorker.get([i, j])).toBeCloseTo(direct.get([i, j]), 12);
            }
        }
    });

    test('the rebuilt chain feeds the same variance as the module one', () => {
        // The end-to-end claim: a worker computing off the serialised chain reports what the
        // main thread would have.
        const options = { baseSuccessRates: BASE_SUCCESS_RATES, successMultiplier: 1, targetLevel: 3, protectFrom: 2 };
        const viaWorker = reconstruct()(mathjs, options);

        const Q = viaWorker.subset(mathjs.index(mathjs.range(0, 3), mathjs.range(0, 3)));
        const M = mathjs.inv(mathjs.subtract(mathjs.identity(3), Q));

        expect(absorptionVariance(M, 3, 0)).toBeCloseTo(108598 / 729, 6);
    });
});
