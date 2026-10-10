/**
 * Trigger optimizer runner: how a sim result becomes a sample, that the DTOs a
 * sim receives carry the candidate threshold, that seeds are shared across the
 * values being compared, and the tiny cases (nothing to tune, a solo party).
 * The simulator itself is a stub.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const sims = vi.hoisted(() => ({ calls: [], respond: null }));

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(async (params) => {
        sims.calls.push(params);
        return sims.respond(params);
    }),
    getMaxWorkers: () => 4,
}));
vi.mock('./combat-sim-adapter.js', () => ({
    calculateSimRevenue: (result, gameData, hrid) => ({ netPerHour: result.profit?.[hrid] || 0 }),
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));

const { runTriggerOptimization, sampleFromResult } = await import('./trigger-optimizer.js');
const { TRIGGER_OPTIMIZER_SETTING } = await import('./trigger-tuning.js');

const HOUR_NS = 3600 * 1e9;
const FIREBALL = '/abilities/fireball';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const HP = '/combat_trigger_conditions/current_hp';
const GTE = '/combat_trigger_comparators/greater_than_equal';

const gameData = {
    abilityDetailMap: {
        [FIREBALL]: {
            name: 'Fireball',
            defaultCombatTriggers: [{ dependencyHrid: TARGET, conditionHrid: HP, comparatorHrid: GTE, value: 1 }],
        },
    },
    itemDetailMap: {},
};

const dto = (hrid) => ({
    hrid,
    abilities: [null, { hrid: FIREBALL, level: 10, triggers: null }],
    food: [null, null, null],
    drinks: [null, null, null],
});

/** A result whose XP depends on the Fireball threshold the sim was handed */
function resultFor(params) {
    const threshold = params.playerDTOs[0].abilities[1].triggers?.[0]?.value ?? 1;
    const xp = 1000 - Math.abs(threshold - 300);
    return {
        simulatedTime: params.hours * HOUR_NS,
        experienceGained: { player1: { magic: xp * params.hours }, player2: { magic: 500 * params.hours } },
        deaths: { player1: 0, player2: 0 },
        totalDamageDealt: { player1: 100 * 3600 * params.hours, player2: 50 * 3600 * params.hours },
        encounters: 10 * params.hours,
        playerPools: { player1: { maxHitpoints: 1500, maxManapoints: 800 } },
        profit: {},
    };
}

beforeEach(() => {
    sims.calls = [];
    sims.respond = resultFor;
});

describe('sampleFromResult', () => {
    test('reads per-hour figures for each player and the pools', () => {
        const sample = sampleFromResult(
            {
                simulatedTime: 2 * HOUR_NS,
                experienceGained: { player1: { magic: 400, defense: 200 } },
                deaths: { player1: 4 },
                totalDamageDealt: { player1: 7200 * 100 },
                encounters: 20,
                playerPools: { player1: { maxHitpoints: 900, maxManapoints: 300 } },
                profit: { player1: 50 },
            },
            gameData,
            ['player1'],
            2
        );
        expect(sample.perPlayer.player1).toEqual({ xp: 300, profit: 50, deaths: 2, dps: 100 });
        expect(sample.encounters).toBe(10);
        expect(sample.pools.player1).toEqual({ hp: 900, mp: 300 });
    });

    test('a result with no clock falls back to the hours asked for', () => {
        const sample = sampleFromResult(
            { experienceGained: { player1: { a: 100 } }, deaths: {} },
            gameData,
            ['player1'],
            4
        );
        expect(sample.perPlayer.player1.xp).toBe(25);
    });
});

describe('runTriggerOptimization', () => {
    const base = {
        gameData,
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        communityBuffs: {},
        precision: 'quick',
    };

    test('reports nothing to tune when no trigger qualifies', async () => {
        const result = await runTriggerOptimization({
            ...base,
            playerDTOs: [
                { hrid: 'player1', abilities: [null, { hrid: '/abilities/x', triggers: null }], food: [], drinks: [] },
            ],
            playerIndex: 0,
        });
        expect(result.noTunables).toBe(true);
        expect(sims.calls).toHaveLength(0);
    });

    test('tunes the selected player, simulating the whole party on shared seeds', async () => {
        const result = await runTriggerOptimization({
            ...base,
            playerDTOs: [dto('player1'), dto('player2')],
            playerIndex: 0,
            scope: 'me',
            playerNames: { player1: 'Milkman' },
        });
        expect(result.scope).toBe('me');
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].playerName).toBe('Milkman');
        expect(Math.abs(result.changes[0].to - 300)).toBeLessThanOrEqual(15);
        // every sim carried both players, and the other player's Fireball was never touched
        expect(sims.calls.every((c) => c.playerDTOs.length === 2)).toBe(true);
        expect(sims.calls.every((c) => c.playerDTOs[1].abilities[1].triggers === null)).toBe(true);
        // sims are paired: the same seed list shows up for different threshold values
        const seedsByValue = new Map();
        for (const c of sims.calls) {
            const value = c.playerDTOs[0].abilities[1].triggers?.[0]?.value ?? 1;
            if (!seedsByValue.has(value)) seedsByValue.set(value, new Set());
            seedsByValue.get(value).add(c.seed);
        }
        const seedSets = [...seedsByValue.values()].map((s) => [...s].sort().join());
        expect(new Set(seedSets).size).toBeLessThanOrEqual(2);
        expect(sims.calls.every((c) => Number.isInteger(c.seed))).toBe(true);
    });

    test('whole-party scope tunes every member and judges the party total', async () => {
        const result = await runTriggerOptimization({
            ...base,
            playerDTOs: [dto('player1'), dto('player2')],
            playerIndex: 0,
            scope: 'party',
        });
        expect(result.scope).toBe('party');
        expect(result.tunableCount).toBe(2);
    });

    test('a solo sim ignores the party scope', async () => {
        const result = await runTriggerOptimization({
            ...base,
            playerDTOs: [dto('player1')],
            playerIndex: 0,
            scope: 'party',
        });
        expect(result.scope).toBe('me');
    });

    test('stopping returns what exists and does not throw on cancelled sims', async () => {
        let stop = false;
        sims.respond = (params) => {
            stop = true;
            throw new Error('cancelled');
        };
        const result = await runTriggerOptimization({ ...base, playerDTOs: [dto('player1')], playerIndex: 0 }, null, {
            abortSignal: () => stop,
        });
        expect(result).toBeNull();
    });

    test('the setting key matches', () => {
        expect(TRIGGER_OPTIMIZER_SETTING).toBe('combatSim_triggerOptimizer');
    });
});
