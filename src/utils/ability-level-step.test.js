import { describe, test, expect } from 'vitest';
import {
    nextMultipleLevel,
    abilityLevelBoxHints,
    DEFAULT_LEVEL_STEP,
    abilityStepLevels,
    normalizeLevelSteps,
    stepLevels,
    singleStepLevels,
    levelStepsTitle,
    levelBoxHints,
    LEVEL_STEPS_TITLE,
} from './ability-level-step.js';

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

describe('abilityStepLevels', () => {
    test('one step is the single legacy level, clamped to the cap', () => {
        expect(abilityStepLevels(70, 'increment', 5, 1, 200)).toEqual([75]);
        expect(abilityStepLevels(198, 'increment', 5, 1, 200)).toEqual([200]);
        expect(abilityStepLevels(62, 'next_multiple', 5, 1, 200)).toEqual([65]);
    });
    test('several steps stride on, and stop at the cap', () => {
        expect(abilityStepLevels(62, 'next_multiple', 5, 3, 200)).toEqual([65, 70, 75]);
        expect(abilityStepLevels(70, 'increment', 5, 3, 200)).toEqual([75, 80, 85]);
        expect(abilityStepLevels(190, 'increment', 5, 5, 200)).toEqual([195, 200]);
        expect(abilityStepLevels(200, 'increment', 5, 3, 200)).toEqual([]);
    });
    test('normalizeLevelSteps', () => {
        expect([0, -1, NaN, '', undefined, null, 1.9, 5, 6, '3'].map(normalizeLevelSteps)).toEqual([
            1, 1, 1, 1, 1, 1, 1, 5, 5, 3,
        ]);
    });
});

describe('the shared step rules beyond abilities', () => {
    test('stepLevels is the ability rule under its general name', () => {
        expect(stepLevels).toBe(abilityStepLevels);
        expect(stepLevels(50, 'increment', 5, 3, 200)).toEqual([55, 60, 65]);
    });

    test('singleStepLevels: +1 per step, capped, nothing at the cap, one step is one level up', () => {
        expect(singleStepLevels(3, 1, 8)).toEqual([4]);
        expect(singleStepLevels(3, 3, 8)).toEqual([4, 5, 6]);
        expect(singleStepLevels(6, 5, 8)).toEqual([7, 8]);
        expect(singleStepLevels(8, 3, 8)).toEqual([]);
        expect(singleStepLevels(0, 99, 20)).toEqual([1, 2, 3, 4, 5]);
        for (const blank of [0, '', null, undefined, NaN]) expect(singleStepLevels(3, blank, 8)).toEqual([4]);
    });

    test('levelStepsTitle and levelBoxHints name what they level', () => {
        expect(LEVEL_STEPS_TITLE).toBe(levelStepsTitle('ability'));
        expect(levelStepsTitle('combat skill', 'More.')).toMatch(/per combat skill.*More\.$/);
        expect(levelBoxHints('increment', 'combat skill').title).toBe('Number of levels to add to each combat skill');
        expect(levelBoxHints('target', 'ability').title).toBe('Absolute target level for all abilities');
        expect(abilityLevelBoxHints('next_multiple')).toEqual(levelBoxHints('next_multiple', 'ability'));
    });
});
