/**
 * The sim-config accessors are what exports quote as the conditions a sim ran
 * under, so these pin their defaults, their clamping, and that loading the sim
 * module wires them into the accuracy export.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getSkills: () => null, characterData: null, getInitClientData: () => null },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {}, onSocketEvent: () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: async () => null, getJSON: async () => null, set: async () => true, setJSON: async () => true },
}));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({}),
    getCommunityBuffs: () => ({}),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async () => ({}),
    runBlindBuffProbe: async () => [],
    runPlayerStatProbe: async () => null,
}));

const { getSimStopRule, getSimHours, getSimPrecisionPct, simCacheMethods } = await import('./labyrinth-sim-cache.js');
const { buildAccuracyExport } = await import('./labyrinth-accuracy-export.js');

afterEach(() => settings.map.clear());

describe('the sim stop rule', () => {
    test('defaults to one percentage point either side, bounded in trials', () => {
        expect(getSimStopRule()).toEqual({ targetHalfWidth: 0.01, minTrials: 100, maxTrials: 20000 });
    });

    test('the precision setting is clamped before it becomes a half-width', () => {
        settings.map.set('labyrinthSimPrecision', 0.01);
        expect(getSimPrecisionPct()).toBe(0.1);
        expect(getSimStopRule().targetHalfWidth).toBeCloseTo(0.001, 10);
        settings.map.set('labyrinthSimPrecision', 50);
        expect(getSimStopRule().targetHalfWidth).toBeCloseTo(0.1, 10);
    });

    test('the hour ceiling is floored and clamped', () => {
        expect(getSimHours()).toBe(3);
        settings.map.set('labyrinthRecommendSimHours', 500);
        expect(getSimHours()).toBe(100);
        settings.map.set('labyrinthRecommendSimHours', 2.9);
        expect(getSimHours()).toBe(2);
        settings.map.set('labyrinthRecommendSimHours', 0);
        expect(getSimHours()).toBe(3);
    });

    test('the mixin methods are the same functions the exports quote', () => {
        // One implementation, two doors: a drift between what sims run under
        // and what exports claim would be worse than either being wrong
        expect(simCacheMethods.getSimStopRule).toBe(getSimStopRule);
        expect(simCacheMethods.getSimHours).toBe(getSimHours);
        expect(simCacheMethods.getSimPrecisionPct).toBe(getSimPrecisionPct);
    });
});

describe('wiring into the accuracy export', () => {
    test('loading the sim module registers the config the export stamps', () => {
        settings.map.set('labyrinthRecommendSimHours', 7);
        const file = buildAccuracyExport({});
        expect(file.simConfig).toEqual({ stopRule: getSimStopRule(), hours: 7 });
    });
});
