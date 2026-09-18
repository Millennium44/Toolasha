/**
 * The fight-count quantile, and the padding built on it.
 *
 * The point of the module is that a closed form is not trusted, so neither is
 * it here: the small cases are checked against a brute-force scan of the same
 * exact tail, the k = 1 case against the geometric closed form it has to
 * reduce to, and the shape of the answer against the properties a quantile
 * cannot violate — monotone in confidence, monotone in kills wanted, and never
 * below the minimum number of fights that could possibly produce the kills.
 */

import { describe, test, expect } from 'vitest';
import { fightsForKillConfidence, binomialAtLeast, padFightCount } from './fight-confidence.js';

/** The same question answered by scanning every n from zero. */
function bruteForce(killsNeeded, killsPerFight, confidence) {
    for (let n = 0; n <= 200_000; n += 1) {
        if (binomialAtLeast(n, killsNeeded, killsPerFight) >= confidence) return n;
    }
    return null;
}

const fights = (killsNeeded, killsPerFight, confidencePercent) =>
    fightsForKillConfidence({ killsNeeded, killsPerFight, confidencePercent });

describe('binomialAtLeast', () => {
    test('reduces to the geometric survival function at k = 1', () => {
        // P(at least one success in n) = 1 - q^n
        for (const n of [1, 5, 40]) {
            expect(binomialAtLeast(n, 1, 0.1)).toBeCloseTo(1 - 0.9 ** n, 12);
        }
    });

    test('is exact on a hand-computable case', () => {
        // Binomial(4, 0.5): P(X >= 2) = 11/16
        expect(binomialAtLeast(4, 2, 0.5)).toBeCloseTo(11 / 16, 12);
        // P(X >= 0) = 1, P(X >= 5) = 0 (more kills than fights)
        expect(binomialAtLeast(4, 0, 0.5)).toBe(1);
        expect(binomialAtLeast(4, 5, 0.5)).toBe(0);
    });

    test('stays finite where a naive product would underflow', () => {
        // q^14000 is exactly 0 as a double; the log-space seed is what keeps
        // the Black Bear row computable at all.
        const tail = binomialAtLeast(14_000, 3833, 3833 / 13_832);
        expect(tail).toBeGreaterThan(0.5);
        expect(tail).toBeLessThan(1);
    });

    test('rises with n and falls with k', () => {
        expect(binomialAtLeast(100, 6, 0.1)).toBeGreaterThan(binomialAtLeast(80, 6, 0.1));
        expect(binomialAtLeast(100, 6, 0.1)).toBeGreaterThan(binomialAtLeast(100, 12, 0.1));
    });
});

describe('fightsForKillConfidence', () => {
    test('k = 1 matches the geometric closed form', () => {
        // Smallest n with 1 - q^n >= c  =>  n = ceil(log(1-c) / log(q))
        for (const [p, c] of [
            [0.1, 90],
            [0.5, 95],
            [0.02, 99],
        ]) {
            const expected = Math.ceil(Math.log(1 - c / 100) / Math.log(1 - p));
            expect(fights(1, p, c)).toBe(expected);
        }
    });

    test('matches an exhaustive scan across small and awkward cases', () => {
        const cases = [
            [1, 0.1, 0.9],
            [6, 0.1, 0.9],
            [6, 0.1, 0.5],
            [6, 0.1, 0.99],
            [3, 0.5, 0.9],
            [20, 0.03, 0.95],
            [2, 0.9, 0.8],
            [50, 0.25, 0.9],
            [500, 0.4, 0.9],
        ];
        for (const [k, p, c] of cases) {
            expect(fights(k, p, c * 100), `k=${k} p=${p} c=${c}`).toBe(bruteForce(k, p, c));
        }
    });

    test('the six-kill case a normal approximation gets wrong', () => {
        // Crystal Colossus 94 -> 100 at the maintainer's ~60 fights: p = 0.1.
        // The median is 57 fights; 90% costs 91, half again as many. A flat
        // 5% would have quoted 63 and stranded the player most of the time.
        expect(fights(6, 0.1, 50)).toBe(57);
        expect(fights(6, 0.1, 90)).toBe(91);
        expect(fights(6, 0.1, 99)).toBe(127);
        expect(binomialAtLeast(90, 6, 0.1)).toBeLessThan(0.9);
        expect(binomialAtLeast(91, 6, 0.1)).toBeGreaterThanOrEqual(0.9);
    });

    test('a large target pads proportionally far less than a small one', () => {
        // Black Bear 6167 -> 10000: 3833 kills at p = 3833/13832.
        const p = 3833 / 13_832;
        const median = fights(3833, p, 50);
        const ninety = fights(3833, p, 90);
        expect(ninety).toBe(14_076);
        // Under 2% over the prediction, against 52% for the six-kill row.
        expect((ninety - 13_832) / 13_832).toBeLessThan(0.02);
        expect(ninety).toBeGreaterThan(median);
        expect((fights(6, 0.1, 90) - 60) / 60).toBeGreaterThan(0.5);
    });

    test('p at the edges', () => {
        // Certain kills: exactly k fights, no padding possible or needed.
        expect(fights(7, 1, 99)).toBe(7);
        // More than one kill per fight (a dungeon quoted in clears) is not a
        // random variable worth padding either.
        expect(fights(10, 2.5, 99)).toBe(4);
        // A vanishingly rare monster still answers, and answers big.
        expect(fights(1, 1e-4, 90)).toBe(23_025);
        // No rate at all is null, never a guess.
        expect(fights(5, 0, 90)).toBeNull();
        expect(fights(5, NaN, 90)).toBeNull();
        expect(fights(5, undefined, 90)).toBeNull();
    });

    test('degenerate kill counts', () => {
        expect(fights(0, 0.5, 90)).toBe(0);
        expect(fights(-3, 0.5, 90)).toBe(0);
    });

    test('confidence 0 is the off switch: the plain expectation', () => {
        expect(fights(6, 0.1, 0)).toBe(60);
        expect(fights(3833, 3833 / 13_832, 0)).toBe(13_832);
    });

    test('never asks for fewer fights as confidence rises', () => {
        let previous = 0;
        for (const c of [50, 60, 70, 75, 80, 85, 90, 95, 97, 99]) {
            const n = fights(40, 0.12, c);
            expect(n).toBeGreaterThanOrEqual(previous);
            previous = n;
        }
    });

    test('never asks for fewer fights as more kills are needed', () => {
        let previous = 0;
        for (const k of [1, 2, 3, 6, 10, 25, 100, 400, 1500]) {
            const n = fights(k, 0.08, 90);
            expect(n).toBeGreaterThanOrEqual(previous);
            previous = n;
        }
    });

    test('never asks for fewer fights than kills', () => {
        for (const k of [1, 6, 50]) {
            for (const p of [0.05, 0.3, 0.95]) {
                expect(fights(k, p, 90)).toBeGreaterThanOrEqual(k);
            }
        }
    });
});

describe('padFightCount', () => {
    const rng = (killsNeeded, killsPerFight) => ({ killsNeeded, killsPerFight });
    const boss = (killsNeeded, killsPerFight) => ({ killsNeeded, killsPerFight, deterministic: true });

    test('a boss threshold pads nothing at all — not even the flat floor', () => {
        // 60 boss kills at one per ten waves: 600 fights, exactly.
        const result = padFightCount({
            unpaddedFights: 600,
            thresholds: [boss(60, 0.1)],
            confidencePercent: 90,
            floorPercent: 5,
        });
        expect(result.fights).toBe(600);
        expect(result.basis).toBe('unpadded');
    });

    test('a random threshold pads to the quantile, well past the flat floor', () => {
        const result = padFightCount({
            unpaddedFights: 60,
            thresholds: [rng(6, 0.1)],
            confidencePercent: 90,
            floorPercent: 5,
        });
        expect(result).toEqual({ fights: 91, basis: 'confidence' });
    });

    test('a small target pads proportionally harder than a large one', () => {
        const small = padFightCount({ unpaddedFights: 60, thresholds: [rng(6, 0.1)], confidencePercent: 90 });
        const large = padFightCount({
            unpaddedFights: 13_832,
            thresholds: [rng(3833, 3833 / 13_832)],
            confidencePercent: 90,
        });
        expect(small.fights / 60).toBeGreaterThan(1.5);
        expect(large.fights / 13_832).toBeLessThan(1.02);
    });

    test('the flat floor still binds where the quantile asks for less', () => {
        // A very large, very certain target: the quantile is under +1%, so the
        // 10% floor is what an existing user keeps.
        const result = padFightCount({
            unpaddedFights: 100_000,
            thresholds: [rng(50_000, 0.5)],
            confidencePercent: 90,
            floorPercent: 10,
        });
        expect(result.fights).toBe(110_000);
        expect(result.basis).toBe('flat');
    });

    test('the binding threshold in a multi-threshold row is the hungriest one', () => {
        const alone = padFightCount({ unpaddedFights: 60, thresholds: [rng(6, 0.1)], confidencePercent: 90 });
        const together = padFightCount({
            unpaddedFights: 60,
            thresholds: [rng(6, 0.1), rng(30, 0.5), rng(1, 0.02), boss(2, 0.1)],
            confidencePercent: 90,
        });
        // Each threshold's own requirement, and the row takes the largest.
        const each = [
            fightsForKillConfidence({ killsNeeded: 6, killsPerFight: 0.1, confidencePercent: 90 }),
            fightsForKillConfidence({ killsNeeded: 30, killsPerFight: 0.5, confidencePercent: 90 }),
            fightsForKillConfidence({ killsNeeded: 1, killsPerFight: 0.02, confidencePercent: 90 }),
            20,
        ];
        expect(together.fights).toBe(Math.max(...each));
        expect(together.fights).toBeGreaterThanOrEqual(alone.fights);
    });

    test('a mixed row keeps the flat floor; the boss half does not veto it', () => {
        const result = padFightCount({
            unpaddedFights: 1000,
            thresholds: [boss(100, 0.1), rng(1, 0.005)],
            confidencePercent: 0,
            floorPercent: 5,
        });
        expect(result).toEqual({ fights: 1050, basis: 'flat' });
    });

    test('an unpriceable threshold falls back to the flat buffer, never a guess', () => {
        const result = padFightCount({
            unpaddedFights: 100,
            thresholds: [rng(6, 0)],
            confidencePercent: 90,
            floorPercent: 5,
        });
        expect(result).toEqual({ fights: 105, basis: 'flat' });
        // And with no thresholds at all, likewise.
        expect(padFightCount({ unpaddedFights: 100, floorPercent: 5 })).toEqual({ fights: 105, basis: 'flat' });
    });

    test('confidence 0 leaves only the flat floor', () => {
        expect(
            padFightCount({ unpaddedFights: 60, thresholds: [rng(6, 0.1)], confidencePercent: 0, floorPercent: 5 })
        ).toEqual({ fights: 63, basis: 'flat' });
    });

    test('both off is the untouched prediction', () => {
        expect(
            padFightCount({ unpaddedFights: 60, thresholds: [rng(6, 0.1)], confidencePercent: 0, floorPercent: 0 })
        ).toEqual({ fights: 60, basis: 'unpadded' });
    });

    test('padding never shrinks the prediction', () => {
        // A 50% confidence quantile sits below the median prediction; the
        // unpadded count is a floor regardless.
        expect(
            padFightCount({ unpaddedFights: 60, thresholds: [rng(6, 0.1)], confidencePercent: 50, floorPercent: 0 })
                .fights
        ).toBe(60);
    });

    test('a deterministic requirement larger than the prediction still raises it', () => {
        const result = padFightCount({
            unpaddedFights: 500,
            thresholds: [boss(60, 0.1)],
            confidencePercent: 90,
            floorPercent: 0,
        });
        expect(result).toEqual({ fights: 600, basis: 'deterministic' });
    });
});
