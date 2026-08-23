import { describe, it, expect } from 'vitest';
import * as mathjs from 'mathjs';
import matrixMath, { createMatrixMath } from './matrix-inverse.js';
import { BASE_SUCCESS_RATES, buildEnhancementMarkov } from './enhancement-calculator.js';

/**
 * Run the enhancement chain's fundamental-matrix computation with a given
 * math namespace, and return the numbers the calculators actually read off it.
 * @param {Object} math - Namespace to use (math.js or ours)
 * @param {Object} options - Chain parameters
 * @returns {{attempts: number, protects: number, row: number[]}} The read-off figures
 */
function solveChain(math, options) {
    const { targetLevel, protectFrom = 0 } = options;
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        ...options,
    });

    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    const row = [];
    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        const value = M.get([0, i]);
        row.push(value);
        attempts += value;
    }

    let protects = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            protects += M.get([0, i]) * markov.get([i, i - 1]);
        }
    }

    return { attempts, protects, row };
}

describe('matrixMath', () => {
    it('inverts a small matrix to within floating-point noise', () => {
        const m = matrixMath.zeros(3, 3);
        const values = [
            [4, 7, 2],
            [3, 6, 1],
            [2, 5, 3],
        ];
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m.set([i, j], values[i][j]);

        const inverse = matrixMath.inv(m);
        const reference = mathjs.inv(values);

        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                expect(inverse.get([i, j])).toBeCloseTo(reference[i][j], 12);
            }
        }
    });

    it('handles a matrix that needs a row swap to find a pivot', () => {
        const values = [
            [0, 1],
            [1, 0],
        ];
        const m = matrixMath.zeros(2, 2);
        for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) m.set([i, j], values[i][j]);

        const inverse = matrixMath.inv(m);
        expect(inverse.get([0, 0])).toBeCloseTo(0, 12);
        expect(inverse.get([0, 1])).toBeCloseTo(1, 12);
        expect(inverse.get([1, 0])).toBeCloseTo(1, 12);
        expect(inverse.get([1, 1])).toBeCloseTo(0, 12);
    });

    it('throws on a singular matrix rather than returning nonsense', () => {
        const m = matrixMath.zeros(2, 2);
        m.set([0, 0], 1);
        m.set([0, 1], 2);
        m.set([1, 0], 2);
        m.set([1, 1], 4);
        expect(() => matrixMath.inv(m)).toThrow(/singular/i);
    });

    it('grows on an out-of-range set the way math.js resizes', () => {
        const m = matrixMath.zeros(2, 2);
        m.set([2, 3], 5);
        expect(m.get([2, 3])).toBe(5);
        expect(m.get([0, 0])).toBe(0);
    });

    it('createMatrixMath closes over nothing, so it survives serialisation', () => {
        // This is what the blob workers do: take the source and evaluate it.
        const revived = new Function(`return (${createMatrixMath.toString()})();`)();
        const identity = revived.identity(3);
        const inverse = revived.inv(identity);
        expect(inverse.get([1, 1])).toBe(1);
        expect(inverse.get([0, 1])).toBe(0);
    });
});

/**
 * Assert two figures agree to 1e-9 relative (or absolute, near zero).
 * @param {number} actual - Our value
 * @param {number} expected - The math.js value
 */
function expectClose(actual, expected) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

describe('matrixMath vs math.js on the enhancement chain', () => {
    const scenarios = [
        { name: 'plain +5', targetLevel: 5, successMultiplier: 1.0 },
        { name: 'plain +20', targetLevel: 20, successMultiplier: 1.0 },
        { name: 'protected from +8 to +14', targetLevel: 14, protectFrom: 8, successMultiplier: 1.2 },
        {
            name: 'blessed tea to +12',
            targetLevel: 12,
            successMultiplier: 1.35,
            blessedTea: true,
            guzzlingBonus: 1.4,
            blessedTeaBonus: 0.02,
        },
        {
            name: 'blessed tea, protected, to +20',
            targetLevel: 20,
            protectFrom: 12,
            successMultiplier: 1.9,
            blessedTea: true,
            guzzlingBonus: 1.0,
            blessedTeaBonus: 0.01,
        },
        { name: 'single level', targetLevel: 1, successMultiplier: 1.0 },
        { name: 'clamped multiplier', targetLevel: 10, successMultiplier: 8 },
    ];

    for (const scenario of scenarios) {
        it(`matches math.js for ${scenario.name}`, () => {
            const { name: _name, ...options } = scenario;
            const ours = solveChain(matrixMath, options);
            const theirs = solveChain(mathjs, options);

            // Relative, not absolute: an unprotected +20 run expects ~3.3e9
            // attempts, where 1e-9 of absolute slack is far below one ulp.
            // 1e-9 relative is still ~seven orders tighter than anything the
            // calculator displays.
            expectClose(ours.attempts, theirs.attempts);
            expectClose(ours.protects, theirs.protects);
            expect(ours.row.length).toBe(theirs.row.length);
            for (let i = 0; i < ours.row.length; i++) {
                expectClose(ours.row[i], theirs.row[i]);
            }
        });
    }
});
