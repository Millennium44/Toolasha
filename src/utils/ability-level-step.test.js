import { describe, test, expect } from 'vitest';
import { nextMultipleLevel, abilityLevelBoxHints, DEFAULT_LEVEL_STEP } from './ability-level-step.js';

describe('nextMultipleLevel', () => {
    test('rounds up to the next multiple, a full step from a multiple', () => {
        expect([42, 61, 66, 70, 75].map((l) => nextMultipleLevel(l, 5, 200))).toEqual([45, 65, 70, 75, 80]);
        expect([42, 70, 75].map((l) => nextMultipleLevel(l, 10, 200))).toEqual([50, 80, 80]);
        expect(nextMultipleLevel(70, 1, 200)).toBe(71);
    });

    test('level 0 and 1 reach the first multiple', () => {
        expect(nextMultipleLevel(0, 5)).toBe(5);
        expect(nextMultipleLevel(1, 5)).toBe(5);
    });

    test('is cut to the cap, and at the cap returns the cap (not above the level)', () => {
        expect(nextMultipleLevel(199, 5, 200)).toBe(200);
        expect(nextMultipleLevel(200, 5, 200)).toBe(200);
    });

    test('an unusable step falls back to 5; a fraction truncates', () => {
        for (const step of [0, -2, NaN, '', null, undefined, 'x']) expect(nextMultipleLevel(70, step)).toBe(75);
        expect(nextMultipleLevel(70, 10.9)).toBe(80);
        expect(DEFAULT_LEVEL_STEP).toBe(5);
    });
});

describe('abilityLevelBoxHints', () => {
    test('each mode has its own box text', () => {
        expect(abilityLevelBoxHints('increment').placeholder).toBe('+5');
        expect(abilityLevelBoxHints('target').value).toBe('');
        expect(abilityLevelBoxHints('next_multiple')).toMatchObject({ value: '5', placeholder: '5' });
    });
});
