import { describe, test, expect } from 'vitest';
import {
    validateTrialScenario,
    skillingSuccessAtTier,
    skillingWorkPerSecond,
    summarizeTrialRuns,
} from './guild-trial-model.js';
import { simulateGuildSkilling } from './engine/guild-skilling-simulator.js';

const member = {
    name: 'Test',
    referenceTier: 1,
    successRate: 1,
    successLossPerTier: 0,
    workPower: 100,
    actionSeconds: 1,
    doubleChance: 0,
};
const scenario = (overrides = {}) => ({
    kind: 'skilling',
    trialHrid: '/guild_skilling/crafting',
    baseWork: 100,
    seconds: 10,
    runs: 2,
    seed: 1,
    members: [member],
    ...overrides,
});

describe('guild work pool simulation', () => {
    test('includes the participant work increase and discards surplus between tiers', () => {
        const result = simulateGuildSkilling(scenario());
        expect(result.medianHighestTier).toBe(5); // each tier requires two 100-work actions
        expect(result.tiers[0].meanClearSeconds).toBe(2);
        expect(result.meanBasePoints).toBe(600);
        expect(result.outcomes.timeout).toBe(2);
    });
    test('double progress is rolled once on a successful action', () => {
        const result = simulateGuildSkilling(scenario({ seconds: 1, members: [{ ...member, doubleChance: 1 }] }));
        expect(result.medianHighestTier).toBe(1);
        expect(result.tiers[0].meanClearSeconds).toBe(1);
    });
    test('does not award actions beyond the remaining budget', () => {
        const result = simulateGuildSkilling(scenario({ seconds: 1.9 }));
        expect(result.medianHighestTier).toBe(0);
        expect(result.meanBasePoints).toBe(0);
    });
    test('includes an action on the exact deadline', () => {
        expect(simulateGuildSkilling(scenario({ seconds: 2 })).medianHighestTier).toBe(1);
    });
    test('stops at tier 21, with an hour cap shared across tiers', () => {
        const result = simulateGuildSkilling(scenario({ baseWork: 1, seconds: 3600 }));
        expect(result.medianHighestTier).toBe(21);
        expect(result.meanSeconds).toBe(21);
        expect(result.meanBasePoints).toBe(2200);
        expect(result.outcomes['max-tier']).toBe(2);
    });
    test('uses each member’s own action clock and probability', () => {
        const result = simulateGuildSkilling(
            scenario({ seconds: 2, baseWork: 200, members: [member, { ...member, actionSeconds: 2 }] })
        );
        expect(result.medianHighestTier).toBe(1);
    });
    test('seeded runs reproduce stochastic outcomes without editing inputs', () => {
        const input = scenario({ runs: 20, members: [{ ...member, successRate: 0.5, doubleChance: 0.1 }] });
        const before = structuredClone(input);
        expect(simulateGuildSkilling(input)).toEqual(simulateGuildSkilling(input));
        expect(input).toEqual(before);
    });
    test('anchors a recorded tier-10 success rate and applies the floor', () => {
        const m = { ...member, referenceTier: 10, successRate: 0.08, successLossPerTier: 0.08 };
        expect(skillingSuccessAtTier(m, 1)).toBeCloseTo(0.8);
        expect(skillingSuccessAtTier(m, 11)).toBe(0.05);
        expect(skillingWorkPerSecond([{ ...m, workPower: 161, actionSeconds: 4.46 }], 10)).toBeCloseTo(
            (161 * 0.08) / 4.46
        );
    });
    test('rejects unusable inputs and bounds expensive scenarios', () => {
        expect(() => validateTrialScenario(scenario({ members: [] }))).toThrow('Add between');
        expect(() => validateTrialScenario(scenario({ startTier: 22 }))).toThrow('Starting tier');
        expect(() => validateTrialScenario(scenario({ members: [{ ...member, actionSeconds: 0 }] }))).toThrow(
            'Work time'
        );
        expect(() =>
            validateTrialScenario(
                scenario({ seconds: 3600, runs: 200, members: Array(100).fill({ ...member, actionSeconds: 0.1 }) })
            )
        ).toThrow('Reduce the runs');
        expect(() =>
            validateTrialScenario(scenario({ buildingBuffs: [{ typeHrid: '/buff_types/damage', ratioBoost: NaN }] }))
        ).toThrow('Buff ratio');
    });
    test('later-tier clear odds include earlier losses; conditional time does not', () => {
        const result = summarizeTrialRuns(validateTrialScenario(scenario()), [
            {
                highestTier: 2,
                seconds: 5,
                reason: 'timeout',
                tiers: [
                    { tier: 1, cleared: true, seconds: 2 },
                    { tier: 2, cleared: true, seconds: 3 },
                ],
            },
            { highestTier: 0, seconds: 10, reason: 'timeout', tiers: [{ tier: 1, cleared: false, seconds: 10 }] },
        ]);
        expect(result.tiers[1].clearChance).toBe(0.5);
        expect(result.tiers[1].reachChance).toBe(0.5);
        expect(result.tiers[1].meanClearSeconds).toBe(3);
        expect(result.lowHighestTier).toBe(0);
        expect(result.highHighestTier).toBe(2);
    });
});
