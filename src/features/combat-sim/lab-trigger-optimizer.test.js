/**
 * Lab Sim trigger tuning: fights grouped per loadout, the measurement the search is handed (one
 * sample per seed across all of a loadout's fights, a fixed attempt count, the same seeds for
 * every setup), and the lab objective end to end — it prefers the threshold that lowers
 * Σ 1/win rate across the loadout's fights and rejects a "gain" that is only noise. The labyrinth
 * simulator itself is a stub.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const sims = vi.hoisted(() => ({ calls: [], respond: null }));

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(async (params) => {
        sims.calls.push(params);
        return sims.respond(params);
    }),
    getMaxWorkers: () => 4,
}));
vi.mock('./combat-sim-adapter.js', () => ({ calculateSimRevenue: () => ({ netPerHour: 0 }) }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
// A fixed run seed, so a stub whose luck comes from the seed answers the same way every run
vi.mock('./engine/rng.js', async (importOriginal) => ({ ...(await importOriginal()), randomSeed: () => 12345 }));

const {
    configureFightGroup,
    groupFightsByLoadout,
    groupFightsForScope,
    runLabTriggerOptimization,
    estimateLabTriggerRun,
    labSampleFromResults,
    labTrials,
    CURRENT_GEAR_KEY,
    LAB_MIN_GAIN,
} = await import('./lab-trigger-optimizer.js');
const { estimateTriggerSims, PRECISIONS } = await import('./trigger-tuning.js');
const { TRIAL_GAME_DATA } = await import('./engine/guild-trial-game-data.fixture.js');

const HOUR_NS = 3600 * 1e9;
const FIREBALL = '/abilities/fireball';
const DONUT = '/items/donut';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const SELF = '/combat_trigger_dependencies/self';
const HP = '/combat_trigger_conditions/current_hp';
const MISSING_HP = '/combat_trigger_conditions/missing_hp';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const FIRE_KEY = `player1|abilities|${FIREBALL}|0`;

const gameData = {
    abilityDetailMap: {
        [FIREBALL]: {
            name: 'Fireball',
            defaultCombatTriggers: [{ dependencyHrid: TARGET, conditionHrid: HP, comparatorHrid: GTE, value: 1 }],
        },
    },
    itemDetailMap: {
        [DONUT]: {
            name: 'Donut',
            consumableDetail: {
                defaultCombatTriggers: [
                    { dependencyHrid: SELF, conditionHrid: MISSING_HP, comparatorHrid: GTE, value: 100 },
                ],
            },
        },
    },
    actionDetailMap: { '/actions/combat/fly': {} },
};

/** A labyrinth loadout's DTO, in the shape `buildLabyrinthPlayerDTO` produces */
const loadoutDTO = ({ food = false } = {}) => ({
    hrid: 'player1',
    equipment: {
        '/equipment_types/two_hand': { hrid: '/items/rippling_trident', enhancementLevel: 5 },
        '/equipment_types/body': { hrid: '/items/sorcerer_robe_top', enhancementLevel: 3 },
    },
    abilities: [null, { hrid: FIREBALL, level: 30, triggers: null }, null, null, null],
    food: [food ? { hrid: DONUT, triggers: null } : null, null, null],
    drinks: [null, null, null],
});

const fight = (monster, loadoutId, loadoutName, extra = {}) => ({
    monsterHrid: `/monsters/${monster}`,
    monsterName: monster,
    roomLevel: 100,
    dto: loadoutDTO(),
    loadoutName,
    loadoutId,
    ...extra,
});

/** A repeatable number in [-1, 1) from a seed and a salt */
function jitter(seed, salt = '') {
    let h = 2166136261 ^ (Number(seed) >>> 0);
    const text = String(salt);
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    return ((h ^ (h >>> 15)) >>> 0) / 2147483648 - 1;
}

/**
 * A stub labyrinth: `winRate(monsterHrid, fireballThreshold)` decides each fight's win rate.
 * Every seed adds the same luck to every setup (that is what pairing buys), plus `noise` wins
 * that differ between setups on the same seed.
 */
function labyrinth(winRate, { noise = 0, seedLuck = 3 } = {}) {
    return (params) => {
        const trials = params.precision.maxTrials;
        const threshold = params.playerDTOs[0].abilities[1].triggers?.[0]?.value ?? 1;
        const p = winRate(params.monsterHrid, threshold);
        const luck = jitter(params.seed) * seedLuck + jitter(params.seed, threshold) * noise;
        // Not rounded: a stub may report fractional wins, which keeps small effects visible
        const wins = Math.max(0, Math.min(trials, trials * p + luck));
        return {
            labyAttemptCount: trials,
            encounters: wins,
            simulatedTime: trials * 40 * 1e9,
            experienceGained: { player1: { magic: 10 * trials } },
            deaths: { player1: trials - wins },
            totalDamageDealt: { player1: 100 * trials * 40 },
            playerPools: { player1: { maxHitpoints: 2000, maxManapoints: 1500 } },
            triggerChecks: { player1: { [FIREBALL]: 50 } },
        };
    };
}

beforeEach(() => {
    sims.calls = [];
});

describe('groupFightsByLoadout', () => {
    test('one group per saved loadout, the worn gear its own "current gear" group, in fight order', () => {
        const groups = groupFightsByLoadout([
            fight('cyclops', 3, 'Mage'),
            fight('mimic', 0, 'Current gear'),
            fight('gobbo', 3, 'Mage'),
            fight('jerry', 7, 'Tank'),
            fight('stalactite', null, 'Current gear'),
        ]);
        expect(groups.map((g) => [g.key, g.name, g.fights.map((f) => f.monsterName)])).toEqual([
            ['loadout:3', 'Mage', ['cyclops', 'gobbo']],
            [CURRENT_GEAR_KEY, 'Current gear', ['mimic', 'stalactite']],
            ['loadout:7', 'Tank', ['jerry']],
        ]);
    });

    test('two loadouts that share a name stay apart, keyed by id', () => {
        const groups = groupFightsByLoadout([fight('cyclops', 3, 'Mage'), fight('mimic', 4, 'Mage')]);
        expect(groups.map((g) => g.key)).toEqual(['loadout:3', 'loadout:4']);
    });
});

describe('groupFightsForScope', () => {
    const fights = () => [
        fight('cyclops', 3, 'Mage'),
        fight('mimic', 3, 'Mage'),
        fight('jerry', 7, 'Tank'),
        fight('gobbo', 0, 'Current gear'),
    ];

    test('all keeps every fight in its loadout group', () => {
        expect(groupFightsForScope(fights(), 'all').map((g) => [g.key, g.fights.length])).toEqual([
            ['loadout:3', 2],
            ['loadout:7', 1],
            [CURRENT_GEAR_KEY, 1],
        ]);
    });

    test('selected keeps only the chosen rooms, so a shared loadout shrinks and an emptied one is gone', () => {
        const groups = groupFightsForScope(fights(), 'selected', ['/monsters/mimic', '/monsters/gobbo']);
        expect(groups.map((g) => [g.key, g.fights.map((f) => f.monsterName)])).toEqual([
            ['loadout:3', ['mimic']],
            [CURRENT_GEAR_KEY, ['gobbo']],
        ]);
    });

    test('an empty chosen set, or the Configure scope, has no loadout groups', () => {
        expect(groupFightsForScope(fights(), 'selected', [])).toEqual([]);
        expect(groupFightsForScope(fights(), 'current')).toEqual([]);
    });
});

describe('configureFightGroup', () => {
    test('is one group keyed by the fight, never by a saved loadout, and estimates like any group', () => {
        const dto = loadoutDTO();
        const group = configureFightGroup({
            monsterHrid: '/monsters/mimic',
            monsterName: 'Mimic',
            roomLevel: 130,
            dto,
        });
        expect(group).toMatchObject({ key: 'configure:/monsters/mimic:130', configure: true, loadoutId: 0 });
        expect(group.key.startsWith('loadout:')).toBe(false);
        expect(group.fights).toEqual([
            {
                monsterHrid: '/monsters/mimic',
                monsterName: 'Mimic',
                roomLevel: 130,
                dto,
                loadoutName: 'Configure fight',
            },
        ]);
        const estimate = estimateLabTriggerRun({ groups: [group], gameData, precision: 'quick' });
        expect(estimate.groups.map((g) => [g.key, g.fights])).toEqual([['configure:/monsters/mimic:130', 1]]);
    });
});

describe('the cost estimate', () => {
    test("is the search's own estimate per loadout, times that loadout's fights", () => {
        const groups = groupFightsByLoadout([
            fight('cyclops', 3, 'Mage'),
            fight('gobbo', 3, 'Mage'),
            fight('jerry', 7, 'Tank', { dto: loadoutDTO({ food: true }) }),
        ]);
        // Food is never counted, even when a caller still passes the old 'both'
        const estimate = estimateLabTriggerRun({ groups, gameData, include: 'both', precision: 'quick' });
        expect(estimate.groups.map((g) => [g.tunables, g.fights])).toEqual([
            [1, 2],
            [1, 1],
        ]);
        expect(estimate.sims).toBe(estimateTriggerSims(1, 'quick') * 3);
        expect(estimate.trials.first).toBe(labTrials(PRECISIONS.quick.pointHours / PRECISIONS.quick.seeds));
        expect(estimateLabTriggerRun({ groups, gameData, include: 'consumables' }).groups[1].tunables).toBe(1);
    });
});

describe('a seed sample', () => {
    test('sums 1/win rate over the fights and reads a fight never won as half a win', () => {
        const sample = labSampleFromResults(
            [
                { labyAttemptCount: 100, encounters: 80, simulatedTime: HOUR_NS },
                { labyAttemptCount: 100, encounters: 0, simulatedTime: HOUR_NS },
            ],
            'player1',
            100
        );
        expect(sample.attempts).toBeCloseTo(1 / 0.8 + 1 / 0.005, 10);
        expect(sample.fights.map((f) => f.winRate)).toEqual([0.8, 0]);
        // Nothing to price: a food in a lab loadout is never left untuned for want of a price
        expect(sample.perPlayer.player1).toMatchObject({ profit: 0, unpriced: [], profitFailed: false });
    });

    test('trigger reads are summed over the fights, so a food used in one room counts as used', () => {
        const sample = labSampleFromResults(
            [
                { labyAttemptCount: 10, encounters: 5, triggerChecks: { player1: {} } },
                { labyAttemptCount: 10, encounters: 5, triggerChecks: { player1: { [DONUT]: 4 } } },
            ],
            'player1',
            10
        );
        expect(sample.triggerUse.player1[DONUT]).toBe(4);
    });
});

describe('runLabTriggerOptimization', () => {
    const twoFights = () => groupFightsByLoadout([fight('cyclops', 3, 'Mage'), fight('gobbo', 3, 'Mage')]);

    test('every sim plays a fixed number of attempts, and setups compared on a seed share it', async () => {
        sims.respond = labyrinth(() => 0.7);
        await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' });
        for (const call of sims.calls) {
            expect(call.precision.minTrials).toBe(call.precision.maxTrials);
            expect(call.labyrinthCombatBuffs).toEqual([]);
        }
        // The baseline's seeds: each fight of a seed has its own, and no two seeds share one
        const seeds = new Set(sims.calls.map((c) => `${c.monsterHrid}|${c.seed}`));
        const bySeed = new Map();
        for (const c of sims.calls) {
            const key = `${c.monsterHrid}|${c.seed}`;
            const threshold = c.playerDTOs[0].abilities[1].triggers?.[0]?.value ?? 1;
            if (!bySeed.has(key)) bySeed.set(key, new Set());
            bySeed.get(key).add(threshold);
        }
        // Some seed was run with more than one threshold: candidates are paired against the reference
        expect([...bySeed.values()].some((thresholds) => thresholds.size > 1)).toBe(true);
        expect(seeds.size).toBeGreaterThan(1);
    });

    test('prefers the threshold that lowers expected attempts across the loadout fights', async () => {
        // Cyclops wants Fireball held for a monster with at least ~300 HP left; the Gobbo does not care
        sims.respond = labyrinth((monster, threshold) =>
            monster === '/monsters/cyclops' ? 0.5 + 0.4 * Math.max(0, 1 - Math.abs(threshold - 300) / 300) : 0.8
        );
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'standard' });
        const [group] = run.groups;
        expect(group.name).toBe('Mage');
        const { result } = group;
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].key).toBe(FIRE_KEY);
        expect(result.changes[0].from).toBe(1);
        expect(Math.abs(result.changes[0].to - 300)).toBeLessThan(80);
        expect(result.changes[0].deltaScore).toBeGreaterThan(LAB_MIN_GAIN);
        expect(result.reliable).toBe(true);
        expect(result.combined.deltaScore).toBeGreaterThan(0);
        // The per-fight figures come from the all-together check: the Cyclops moves, the Gobbo does not
        const [cyclops, gobbo] = group.fights;
        expect(cyclops.tunedWinRate - cyclops.winRate).toBeGreaterThan(0.2);
        expect(gobbo.tunedWinRate).toBeCloseTo(gobbo.winRate, 2);
        expect(group.tunedAttempts).toBeLessThan(group.baselineAttempts);
        expect(run.stopped).toBe(false);
    });

    test('the shown before and after totals differ by exactly the saving, even with a seed that never won', async () => {
        // At the current threshold the Cyclops is nearly unwinnable: some seeds win it 0 times
        sims.respond = labyrinth(
            (monster, threshold) => (monster === '/monsters/cyclops' ? (threshold >= 200 ? 0.5 : 0.02) : 0.8),
            { seedLuck: 4 }
        );
        const zeroWinSeeds = () =>
            sims.calls.some((c) => c.monsterHrid === '/monsters/cyclops' && sims.respond(c).encounters === 0);
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' });
        const [group] = run.groups;
        expect(zeroWinSeeds()).toBe(true);
        // The all-together check ran (whether or not it then believed the change)
        expect(group.result.combined).not.toBeNull();
        expect(group.baselineAttempts - group.tunedAttempts).toBeCloseTo(group.result.combined.deltaScore, 6);
    });

    test('a "gain" inside the noise is rejected', async () => {
        // Every threshold wins 70% of the time; only per-setup luck tells them apart
        sims.respond = labyrinth(() => 0.7, { noise: 4 });
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' });
        expect(run.groups[0].result.changes).toEqual([]);
    });

    test('a run that accepts nothing still carries the best measured candidate', async () => {
        sims.respond = labyrinth(() => 0.7, { noise: 4 });
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' });
        const { result } = run.groups[0];
        expect(result.changes).toEqual([]);
        expect(result.bestMeasured).toBeTruthy();
        expect(Number.isFinite(result.bestMeasured.deltaScore)).toBe(true);
    });

    test('a real gain smaller than the minimum is not offered', async () => {
        // Noise-free and real: the Cyclops wins 70.5% instead of 70% at 300+, about 0.01 attempts saved
        const better = (monster, threshold) => (monster === '/monsters/cyclops' && threshold >= 300 ? 0.705 : 0.7);
        sims.respond = labyrinth(better, { seedLuck: 0 });
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' });
        expect(run.groups[0].result.changes).toEqual([]);
        // The control: with a lower bar the same gain is found, so the minimum is what refused it
        const lowBar = await runLabTriggerOptimization({
            gameData,
            groups: twoFights(),
            precision: 'quick',
            minGain: 0.005,
        });
        expect(lowBar.groups[0].result.changes).toHaveLength(1);
        expect(lowBar.groups[0].result.changes[0].deltaScore).toBeCloseTo(1 / 0.7 - 1 / 0.705, 6);
    });

    test('each loadout is tuned once, against its own fights only', async () => {
        sims.respond = labyrinth(() => 0.7);
        const groups = groupFightsByLoadout([
            fight('cyclops', 3, 'Mage'),
            fight('jerry', 7, 'Tank'),
            fight('gobbo', 3, 'Mage'),
        ]);
        const run = await runLabTriggerOptimization({ gameData, groups, precision: 'quick' });
        expect(run.groups.map((g) => [g.name, g.fights.map((f) => f.monsterName)])).toEqual([
            ['Mage', ['cyclops', 'gobbo']],
            ['Tank', ['jerry']],
        ]);
    });

    test('a loadout with nothing to tune runs no sims', async () => {
        sims.respond = labyrinth(() => 0.7);
        const groups = groupFightsByLoadout([
            fight('cyclops', 3, 'Mage', { dto: { ...loadoutDTO(), abilities: [null, null, null, null, null] } }),
        ]);
        const run = await runLabTriggerOptimization({ gameData, groups });
        expect(run.groups[0].result.noTunables).toBe(true);
        expect(sims.calls).toHaveLength(0);
    });

    test('a finished run ends its progress at the full total, and a stopped one does not', async () => {
        sims.respond = labyrinth(() => 0.7);
        const events = [];
        await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' }, (p) => events.push(p));
        const last = events[events.length - 1];
        expect(last.current).toBe(last.total);
        // The estimate is a worst case, so the run alone had not reached it
        expect(events.slice(0, -1).every((p) => p.current <= p.total)).toBe(true);

        let stop = false;
        const stoppedEvents = [];
        sims.respond = (params) => {
            stop = true;
            return labyrinth(() => 0.7)(params);
        };
        await runLabTriggerOptimization(
            { gameData, groups: twoFights(), precision: 'quick' },
            (p) => stoppedEvents.push(p),
            {
                abortSignal: () => stop,
            }
        );
        const stoppedLast = stoppedEvents[stoppedEvents.length - 1];
        expect(!stoppedLast || stoppedLast.current < stoppedLast.total).toBe(true);
    });

    test('a stop before the baseline finishes returns a stopped run with no result', async () => {
        sims.respond = labyrinth(() => 0.7);
        let stop = false;
        sims.respond = (params) => {
            stop = true;
            return labyrinth(() => 0.7)(params);
        };
        const run = await runLabTriggerOptimization({ gameData, groups: twoFights(), precision: 'quick' }, null, {
            abortSignal: () => stop,
        });
        expect(run.stopped).toBe(true);
        expect(run.groups[0].result).toBeNull();
    });
});

describe('runLabTriggerOptimization with the condition search', () => {
    const COFFEE = '/items/attack_coffee';
    const WASP = '/monsters/trial_wasp';
    const FRENZY_ON = {
        dependencyHrid: TARGET,
        conditionHrid: '/combat_trigger_conditions/frenzy',
        comparatorHrid: '/combat_trigger_comparators/is_active',
        value: 0,
    };
    const condGameData = {
        ...TRIAL_GAME_DATA,
        ...gameData,
        abilityDetailMap: { ...TRIAL_GAME_DATA.abilityDetailMap, ...gameData.abilityDetailMap },
        itemDetailMap: {
            ...gameData.itemDetailMap,
            [COFFEE]: {
                name: 'Attack Coffee',
                consumableDetail: {
                    buffs: [{ uniqueHrid: '/buff_uniques/attack_coffee' }],
                    defaultCombatTriggers: [
                        {
                            dependencyHrid: SELF,
                            conditionHrid: '/combat_trigger_conditions/attack_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            },
        },
    };
    const BURST = '/abilities/test_burst';
    condGameData.abilityDetailMap[BURST] = { name: 'Burst', defaultCombatTriggers: [] };
    const coffeeGroups = () =>
        groupFightsByLoadout([
            {
                monsterHrid: WASP,
                monsterName: 'Trial Wasp',
                roomLevel: 100,
                loadoutId: 3,
                loadoutName: 'Mage',
                dto: {
                    ...loadoutDTO({ food: true }),
                    abilities: [null, { hrid: BURST, level: 30, triggers: null }, null, null, null],
                    drinks: [{ hrid: COFFEE, triggers: null }, null, null],
                },
            },
        ]);
    /** A stub labyrinth where the ability pays off only when drunk while the wasp is frenzied */
    const frenzyCoffee = (params) => {
        const base = labyrinth(() => 0)(params);
        const rows = params.playerDTOs[0].abilities[1].triggers || [];
        const frenzied = rows.some(
            (r) =>
                r.dependencyHrid === TARGET &&
                r.conditionHrid === FRENZY_ON.conditionHrid &&
                r.comparatorHrid === FRENZY_ON.comparatorHrid
        );
        const trials = params.precision.maxTrials;
        const wins = Math.max(0, Math.min(trials, trials * (frenzied ? 0.85 : 0.6) + jitter(params.seed) * 2));
        return { ...base, encounters: wins, deaths: { player1: trials - wins } };
    };

    test('finds a condition the threshold tuner cannot, and reports it with per-fight win rates', async () => {
        sims.respond = frenzyCoffee;
        const groups = coffeeGroups();
        const estimate = estimateLabTriggerRun({
            groups,
            gameData: condGameData,
            precision: 'quick',
            searchConditions: true,
        });
        expect(estimate.sims).toBe(0);
        expect(estimate.conditionSims).toBeGreaterThan(0);

        const run = await runLabTriggerOptimization({
            gameData: condGameData,
            groups,
            precision: 'quick',
            searchConditions: true,
        });
        const [group] = run.groups;
        // Nothing for the threshold tuner: the ability has no rows to tune
        expect(group.result.noTunables).toBe(true);
        const { conditions } = group;
        expect(conditions.reliable).toBe(true);
        expect(conditions.changes).toHaveLength(1);
        expect(conditions.changes[0].itemHrid).toBe(BURST);
        // The coffee and the donut are never searched: the labyrinth allows no food or drink
        for (const call of sims.calls) expect(call.playerDTOs[0].drinks[0].triggers ?? null).toBeNull();
        expect(conditions.changes[0].toRows).toContainEqual(FRENZY_ON);
        expect(conditions.fights[0].tunedWinRate - conditions.fights[0].winRate).toBeGreaterThan(0.15);
        // Within the stated ceiling, and every sim a fixed attempt count
        expect(sims.calls.length).toBeLessThanOrEqual(estimate.conditionSims);
        for (const call of sims.calls) expect(call.precision.minTrials).toBe(call.precision.maxTrials);
    });

    test('the sim cap stops the condition search where it stands', async () => {
        sims.respond = frenzyCoffee;
        const run = await runLabTriggerOptimization({
            gameData: condGameData,
            groups: coffeeGroups(),
            precision: 'quick',
            searchConditions: true,
            maxConditionSims: 1,
        });
        expect(run.groups[0].conditions.capped).toBe(true);
        expect(run.groups[0].conditions.changes).toEqual([]);
        expect(run.conditionSimCount).toBeLessThanOrEqual(1);
    });

    test('the sim cap is a real bound: no batch is launched past it', async () => {
        sims.respond = frenzyCoffee;
        for (const cap of [20, 60, 150]) {
            const run = await runLabTriggerOptimization({
                gameData: condGameData,
                groups: coffeeGroups(),
                precision: 'quick',
                searchConditions: true,
                maxConditionSims: cap,
            });
            expect(run.conditionSimCount).toBeLessThanOrEqual(cap);
            if (cap < 60) expect(run.groups[0].conditions.capped).toBe(true);
        }
    });

    test('off by default: no condition search runs', async () => {
        sims.respond = frenzyCoffee;
        const run = await runLabTriggerOptimization({
            gameData: condGameData,
            groups: coffeeGroups(),
        });
        expect(run.groups[0].conditions).toBeUndefined();
        expect(sims.calls).toHaveLength(0);
    });
});
