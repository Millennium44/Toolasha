/**
 * The trigger search valued by the real `calculateSimRevenue`, with a stub
 * simulator whose counters are set by the food threshold it is handed.
 *
 * These pin how profit enters the search: a break-even baseline must still see
 * a loss, prices that move during a run must not look like a trigger effect,
 * and an item nothing can price must not make a change look profitable.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ prices: {}, respond: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }) },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => null, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    guildMemberSkills: () => null,
    loadoutSnapshot: () => ({}),
    expectedValueCalculator: () => null,
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => mocks.prices[hrid] || null },
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, calculateSingleContainer: () => null },
}));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));
// Every price the sim reads comes off `mocks.prices`, at the ask
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => {
        const price = mocks.prices[hrid]?.ask;
        return price > 0 ? price : null;
    },
    getItemPrices: () => ({}),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));
vi.mock('./combat-sim-runner.js', () => ({
    getMaxWorkers: () => 1,
    runSimulation: async (params) => mocks.respond(params),
}));

const { runTriggerOptimization } = await import('./trigger-optimizer.js');

const MONSTER = '/monsters/fly';
const ZONE = '/actions/combat/fly';
const ROW = {
    dependencyHrid: '/combat_trigger_dependencies/self',
    conditionHrid: '/combat_trigger_conditions/missing_hp',
    comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
    value: 100,
};

/**
 * One player with one food whose trigger is tuned. Each fly drops `dropCount`
 * of `dropHrid`; `counters(threshold)` sets the per-hour rates the stub sim
 * reports for a threshold.
 */
function scenario({ food = '/items/donut', dropHrid = '/items/coin', dropCount = 10, counters, objective, onSim }) {
    const gameData = {
        itemDetailMap: { [food]: { name: 'Donut', consumableDetail: { defaultCombatTriggers: [ROW] } } },
        abilityDetailMap: {},
        combatMonsterDetailMap: {
            [MONSTER]: {
                dropTable: [
                    { itemHrid: dropHrid, dropRate: 1, minCount: dropCount, maxCount: dropCount, minDifficultyTier: 0 },
                ],
            },
        },
        actionDetailMap: { [ZONE]: { combatZoneInfo: { fightInfo: { randomSpawnInfo: { maxSpawnCount: 1 } } } } },
    };
    const playerDTOs = [{ hrid: 'player1', abilities: [], food: [{ hrid: food, triggers: null }], drinks: [] }];
    mocks.respond = (p) => {
        onSim?.();
        const threshold = p.playerDTOs[0].food[0].triggers?.[0]?.value ?? 100;
        const c = counters(threshold);
        const h = p.hours;
        return {
            simulatedTime: h * 3600 * 1e9,
            numberOfPlayers: 1,
            difficultyTier: 0,
            zoneName: ZONE,
            isDungeon: false,
            deaths: { player1: 0, [MONSTER]: c.kills * h },
            experienceGained: { player1: { stamina: c.xp * h } },
            encounters: c.kills * h,
            totalDamageDealt: { player1: c.dps * h * 3600 },
            dropRateMultiplier: { player1: 1 },
            rareFindMultiplier: { player1: 1 },
            combatDropQuantity: { player1: 0 },
            debuffOnLevelGap: { player1: 0 },
            playerPools: { player1: { maxHitpoints: 1000, maxManapoints: 500 } },
            consumablesUsed: { player1: c.food ? { [food]: c.food * h } : {} },
        };
    };
    return {
        gameData,
        playerDTOs,
        playerIndex: 0,
        zoneHrid: ZONE,
        difficultyTier: 0,
        communityBuffs: {},
        precision: 'quick',
        minGain: 0.5,
        objective,
    };
}

/**
 * The review's break-even fight: 500 flies/h dropping 10 coin each, 10 donuts/h
 * at 500. Any lower threshold eats 100 donuts/h for 1% more of everything else.
 */
const eatMore = (threshold) => {
    const gain = threshold < 100 ? 1.01 : 1;
    return { kills: 500 * gain, xp: 1000 * gain, dps: 100 * gain, food: threshold < 100 ? 100 : 10 };
};

beforeEach(() => {
    mocks.prices = {};
});

describe('a zero-profit baseline', () => {
    test('a 44,950 gold/h loss is not offered for 1% more XP, DPS and encounters', async () => {
        mocks.prices['/items/donut'] = { ask: 500 };
        const params = scenario({ counters: eatMore });
        const result = await runTriggerOptimization(params);
        expect(result.baseline.profit).toBe(0);
        expect(result.changes).toHaveLength(0);
        expect(result.reliable).not.toBe(true);
    });

    test('the same change from +0.10 gold/h is rejected the same way', async () => {
        mocks.prices['/items/donut'] = { ask: 499.99 };
        const result = await runTriggerOptimization(scenario({ counters: eatMore }));
        expect(result.baseline.profit).toBeCloseTo(0.1, 6);
        expect(result.changes).toHaveLength(0);
    });

    test('a gain from break-even is found under Profit/h', async () => {
        mocks.prices['/items/donut'] = { ask: 500 };
        const eatLess = (threshold) => ({ kills: 500, xp: 1000, dps: 100, food: threshold < 100 ? 5 : 10 });
        const result = await runTriggerOptimization(scenario({ counters: eatLess, objective: 'profit' }));
        expect(result.baseline.profit).toBe(0);
        expect(result.changes.length).toBeGreaterThan(0);
        expect(result.reliable).toBe(true);
        expect(result.combined.deltaProfit).toBeCloseTo(2500, 6);
    });
});
