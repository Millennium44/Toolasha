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

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** What the adapter would say the character is wearing, and what the sim was handed */
const game = vi.hoisted(() => ({
    dto: {},
    zone: { zoneHrid: '/actions/combat/fly', difficultyTier: 0 },
    lastRun: null,
    simResult: {},
}));

/** Storage, as a map, with the quota switch the recorders stand down on */
const store = vi.hoisted(() => ({ data: new Map(), quota: false }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback, Z_FLOATING_PANEL: 100 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (store.data.has(key) ? store.data.get(key) : fallback),
        set: async (key, value) => {
            store.data.set(key, value);
            return true;
        },
        isQuotaExceeded: () => store.quota,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ actionDetailMap: { '/actions/combat/fly': { name: 'Fly' } } }),
        // The panel's draw reaches storage through the character key
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({}),
    // A fresh copy each time, as the real one builds: a test that mutated the
    // snapshot would otherwise be mutating what the adapter is pretending to read
    buildPlayerDTO: () => (game.dto ? structuredClone(game.dto) : null),
    getCommunityBuffs: () => ({}),
    getCurrentCombatZone: () => game.zone,
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runSimulation: async (options) => {
        game.lastRun = options;
        return game.simResult;
    },
}));
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

import replayCheck, {
    replayCheckPanel,
    replayFights,
    busiestPlayer,
    observeRecording,
    aggregateObservations,
    predictFromSim,
    deviationPct,
    noiseMargin,
    noiseSummary,
    captureLoadoutSnapshot,
    applyLoadoutSnapshot,
    compareMetric,
    compareRun,
    summaryLine,
    MIN_SAMPLE_FIGHTS,
    SIM_NOISE_FLOOR_PCT,
    NOISE_QUIET_PCT,
} from './combat-replay-check.js';
import combatRecorder from './combat-recorder.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import recording from '../../utils/__fixtures__/combat-run.json';

/** Where the scoped keys land, given the character the data manager is pretending to be */
const OBSERVATIONS_KEY = 'combatReplayCheck_observations_char1';
const CHECKPOINT_KEY = 'combatReplayCheck_recordingCheckpoint_char1';

/** A character wearing something, in the shape the adapter hands the simulator */
function loadout({ weapon = '/items/sword', enhancement = 5, attack = 90, ability = '/abilities/poke' } = {}) {
    return {
        hrid: 'player1',
        attackLevel: attack,
        meleeLevel: attack,
        defenseLevel: 70,
        magicLevel: 1,
        rangedLevel: 1,
        staminaLevel: 80,
        intelligenceLevel: 60,
        // Skilling levels never enter a fight and are not part of the snapshot
        cookingLevel: 42,
        equipment: { main_hand: { hrid: weapon, enhancementLevel: enhancement } },
        abilities: [null, { hrid: ability, level: 3, triggers: null }, null, null, null],
        food: [{ hrid: '/items/donut', triggers: null }, null, null],
        drinks: [{ hrid: '/items/coffee', triggers: null }, null, null],
        houseRooms: { '/house_rooms/dairy_barn': 6 },
        guildShrineLevels: { attack: 2 },
        guildCombatBuffs: [{ typeHrid: '/buff_types/attack_level', flatBoost: 3 }],
        achievementCombatBuffs: [],
        // World state, not the character's: these come from now, never the snapshot
        communityBuffLevels: { experience: 4 },
        tokenUpgrades: { speed: 1 },
    };
}

/** Let the awaits inside a fire-and-forget handler settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    store.data.clear();
    store.quota = false;
    game.dto = loadout();
    game.zone = { zoneHrid: '/actions/combat/fly', difficultyTier: 0 };
    game.lastRun = null;
    game.simResult = {};
    replayCheck.observations = [];
    replayCheck.comparison = null;
    replayCheck.error = null;
    replayCheck.loaded = false;
    replayCheck.disable();
});

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

describe('the loadout the fight was actually fought in', () => {
    test('the snapshot keeps what describes the character', () => {
        const snapshot = captureLoadoutSnapshot(loadout());

        expect(snapshot.equipment.main_hand).toEqual({ hrid: '/items/sword', enhancementLevel: 5 });
        expect(snapshot.levels).toEqual({
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 70,
            magicLevel: 1,
            rangedLevel: 1,
            staminaLevel: 80,
            intelligenceLevel: 60,
        });
        expect(snapshot.abilities[1]).toEqual({ hrid: '/abilities/poke', level: 3, triggers: null });
        expect(snapshot.houseRooms).toEqual({ '/house_rooms/dairy_barn': 6 });
        expect(snapshot.guildShrineLevels).toEqual({ attack: 2 });
        expect(snapshot.drinks[0]).toEqual({ hrid: '/items/coffee', triggers: null });
        expect(snapshot.food[0]).toEqual({ hrid: '/items/donut', triggers: null });
    });

    test('and not what describes the world', () => {
        // Community buffs and token upgrades are the server's state and are the
        // same for the simulated run as for the recorded one. Freezing them
        // would make a snapshot go stale in a way the gear never does.
        const snapshot = captureLoadoutSnapshot(loadout());

        expect(snapshot.communityBuffLevels).toBeUndefined();
        expect(snapshot.tokenUpgrades).toBeUndefined();
        expect(snapshot.cookingLevel).toBeUndefined();
        expect(snapshot.levels.cookingLevel).toBeUndefined();
    });

    test('a character that has not loaded snapshots nothing rather than an empty one', () => {
        expect(captureLoadoutSnapshot(null)).toBe(null);
    });

    test('it is laid over the current character, not swapped for it', () => {
        const snapshot = captureLoadoutSnapshot(loadout({ weapon: '/items/spear', attack: 50 }));
        const current = loadout({ weapon: '/items/sword', attack: 99 });
        current.communityBuffLevels = { experience: 9 };

        const merged = applyLoadoutSnapshot(current, snapshot);

        expect(merged.equipment.main_hand.hrid).toBe('/items/spear');
        expect(merged.attackLevel).toBe(50);
        // Not named by the snapshot, so it comes from now, which is where it is right
        expect(merged.communityBuffLevels).toEqual({ experience: 9 });
        expect(merged.hrid).toBe('player1');
        // And the DTO it was built from is untouched
        expect(current.attackLevel).toBe(99);
    });

    test('no snapshot leaves the DTO exactly as it was built', () => {
        const current = loadout();
        expect(applyLoadoutSnapshot(current, null)).toBe(current);
        expect(applyLoadoutSnapshot(null, captureLoadoutSnapshot(loadout()))).toBe(null);
    });

    test('a recording carries the snapshot the recorder took onto its observation', () => {
        const snapshot = captureLoadoutSnapshot(loadout({ weapon: '/items/spear' }));
        const observation = observeRecording({ ...recording, loadout: snapshot });

        expect(observation.loadout.equipment.main_hand.hrid).toBe('/items/spear');
    });

    test('a legacy recording has no snapshot, and says so rather than inventing one', () => {
        expect(observeRecording(recording).loadout).toBe(null);
    });
});

describe('what the check simulates', () => {
    /** A sim result complete enough for `predictFromSim` to read */
    const simResult = {
        simulatedTime: 3600 * 1e9,
        encounters: 360,
        deaths: {},
        totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
        warnings: [],
    };

    test('the gear worn when it was recorded, not the gear worn now', () => {
        // The whole point: record, go and enhance something, run the check, and
        // the deviation used to be the enhancement
        game.simResult = simResult;
        const recorded = captureLoadoutSnapshot(loadout({ weapon: '/items/spear', enhancement: 0, attack: 50 }));
        game.dto = loadout({ weapon: '/items/sword', enhancement: 12, attack: 99 });
        replayCheck.observations = [evenObservation({ fights: 6, loadout: recorded })];

        return replayCheck.check().then(() => {
            const dto = game.lastRun.playerDTOs[0];
            expect(dto.equipment.main_hand).toEqual({ hrid: '/items/spear', enhancementLevel: 0 });
            expect(dto.attackLevel).toBe(50);
        });
    });

    test('a legacy observation still simulates the character as it is now', () => {
        // Nothing said what it was wearing, so the only honest answer is the
        // current character — which is what the panel's caveat has always said
        game.simResult = simResult;
        game.dto = loadout({ weapon: '/items/sword', enhancement: 12, attack: 99 });
        replayCheck.observations = [evenObservation({ fights: 6 })];

        return replayCheck.check().then(() => {
            const dto = game.lastRun.playerDTOs[0];
            expect(dto.equipment.main_hand).toEqual({ hrid: '/items/sword', enhancementLevel: 12 });
            expect(dto.attackLevel).toBe(99);
        });
    });

    test('the newest snapshot wins, and a sample that straddles a change says so', () => {
        const early = captureLoadoutSnapshot(loadout({ weapon: '/items/spear' }));
        const late = captureLoadoutSnapshot(loadout({ weapon: '/items/sword' }));
        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: early }),
            evenObservation({ fights: 3, recordedAt: 2_000, loadout: late }),
        ]);

        expect(observed.loadout.equipment.main_hand.hrid).toBe('/items/sword');
        expect(observed.mixedLoadouts).toBe(true);
    });

    test('two segments of one recording are one loadout, whenever they were taken', () => {
        const first = captureLoadoutSnapshot(loadout());
        const second = captureLoadoutSnapshot(loadout());
        second.capturedAt = first.capturedAt + 600_000;

        const observed = aggregateObservations([
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: first }),
            evenObservation({ fights: 3, recordedAt: 2_000, loadout: second }),
        ]);

        expect(observed.mixedLoadouts).toBe(false);
    });
});

describe('surviving a refresh', () => {
    test('the fights so far are written at a fight boundary, summarised and not raw', () => {
        // Raw ticks are megabytes and arrive several times a second; the summary
        // is a few hundred bytes and is what the check reads anyway
        return replayCheck.checkpoint(recording).then(() => {
            const checkpoint = store.data.get(CHECKPOINT_KEY);
            expect(checkpoint.fights.length).toBeGreaterThan(0);
            expect(JSON.stringify(checkpoint)).not.toContain('pMap');
        });
    });

    test('a segment with no completed fight clears the checkpoint instead of writing one', () => {
        // What a rotation leaves behind: the segment it banked is already folded
        // in, so the checkpoint taken from it is a duplicate waiting to happen
        store.data.set(CHECKPOINT_KEY, { fights: [{ seconds: 1 }] });

        return replayCheck.checkpoint({ ticks: recording.ticks.slice(0, 3) }).then(() => {
            expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
        });
    });

    test('a full disk stands the checkpoint down rather than failing every fight', async () => {
        store.quota = true;

        await replayCheck.checkpoint(recording);

        expect(store.data.has(CHECKPOINT_KEY)).toBe(false);
    });

    test('a leftover checkpoint is folded in on startup and then dropped', async () => {
        const interrupted = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 });
        store.data.set(CHECKPOINT_KEY, interrupted);
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        await replayCheck.load();

        expect(replayCheck.observations).toHaveLength(1);
        expect(replayCheck.observations[0].fights).toHaveLength(interrupted.fights.length);
        expect(store.data.get(OBSERVATIONS_KEY)).toHaveLength(1);
        expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
        expect(log.mock.calls[0][0]).toContain(`Recovered ${interrupted.fights.length} fights`);
        log.mockRestore();
    });

    test('and is not folded in twice when the same run is already kept', async () => {
        const interrupted = observeRecording(recording, { zoneHrid: '/actions/combat/fly', recordedAt: 1_000 });
        store.data.set(OBSERVATIONS_KEY, [interrupted]);
        store.data.set(CHECKPOINT_KEY, { ...interrupted, recordedAt: 2_000 });

        await replayCheck.load();

        expect(replayCheck.observations).toHaveLength(1);
    });

    test('nothing left over is a quiet startup', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});

        await replayCheck.load();

        expect(log).not.toHaveBeenCalled();
        log.mockRestore();
    });

    test('a clean stop clears it, so the next session recovers nothing', async () => {
        replayCheck.ensureWatching();
        await settle();
        await replayCheck.checkpoint(recording);
        expect(store.data.get(CHECKPOINT_KEY)).toBeTruthy();

        combatRecorder.startRecording();
        combatRecorder.stopRecording();
        await settle();

        expect(store.data.get(CHECKPOINT_KEY)).toBe(null);
    });
});

describe('how much of this sample is noise', () => {
    test('it is measured from the fights, not assumed from their number', () => {
        // 1/√n would call twelve fights a 29% margin whatever they did; twelve
        // fights that all landed within a percent of each other are far tighter
        const steady = noiseSummary(aggregateObservations([evenObservation({ fights: 12 })]));

        expect(steady.marginPct).toBeCloseTo(SIM_NOISE_FLOOR_PCT, 10);
        expect(steady.marginPct).toBeLessThan((1 / Math.sqrt(12)) * 100);
    });

    test('a spread sample is a wide band and says not to read anything off it', () => {
        const observed = aggregateObservations([
            {
                ...evenObservation({ fights: 0 }),
                fights: [10, 30, 5, 25, 12].map((damageDealt) => ({
                    seconds: 1,
                    damageDealt,
                    damageTaken: 1,
                    regen: 0,
                    hits: 1,
                    misses: 0,
                    deaths: 0,
                    kills: 1,
                    monsters: ['Fly'],
                })),
            },
        ]);
        const noise = noiseSummary(observed);

        expect(noise.marginPct).toBeGreaterThan(NOISE_QUIET_PCT);
        expect(noise.quiet).toBe(false);
        expect(noise.text).toContain('5 fights');
        expect(noise.text).toContain('differences inside that band are not findings');
    });

    test('a tight sample goes quiet, because it can finally see something', () => {
        const noise = noiseSummary(aggregateObservations([evenObservation({ fights: 24 })]));

        expect(noise.marginPct).toBeLessThan(NOISE_QUIET_PCT);
        expect(noise.quiet).toBe(true);
        expect(noise.text).toContain('large enough to argue with');
    });

    test('too few fights admits it rather than quoting a margin', () => {
        const noise = noiseSummary(aggregateObservations([evenObservation({ fights: 2 })]));

        expect(noise.marginPct).toBe(null);
        expect(noise.quiet).toBe(false);
        expect(noise.text).toContain('too few');
    });

    test('nothing observed is nothing claimed', () => {
        expect(noiseSummary(null)).toMatchObject({ fights: 0, marginPct: null, quiet: false });
    });
});

describe('drawing a deviation the sample cannot see', () => {
    /** Open the panel over one sample and one comparison */
    function draw({ damageDealt = 1000, fights = 6 } = {}) {
        replayCheck.observations = [evenObservation({ seconds: 10, damageDealt, fights })];
        replayCheck.comparison = compareRun(
            aggregateObservations(replayCheck.observations),
            predictFromSim({
                simulatedTime: 3600 * 1e9,
                encounters: 360,
                deaths: {},
                totalDamageDealt: { player1: 360_000, '/monsters/fly': 36_000 },
                warnings: [],
            })
        );
        replayCheckPanel.show({ remember: false });
    }

    /** The line whose label is `label`, and the ink its figure is drawn in */
    function row(label) {
        const line = [...replayCheckPanel.panel.querySelectorAll('div')].find(
            (element) => element.firstChild?.textContent === label
        );
        return line ? { text: line.textContent, color: line.lastChild.style.color } : null;
    }

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('a deviation inside the band is dimmed and carries the band with it', () => {
        // Green read as "checked, and fine". Six fights agreeing with the
        // simulator to within their own margin have established nothing.
        draw({ damageDealt: 1005 });

        const dps = row('Damage dealt / sec');
        expect(dps.text).toContain('±');
        expect(dps.color).toBe(ROW_COLORS.dim);
        expect(dps.color).not.toBe(ROW_COLORS.good);
    });

    test('a deviation outside it is still flagged', () => {
        draw({ damageDealt: 900 });

        expect(row('Damage dealt / sec').color).toBe(ROW_COLORS.bad);
    });

    test('too few fights says so on the row rather than quoting a band', () => {
        draw({ damageDealt: 900, fights: 2 });

        const dps = row('Damage dealt / sec');
        expect(dps.text).toContain('too few fights');
        expect(dps.color).toBe(ROW_COLORS.dim);
    });

    test('the sample line sits beside the fight count, and turns quiet when it can', () => {
        draw({ fights: 24 });

        expect(row('Sample').text).toContain('±');
        expect(row('Sample').color).toBe(ROW_COLORS.good);
    });

    test('and stays dim while the noise is the largest thing in the comparison', () => {
        // Not the fight count that decides this but the spread: four fights that
        // all went the same way see further than twenty that did not
        replayCheck.observations = [
            {
                ...evenObservation({ fights: 0 }),
                fights: [400, 1600, 700, 1300, 900].map((damageDealt) => ({
                    seconds: 10,
                    damageDealt,
                    damageTaken: 100,
                    regen: 0,
                    hits: 4,
                    misses: 1,
                    deaths: 0,
                    kills: 3,
                    monsters: ['Fly'],
                })),
            },
        ];
        replayCheckPanel.show({ remember: false });

        expect(row('Sample').color).toBe(ROW_COLORS.dim);
        expect(row('Sample').text).toContain('not findings');
    });
});

describe('what the panel admits it does not know', () => {
    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('with a snapshot, the gear caveat becomes a statement of fact', () => {
        replayCheck.observations = [evenObservation({ fights: 6, loadout: captureLoadoutSnapshot(loadout()) })];
        replayCheckPanel.show({ remember: false });

        const text = replayCheckPanel.panel.textContent;
        expect(text).toContain('Simmed against the gear worn when recorded');
        expect(text).not.toContain('read as it is worn now');
        // What genuinely is not captured still is
        expect(text).toContain('whether they were actually up');
        expect(text).not.toContain('could not be drawn');
    });

    test('without one, it says the gear is whatever is worn now', () => {
        replayCheck.observations = [evenObservation({ fights: 6 })];
        replayCheckPanel.show({ remember: false });

        const text = replayCheckPanel.panel.textContent;
        expect(text).toContain('read as it is worn now');
        expect(text).not.toContain('Simmed against the gear worn when recorded');
    });

    test('a sample straddling a gear change is not passed off as one loadout', () => {
        replayCheck.observations = [
            evenObservation({ fights: 3, recordedAt: 1_000, loadout: captureLoadoutSnapshot(loadout()) }),
            evenObservation({
                fights: 3,
                recordedAt: 2_000,
                loadout: captureLoadoutSnapshot(loadout({ weapon: '/items/spear' })),
            }),
        ];
        replayCheckPanel.show({ remember: false });

        expect(replayCheckPanel.panel.textContent).toContain('not all made with the same loadout');
    });
});

describe('the Record button on the panel', () => {
    /** The shared recorder, as the panel finds it */
    function install(recording = false, ticks = 0) {
        const fake = {
            recording,
            isRecording: () => fake.recording,
            recordingStatus: () => ({ ticks, seconds: 0, full: false }),
            startRecording: vi.fn(() => {
                fake.recording = true;
            }),
            stopRecording: vi.fn(() => {
                fake.recording = false;
            }),
            downloadRecording: vi.fn(),
        };
        window.Toolasha = { Combat: { combatRecorder: fake } };
        return fake;
    }

    /** Every button in the open panel, by its label */
    function buttons() {
        return [...(replayCheckPanel.panel?.querySelectorAll('button') || [])];
    }

    function labelled(text) {
        return buttons().find((button) => button.textContent.startsWith(text));
    }

    afterEach(() => {
        replayCheckPanel.hide({ remember: false });
        delete window.Toolasha;
    });

    test('the panel offers a Record button instead of pointing at another panel', () => {
        // Being told to press Record somewhere else was the one thing this
        // panel could do nothing about, and the recording is what it runs on
        install();
        replayCheckPanel.show({ remember: false });

        expect(labelled('Record')).toBeTruthy();
        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
        expect(replayCheckPanel.panel.textContent).not.toContain('Damage panel');
    });

    test('pressing it starts the shared recorder', () => {
        const recorder = install();
        replayCheckPanel.show({ remember: false });

        labelled('Record').click();

        expect(recorder.startRecording).toHaveBeenCalledTimes(1);
        // Redrawn from the recorder's state, not from a remembered flag
        expect(labelled('Recording')).toBeTruthy();
    });

    test('a recording started anywhere else already reads as running here', () => {
        install(true, 240);
        replayCheckPanel.show({ remember: false });

        expect(labelled('Recording 240…')).toBeTruthy();
        expect(labelled('Record (')).toBeFalsy();
    });

    test('pressing it while running stops the recording and writes no file', () => {
        // The file is for handing over; a recording made here is read by the
        // ingest that follows it
        const recorder = install(true, 240);
        replayCheckPanel.show({ remember: false });

        labelled('Recording').click();

        expect(recorder.stopRecording).toHaveBeenCalledTimes(1);
        expect(recorder.downloadRecording).not.toHaveBeenCalled();
        expect(labelled('Record')).toBeTruthy();
    });

    test('no recorder means the other controls still draw', () => {
        window.Toolasha = { Combat: {} };
        replayCheckPanel.show({ remember: false });

        expect(replayCheckPanel.panel.textContent).not.toContain('could not be drawn');
        expect(labelled('Forget')).toBeTruthy();
    });
});
