import { describe, expect, test } from 'vitest';
import {
    findHighestLevelWithinSeconds,
    normalizeTargetSeconds,
    recommendationBasisKey,
} from './labyrinth-recommend-time.js';

/** A probe over a seconds-by-delta function, counting calls */
function probeOf(secondsAt) {
    const calls = [];
    const evaluate = async (delta) => {
        calls.push(delta);
        return { seconds: secondsAt(delta) };
    };
    return { evaluate, calls };
}

const WINDOW = { minDelta: -200, maxDelta: 200 };

describe('findHighestLevelWithinSeconds', () => {
    test('picks the highest level whose time is within the target', async () => {
        const { evaluate } = probeOf((d) => 100 + d * 10);
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        // 100 + 10d <= 300 -> d <= 20
        expect(found).toEqual({ delta: 20, seconds: 300, qualifies: true });
    });

    test('finds it when the current level is already over the limit', async () => {
        const { evaluate } = probeOf((d) => 500 + d * 10);
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found).toEqual({ delta: -20, seconds: 300, qualifies: true });
    });

    test('compares the rounded figure, as the panel displays it', async () => {
        const { evaluate } = probeOf((d) => (d <= 5 ? 300.4 : 400));
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found.delta).toBe(5);
        expect(found.qualifies).toBe(true);
    });

    test('falls back to the closest miss when no level qualifies', async () => {
        // Every level is over 300s; the cheapest is at the window floor
        const { evaluate } = probeOf((d) => 1000 + (d + 200));
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found).toEqual({ delta: -200, seconds: 1000, qualifies: false });
    });

    test('an unreachable window reports the lowest level rather than the highest', async () => {
        const { evaluate } = probeOf(() => Infinity);
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found.qualifies).toBe(false);
        expect(found.delta).toBe(-200);
    });

    test('clamps the first probe into a window that does not contain zero', async () => {
        const { evaluate, calls } = probeOf((d) => 100 + d);
        const found = await findHighestLevelWithinSeconds({
            evaluate,
            minDelta: 10,
            maxDelta: 50,
            targetSeconds: 125,
        });
        expect(calls[0]).toBe(10);
        expect(found.delta).toBe(25);
    });

    test('a pass sitting above a miss is found by the upward sweep', async () => {
        // Non-monotone: levels 0..9 pass, 10..12 miss, 13 passes again, then all miss
        const secondsAt = (d) => (d <= 9 || d === 13 ? 200 : 900);
        const { evaluate } = probeOf(secondsAt);
        const guarded = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(guarded.delta).toBe(13);

        // Without the sweep the bracketing alone stops at the first boundary
        const { evaluate: plain } = probeOf(secondsAt);
        const unguarded = await findHighestLevelWithinSeconds({
            evaluate: plain,
            ...WINDOW,
            targetSeconds: 300,
            sweepSteps: 0,
        });
        expect(unguarded.delta).toBeLessThan(13);
    });

    test('a dip just under a failed base, between the downward steps, is found', async () => {
        // Misses at 0, -4, -12, ... but -2 qualifies
        const { evaluate } = probeOf((d) => (d === -2 ? 250 : 400));
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found).toEqual({ delta: -2, seconds: 250, qualifies: true });
    });

    test('a dip just above a failed base is found when nothing below qualifies', async () => {
        const { evaluate } = probeOf((d) => (d === 2 ? 250 : 400));
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found).toEqual({ delta: 2, seconds: 250, qualifies: true });
    });

    test('the sweep is bounded, so a far-off pass is not chased', async () => {
        const { evaluate, calls } = probeOf((d) => (d <= 9 || d === 150 ? 200 : 900));
        const found = await findHighestLevelWithinSeconds({ evaluate, ...WINDOW, targetSeconds: 300 });
        expect(found.delta).toBe(9);
        expect(calls).not.toContain(150);
    });

    test('a cancelled probe abandons the search', async () => {
        let n = 0;
        const found = await findHighestLevelWithinSeconds({
            evaluate: async () => (++n === 3 ? { cancelled: true } : { seconds: 100 }),
            ...WINDOW,
            targetSeconds: 300,
        });
        expect(found).toBeNull();
    });

    test('never probes outside the window and never probes a level twice', async () => {
        const { evaluate, calls } = probeOf(() => 1);
        const found = await findHighestLevelWithinSeconds({ evaluate, minDelta: -5, maxDelta: 7, targetSeconds: 300 });
        expect(found.delta).toBe(7);
        expect(Math.min(...calls)).toBeGreaterThanOrEqual(-5);
        expect(Math.max(...calls)).toBeLessThanOrEqual(7);
        expect(new Set(calls).size).toBe(calls.length);
    });
});

describe('target seconds and the basis key', () => {
    test('normalizeTargetSeconds clamps to 1..100000 and floors', () => {
        expect(normalizeTargetSeconds(0.2)).toBe(300);
        expect(normalizeTargetSeconds(-5)).toBe(300);
        expect(normalizeTargetSeconds(1)).toBe(1);
        expect(normalizeTargetSeconds(450.9)).toBe(450);
        expect(normalizeTargetSeconds(1e9)).toBe(100000);
        expect(normalizeTargetSeconds('abc', 45)).toBe(45);
        expect(normalizeTargetSeconds('', 1e9)).toBe(100000);
    });

    test('the basis key tells win rate and time apart, and one target from another', () => {
        expect(recommendationBasisKey('winRate', 70)).not.toBe(recommendationBasisKey('seconds', 70));
        expect(recommendationBasisKey('seconds', 300)).not.toBe(recommendationBasisKey('seconds', 301));
        expect(recommendationBasisKey('seconds', 300)).toBe(recommendationBasisKey('seconds', 300));
    });
});
