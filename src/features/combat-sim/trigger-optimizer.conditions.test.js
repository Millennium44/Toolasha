/**
 * The Combat Sim's opt-in "Search new conditions": after the threshold tuner it tries different trigger
 * conditions (not just different numbers) on the selected player's slots, scored on the run's objective.
 * The simulator is a stub whose XP rises when Fireball's rows include "my missing HP >= 375".
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
    seedSimPriceCache: (cache) => cache,

    calculateSimRevenue: (result) => ({
        netPerHour: result.profitRate || 0,
        unpricedDrops: result.unpricedDrops || [],
    }),
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
const prices = vi.hoisted(() => ({ map: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => prices.map[hrid] ?? null }));

const { runTriggerOptimization, estimateConditionRun, zoneMonsterHrids, monsterMaxHpReader } =
    await import('./trigger-optimizer.js');

const HOUR_NS = 3600 * 1e9;
const FIREBALL = '/abilities/fireball';
const SELF = '/combat_trigger_dependencies/self';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const HP = '/combat_trigger_conditions/current_hp';
const MP = '/combat_trigger_conditions/current_mp';
const MISSING_HP = '/combat_trigger_conditions/missing_hp';
const MISSING_MP = '/combat_trigger_conditions/missing_mp';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';

const gameData = {
    abilityDetailMap: {
        [FIREBALL]: {
            name: 'Fireball',
            defaultCombatTriggers: [{ dependencyHrid: TARGET, conditionHrid: HP, comparatorHrid: GTE, value: 1 }],
        },
    },
    itemDetailMap: {},
    combatTriggerDependencyDetailMap: { [SELF]: { name: 'Me' }, [TARGET]: { name: 'Target enemy' } },
    combatTriggerConditionDetailMap: {
        [HP]: { name: 'Hp', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
        [MP]: { name: 'Mp', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
        [MISSING_HP]: { name: 'Missing Hp', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
        [MISSING_MP]: { name: 'Missing Mp', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
    },
    combatTriggerComparatorDetailMap: {},
    actionDetailMap: {},
};

const dto = () => ({
    hrid: 'player1',
    abilities: [null, { hrid: FIREBALL, level: 10, triggers: null }],
    food: [null, null, null],
    drinks: [null, null, null],
});

/** XP is 1000, plus 50 when Fireball keeps its HP row and adds "missing HP >= 375". The threshold of the default row is irrelevant. */
function respond(params) {
    const rows = params.playerDTOs[0].abilities[1].triggers || [];
    const lucky =
        rows.length === 2 &&
        rows[0].conditionHrid === HP &&
        rows[1].conditionHrid === MISSING_HP &&
        Number(rows[1].value) === 375;
    return {
        simulatedTime: params.hours * HOUR_NS,
        experienceGained: { player1: { magic: (1000 + (lucky ? 50 : 0)) * params.hours } },
        deaths: { player1: 0 },
        totalDamageDealt: { player1: 100 * 3600 * params.hours },
        encounters: 10 * params.hours,
        playerPools: { player1: { maxHitpoints: 1500, maxManapoints: 800 } },
    };
}

const base = {
    gameData,
    playerDTOs: [dto()],
    playerIndex: 0,
    zoneHrid: '/actions/combat/fly',
    difficultyTier: 0,
    communityBuffs: {},
    precision: 'quick',
    objective: 'xp',
};

beforeEach(() => {
    sims.calls = [];
    sims.respond = respond;
});

describe('a food or drink with no market price is never condition-searched', () => {
    const COFFEE = '/items/wisdom_coffee';
    const withCoffee = () => ({ ...dto(), drinks: [{ hrid: COFFEE, triggers: null }, null, null] });
    const gd = {
        ...gameData,
        itemDetailMap: { [COFFEE]: { name: 'Wisdom Coffee', consumableDetail: { defaultCombatTriggers: [] } } },
    };
    const drinkEdited = () => sims.calls.some((c) => (c.playerDTOs[0].drinks?.[0]?.triggers || []).length > 0);

    test('an unpriced drink slot is left out', async () => {
        prices.map = {};
        await runTriggerOptimization({ ...base, gameData: gd, playerDTOs: [withCoffee()], searchConditions: true });
        expect(drinkEdited()).toBe(false);
    });

    test('a priced drink slot is still searched', async () => {
        prices.map = { [COFFEE]: 500 };
        await runTriggerOptimization({ ...base, gameData: gd, playerDTOs: [withCoffee()], searchConditions: true });
        expect(drinkEdited()).toBe(true);
        prices.map = {};
    });
});

describe('Combat Sim condition search', () => {
    test('off by default: no condition sims, no conditions block', async () => {
        const result = await runTriggerOptimization({ ...base });
        expect(result.conditions).toBeUndefined();
        expect(result.conditionSimCount).toBeUndefined();
        // every sim ran Fireball on its own single row (or the default): nothing was ANDed
        expect(sims.calls.every((c) => (c.playerDTOs[0].abilities[1].triggers || []).length <= 1)).toBe(true);
    });

    test('on: finds a "current AND X" condition that beats the current one, in the objective score points', async () => {
        const result = await runTriggerOptimization({ ...base, searchConditions: true });
        const found = result.conditions.changes;
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ key: 'abilities|1', itemName: 'Fireball', kind: 'and-current' });
        expect(found[0].fromRows).toHaveLength(1);
        expect(found[0].toRows).toHaveLength(2);
        expect(found[0].toRows[1]).toMatchObject({ dependencyHrid: SELF, conditionHrid: MISSING_HP, value: 375 });
        // +50 on 1000 EXP/h is +5 points of the XP objective
        expect(found[0].deltaScore).toBeCloseTo(5, 1);
        expect(result.conditions.reliable).toBe(true);
        expect(result.conditions.combined.deltaScore).toBeCloseTo(5, 1);
        expect(result.conditions.slotCount).toBe(1);
        expect(result.conditionSimCount).toBeGreaterThan(0);
        // the sims it counted are the sims it ran on top of the threshold tuner's
        const withoutConditions = sims.calls.length - result.conditionSimCount;
        sims.calls = [];
        await runTriggerOptimization({ ...base });
        expect(sims.calls.length).toBe(withoutConditions);
    });

    test('when nothing helps, the best candidate measured is kept for the best-found line', async () => {
        sims.respond = (params) => ({
            ...respond(params),
            experienceGained: { player1: { magic: 1000 * params.hours } },
        });
        const result = await runTriggerOptimization({ ...base, searchConditions: true });
        expect(result.conditions.changes).toHaveLength(0);
        expect(result.conditions.bestMeasured).toHaveLength(1);
        expect(Number.isFinite(result.conditions.bestMeasured[0].deltaScore)).toBe(true);
    });

    test('the sim cap is a real bound on the condition search', async () => {
        const free = await runTriggerOptimization({ ...base, searchConditions: true });
        const cap = Math.floor(free.conditionSimCount / 2);
        sims.calls = [];
        const capped = await runTriggerOptimization({ ...base, searchConditions: true, maxConditionSims: cap });
        expect(capped.conditionSimCount).toBeLessThanOrEqual(cap);
        expect(capped.conditionSimCount).toBeLessThan(free.conditionSimCount);
        expect(capped.conditions.capped).toBe(true);
        // and the count is the sims actually launched, not a guess
        const plain = sims.calls.length - capped.conditionSimCount;
        sims.calls = [];
        await runTriggerOptimization({ ...base });
        expect(sims.calls.length).toBe(plain);
    });

    test('a candidate with an unpriced drop is not judged on a different objective from its reference', async () => {
        // The scoring baseline (7.5 h per seed) earns more than every other batch, so references sit below it in
        // profit while XP is identical everywhere. The ANDed candidate also gains an unpriced drop and nothing else.
        sims.respond = (params) => {
            const rows = params.playerDTOs[0].abilities[1].triggers || [];
            const andsMissingHp = rows.length === 2 && rows[1].conditionHrid === MISSING_HP && rows[1].value === 375;
            return {
                ...respond(params),
                experienceGained: { player1: { magic: 1000 * params.hours } },
                profitRate: params.hours === 7.5 ? 1500 : 1000,
                unpricedDrops: andsMissingHp ? ['/items/mystery'] : [],
            };
        };
        const result = await runTriggerOptimization({ ...base, objective: 'balanced', searchConditions: true });
        // Mixed rules would score the candidate without profit (0) against a reference with a negative profit term
        // (it ran shorter than the baseline) and call the difference a win
        expect(result.conditions.changes).toHaveLength(0);
        for (const best of result.conditions.bestMeasured) expect(best.deltaScore).toBeLessThan(0.5);
        // …and the results say profit was left out, naming the item, so the footer does not claim it averaged in
        expect(result.profitLeftOut).toBe(true);
        expect(result.unpriced).toContain('/items/mystery');
    });

    test('an unpriced drop in the condition baseline alone still marks profit as left out', async () => {
        sims.respond = (params) => ({
            ...respond(params),
            profitRate: 1000,
            // Only the condition search's own baseline batch (7.5 h per seed) sees the unpriced drop
            unpricedDrops: params.hours === 7.5 ? ['/items/mystery'] : [],
        });
        const result = await runTriggerOptimization({ ...base, objective: 'balanced', searchConditions: true });
        expect(result.profitLeftOut).toBe(true);
        expect(result.unpriced).toContain('/items/mystery');
    });

    test('Profit/h skips the condition search once the threshold phase could not value profit', async () => {
        sims.respond = (params) => ({
            ...respond(params),
            profitRate: 1000,
            // Unpriced everywhere except the condition baseline batch
            unpricedDrops: params.hours === 7.5 ? [] : ['/items/mystery'],
        });
        const result = await runTriggerOptimization({ ...base, objective: 'profit', searchConditions: true });
        expect(result.profitLeftOut).toBe(true);
        expect(result.conditions.skipped).toBe('profit');
        expect(result.conditions.changes).toEqual([]);
    });

    test('Profit/h withholds threshold changes when only the condition baseline cannot value profit', async () => {
        // Profit peaks with Fireball's row at 300. Only the condition search's own baseline (the first 7.5 h
        // batch after the threshold phase) sees an unpriced drop, so the threshold phase valued everything
        let unpricedFrom = Infinity;
        sims.respond = (params) => {
            const v = Number(params.playerDTOs[0].abilities[1].triggers?.[0]?.value ?? 1);
            return {
                ...respond(params),
                profitRate: 1000 + 400 - Math.min(400, Math.abs(v - 300)),
                unpricedDrops: params.hours === 7.5 && sims.calls.length > unpricedFrom ? ['/items/mystery'] : [],
            };
        };
        const withoutConditions = await runTriggerOptimization({ ...base, objective: 'profit', minGain: 0.5 });
        expect(withoutConditions.changes.length).toBeGreaterThan(0);
        expect(withoutConditions.profitLeftOut).toBeFalsy();
        unpricedFrom = sims.calls.length;
        sims.calls = [];
        unpricedFrom = withoutConditions.simCount;

        const result = await runTriggerOptimization({
            ...base,
            objective: 'profit',
            minGain: 0.5,
            searchConditions: true,
        });
        expect(result.conditions.skipped).toBe('profit');
        expect(result.profitLeftOut).toBe(true);
        expect(result.unpriced).toContain('/items/mystery');
        expect(result.changes).toEqual([]);
        expect(result.rejected.length).toBeGreaterThan(0);
        expect(result.reliable).toBe(false);
        expect(result.conditions.afterThresholds).toBe(false);
    });

    test('enemy-HP candidates use the zone HP at each spawn tier plus the selected tier', async () => {
        const SLIME = '/monsters/slime';
        const ZONE = '/actions/combat/slimes';
        const zoned = {
            ...gameData,
            actionDetailMap: {
                [ZONE]: {
                    combatZoneInfo: {
                        fightInfo: {
                            randomSpawnInfo: {
                                spawns: [{ combatMonsterHrid: SLIME, difficultyTier: 3, rate: 1, strength: 1 }],
                                maxSpawnCount: 1,
                                maxTotalStrength: 1,
                            },
                        },
                    },
                },
            },
            combatMonsterDetailMap: {
                [SLIME]: {
                    experience: 10,
                    enrageTime: 300 * 1e9,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 10,
                        intelligenceLevel: 1,
                        attackLevel: 1,
                        meleeLevel: 1,
                        defenseLevel: 1,
                        rangedLevel: 1,
                        magicLevel: 1,
                        attackInterval: 3e9,
                        combatStats: { combatStyleHrids: ['/combat_styles/smash'], attackInterval: 0 },
                    },
                },
            },
        };
        const hpAt = (tier) => monsterMaxHpReader(zoned)(SLIME, tier);
        expect(hpAt(3)).not.toBe(hpAt(0));
        await runTriggerOptimization({ ...base, gameData: zoned, zoneHrid: ZONE, searchConditions: true });
        const targetValues = new Set(
            sims.calls
                .flatMap((c) => c.playerDTOs[0].abilities[1].triggers || [])
                .filter((r) => r.dependencyHrid === TARGET && r.conditionHrid === HP)
                .map((r) => Number(r.value))
        );
        // half the monster's HP at its spawn tier (3): not at tier 0, which dropping the spawn's tier would give
        expect(targetValues.has(Math.round(hpAt(3) * 0.5))).toBe(true);
        expect(targetValues.has(Math.round(hpAt(0) * 0.5))).toBe(false);
    });

    test('a cap too small for even the scoring baseline runs no condition sims', async () => {
        const result = await runTriggerOptimization({ ...base, searchConditions: true, maxConditionSims: 2 });
        expect(result.conditionSimCount).toBe(0);
        expect(result.conditions.skipped).toBe('cap');
    });

    test('Stop before the condition search leaves it unrun; a stop during it reports stopped', async () => {
        let stopAfter = Infinity;
        const result = await runTriggerOptimization({ ...base, searchConditions: true }, null, {
            abortSignal: () => sims.calls.length >= stopAfter,
        });
        expect(result.stopped).toBe(false);
        const full = sims.calls.length;
        sims.calls = [];
        stopAfter = full - 20;
        const stopped = await runTriggerOptimization({ ...base, searchConditions: true }, null, {
            abortSignal: () => sims.calls.length >= stopAfter,
        });
        expect(stopped.stopped).toBe(true);
        expect(sims.calls.length).toBeLessThan(full);
    });

    test('with nothing for the threshold tuner, the condition search still runs', async () => {
        const noRows = {
            ...dto(),
            abilities: [
                null,
                {
                    hrid: FIREBALL,
                    level: 10,
                    triggers: [{ dependencyHrid: SELF, conditionHrid: HP, comparatorHrid: LTE, value: 0 }],
                },
            ],
        };
        // a "self HP <= 0" row is not an enemy-HP / pool threshold the tuner moves, so only conditions are searched
        const result = await runTriggerOptimization({ ...base, playerDTOs: [noRows], searchConditions: true });
        expect(result.noTunables).toBe(true);
        expect(result.conditions).toBeDefined();
        expect(result.conditions.slotCount).toBe(1);
    });

    test('the estimate counts slots, candidates and a capped sim total', () => {
        const estimate = estimateConditionRun({ gameData, dto: dto(), zoneHrid: base.zoneHrid, precision: 'quick' });
        expect(estimate.slots).toBe(1);
        expect(estimate.counts[0]).toBeGreaterThan(0);
        expect(estimate.sims).toBeGreaterThan(0);
        expect(estimateConditionRun({ gameData, dto: dto(), zoneHrid: base.zoneHrid, maxConditionSims: 10 }).sims).toBe(
            10
        );
        expect(estimateConditionRun({ gameData, dto: { ...dto(), abilities: [] }, zoneHrid: base.zoneHrid }).sims).toBe(
            0
        );
    });

    test('zoneMonsterHrids reads random, boss and dungeon spawns once each', () => {
        const data = {
            actionDetailMap: {
                '/actions/combat/z': {
                    combatZoneInfo: {
                        fightInfo: {
                            randomSpawnInfo: {
                                spawns: [{ combatMonsterHrid: '/monsters/a' }, { combatMonsterHrid: '/monsters/b' }],
                            },
                            bossSpawns: [{ combatMonsterHrid: '/monsters/a' }],
                        },
                        dungeonInfo: {
                            randomSpawnInfoMap: { 1: { spawns: [{ combatMonsterHrid: '/monsters/c' }] } },
                            fixedSpawnsMap: { 2: [{ combatMonsterHrid: '/monsters/d' }] },
                        },
                    },
                },
            },
        };
        expect(zoneMonsterHrids(data, '/actions/combat/z').sort()).toEqual([
            '/monsters/a',
            '/monsters/b',
            '/monsters/c',
            '/monsters/d',
        ]);
        expect(zoneMonsterHrids(data, '/actions/combat/missing')).toEqual([]);
    });
});
