/**
 * Tests for Labyrinth Clear Rate live-estimate math
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), Z_NOTIFICATION: 10500, Z_FLOATING_PANEL: 10100 },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(), register: vi.fn() } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: vi.fn(), off: vi.fn(), getSkills: vi.fn(() => []), characterData: null },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildPlayerDTO: vi.fn(),
    buildGameDataPayload: vi.fn(),
    applyLoadoutSnapshotToDTO: vi.fn(),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runLabyrinthSimulation: vi.fn() }));
vi.mock('./loadout-snapshot.js', () => ({ default: {} }));

const { default: labyrinthClearRate } = await import('./labyrinth-clear-rate.js');

describe('normalizeChance', () => {
    test('passes through ratios and converts percent-form values', () => {
        expect(labyrinthClearRate.normalizeChance(0.8)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(80)).toBe(0.8);
        expect(labyrinthClearRate.normalizeChance(1)).toBe(1);
        expect(labyrinthClearRate.normalizeChance(0)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(-5)).toBe(0);
        expect(labyrinthClearRate.normalizeChance(undefined)).toBe(0);
    });
});

describe('clear-chance Markov math', () => {
    test('guaranteed success clears exactly when enough attempts remain', () => {
        // Needs 10 successes (100 work / 10 per success) with 100% success rate
        const enough = labyrinthClearRate.computeNonEnhancingClearStats(10, 1, 0, 10, 100);
        expect(enough.clearChance).toBeCloseTo(1, 9);
        expect(enough.expectedAttemptsOnClear).toBeCloseTo(10, 9);

        const tooFew = labyrinthClearRate.computeNonEnhancingClearStats(9, 1, 0, 10, 100);
        expect(tooFew.clearChance).toBe(0);
    });

    test('double progress halves the required attempts', () => {
        // 100% success and 100% double: 10 units in 5 attempts
        const result = labyrinthClearRate.computeNonEnhancingClearStats(5, 1, 1, 10, 100);
        expect(result.clearChance).toBeCloseTo(1, 9);
        expect(result.expectedAttemptsOnClear).toBeCloseTo(5, 9);
    });

    test('enhancing walk reaches the target only with enough attempts', () => {
        const enough = labyrinthClearRate.computeEnhancingClearStats(5, 1, 0, 5, 0);
        expect(enough.clearChance).toBeCloseTo(1, 9);

        const tooFew = labyrinthClearRate.computeEnhancingClearStats(4, 1, 0, 5, 0);
        expect(tooFew.clearChance).toBe(0);
    });

    test('enhancing failures walk the level back down', () => {
        // 50% success from level 0 to 1 in one attempt = 0.5
        const oneShot = labyrinthClearRate.computeEnhancingClearStats(1, 0.5, 0, 1, 0);
        expect(oneShot.clearChance).toBeCloseTo(0.5, 9);
    });
});

describe('computeLiveEstimate', () => {
    const baseMessage = {
        targetLevel: null,
        successRate: 0.8,
        doubleProgressChance: 0.1,
        actionTimeMs: 10000,
        actionCounter: 2,
        currentWorkValue: 30,
        targetWorkValue: 100,
        progressPerAction: 10,
    };

    test('computes a skilling estimate with remaining attempts', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        expect(estimate.isEnhancing).toBe(false);
        expect(estimate.totalAttempts).toBe(12);
        expect(estimate.attemptsLeft).toBe(10);
        expect(estimate.clearChance).toBeGreaterThan(0);
        expect(estimate.clearChance).toBeLessThanOrEqual(1);
    });

    test('percent-form success rates produce the same estimate as ratios', () => {
        const ratioEstimate = labyrinthClearRate.computeLiveEstimate(baseMessage);
        const percentEstimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            successRate: 80,
            doubleProgressChance: 10,
        });
        expect(percentEstimate.clearChance).toBeCloseTo(ratioEstimate.clearChance, 9);
    });

    test('detects enhancing rooms from targetLevel', () => {
        const estimate = labyrinthClearRate.computeLiveEstimate({
            ...baseMessage,
            targetLevel: 5,
            currentEnhLevel: 2,
            actionTimeMs: 8000,
        });
        expect(estimate.isEnhancing).toBe(true);
        expect(estimate.currentLevel).toBe(2);
        expect(estimate.targetLevel).toBe(5);
        expect(estimate.totalAttempts).toBe(15);
    });
});

describe('attachSkillingWhatIfs', () => {
    const buildBase = () => ({
        clearChance: 0.6,
        expectedSeconds: 90,
        xpPerRoom: 5000,
    });
    const metrics = { successBonus: 0, efficiencyBonus: 0.1, actionSpeedBonus: 0.05 };
    const params = {
        attempts: 12,
        successChance: 0.8,
        doubleChance: 0.05,
        levelBonus: 0,
        effectiveLevel: 110,
        progressPerSuccess: 121,
        targetProgress: 1000,
        roomLevel: 100,
    };

    test('adds what-if clear chances and XP/hour', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        expect(result.nextLevelClearChance).toBeGreaterThanOrEqual(0);
        expect(result.nextLevelClearChance).toBeLessThanOrEqual(1);
        expect(result.speedTierClearChance).toBeGreaterThanOrEqual(result.clearChance - 1e-9);
        expect(result.speedDelta).toBeGreaterThanOrEqual(0);
        expect(result.xpPerHour).toBeCloseTo((5000 * 3600) / 91, 6);
    });

    test('efficiency tier reflects one fewer required progress unit', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, params);

        // 1000 target / 121 per success = 9 units needed; tier requires ceil(1000/8) = 125 per success
        expect(result.efficiencyDelta).toBeGreaterThan(0);
        expect(result.efficiencyTierClearChance).toBeGreaterThanOrEqual(0);
        expect(result.efficiencyTierClearChance).toBeLessThanOrEqual(1);
    });

    test('marks efficiency as optimal when one success clears the room', () => {
        const result = buildBase();
        labyrinthClearRate.attachSkillingWhatIfs(result, metrics, {
            ...params,
            progressPerSuccess: 1000,
            targetProgress: 1000,
        });
        expect(result.efficiencyDelta).toBeNull();
        expect(result.efficiencyTierClearChance).toBeNull();
    });
});
