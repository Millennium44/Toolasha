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
    cancelSimulation: () => {},
}));

const {
    getSimStopRule,
    getSimHours,
    getSimPrecisionPct,
    simCacheMethods,
    resolveSimStopRule,
    resolveDecisionStopRule,
    resolveSimHours,
    getAutomationSimPrecisionPct,
    getAutomationUncapped,
    automationSimOptions,
    UNCAPPED_MAX_SIM_TRIALS,
} = await import('./labyrinth-sim-cache.js');
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

/**
 * "Uncapped" is a promise about which stopping rule applies, and the one thing
 * it must not mean is "runs forever" — a tab that never answers is worse than a
 * wide answer. So both halves are pinned: the ordinary ceiling is genuinely
 * lifted, and the backstop it is lifted to is finite and far above anything the
 * tightest precision the input allows could need.
 */
describe('resolving the fight cap', () => {
    test('capped is the ordinary ceiling', () => {
        expect(resolveSimStopRule({ uncapped: false }).maxTrials).toBe(20000);
    });

    test('uncapped lifts it to the backstop, which is finite', () => {
        const rule = resolveSimStopRule({ uncapped: true });
        expect(rule.maxTrials).toBe(UNCAPPED_MAX_SIM_TRIALS);
        expect(rule.maxTrials).toBe(20000 * 100);
        expect(Number.isFinite(rule.maxTrials)).toBe(true);
    });

    test('the precision target is untouched by the cap, and the floor on trials stays', () => {
        settings.map.set('labyrinthSimPrecision', 2);
        const capped = resolveSimStopRule({ uncapped: false });
        const uncapped = resolveSimStopRule({ uncapped: true });
        expect(uncapped.targetHalfWidth).toBe(capped.targetHalfWidth);
        expect(uncapped.minTrials).toBe(capped.minTrials);
    });

    test('an explicit precision overrides the configured one, clamped the same way', () => {
        settings.map.set('labyrinthSimPrecision', 2);
        expect(resolveSimStopRule({ precisionPct: 0.5 }).targetHalfWidth).toBeCloseTo(0.005, 10);
        // Out of range and unusable values both fall back to the sane end
        expect(resolveSimStopRule({ precisionPct: 99 }).targetHalfWidth).toBeCloseTo(0.1, 10);
        expect(resolveSimStopRule({ precisionPct: 0 }).targetHalfWidth).toBeCloseTo(0.02, 10);
    });

    test('a decision run gives up later when uncapped, not never', () => {
        expect(resolveDecisionStopRule({ decideAgainst: 0.7 }).maxTrials).toBe(4000);
        expect(resolveDecisionStopRule({ decideAgainst: 0.7, uncapped: true }).maxTrials).toBe(400000);
        expect(resolveDecisionStopRule({ decideAgainst: 0.7, uncapped: true }).decideAgainst).toBe(0.7);
    });

    test('the clock is lifted too, so time never binds before the backstop does', () => {
        expect(resolveSimHours(false)).toBe(3);
        expect(resolveSimHours(true)).toBe(100000);
    });
});

/**
 * The Automation tab's precision is its own knob, but an untouched install must
 * keep following the map's — cached results are keyed on the precision they were
 * run at, so a default that differed would silently re-sim every room.
 */
describe('the Automation tab’s own sim settings', () => {
    test('unset, it follows the floor map’s precision', () => {
        settings.map.set('labyrinthSimPrecision', 2.5);
        expect(getAutomationSimPrecisionPct()).toBe(2.5);
    });

    test('set, it wins, clamped to the input’s range', () => {
        settings.map.set('labyrinthSimPrecision', 2.5);
        settings.map.set('labyrinthAutomationSimPrecision', 0.5);
        expect(getAutomationSimPrecisionPct()).toBe(0.5);
        settings.map.set('labyrinthAutomationSimPrecision', 40);
        expect(getAutomationSimPrecisionPct()).toBe(10);
    });

    test('the options handed to every automation sim carry both knobs', () => {
        settings.map.set('labyrinthAutomationSimPrecision', 3);
        expect(automationSimOptions()).toEqual({ precisionPct: 3, uncapped: false });
        expect(getAutomationUncapped()).toBe(false);
    });
});
