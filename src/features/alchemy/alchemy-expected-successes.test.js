import { describe, it, expect } from 'vitest';
import {
    computeExpectedSuccesses,
    formatExpectedSuccesses,
    poolExpectedSuccesses,
    formatPooledExpectedSuccesses,
} from './alchemy-expected-successes.js';

describe('computeExpectedSuccesses', () => {
    it('multiplies attempts by the stamped predicted rate', () => {
        const result = computeExpectedSuccesses({ totalAttempts: 100, totalSuccesses: 68, predictedRate: 0.6 });
        expect(result.expected).toBeCloseTo(60);
        expect(result.delta).toBeCloseTo(8);
    });

    it('is null without a predicted rate — never 0', () => {
        expect(computeExpectedSuccesses({ totalAttempts: 100, totalSuccesses: 68 })).toBeNull();
        expect(computeExpectedSuccesses({ totalAttempts: 100, totalSuccesses: 68, predictedRate: null })).toBeNull();
        expect(computeExpectedSuccesses({ totalAttempts: 100, totalSuccesses: 68, predictedRate: 0 })).toBeNull();
    });

    it('is null for a garbage predicted rate rather than NaN math', () => {
        expect(
            computeExpectedSuccesses({ totalAttempts: 100, totalSuccesses: 68, predictedRate: 'not a number' })
        ).toBeNull();
    });

    it('treats missing attempts/successes as zero, not NaN', () => {
        const result = computeExpectedSuccesses({ predictedRate: 0.5 });
        expect(result.expected).toBe(0);
        expect(result.delta).toBe(0);
    });
});

describe('formatExpectedSuccesses', () => {
    it('shows expected and a signed delta', () => {
        expect(formatExpectedSuccesses({ expected: 60, delta: 8 })).toBe('60.0 (+8.0)');
        expect(formatExpectedSuccesses({ expected: 60, delta: -3.5 })).toBe('60.0 (-3.5)');
    });

    it('is a dash for null', () => {
        expect(formatExpectedSuccesses(null)).toBe('—');
    });
});

describe('poolExpectedSuccesses', () => {
    it('sums only sessions that carry a predicted rate', () => {
        const sessions = [
            { totalAttempts: 100, totalSuccesses: 65, predictedRate: 0.6 },
            { totalAttempts: 50, totalSuccesses: 20 }, // predates stamping — excluded
            { totalAttempts: 100, totalSuccesses: 55, predictedRate: 0.6 },
        ];
        const pooled = poolExpectedSuccesses(sessions);
        expect(pooled.expected).toBeCloseTo(120);
        expect(pooled.actual).toBe(120);
        expect(pooled.delta).toBeCloseTo(0);
        expect(pooled.countedSessions).toBe(2);
        expect(pooled.excludedSessions).toBe(1);
    });

    it('handles an empty or all-excluded list without NaN', () => {
        expect(poolExpectedSuccesses([])).toEqual({
            expected: 0,
            actual: 0,
            delta: 0,
            countedSessions: 0,
            excludedSessions: 0,
        });
        const pooled = poolExpectedSuccesses([{ totalAttempts: 10, totalSuccesses: 5 }]);
        expect(pooled.countedSessions).toBe(0);
        expect(pooled.excludedSessions).toBe(1);
    });
});

describe('formatPooledExpectedSuccesses', () => {
    it('is a dash when nothing could be compared', () => {
        expect(formatPooledExpectedSuccesses({ countedSessions: 0 })).toBe('—');
        expect(formatPooledExpectedSuccesses(null)).toBe('—');
    });

    it('shows actual vs expected with a signed delta', () => {
        expect(formatPooledExpectedSuccesses({ actual: 120, expected: 120, delta: 0, countedSessions: 2 })).toBe(
            '120 vs 120.0 (+0.0)'
        );
    });
});
