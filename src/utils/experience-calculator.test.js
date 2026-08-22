/**
 * Tests for Experience Calculator
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    actionDetails: null,
    skills: [],
    gameData: {},
    equipment: new Map(),
    actionStats: null,
    xpMultiplierData: { totalMultiplier: 1 },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => state.actionDetails,
        getSkills: () => state.skills,
        getInitClientData: () => state.gameData,
    },
}));

vi.mock('./action-calculator.js', () => ({
    calculateActionStats: vi.fn(() => state.actionStats),
}));

vi.mock('./experience-parser.js', () => ({
    calculateExperienceMultiplier: vi.fn(() => state.xpMultiplierData),
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: state.equipment }),
}));

// Use the real efficiency + profit-helpers modules — they're small, pure, and already
// covered elsewhere, so composing through them keeps this test honest about the formula.
const { calculateExpPerHour, calculateMultiLevelProgress, calculateLevelFromActions } =
    await import('./experience-calculator.js');

describe('calculateLevelFromActions', () => {
    const table = { 1: 0, 2: 100, 3: 300, 4: 700, 5: 1500 };

    test('feeding actionsNeeded back in lands exactly on the target level', () => {
        const forward = calculateMultiLevelProgress(1, 0, 4, 10, 6, 25, table);
        const back = calculateLevelFromActions(1, 0, forward.actionsNeeded, 10, 6, 25, table);
        expect(back.finalLevel).toBe(4);
        expect(back.percentToNext).toBe(0);
        expect(back.timeElapsed).toBeCloseTo(forward.timeNeeded, 6);
    });

    test('a budget that stops mid-level reports the fraction through it', () => {
        // Level 1→2 needs 100 xp at 25 xp/action and 0% efficiency: 4 actions. Two in: halfway
        const r = calculateLevelFromActions(1, 0, 2, 0, 6, 25, table);
        expect(r.finalLevel).toBe(1);
        expect(r.percentToNext).toBeCloseTo(50);
        expect(r.xpGained).toBeCloseTo(50);
        expect(r.timeElapsed).toBeCloseTo(12);
    });

    test('running off the end of the table stops at the last level', () => {
        const r = calculateLevelFromActions(4, 700, 1_000_000, 0, 6, 25, table);
        expect(r.finalLevel).toBe(5);
        expect(r.percentToNext).toBe(100);
    });
});

beforeEach(() => {
    state.actionDetails = null;
    state.skills = [{ skillHrid: '/skills/foraging', level: 10 }];
    state.gameData = { itemDetailMap: {} };
    state.equipment = new Map();
    state.actionStats = { actionTime: 6, totalEfficiency: 0 };
    state.xpMultiplierData = { totalMultiplier: 1 };
});

describe('calculateExpPerHour', () => {
    test('returns null when the action has no experience gain', () => {
        state.actionDetails = { type: '/action_types/foraging' };
        expect(calculateExpPerHour('/actions/foraging/carrot')).toBeNull();
    });

    test('returns null when action details are missing entirely', () => {
        state.actionDetails = null;
        expect(calculateExpPerHour('/actions/foraging/carrot')).toBeNull();
    });

    test('returns null when calculateActionStats yields nothing (bad data)', () => {
        state.actionDetails = {
            type: '/action_types/foraging',
            experienceGain: { value: 10, skillHrid: '/skills/foraging' },
        };
        state.actionStats = null;
        expect(calculateExpPerHour('/actions/foraging/carrot')).toBeNull();
    });

    test('computes expPerHour = actionsPerHour(with efficiency) * baseExp * xpMultiplier', () => {
        state.actionDetails = {
            type: '/action_types/foraging',
            experienceGain: { value: 10, skillHrid: '/skills/foraging' },
        };
        state.actionStats = { actionTime: 6, totalEfficiency: 0 }; // 600 actions/hr, no efficiency bonus
        state.xpMultiplierData = { totalMultiplier: 1.2 };

        const result = calculateExpPerHour('/actions/foraging/carrot');

        expect(result.actionsPerHour).toBe(600);
        expect(result.baseExp).toBe(10);
        expect(result.modifiedXP).toBeCloseTo(12, 6);
        expect(result.expPerHour).toBe(Math.floor(600 * 12));
        expect(result.xpMultiplier).toBe(1.2);
    });

    test('efficiency increases effective actions per hour and therefore expPerHour', () => {
        state.actionDetails = {
            type: '/action_types/foraging',
            experienceGain: { value: 10, skillHrid: '/skills/foraging' },
        };
        state.actionStats = { actionTime: 6, totalEfficiency: 100 }; // +100% efficiency => 2x multiplier
        state.xpMultiplierData = { totalMultiplier: 1 };

        const result = calculateExpPerHour('/actions/foraging/carrot');
        expect(result.actionsPerHour).toBe(1200); // 600 base * 2
        expect(result.expPerHour).toBe(12000); // 1200 * 10
    });
});

describe('calculateMultiLevelProgress', () => {
    const levelExperienceTable = { 1: 0, 2: 100, 3: 300, 4: 600 };

    test('single level, no progressive efficiency gain', () => {
        const result = calculateMultiLevelProgress(1, 0, 2, 0, 6, 100, levelExperienceTable);
        // xpNeeded = 100 - 0 = 100; efficiencyMultiplier = 1; actions = ceil(100/100) = 1
        expect(result.actionsNeeded).toBe(1);
        expect(result.timeNeeded).toBe(6);
    });

    test('accounts for existing XP progress toward the next level', () => {
        const result = calculateMultiLevelProgress(1, 50, 2, 0, 6, 100, levelExperienceTable);
        // xpNeeded = 100 - 50 = 50; actions = ceil(50/100) = 1 (still rounds up to 1 action)
        expect(result.actionsNeeded).toBe(1);
        expect(result.timeNeeded).toBe(6);
    });

    test('spans multiple levels, applying +1% efficiency per level gained', () => {
        const result = calculateMultiLevelProgress(1, 0, 3, 0, 6, 100, levelExperienceTable);
        // Level 1->2: xpNeeded=100, levelsGained=0, mult=1.00, actionsToQueue=ceil(100/100)*1=1, time=1*6=6
        // Level 2->3: xpNeeded=300-100=200, levelsGained=1, mult=1.01, xpPerAction=101,
        //   baseActionsForLevel=ceil(200/101)=2, actionsToQueue=round(2*1.01)=2, time=2*6=12
        expect(result.actionsNeeded).toBe(3);
        expect(result.timeNeeded).toBe(18);
    });

    test('returns zero for a target level equal to the current level', () => {
        const result = calculateMultiLevelProgress(5, 0, 5, 0, 6, 100, levelExperienceTable);
        expect(result).toEqual({ actionsNeeded: 0, timeNeeded: 0 });
    });
});
