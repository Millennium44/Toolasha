import { describe, test, expect } from 'vitest';
import {
    wilsonHalfWidth,
    wilsonInterval,
    hasConverged,
    decidedAgainst,
    isStoppingRule,
    trialsNeeded,
    Z_95,
} from './wilson.js';

describe('wilsonHalfWidth', () => {
    test('matches the published figures', () => {
        // 50/100 → Wilson 95% interval is 40.4%..59.6%
        const half = wilsonHalfWidth(50, 100);
        expect(half).toBeCloseTo(0.09617, 5);

        const { low, high } = wilsonInterval(50, 100);
        expect(low).toBeCloseTo(0.4038, 4);
        expect(high).toBeCloseTo(0.5962, 4);
    });

    test('narrows with the square root of the trials', () => {
        const at100 = wilsonHalfWidth(50, 100);
        const at400 = wilsonHalfWidth(200, 400);
        expect(at400 / at100).toBeCloseTo(0.5, 1);
    });

    test('keeps a real interval at the ends, where the normal one collapses', () => {
        // 0 wins in 300: the textbook interval is 0 ± 0, which claims certainty
        // a sample of 300 cannot support
        const half = wilsonHalfWidth(0, 300);
        expect(half).toBeGreaterThan(0);
        const { low, high } = wilsonInterval(0, 300);
        expect(low).toBeCloseTo(0, 12);
        expect(high).toBeGreaterThan(0);
        expect(high).toBeLessThan(0.02);
    });

    test('has nothing to say about no trials', () => {
        expect(wilsonHalfWidth(0, 0)).toBe(Infinity);
        expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1, halfWidth: Infinity });
    });

    test('survives impossible input rather than returning a NaN', () => {
        expect(wilsonHalfWidth(500, 100)).toBe(wilsonHalfWidth(100, 100));
        expect(wilsonHalfWidth(-5, 100)).toBe(wilsonHalfWidth(0, 100));
    });
});

describe('hasConverged', () => {
    const rule = { targetHalfWidth: 0.01, minTrials: 50, maxTrials: 20000 };

    test('a settled room stops long before a marginal one', () => {
        // Never once won: the interval is tight almost immediately
        expect(hasConverged(0, 400, rule)).toBe(true);
        // A coin toss needs thousands to pin to ±1 point
        expect(hasConverged(200, 400, rule)).toBe(false);
        expect(hasConverged(4800, 9600, rule)).toBe(true);
    });

    test('the floor outranks the target', () => {
        // 0/40 is inside ±5 points on its own account, but 40 trials is a
        // thinner basis than the run was told to accept
        const loose = { targetHalfWidth: 0.05, maxTrials: 20000 };
        expect(hasConverged(0, 40, { ...loose, minTrials: 50 })).toBe(false);
        expect(hasConverged(0, 40, { ...loose, minTrials: 10 })).toBe(true);
    });

    test('the cap outranks everything', () => {
        expect(hasConverged(10, 20, { targetHalfWidth: 0.001, minTrials: 500, maxTrials: 20 })).toBe(true);
    });

    test('no target means precision never stops the run', () => {
        expect(hasConverged(0, 5000, { minTrials: 50 })).toBe(false);
        expect(hasConverged(0, 5000, { targetHalfWidth: 0, minTrials: 50 })).toBe(false);
    });
});

describe('decidedAgainst', () => {
    test('a clear answer is reached in a fraction of the trials a figure needs', () => {
        // 90% against a 50% bar: settled almost at once, where measuring that
        // 90% to a point takes nearly two thousand fights
        expect(decidedAgainst(45, 50, 0.5)).toBe(true);
        expect(trialsNeeded(0.9, 0.01)).toBeGreaterThan(1500);
    });

    test('a rate sitting on the bar never decides', () => {
        expect(decidedAgainst(50, 100, 0.5)).toBe(false);
        expect(decidedAgainst(5000, 10000, 0.5)).toBe(false);
    });

    test('decides below the bar as readily as above it', () => {
        expect(decidedAgainst(5, 50, 0.5)).toBe(true);
        expect(wilsonInterval(5, 50).high).toBeLessThan(0.5);
    });

    test('has nothing to say about no trials or no bar', () => {
        expect(decidedAgainst(0, 0, 0.5)).toBe(false);
        expect(decidedAgainst(10, 20, NaN)).toBe(false);
    });
});

describe('hasConverged threshold mode', () => {
    test('stops on a decision rather than on a width', () => {
        const rule = { decideAgainst: 0.5, minTrials: 50, maxTrials: 8000 };
        // Nowhere near ±1% precision, but the side is no longer in doubt
        expect(wilsonHalfWidth(45, 50)).toBeGreaterThan(0.05);
        expect(hasConverged(45, 50, rule)).toBe(true);
        expect(hasConverged(25, 50, rule)).toBe(false);
    });

    test('a threshold outranks a width when both are set', () => {
        const rule = { decideAgainst: 0.5, targetHalfWidth: 0.001, minTrials: 50 };
        expect(hasConverged(45, 50, rule)).toBe(true);
    });

    test('a nonsensical bar falls back to the width', () => {
        expect(hasConverged(45, 50, { decideAgainst: 0, targetHalfWidth: 0.5, minTrials: 10 })).toBe(true);
        expect(hasConverged(45, 50, { decideAgainst: 1.5, targetHalfWidth: 0.001, minTrials: 10 })).toBe(false);
    });
});

describe('isStoppingRule', () => {
    test('recognises each of the three forms and nothing else', () => {
        expect(isStoppingRule({ targetHalfWidth: 0.01 })).toBe(true);
        expect(isStoppingRule({ maxTrials: 500 })).toBe(true);
        expect(isStoppingRule({ decideAgainst: 0.5 })).toBe(true);
        expect(isStoppingRule({ minTrials: 100 })).toBe(false);
        expect(isStoppingRule({})).toBe(false);
        expect(isStoppingRule(null)).toBe(false);
    });
});

describe('trialsNeeded', () => {
    test('peaks at a coin toss and collapses at the ends', () => {
        expect(trialsNeeded(0.5, 0.01)).toBe(9604);
        expect(trialsNeeded(0.95, 0.01)).toBe(1825);
        expect(trialsNeeded(0.5, 0.01)).toBeGreaterThan(trialsNeeded(0.2, 0.01));
    });

    test('quadruples when the target halves', () => {
        expect(trialsNeeded(0.5, 0.005) / trialsNeeded(0.5, 0.01)).toBeCloseTo(4, 1);
    });

    test('an impossible target needs an impossible number of trials', () => {
        expect(trialsNeeded(0.5, 0)).toBe(Infinity);
    });

    test('uses the quantile it is given', () => {
        expect(trialsNeeded(0.5, 0.01, Z_95)).toBeGreaterThan(trialsNeeded(0.5, 0.01, 1));
    });
});
