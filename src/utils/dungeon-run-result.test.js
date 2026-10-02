import { describe, test, expect } from 'vitest';
import { isClearRun, isFailedRun, isCanceledRun, isKnownRunResult, summarizeAttempts } from './dungeon-run-result.js';

describe('how a stored run ended', () => {
    test('a record with no result is a clear: every run stored before attempts were', () => {
        expect(isClearRun({ duration: 1 })).toBe(true);
        expect(isClearRun({ duration: 1, result: null })).toBe(true);
        expect(isClearRun({ duration: 1, result: 'clear' })).toBe(true);
    });

    test('a fail and a cancel are not clears, and are told apart', () => {
        expect(isClearRun({ result: 'fail' })).toBe(false);
        expect(isClearRun({ result: 'cancel' })).toBe(false);
        expect(isFailedRun({ result: 'fail' })).toBe(true);
        expect(isFailedRun({ result: 'cancel' })).toBe(false);
        expect(isCanceledRun({ result: 'cancel' })).toBe(true);
    });

    test('an unknown result is neither a clear nor an attempt, and is not a known value', () => {
        const odd = { result: 'exploded' };
        expect(isClearRun(odd)).toBe(false);
        expect(isFailedRun(odd)).toBe(false);
        expect(isCanceledRun(odd)).toBe(false);
        expect(isKnownRunResult('exploded')).toBe(false);
        expect(isKnownRunResult(undefined)).toBe(true);
    });
});

describe('summarizeAttempts', () => {
    test('the fail rate leaves cancels out; the time per clear does not', () => {
        const summary = summarizeAttempts([
            { duration: 600_000 },
            { duration: 600_000, result: 'clear' },
            { duration: 300_000, result: 'fail' },
            { duration: 120_000, result: 'cancel' },
            { duration: 120_000, result: 'cancel' },
        ]);

        expect(summary).toEqual({
            clears: 2,
            fails: 1,
            cancels: 2,
            failRate: 1 / 3,
            timePerClearMs: 870_000,
        });
    });

    test('a history of clears alone has a zero fail rate and a time per clear equal to the average', () => {
        expect(summarizeAttempts([{ duration: 400_000 }, { totalTime: 200_000 }])).toEqual({
            clears: 2,
            fails: 0,
            cancels: 0,
            failRate: 0,
            timePerClearMs: 300_000,
        });
    });

    test('nothing at all, and nothing but cancels, have no fail rate to report', () => {
        expect(summarizeAttempts([]).failRate).toBeNull();
        expect(summarizeAttempts(null).failRate).toBeNull();
        expect(summarizeAttempts([{ duration: 1, result: 'cancel' }])).toMatchObject({
            failRate: null,
            timePerClearMs: 0,
        });
    });
});
