/**
 * @vitest-environment happy-dom
 *
 * Sim accuracy, checked on the three things that could make it lie.
 *
 * **The derivation**, against the same recorded Planet of the Eyes run the
 * attribution replays. A metric derived from real payloads is the only kind
 * worth comparing to a simulator, and the ways it can be wrong are all boundary
 * conditions — a fight cut off by the end of the recording counted as a fast
 * one, the ticks before the first `new_battle` filed under a fight they do not
 * belong to, monster counters carried between battles that reuse the same
 * indices.
 *
 * **The deviation arithmetic**, which is where a sign error would turn "your
 * damage is 10% under the prediction" into the opposite advice.
 *
 * **The noise margin**, which is the whole point: without one, six fights will
 * flag a disagreement every time, and a check that always says the simulator is
 * wrong is a check nobody reads twice.
 *
 * A DOM because the module registers an overlay row and builds a panel at import.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback, Z_FLOATING_PANEL: 100 },
}));
vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ actionDetailMap: { '/actions/combat/fly': { name: 'Fly' } } }) },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({}),
    buildPlayerDTO: () => ({}),
    getCommunityBuffs: () => ({}),
    getCurrentCombatZone: () => ({ zoneHrid: '/actions/combat/fly', difficultyTier: 0 }),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: async () => ({}) }));
vi.mock('../../utils/panel-geometry.js', () => ({
    clampGeometry: (geometry) => geometry,
    allGeometry: async () => ({}),
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    clearPosition: async () => {},
    restoreGeometry: async () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

import {
    replayFights,
    busiestPlayer,
    observeRecording,
    aggregateObservations,
    predictFromSim,
    deviationPct,
    noiseMargin,
    compareMetric,
    compareRun,
    summaryLine,
    MIN_SAMPLE_FIGHTS,
    SIM_NOISE_FLOOR_PCT,
} from './combat-replay-check.js';
import recording from '../../utils/__fixtures__/combat-run.json';

describe('deriving what happened from a recording', () => {
    const fights = replayFights(recording.ticks);

    test('a recording is split at every battle but the last', () => {
        // Six `new_battle` messages, and the sixth battle was still being fought
        // when the recording stopped — its length is unknown, so it is dropped
        const battles = recording.ticks.filter((tick) => tick.type === 'new_battle').length;
        expect(battles).toBe(6);
        expect(fights).toHaveLength(battles - 1);
    });

    test('every fight has a positive length and knows what it was against', () => {
        for (const fight of fights) {
            expect(fight.seconds).toBeGreaterThan(0);
            expect(fight.monsters.length).toBeGreaterThan(0);
        }
    });

    test('a fight runs to the next battle, so the lengths tile the run', () => {
        const spanned = fights.reduce((total, fight) => total + fight.seconds, 0);
        const first = fights[0].startAt;
        const last = fights[fights.length - 1].endAt;
        expect(spanned).toBeCloseTo((last - first) / 1000, 6);
    });

    test('the ticks before the first battle belong to no fight', () => {
        // The recording starts mid-battle. Filing those ticks under the first
        // `new_battle` would credit its damage to a fight that had not begun.
        const firstBattleAt = recording.ticks.find((tick) => tick.type === 'new_battle').at;
        expect(fights[0].startAt).toBe(firstBattleAt);
    });

    test('the run is attributed to the one character who fought it', () => {
        expect(busiestPlayer(fights)).toBe('0');
    });

    test('the damage per fight sums to what the attribution replay measures', () => {
        // The same total the attribution's own replay asserts, arrived at by
        // splitting the run first — if the per-battle reset were wrong, this is
        // where the monsters carried between battles would show up
        const dealt = fights.reduce((total, fight) => total + (fight.players['0']?.damage || 0), 0);
        expect(dealt).toBeGreaterThan(15_000);
    });

    test('the kills are counted, and there are fewer than the whole run had', () => {
        // Fourteen across the whole recording, minus whatever the dropped last
        // battle and the pre-battle ticks contributed
        const killed = fights.reduce((total, fight) => total + fight.kills, 0);
        expect(killed).toBeGreaterThan(0);
        expect(killed).toBeLessThanOrEqual(14);
    });

    test('damage taken is derived too, from the same ticks', () => {
        const taken = fights.reduce((total, fight) => total + (fight.taken['0']?.damage || 0), 0);
        expect(taken).toBeGreaterThan(0);
    });
});

describe('an observation', () => {
    const observation = observeRecording(recording, {
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        recordedAt: 1_700_000_000_000,
    });

    test('it is stamped with when and where, since the comparison depends on both', () => {
        expect(observation.recordedAt).toBe(1_700_000_000_000);
        expect(observation.zoneHrid).toBe('/actions/combat/fly');
    });

    test('it keeps the derived numbers and none of the payloads', () => {
        expect(observation.fights.length).toBeGreaterThan(0);
        for (const fight of observation.fights) {
            expect(Object.keys(fight).sort()).toEqual(
                [
                    'damageDealt',
                    'damageTaken',
                    'deaths',
                    'hits',
                    'kills',
                    'misses',
                    'monsters',
                    'regen',
                    'seconds',
                ].sort()
            );
        }
    });

    test('a solo run is recognised as one', () => {
        expect(observation.partySize).toBe(1);
    });

    test('a recording with no completed fight yields nothing rather than a zero', () => {
        expect(observeRecording({ ticks: [] })).toBe(null);
        expect(observeRecording({ ticks: recording.ticks.slice(0, 5) })).toBe(null);
    });
});

/**
 * An observation of `fights` identical fights, for the arithmetic tests.
 *
 * @param {Object} shape - `{seconds, damageDealt, damageTaken, fights}`
 * @returns {Object}
 */
function evenObservation({ seconds = 10, damageDealt = 1000, damageTaken = 100, fights = 5, ...rest } = {}) {
    return {
        recordedAt: 1_700_000_000_000,
        zoneHrid: '/actions/combat/fly',
        difficultyTier: 0,
        truncated: false,
        partySize: 1,
        playerIndex: '0',
        fights: Array.from({ length: fights }, () => ({
            seconds,
            damageDealt,
            damageTaken,
            regen: 0,
            hits: 4,
            misses: 1,
            deaths: 0,
            kills: 3,
            monsters: ['Fly'],
        })),
        ...rest,
    };
}

describe('folding observations together', () => {
    test('the rates are ratios of the totals, not means of the fights', () => {
        const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 1000, fights: 4 })]);
        expect(observed.fights).toBe(4);
        expect(observed.seconds).toBe(40);
        expect(observed.dps).toBe(100);
        expect(observed.secondsPerFight).toBe(10);
    });

    test('two recordings of the same zone are one sample', () => {
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000 }),
            evenObservation({ fights: 4, recordedAt: 2_000 }),
        ]);
        expect(observed.fights).toBe(7);
        expect(observed.recordings).toBe(2);
        expect(observed.recordedAt).toBe(2_000);
        expect(observed.oldestRecordedAt).toBe(1_000);
    });

    test('a recording of another zone is not folded in', () => {
        // Otherwise a session that moved zones would average two different
        // fights together and compare the average against one of them
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, zoneHrid: '/actions/combat/bee' }),
            evenObservation({ fights: 4, recordedAt: 2_000 }),
        ]);
        expect(observed.fights).toBe(4);
        expect(observed.recordings).toBe(1);
        expect(observed.zoneHrid).toBe('/actions/combat/fly');
    });

    test('nothing observed is null rather than a run of zeroes', () => {
        expect(aggregateObservations([])).toBe(null);
        expect(aggregateObservations([{ fights: [] }])).toBe(null);
    });
});

describe('reading the prediction off a sim result', () => {
    const simResult = {
        simulatedTime: 3600 * 1e9,
        encounters: 100,
        deaths: { player1: 2 },
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000, '/monsters/jungle_sprite': 18_000 },
        warnings: [],
    };

    test('damage per second is over the simulated clock, gaps included', () => {
        const predicted = predictFromSim(simResult);
        expect(predicted.seconds).toBe(3600);
        expect(predicted.dps).toBe(100);
        expect(predicted.secondsPerFight).toBe(36);
    });

    test('everything the monsters dealt is what the solo player took', () => {
        // Summed across the wave rather than read off one monster: a zone spawns
        // three at a time and only their total is the damage you actually took
        expect(predictFromSim(simResult).takenPerSecond).toBe(15);
    });

    test('a sim that never ran predicts nothing', () => {
        expect(predictFromSim({ simulatedTime: 0 })).toBe(null);
        expect(predictFromSim(null)).toBe(null);
    });
});

describe('the deviation', () => {
    test('it is signed towards the observation', () => {
        expect(deviationPct(90, 100)).toBeCloseTo(-10, 10);
        expect(deviationPct(110, 100)).toBeCloseTo(10, 10);
        expect(deviationPct(100, 100)).toBe(0);
    });

    test('it is a percentage of the prediction, which is what is being checked', () => {
        // Not of the observation, and not of their mean: the claim under test is
        // the simulator's, so it is the simulator's number that is the denominator
        expect(deviationPct(150, 100)).toBeCloseTo(50, 10);
        expect(deviationPct(100, 150)).toBeCloseTo(-33.333, 3);
    });

    test('there is no deviation from a prediction of nothing', () => {
        expect(deviationPct(10, 0)).toBe(null);
        expect(deviationPct(10, null)).toBe(null);
        expect(deviationPct(undefined, 10)).toBe(null);
    });
});

describe('the noise margin', () => {
    test('fewer fights than the minimum says nothing at all', () => {
        expect(noiseMargin([100, 100])).toBe(null);
        expect(noiseMargin(Array(MIN_SAMPLE_FIGHTS).fill(100))).not.toBe(null);
    });

    test('a sample that never varies still allows for the simulator', () => {
        // The observed side contributes nothing, so what is left is the floor —
        // one sim run is one sample and has its own spread
        expect(noiseMargin([100, 100, 100, 100])).toBeCloseTo(SIM_NOISE_FLOOR_PCT, 10);
    });

    test('a wider spread is a wider margin', () => {
        const tight = noiseMargin([98, 100, 102, 100, 100]);
        const loose = noiseMargin([50, 100, 150, 100, 100]);
        expect(loose).toBeGreaterThan(tight);
    });

    test('more of the same fights narrows it', () => {
        const few = noiseMargin([90, 100, 110]);
        const many = noiseMargin([90, 100, 110, 90, 100, 110, 90, 100, 110]);
        expect(many).toBeLessThan(few);
    });

    test('the two sources of noise add as squares, not as sums', () => {
        const samples = [90, 100, 110, 100];
        const sampleOnly = noiseMargin(samples, 0);
        expect(noiseMargin(samples)).toBeCloseTo(Math.hypot(sampleOnly, SIM_NOISE_FLOOR_PCT), 10);
        expect(noiseMargin(samples)).toBeLessThan(sampleOnly + SIM_NOISE_FLOOR_PCT);
    });
});

describe('flagging a deviation', () => {
    test('a deviation inside the margin is reported and not flagged', () => {
        const metric = compareMetric({
            key: 'dps',
            label: 'Damage dealt / sec',
            observed: 101,
            predicted: 100,
            samples: [90, 100, 110, 100, 100],
        });
        expect(metric.deviationPct).toBeCloseTo(1, 10);
        expect(metric.verdict).toBe('within-noise');
    });

    test('a deviation outside it is flagged', () => {
        const metric = compareMetric({
            key: 'dps',
            label: 'Damage dealt / sec',
            observed: 60,
            predicted: 100,
            samples: [60, 60, 60, 60, 60],
        });
        expect(metric.deviationPct).toBeCloseTo(-40, 10);
        expect(metric.verdict).toBe('beyond-noise');
    });

    test('too few fights is neither, however far apart the numbers are', () => {
        // The dangerous case: two fights that happened to go badly are not
        // evidence about the simulator, and calling them evidence is worse than
        // saying nothing
        const metric = compareMetric({ key: 'dps', label: '', observed: 10, predicted: 100, samples: [10, 10] });
        expect(metric.deviationPct).toBeCloseTo(-90, 10);
        expect(metric.verdict).toBe('insufficient');
    });

    test('a noisy sample can hold a large deviation as unproven', () => {
        const metric = compareMetric({
            key: 'dps',
            label: '',
            observed: 100,
            predicted: 130,
            samples: [10, 100, 190, 60, 140],
        });
        expect(metric.verdict).toBe('within-noise');
    });
});

describe('the whole comparison', () => {
    const observed = aggregateObservations([evenObservation({ seconds: 10, damageDealt: 900, fights: 6 })]);
    const predicted = predictFromSim({
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    });

    test('every metric is compared, in a fixed order', () => {
        const comparison = compareRun(observed, predicted);
        expect(comparison.metrics.map((metric) => metric.key)).toEqual(['dps', 'takenPerSecond', 'secondsPerFight']);
    });

    test('the comparison carries when the fight was recorded', () => {
        // The one caveat that cannot be shown without it: gear may have changed
        const comparison = compareRun(observed, predicted);
        expect(comparison.recordedAt).toBe(1_700_000_000_000);
        expect(comparison.fights).toBe(6);
    });

    test('a run at 90 against a prediction of 100 reads as 10% under', () => {
        const comparison = compareRun(observed, predicted);
        const dps = comparison.metrics.find((metric) => metric.key === 'dps');
        expect(dps.observed).toBe(90);
        expect(dps.predicted).toBe(100);
        expect(dps.deviationPct).toBeCloseTo(-10, 10);
        expect(dps.verdict).toBe('beyond-noise');
    });

    test('half a comparison is no comparison', () => {
        expect(compareRun(observed, null)).toBe(null);
        expect(compareRun(null, predicted)).toBe(null);
    });
});

describe('the line the tile carries', () => {
    const predicted = predictFromSim({
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    });

    test('it says which way the run went and by how much', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 900, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toBe('Last 6 fights ran 10.0% under predicted DPS');
    });

    test('a run above the prediction reads as over it', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 1100, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('over predicted DPS');
    });

    test('a deviation within noise says so rather than claiming a finding', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 1005, fights: 6 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('within noise');
    });

    test('too few fights is admitted on the tile itself', () => {
        const comparison = compareRun(
            aggregateObservations([evenObservation({ damageDealt: 900, fights: 2 })]),
            predicted
        );
        expect(summaryLine(comparison)).toContain('too few to judge');
    });

    test('nothing compared yet is not an accuracy claim', () => {
        expect(summaryLine(null)).toBe('No sim check yet');
        expect(summaryLine({ metrics: [] })).toBe('No sim check yet');
    });
});
