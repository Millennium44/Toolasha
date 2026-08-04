/**
 * Tests for the enhancement Markov chain.
 *
 * The chain is loaded as a userscript global in the browser, so the tests hand it the same
 * math.js API off globalThis before touching the module under test.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import { calculateEnhancement, buildEnhancementMarkov, BLESSED_TEA_BASE_CHANCE } from './enhancement-calculator.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

/**
 * Baseline parameters: level exactly at item level and no tool bonus, so the success
 * multiplier is 1 and the base rates apply unchanged (+1 is 50%, +2 is 45%).
 */
const base = {
    enhancingLevel: 50,
    itemLevel: 50,
    toolBonus: 0,
    speedBonus: 0,
};

describe('expected attempts', () => {
    test('+0 to +2 matches the hand-solved expectation', () => {
        // E0 = 1 + 0.5·E0 + 0.5·E1, E1 = 1 + 0.55·E0  ⇒  E0 = 6.667
        const result = calculateEnhancement({ ...base, targetLevel: 2 });
        expect(result.attempts).toBeCloseTo(20 / 3, 6);
    });

    test('starting above +0 still counts the attempts spent after falling back down', () => {
        // From +1: E1 = 1 + 0.55·E0 = 4.667. Summing the fundamental matrix row only from
        // startLevel up would report 2.222 — it drops every revisit to +0 after a failure.
        const result = calculateEnhancement({ ...base, targetLevel: 2, startLevel: 1 });
        expect(result.attempts).toBeCloseTo(14 / 3, 6);
    });

    test('protection softens the fall but the states below the start still cost attempts', () => {
        // Protecting from +2 sends a failure at +2 down to +1, and a failure at +1 back to +0.
        // E0 = 2 + E1, E1 = 1 + 0.55·E0 + 0.45·E2, E2 = 1 + 0.55·E1  ⇒  E2 = 7.926
        const result = calculateEnhancement({ ...base, targetLevel: 3, startLevel: 2, protectFrom: 2 });
        const e1 = 2.55 / 0.2025;
        expect(result.attempts).toBeCloseTo(1 + 0.55 * e1, 6);
    });

    test('visit counts are reported for every state, not just those at or above the start', () => {
        const result = calculateEnhancement({ ...base, targetLevel: 2, startLevel: 1 });
        expect(result.visitCounts).toHaveLength(2);
        expect(result.visitCounts[0]).toBeGreaterThan(0);
        expect(result.attempts).toBeCloseTo(
            result.visitCounts.reduce((sum, v) => sum + v, 0),
            9
        );
    });
});

describe('success chance clamping', () => {
    test('a multiplier that would push a rate past 100% cannot create negative failure odds', () => {
        // 4000 levels above the item gives a ×3 multiplier, so +1 computes to 150%
        const result = calculateEnhancement({
            ...base,
            enhancingLevel: 4050,
            targetLevel: 1,
        });

        // Certain success means exactly one attempt; an unclamped chain reports 1/1.5 = 0.667
        expect(result.attempts).toBeCloseTo(1, 9);
        expect(result.successRates[0].actualRate).toBe(100);
    });
});

describe('blessed tea', () => {
    test('the double-jump chance is a parameter, defaulting to the base 1%', () => {
        const explicit = calculateEnhancement({
            ...base,
            targetLevel: 3,
            blessedTea: true,
            blessedTeaBonus: BLESSED_TEA_BASE_CHANCE,
        });
        const defaulted = calculateEnhancement({ ...base, targetLevel: 3, blessedTea: true });

        expect(explicit.attempts).toBeCloseTo(defaulted.attempts, 9);
    });

    test('a larger double-jump chance skips levels and needs fewer attempts', () => {
        const weak = calculateEnhancement({ ...base, targetLevel: 3, blessedTea: true, blessedTeaBonus: 0.01 });
        const strong = calculateEnhancement({ ...base, targetLevel: 3, blessedTea: true, blessedTeaBonus: 0.5 });

        expect(strong.attempts).toBeLessThan(weak.attempts);
    });
});

describe('per-action time override', () => {
    test('a measured action time replaces the formula and drives total time', () => {
        const formula = calculateEnhancement({ ...base, targetLevel: 2 });
        const measured = calculateEnhancement({ ...base, targetLevel: 2, perActionTimeOverride: 3.5 });

        expect(formula.perActionTime).not.toBeCloseTo(3.5, 6);
        expect(measured.perActionTime).toBe(3.5);
        expect(measured.totalTime).toBeCloseTo(3.5 * measured.attempts, 9);
    });

    test('an absent or zero override falls back to the computed time', () => {
        const withZero = calculateEnhancement({ ...base, targetLevel: 2, perActionTimeOverride: 0 });
        const without = calculateEnhancement({ ...base, targetLevel: 2 });

        expect(withZero.perActionTime).toBeCloseTo(without.perActionTime, 9);
    });
});

describe('buildEnhancementMarkov as shared worker source', () => {
    test('the clamp and the blessed-tea chance live in the shared body', () => {
        const source = buildEnhancementMarkov.toString();

        expect(source).toContain('Math.min(1, baseSuccessRate * successMultiplier)');
        expect(source).toContain('blessedTeaBonus');
    });

    test('it closes over nothing, so it survives being serialised into a worker', () => {
        // The worker managers interpolate this body into a blob script. A reference to any
        // module-scope name would compile here and be undefined there, which is precisely how
        // the two hand-copied chains drifted apart in the first place.
        const source = buildEnhancementMarkov.toString();

        for (const moduleScopeName of ['BASE_SUCCESS_RATES', 'BLESSED_TEA_BASE_CHANCE', 'MIN_ACTION_TIME_SECONDS']) {
            expect(source).not.toContain(moduleScopeName);
        }
        // math arrives as a parameter rather than the global for the same reason
        expect(source.startsWith('function buildEnhancementMarkov(math, options)')).toBe(true);
    });

    test('a blessed double-jump off the last transient level stays inside the matrix', () => {
        // Without the bounds guard this writes column 21 of a 20-wide matrix and throws
        expect(() =>
            calculateEnhancement({ ...base, targetLevel: 19, blessedTea: true, blessedTeaBonus: 0.01 })
        ).not.toThrow();
    });

    test('the chain a worker builds is the chain the calculator builds', () => {
        const options = {
            baseSuccessRates: [50, 45, 45],
            successMultiplier: 3, // High enough that +1 would compute to 150% unclamped
            targetLevel: 2,
            blessedTea: false,
        };

        const markov = buildEnhancementMarkov(mathjs, options);

        expect(markov.get([0, 1])).toBeCloseTo(1, 9);
        expect(markov.get([0, 0])).toBeCloseTo(0, 9);
    });
});
