// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * A golden run of the whole simulation loop.
 *
 * Every other engine test exercises one mechanic in isolation; nothing ran the
 * loop end to end, so a subtle change anywhere in it — event ordering, a stat
 * formula, an RNG draw added or removed — could shift every simulated number
 * without failing a single test. This pins one seeded run's exact totals.
 *
 * The pinned numbers are NOT asserted to be *correct* — they are whatever the
 * engine produced on the day they were pinned. Their value is purely that they
 * cannot change unnoticed. If an intentional engine change moves them, re-run
 * the test, eyeball that the movement matches the intent, and update the pins
 * deliberately in the same change. If they move when nothing in the engine was
 * meant to change behavior, that is the bug this test exists to catch.
 */

import { describe, test, expect, afterEach } from 'vitest';

import CombatSimulator, { getCapturedPlayerDetails, setPlayerDetailsCapture } from './combat-simulator.js';
import CombatUtilities from './combat-utilities.js';
import AbilityCastEndEvent from './events/ability-cast-end-event.js';
import AutoAttackEvent from './events/auto-attack-event.js';
import BlindExpirationEvent from './events/blind-expiration-event.js';
import CombatStartEvent from './events/combat-start-event.js';
import DamageOverTimeEvent from './events/damage-over-time-event.js';
import EnemyRespawnEvent from './events/enemy-respawn-event.js';
import SilenceExpirationEvent from './events/silence-expiration-event.js';
import StunExpirationEvent from './events/stun-expiration-event.js';
import { getGameData, setGameData } from './game-data.js';
import Labyrinth from './labyrinth.js';
import Monster from './monster.js';
import Player from './player.js';
import { clearSimRng, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ONE_SECOND = 1e9;
const ONE_HOUR = 3600 * ONE_SECOND;

const ZONE_HRID = '/actions/combat/golden_meadow';
const RAT_HRID = '/monsters/golden_rat';
const TOAD_HRID = '/monsters/golden_toad';

/**
 * A monster the engine can fight without any ability or consumable machinery:
 * an unarmed smash attacker, like the fixture player.
 * @param {Object} levels - The seven base levels
 * @param {number} experience - Experience the monster is worth
 * @returns {Object} combatMonsterDetailMap entry
 */
function monster(levels, experience) {
    return {
        experience,
        // Enrage never fires inside these short fights, but the enrage-based
        // XP-rate arithmetic divides by it, so it must be a real duration
        enrageTime: 300 * ONE_SECOND,
        abilities: [],
        combatDetails: {
            ...levels,
            attackInterval: 3500000000,
            combatStats: {
                combatStyleHrids: ['/combat_styles/smash'],
                damageType: '/damage_types/physical',
                // Zero on purpose: the engine falls back to the
                // combatDetails.attackInterval above, as it does for the
                // game's own monsters
                attackInterval: 0,
            },
        },
    };
}

/** The minimal game data the loop reads: one zone, two monsters, one combat style. */
function installGameData() {
    setGameData({
        actionDetailMap: {
            [ZONE_HRID]: {
                buffs: null,
                combatZoneInfo: {
                    isDungeon: false,
                    dungeonInfo: null,
                    fightInfo: {
                        bossSpawns: null,
                        randomSpawnInfo: {
                            maxSpawnCount: 2,
                            maxTotalStrength: 2,
                            spawns: [
                                { combatMonsterHrid: RAT_HRID, difficultyTier: 0, rate: 2, strength: 1 },
                                { combatMonsterHrid: TOAD_HRID, difficultyTier: 0, rate: 1, strength: 1 },
                            ],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [RAT_HRID]: monster(
                {
                    staminaLevel: 10,
                    intelligenceLevel: 5,
                    attackLevel: 40,
                    meleeLevel: 40,
                    defenseLevel: 30,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                60
            ),
            [TOAD_HRID]: monster(
                {
                    staminaLevel: 20,
                    intelligenceLevel: 5,
                    attackLevel: 55,
                    meleeLevel: 55,
                    defenseLevel: 40,
                    rangedLevel: 1,
                    magicLevel: 1,
                },
                110
            ),
        },
        combatStyleDetailMap: {
            '/combat_styles/smash': {
                skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 },
            },
        },
    });
}

/**
 * An unarmed, unfed, ability-less player: every swing goes through the full
 * attack pipeline (accuracy, damage roll, threat, XP split) with none of the
 * equipment or consumable machinery in the way.
 * @returns {Player}
 */
function fixturePlayer() {
    const player = Player.createFromDTO({
        hrid: 'player1',
        staminaLevel: 70,
        intelligenceLevel: 40,
        attackLevel: 70,
        meleeLevel: 70,
        defenseLevel: 60,
        rangedLevel: 1,
        magicLevel: 1,
        equipment: {},
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null],
        houseRooms: {},
        debuffOnLevelGap: 0,
    });
    return player;
}

/**
 * One seeded hour in the fixture zone.
 * @param {number} seed - RNG seed
 * @returns {import('./sim-result.js').default}
 */
function goldenRun(seed) {
    installGameData();
    seedSimRng(seed);

    const zone = new Zone(ZONE_HRID, 0);
    const player = fixturePlayer();
    // The worker wires these two on every run; without them the first combat
    // start throws on `extraBuffs.forEach`
    player.zoneBuffs = zone.buffs;
    player.extraBuffs = [];

    const simulator = new CombatSimulator([player], zone);
    return simulator.simulate(ONE_HOUR);
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

/**
 * The wire between the adapter and the per-encounter task rule. The sim runs
 * headless, so a player's combat tasks arrive as plain hrids on the DTO and
 * become the set the engine consults on every swing.
 */
describe('a player DTO carries its own combat tasks', () => {
    /**
     * @param {Array<string>|undefined} taskMonsterHrids - Tasks on the DTO
     * @param {Object<string, number>} [taskMonsterRemaining] - Kills each still wants
     * @returns {Player} The built player
     */
    function playerWithTasks(taskMonsterHrids, taskMonsterRemaining) {
        installGameData();
        return Player.createFromDTO({
            hrid: 'player1',
            staminaLevel: 70,
            intelligenceLevel: 40,
            attackLevel: 70,
            meleeLevel: 70,
            defenseLevel: 60,
            rangedLevel: 1,
            magicLevel: 1,
            equipment: {},
            food: [null, null, null],
            drinks: [null, null, null],
            abilities: [null, null, null, null],
            houseRooms: {},
            debuffOnLevelGap: 0,
            taskMonsterHrids,
            taskMonsterRemaining,
        });
    }

    test('the tasks become a lookup the engine can consult per swing', () => {
        const player = playerWithTasks(['/monsters/jungle_sprite', '/monsters/myconid']);

        expect(player.taskMonsterHrids.has('/monsters/jungle_sprite')).toBe(true);
        expect(player.taskMonsterHrids.has('/monsters/centaur')).toBe(false);
    });

    test('a DTO with no tasks — an import, or a party member — carries none', () => {
        // Null rather than an empty set, and deliberately so: nobody else's
        // taskDamage may stand in for a task board we cannot see.
        expect(playerWithTasks(undefined).taskMonsterHrids).toBeNull();
        expect(playerWithTasks([]).taskMonsterHrids).toBeNull();
    });

    test('the remaining kill counts come across as a map, or null when absent', () => {
        const player = playerWithTasks(['/monsters/jungle_sprite'], { '/monsters/jungle_sprite': 45 });

        expect(player.taskMonsterRemaining.get('/monsters/jungle_sprite')).toBe(45);
        // Absent means an unbounded task, which is what a DTO built before the
        // counts existed already got
        expect(playerWithTasks(['/monsters/jungle_sprite']).taskMonsterRemaining).toBeNull();
        expect(playerWithTasks(['/monsters/jungle_sprite'], {}).taskMonsterRemaining).toBeNull();
    });
});

/**
 * A task is a number of kills, so the bonus it pays has an end. These pin who
 * it is counted for (each player's own board), how often (once per death, not
 * once per attacker), from which paths (a thorns kill is a kill), and in which
 * modes (only per-monster: off pays nothing to stop, and every-fight was asked
 * for explicitly).
 */
describe('a task finishing mid-run', () => {
    const ZONE_STUB = { hrid: ZONE_HRID, difficultyTier: 0, isDungeon: false };

    /**
     * A stand-in player carrying a task board, enough for the kill counting.
     * @param {string} hrid - Player hrid
     * @param {Object<string, number>} tasks - Monster hrid → kills still needed
     * @returns {Object} A unit-shaped stub
     */
    function taskPlayer(hrid, tasks) {
        return {
            hrid,
            isPlayer: true,
            taskMonsterHrids: new Set(Object.keys(tasks)),
            taskMonsterRemaining: new Map(Object.entries(tasks)),
            taskMonsterKills: null,
        };
    }

    /** A monster, as the death paths hand one over. */
    const deadMonster = (hrid) => ({ hrid, isPlayer: false });

    /**
     * @param {Array<Object>} players - Units to run with
     * @param {string} mode - Task damage mode
     * @returns {CombatSimulator} A simulator that has run nothing
     */
    function sim(players, mode = 'perMonster') {
        return new CombatSimulator(players, ZONE_STUB, null, null, mode);
    }

    test('the bonus stops on the kill that finishes the task', () => {
        const player = taskPlayer('player1', { [RAT_HRID]: 3 });
        const simulator = sim([player]);
        const rat = deadMonster(RAT_HRID);

        expect(CombatUtilities.appliesTaskDamage(player, rat, 'perMonster')).toBe(true);
        simulator.recordDeath(rat);
        simulator.recordDeath(rat);
        // Two down, one to go — still paying
        expect(CombatUtilities.appliesTaskDamage(player, rat, 'perMonster')).toBe(true);
        simulator.recordDeath(rat);
        expect(CombatUtilities.appliesTaskDamage(player, rat, 'perMonster')).toBe(false);

        simulator.recordDeath(rat);
        expect(simulator.taskDamageKills[RAT_HRID]).toEqual({ onTask: 3, offTask: 1 });
    });

    test('two tasks on one board retire independently', () => {
        const player = taskPlayer('player1', { [RAT_HRID]: 1, [TOAD_HRID]: 3 });
        const simulator = sim([player]);

        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(CombatUtilities.appliesTaskDamage(player, deadMonster(RAT_HRID), 'perMonster')).toBe(false);
        expect(CombatUtilities.appliesTaskDamage(player, deadMonster(TOAD_HRID), 'perMonster')).toBe(true);
    });

    test("one party member finishing theirs does not retire another's", () => {
        const mine = taskPlayer('player1', { [RAT_HRID]: 1 });
        const theirs = taskPlayer('player2', { [RAT_HRID]: 5 });
        const simulator = sim([mine, theirs]);

        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(CombatUtilities.appliesTaskDamage(mine, deadMonster(RAT_HRID), 'perMonster')).toBe(false);
        expect(CombatUtilities.appliesTaskDamage(theirs, deadMonster(RAT_HRID), 'perMonster')).toBe(true);
    });

    test('a monster dies once, not once per party member', () => {
        // Three players swinging at one rat is one kill each of them is
        // credited with — not three kills off each of their boards.
        const players = [
            taskPlayer('player1', { [RAT_HRID]: 2 }),
            taskPlayer('player2', { [RAT_HRID]: 2 }),
            taskPlayer('player3', { [RAT_HRID]: 2 }),
        ];
        const simulator = sim(players);

        simulator.recordDeath(deadMonster(RAT_HRID));

        for (const player of players) {
            expect(player.taskMonsterKills.get(RAT_HRID)).toBe(1);
            expect(CombatUtilities.appliesTaskDamage(player, deadMonster(RAT_HRID), 'perMonster')).toBe(true);
        }
        expect(simulator.simResult.deaths[RAT_HRID]).toBe(1);
    });

    test('a monster killed by thorns counts like any other kill', () => {
        // Nothing here knows how the monster died: the thorns path reports the
        // death through the same recordDeath every swing does.
        const player = taskPlayer('player1', { [RAT_HRID]: 1 });
        const simulator = sim([player]);

        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(player.taskMonsterKills.get(RAT_HRID)).toBe(1);
        expect(CombatUtilities.appliesTaskDamage(player, deadMonster(RAT_HRID), 'perMonster')).toBe(false);
    });

    test('a revived monster gives its task credit back', () => {
        const player = taskPlayer('player1', { [RAT_HRID]: 1 });
        const simulator = sim([player]);
        const rat = deadMonster(RAT_HRID);

        simulator.recordDeath(rat);
        simulator.undoRecordedDeath(rat, 0);

        expect(player.taskMonsterKills.get(RAT_HRID)).toBe(0);
        expect(CombatUtilities.appliesTaskDamage(player, rat, 'perMonster')).toBe(true);
        expect(simulator.taskDamageKills[RAT_HRID]).toEqual({ onTask: 0, offTask: 0 });
    });

    test('counting is inert with task damage off', () => {
        const player = taskPlayer('player1', { [RAT_HRID]: 1 });
        const simulator = sim([player], 'off');

        simulator.recordDeath(deadMonster(RAT_HRID));
        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(player.taskMonsterKills).toBeNull();
        expect(simulator.taskDamageKills).toEqual({});
    });

    test('and inert in every-fight mode, which was asked for deliberately', () => {
        // Someone comparing task gear head to head wants the bonus on for the
        // whole run; retiring it partway would answer a different question.
        const player = taskPlayer('player1', { [RAT_HRID]: 1 });
        const simulator = sim([player], 'everyFight');

        simulator.recordDeath(deadMonster(RAT_HRID));
        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(player.taskMonsterKills).toBeNull();
        expect(CombatUtilities.appliesTaskDamage(player, deadMonster(RAT_HRID), 'everyFight')).toBe(true);
    });

    test('a task with no remaining count given never finishes', () => {
        // A DTO built before the counts existed, or an import
        const player = {
            hrid: 'player1',
            isPlayer: true,
            taskMonsterHrids: new Set([RAT_HRID]),
            taskMonsterRemaining: null,
        };
        const simulator = sim([player]);

        simulator.recordDeath(deadMonster(RAT_HRID));
        simulator.recordDeath(deadMonster(RAT_HRID));

        expect(CombatUtilities.appliesTaskDamage(player, deadMonster(RAT_HRID), 'perMonster')).toBe(true);
        expect(simulator.taskDamageKills[RAT_HRID]).toEqual({ onTask: 2, offTask: 0 });
    });
});

describe('golden run: one seeded hour, pinned exactly', () => {
    test('the totals are what they were when this was pinned', () => {
        const result = goldenRun(20260806);

        // Encounters fully cleared in the hour (a wipe ends a fight without
        // counting here — the ten player deaths below are those)
        expect(result.encounters).toBe(34);

        // Kills, per monster, and the player's own deaths
        expect(result.deaths).toEqual({
            '/monsters/golden_rat': 39,
            '/monsters/golden_toad': 29,
            player1: 10,
        });

        // Player XP: an unarmed smash attacker trains melee (0.3 primary +
        // 0.35 style split) and attack (0.35 style split), nothing else
        expect(result.experienceGained.player1).toEqual({
            stamina: 0,
            intelligence: 0,
            attack: 2494.130396668348,
            melee: 4631.956450955504,
            defense: 0,
            ranged: 0,
            magic: 0,
        });

        // Damage dealt by the player, and taken from each monster type
        expect(result.totalDamageDealt).toEqual({
            player1: 16520,
            '/monsters/golden_toad': 6107,
            '/monsters/golden_rat': 3723,
        });

        // The run stops on the first event at or past the hour; with this seed
        // that lands exactly on it
        expect(result.simulatedTime).toBe(3600000000000);
    });

    test('the same seed reproduces the run draw for draw', () => {
        const first = goldenRun(20260806);
        clearSimRng();
        setGameData(null);
        const second = goldenRun(20260806);

        expect(second.encounters).toBe(first.encounters);
        expect(second.deaths).toEqual(first.deaths);
        expect(second.experienceGained).toEqual(first.experienceGained);
        expect(second.totalDamageDealt).toEqual(first.totalDamageDealt);
        expect(second.simulatedTime).toBe(first.simulatedTime);
    });
});

/**
 * Labyrinth attempt accounting.
 *
 * A clear rate is wins over attempts, so the denominator must count exactly
 * the attempts that finished — win, death or timeout — never the fight still
 * in progress when the run stopped, and never one fewer. The old blanket
 * `attemptCount - 1` subtracted a *resolved* win whenever the time cap landed
 * on the killing blow itself, and a 100%-win run then read 251/250 — the
 * "100.4% clear" a room log actually displayed.
 */
describe('labyrinth attempt accounting', () => {
    const LAB_MONSTER = '/monsters/golden_lab_rat';

    /**
     * One seeded, time-capped labyrinth run against a monster with the given
     * levels. Returns both the result and the labyrinth, so tests can check
     * the result's counts against the engine's own spawn counter.
     * @param {number} seed - RNG seed
     * @param {Object} levels - Monster level block (see monster())
     * @param {number} capSeconds - Simulation time cap
     * @returns {{result: Object, labyrinth: Labyrinth}}
     */
    function labyrinthRun(seed, levels, capSeconds) {
        // The golden zone (for SimResult's constructor) plus the lab monster
        setGameData({
            actionDetailMap: {
                [ZONE_HRID]: {
                    buffs: null,
                    combatZoneInfo: {
                        isDungeon: false,
                        dungeonInfo: null,
                        fightInfo: {
                            bossSpawns: null,
                            randomSpawnInfo: { maxSpawnCount: 1, maxTotalStrength: 1, spawns: [] },
                        },
                    },
                },
            },
            combatMonsterDetailMap: { [LAB_MONSTER]: monster(levels, 50) },
            combatStyleDetailMap: {
                '/combat_styles/smash': { skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 } },
            },
        });
        seedSimRng(seed);

        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];

        // Room level 100 = scale factor 1, so the level block is used as-is
        const labyrinth = new Labyrinth(LAB_MONSTER, 100);
        const simulator = new CombatSimulator([player], zone, undefined, labyrinth);
        return { result: simulator.simulate(capSeconds * ONE_SECOND), labyrinth };
    }

    /** The invariants every labyrinth run must satisfy, whatever the seed */
    function expectSoundCounts(result, labyrinth) {
        // Wins can never exceed finished attempts — this is the 100.4% bug
        expect(result.encounters).toBeLessThanOrEqual(result.labyAttemptCount);
        // Every spawn is either finished or the one fight still in progress
        expect(result.labyAttemptCount + result.labyUnfinishedAttempts).toBe(labyrinth.attemptCount);
        expect([0, 1]).toContain(result.labyUnfinishedAttempts);
        if (result.labyAttemptCount > 0) {
            expect(result.encounters / result.labyAttemptCount).toBeLessThanOrEqual(1);
        }
    }

    // Feeble monster: every fight is a quick kill, so the event that crosses
    // the time cap is very often the killing blow itself — the exact case the
    // old subtraction scored as 101%
    const FEEBLE = {
        staminaLevel: 3,
        intelligenceLevel: 1,
        attackLevel: 1,
        meleeLevel: 1,
        defenseLevel: 1,
        rangedLevel: 1,
        magicLevel: 1,
    };

    test('an all-win run keeps every win in the denominator, cap-on-kill included', () => {
        let sawCapLandOnAKill = false;
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const { result, labyrinth } = labyrinthRun(seed, FEEBLE, 60);
            expectSoundCounts(result, labyrinth);
            expect(result.encounters).toBeGreaterThan(0);
            if (result.labyUnfinishedAttempts === 0) {
                // The run stopped on a resolution — under the old accounting
                // this read wins/(wins-1), i.e. more than 100%
                sawCapLandOnAKill = true;
                expect(result.encounters).toBe(result.labyAttemptCount);
            }
        }
        expect(sawCapLandOnAKill).toBe(true);
    });

    test('an all-loss run counts the deaths and claims no wins', () => {
        // A monster that flattens the fixture player every fight
        const { result, labyrinth } = labyrinthRun(
            11,
            {
                staminaLevel: 300,
                intelligenceLevel: 50,
                attackLevel: 500,
                meleeLevel: 500,
                defenseLevel: 300,
                rangedLevel: 1,
                magicLevel: 1,
            },
            300
        );
        expectSoundCounts(result, labyrinth);
        expect(result.encounters).toBe(0);
        expect(result.labyAttemptCount).toBeGreaterThan(0);
    });

    test('fights that hit the 120s room timeout resolve as losses, not phantoms', () => {
        // Both sides too tanky to finish: every fight times out
        const { result, labyrinth } = labyrinthRun(
            7,
            {
                staminaLevel: 5000,
                intelligenceLevel: 50,
                attackLevel: 5,
                meleeLevel: 5,
                defenseLevel: 200,
                rangedLevel: 1,
                magicLevel: 1,
            },
            500
        );
        expectSoundCounts(result, labyrinth);
        expect(result.encounters).toBe(0);
        // 500s of 120s timeouts: four resolve, a fifth may be in flight
        expect(result.labyAttemptCount).toBeGreaterThanOrEqual(3);
    });
});

describe('Labyrinth as an isolated zone fight', () => {
    afterEach(() => {
        clearSimRng();
    });

    test('a zone fight builds the monster at its zone tier; a lab room at tier 0', () => {
        // Only what Monster needs to resolve a tiered spawn
        setGameData({
            combatMonsterDetailMap: {
                '/monsters/vampire': {
                    hrid: '/monsters/vampire',
                    name: 'Vampire',
                    combatDetails: {
                        currentHitpoints: 100,
                        maxHitpoints: 100,
                        staminaLevel: 10,
                        intelligenceLevel: 10,
                        attackLevel: 10,
                        meleeLevel: 10,
                        defenseLevel: 10,
                        rangedLevel: 10,
                        magicLevel: 10,
                        combatStats: {},
                    },
                    abilities: [],
                    dropTable: [],
                    rareDropTable: [],
                    elite: false,
                },
            },
            abilityDetailMap: {},
            itemDetailMap: {},
            combatStyleDetailMap: {},
        });
        const lab = new Labyrinth('/monsters/vampire', 0);
        const zoneFight = new Labyrinth('/monsters/vampire', 0, [], null, true, { zoneFight: true, difficultyTier: 5 });

        expect(lab.zoneFight).toBe(false);
        expect(lab.difficultyTier).toBe(0);
        expect(zoneFight.zoneFight).toBe(true);
        expect(zoneFight.difficultyTier).toBe(5);
        expect(lab.getMonster()[0].difficultyTier).toBe(0);
        expect(zoneFight.getMonster()[0].difficultyTier).toBe(5);
    });
});

describe('player build snapshot folds buffs as per-type targets', () => {
    afterEach(() => {
        setPlayerDetailsCapture(false);
        clearSimRng();
        setGameData(null);
    });

    /** One seeded run with the capture on, returning the snapshot */
    function snapshotWith(foldBuffs, permanentHpRatio) {
        installGameData();
        seedSimRng(1);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        // A persistent buff the sim's build already carries — the guild
        // max-HP buff, say — seeded the way `clearBuffs` seeds them
        player.extraBuffs = permanentHpRatio
            ? [
                  {
                      uniqueHrid: '/buff_uniques/guild_hp',
                      typeHrid: '/buff_types/max_hitpoints',
                      ratioBoost: permanentHpRatio,
                      ratioBoostLevelBonus: 0,
                      flatBoost: 0,
                      flatBoostLevelBonus: 0,
                      startTime: 0,
                      duration: Number.MAX_SAFE_INTEGER,
                  },
              ]
            : [];
        setPlayerDetailsCapture(true, foldBuffs);
        new CombatSimulator([player], zone).simulate(30 * ONE_SECOND);
        return getCapturedPlayerDetails();
    }

    const target = (ratio) => ({
        '/buff_uniques/toolasha_fold/max_hitpoints': {
            uniqueHrid: '/buff_uniques/toolasha_fold/max_hitpoints',
            typeHrid: '/buff_types/max_hitpoints',
            ratioBoost: ratio,
            flatBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoostLevelBonus: 0,
            startTime: 0,
            duration: Number.MAX_SAFE_INTEGER,
        },
    });

    test('a target equal to what the build already holds changes nothing (no double count)', () => {
        const snap = snapshotWith(target(0.1), 0.1);
        expect(snap.buffed.maxHitpoints).toBe(snap.base.maxHitpoints);
        expect(snap.deltas['/buff_types/max_hitpoints'].ratioBoost).toBeCloseTo(0, 9);
    });

    test('a target above what the build holds applies only the difference', () => {
        const held = snapshotWith(target(0.3), 0.1);
        // Ratios of one type add to the base: the build already at +10% ends at
        // +30% total — the delta applied was +20%, not +30% on top of +10%
        // The fixture's unbuffed HP is 10 × (10 + stamina 70) = 800
        expect(held.base.maxHitpoints).toBe(Math.floor(800 * 1.1));
        expect(held.buffed.maxHitpoints).toBe(Math.floor(800 * 1.3));
        expect(held.deltas['/buff_types/max_hitpoints'].ratioBoost).toBeCloseTo(0.2, 9);
    });
});

/**
 * What a pass of checkEncounterEnd leaves behind.
 *
 * The event queue outlives the encounter, so anything still queued when
 * this.enemies is replaced keeps acting from outside the fight — and
 * checkEncounterEnd only ever looks at this.enemies, so nothing can ever
 * retire it. These tests pin the two ways that used to happen.
 */
describe('encounter teardown', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';

    /** A simulator sitting in a two-wave dungeon with the first wave spawned. */
    function dungeonSim() {
        installGameData();
        const gameData = getGameData();
        gameData.actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: null,
                dungeonInfo: {
                    maxWaves: 2,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
        seedSimRng(7);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 10 * ONE_SECOND;
        player.reset(sim.simulationTime);
        sim.enemies = zone.getNextWave();
        sim.enemies.forEach((enemy) => enemy.reset(sim.simulationTime));
        // startNewEncounter opens the wave's alive window; this fixture spawns
        // the wave by hand, so open it here too
        sim.simResult.updateTimeSpentAlive('#' + (zone.encountersKilled - 1).toString(), true, sim.simulationTime);
        return sim;
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('a wipe moments after a wave was cleared leaves nothing queued to respawn', () => {
        const sim = dungeonSim();

        // The wave dies...
        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        expect(sim.checkEncounterEnd()).toBe(true);
        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(true);

        // ...and a damage-over-time tick finishes the party before it fires
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));
        expect(sim.checkEncounterEnd()).toBe(true);

        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(false);
    });

    test('and no phantom attacker survives the restart', () => {
        const sim = dungeonSim();

        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();

        // Drive the queue until the restart has spawned the next wave
        for (let i = 0; i < 50 && !sim.enemies; i++) {
            sim.processEvent(sim.eventQueue.getNextEvent());
        }
        expect(sim.enemies).toBeTruthy();

        const known = new Set([...sim.players, ...sim.enemies]);
        const stray = sim.eventQueue.getMatching((event) => event.source && !known.has(event.source));
        expect(stray).toBeNull();
    });

    test('a pass that both clears the wave and wipes the party counts once, as a wipe', () => {
        // Thorns can kill the last monster and the last player in the same blow.
        // A dungeon run ends when the party is down, so the wave is not credited
        const sim = dungeonSim();

        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.players.forEach((player) => (player.combatDetails.currentHitpoints = 0));

        expect(sim.checkEncounterEnd()).toBe(true);

        // No wave credit, no experience, nothing waiting to respawn
        expect(sim.simResult.encounters).toBe(0);
        expect(sim.simResult.experienceGained.player1).toBeUndefined();
        expect(sim.eventQueue.containsEventOfType(EnemyRespawnEvent.type)).toBe(false);

        // Exactly one restart, and one failure once it runs
        const restarts = sim.eventQueue.minHeap.data.filter((e) => e.type === CombatStartEvent.type);
        expect(restarts).toHaveLength(1);
        expect(sim.allPlayersDead).toBe(true);
        sim.startNewEncounter();
        expect(sim.zone.dungeonsFailed).toBe(1);
        expect(sim.zone.dungeonsCompleted).toBe(0);
    });
});

/**
 * Deaths counted by the auto-attack path.
 *
 * Pierce keeps one attack swinging, and a monster picks its next victim by
 * threat. Rolling that against the list of targets alive when the attack
 * *started* can pick a player this same attack already killed: the corpse takes
 * a second 0-damage hit and is counted dead twice.
 */
describe('pierce does not kill anyone twice', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    /**
     * One monster auto-attack with guaranteed pierce into a two-player party
     * standing at a single hitpoint each.
     * @param {number} seed - RNG seed
     * @returns {CombatSimulator}
     */
    function pierceSwing(seed) {
        installGameData();
        seedSimRng(seed);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const player = fixturePlayer();
            player.hrid = hrid;
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            return player;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((player) => {
            player.reset(sim.simulationTime);
            player.combatDetails.currentHitpoints = 1;
        });
        sim.enemies = [new Monster(TOAD_HRID, 0)];
        sim.enemies[0].reset(sim.simulationTime);
        // Always pierce, so one swing walks the whole party
        sim.enemies[0].combatDetails.combatStats.pierce = 1;

        sim.processAutoAttackEvent(new AutoAttackEvent(sim.simulationTime, sim.enemies[0]));
        return sim;
    }

    test('a player is counted dead once, however many times the swing pierces', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const sim = pierceSwing(seed);
            for (const player of sim.players) {
                const down = player.combatDetails.currentHitpoints === 0;
                expect(sim.simResult.deaths[player.hrid] ?? 0).toBe(down ? 1 : 0);
            }
            clearSimRng();
            setGameData(null);
        }
    });

    test('and no corpse takes a zero-damage hit', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const sim = pierceSwing(seed);
            const landed = sim.simResult.attacks[TOAD_HRID] ?? {};
            for (const byTarget of Object.values(landed)) {
                expect(byTarget.autoAttack?.[0] ?? 0).toBe(0);
            }
            clearSimRng();
            setGameData(null);
        }
    });

    test('a surviving high-threat player is not hit twice by one piercing swing', () => {
        const sim = pierceSwing(7);
        const [tank, other] = sim.players;

        // Re-run the swing with both players healthy enough to survive it. A
        // zero-threat second player makes the first threat roll deterministic:
        // without excluding prior targets, both pierce hits land on the tank.
        sim.simResult.attacks = {};
        sim.eventQueue.clear();
        for (const player of sim.players) {
            player.combatDetails.maxHitpoints = 1_000_000;
            player.combatDetails.currentHitpoints = 1_000_000;
            player.combatDetails.smashEvasionRating = 0;
        }
        tank.combatDetails.combatStats.threat = 100;
        other.combatDetails.combatStats.threat = 0;
        sim.enemies[0].combatDetails.smashAccuracyRating = 1_000_000;

        sim.processAutoAttackEvent(new AutoAttackEvent(sim.simulationTime, sim.enemies[0]));

        const attemptsAgainst = (player) =>
            Object.values(sim.simResult.attacks[TOAD_HRID]?.[player.hrid]?.autoAttack ?? {}).reduce(
                (sum, count) => sum + count,
                0
            );
        expect(attemptsAgainst(tank)).toBe(1);
        expect(attemptsAgainst(other)).toBe(1);
    });
});

/**
 * A revived monster is still one spawn.
 *
 * `simResult.deaths[monsterHrid]` is read as a kill count: the combat adapter
 * prices a run's loot by multiplying it against the drop table, and
 * utils/expected-kills.js models the same quantity as spawns per battle. Loot
 * is a spawn's, not a knockdown's, so a monster raised and killed again must
 * still be one.
 */
describe('revive takes the death back', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    const REVIVE_EFFECT = {
        targetType: 'deadAlly',
        combatStyleHrid: '/combat_styles/magic',
        damageFlat: 100,
        damageRatio: 0,
    };

    test('killed, revived, killed again is one kill for drops', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const healer = new Monster(RAT_HRID, 0);
        const victim = new Monster(TOAD_HRID, 0);
        [healer, victim].forEach((monster) => monster.reset(sim.simulationTime));
        sim.enemies = [healer, victim];
        sim.simResult.updateTimeSpentAlive(victim.hrid, true, sim.simulationTime);

        // First death
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.simResult.updateTimeSpentAlive(victim.hrid, false, sim.simulationTime);

        // Raised
        sim.simulationTime += ONE_SECOND;
        sim.processAbilityReviveEffect(healer, { hrid: '/abilities/revive' }, REVIVE_EFFECT);
        expect(victim.combatDetails.currentHitpoints).toBeGreaterThan(0);
        expect(sim.simResult.deaths[TOAD_HRID] ?? 0).toBe(0);

        // And killed for good
        sim.simulationTime += ONE_SECOND;
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.simResult.updateTimeSpentAlive(victim.hrid, false, sim.simulationTime);

        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);
        const entry = sim.simResult.timeSpentAlive.find((e) => e.name === TOAD_HRID);
        expect(entry.count).toBe(1);
    });

    /**
     * Dying clears every event that names the unit, expiry checks included, and
     * nothing else prunes a buff. A revived unit whose checks were not re-armed
     * kept a timed buff for the rest of the encounter.
     */
    test('a revived unit keeps its buffs only for what is left of their duration', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const p = fixturePlayer();
            p.hrid = hrid;
            p.zoneBuffs = zone.buffs;
            p.extraBuffs = [];
            return p;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((p) => p.reset(sim.simulationTime));

        const victim = players[1];
        victim.addBuff(
            {
                uniqueHrid: '/buff_uniques/test_aura',
                typeHrid: '/buff_types/damage',
                flatBoost: 0,
                ratioBoost: 0.3,
                duration: 10 * ONE_SECOND,
            },
            sim.simulationTime
        );
        const expiry = sim.simulationTime + 10 * ONE_SECOND;

        // Down, which is what sweeps the buff's own expiry check off the queue
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        sim.eventQueue.clearEventsForUnit(victim);

        sim.simulationTime += ONE_SECOND;
        sim.processAbilityReviveEffect(players[0], { hrid: '/abilities/revive' }, REVIVE_EFFECT);

        const checks = sim.eventQueue.minHeap.data.filter(
            (event) => event.type === 'checkBuffExpiration' && event.source === victim
        );
        expect(checks.map((event) => event.time)).toContain(expiry);

        // And the buff really goes when that check fires
        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs['/buff_uniques/test_aura']).toBeUndefined();
    });

    test('but a revived player still shows every time they went down', () => {
        installGameData();
        seedSimRng(3);
        const zone = new Zone(ZONE_HRID, 0);
        const players = ['player1', 'player2'].map((hrid) => {
            const p = fixturePlayer();
            p.hrid = hrid;
            p.zoneBuffs = zone.buffs;
            p.extraBuffs = [];
            return p;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((p) => p.reset(sim.simulationTime));

        players[1].combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(players[1]);

        sim.processAbilityReviveEffect(players[0], { hrid: '/abilities/revive' }, REVIVE_EFFECT);

        expect(sim.simResult.deaths.player2).toBe(1);
    });
});

/**
 * Boss progress in an ordinary zone.
 *
 * Zone.failWave() counts a dungeon failure and resets encountersKilled — which
 * outside a dungeon is the count towards the next boss. Running it on any death
 * wiped boss progress in ordinary zones, a reset the game does not do
 * (utils/expected-kills.js models none either).
 */
describe('dying in an ordinary zone', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('keeps the progress towards the next boss', () => {
        installGameData();
        seedSimRng(11);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();

        zone.getRandomEncounter();
        zone.getRandomEncounter();
        const progress = zone.encountersKilled;
        expect(progress).toBeGreaterThan(1);

        sim.allPlayersDead = true;
        sim.startNewEncounter();

        expect(zone.encountersKilled).toBeGreaterThan(progress);
        expect(zone.dungeonsFailed).toBe(0);
    });
});

/**
 * A monster with a missing or zero enrageTime must not poison XP.
 *
 * checkEncounterEnd divides by enrageTime to compute experienceRate; a
 * degenerate 0/absent value made it NaN, and NaN slips past both the `=== 0`
 * re-check and the `<= 0` warning, silently zeroing every awarded XP total.
 */
describe('a monster with no enrage time', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('yields finite XP instead of NaN', () => {
        installGameData();
        seedSimRng(7);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 5 * ONE_SECOND;
        sim.enrageBeginTime = 0;
        player.reset(sim.simulationTime);

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        // Degenerate game data: enrageTime absent/zero
        victim.enrageTime = 0;
        victim.combatDetails.currentHitpoints = 0;
        sim.enemies = [victim];

        sim.checkEncounterEnd();

        expect(victim.experienceRate).toBe(1.0);
        const xp = sim.simResult.experienceGained.player1;
        Object.values(xp).forEach((value) => expect(Number.isFinite(value)).toBe(true));
        expect(xp.melee).toBeGreaterThan(0);
    });
});

/**
 * A damage-over-time tick must never re-kill a corpse.
 *
 * Every melee death site reads targetWasAlive before the blow so a zero-damage
 * hit on a downed unit is not credited as a fresh death; the DoT tick lacked
 * that guard. It is currently unreachable (clearEventsForUnit drops queued DoT
 * ticks on death), but one event-ordering change from double-counting a kill —
 * and deaths[monsterHrid] prices a run's loot.
 */
describe('a damage-over-time tick on a corpse', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('does not count a second death on an already-dead unit', () => {
        installGameData();
        seedSimRng(5);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        sim.enemies = [victim];

        // Already down and already counted once
        victim.combatDetails.currentHitpoints = 0;
        sim.simResult.addDeath(victim);
        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);

        const tick = new DamageOverTimeEvent(sim.simulationTime, player, victim, 100, 5, 1, '/combat_styles/smash');
        sim.processDamageOverTimeTickEvent(tick);

        expect(sim.simResult.deaths[TOAD_HRID]).toBe(1);
    });
});

/**
 * A damage-over-time tick outside a dungeon must not fill the wipe-log buffer.
 *
 * The other seven addToWipeLogs sites gate on zone.isDungeon; the DoT tick did
 * not, so in a dungeon its per-tick lines evict the damage that explains a wipe
 * from the 200-entry ring buffer. Diagnostic only — no simulated number moves.
 */
describe('a damage-over-time tick outside a dungeon', () => {
    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('writes no wipe-log line', () => {
        installGameData();
        seedSimRng(6);
        const zone = new Zone(ZONE_HRID, 0);
        expect(zone.isDungeon).toBe(false);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;

        const victim = new Monster(TOAD_HRID, 0);
        victim.reset(sim.simulationTime);
        sim.enemies = [victim];

        const tick = new DamageOverTimeEvent(sim.simulationTime, player, victim, 100, 5, 1, '/combat_styles/smash');
        sim.processDamageOverTimeTickEvent(tick);

        expect(sim.wipeLogs.count).toBe(0);
    });
});

/**
 * "Avg completion time" must match the in-game dungeon tracker's key→key
 * definition: the mean of completion-to-completion intervals over consecutive
 * successful runs. The old `simulatedTime / dungeonsCompleted` divided the whole
 * simulated window (including the unfinished final run, and any wipe time) by
 * only the completed runs, so it read systematically longer than a real clear.
 */
describe('dungeon clean clear-time metric', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';

    function installDungeon(maxWaves = 2) {
        installGameData();
        getGameData().actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { bossSpawns: null },
                dungeonInfo: {
                    maxWaves,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('averages completion-to-completion intervals, excluding the unfinished tail', () => {
        installDungeon();
        seedSimRng(11);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];

        const result = new CombatSimulator([player], zone).simulate(600 * ONE_SECOND);

        // The fixture player clears these trivial waves every time
        expect(result.isDungeon).toBe(true);
        expect(result.dungeonsFailed).toBe(0);
        expect(result.dungeonsCompleted).toBeGreaterThan(2);

        // With no wipes, every completion after the first forms a clean pair
        expect(result.dungeonCleanClearCount).toBe(result.dungeonsCompleted - 1);
        expect(result.dungeonCleanClearTimeTotal).toBeGreaterThan(0);

        const cleanAvg = result.dungeonCleanClearTimeTotal / result.dungeonCleanClearCount;
        const naiveAvg = result.simulatedTime / result.dungeonsCompleted;

        // The naive average carries the unfinished final run's elapsed time in
        // its numerator without crediting it, so it is strictly larger.
        expect(cleanAvg).toBeLessThan(naiveAvg);

        // Each clean pair is exactly one completion-to-completion interval; they
        // are consistent, so the total is an integer multiple of one cycle.
        const perCycle = result.dungeonCleanClearTimeTotal / result.dungeonCleanClearCount;
        expect(perCycle).toBeGreaterThan(0);
    });

    test('a wipe breaks the clear-time pair', () => {
        installDungeon();
        seedSimRng(3);
        const zone = new Zone(DUNGEON_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = 10 * ONE_SECOND;
        player.reset(sim.simulationTime);
        sim.enemies = zone.getNextWave();
        sim.enemies.forEach((enemy) => enemy.reset(sim.simulationTime));
        // Open the wave's alive window that startNewEncounter would have opened
        sim.simResult.updateTimeSpentAlive('#' + (zone.encountersKilled - 1).toString(), true, sim.simulationTime);

        // Clear the wave, then wipe the party
        sim.enemies.forEach((enemy) => (enemy.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();
        sim.simulationTime += ONE_SECOND;
        sim.players.forEach((p) => (p.combatDetails.currentHitpoints = 0));
        sim.checkEncounterEnd();

        expect(sim.dungeonPairBroken).toBe(true);
    });
});

/**
 * The other two doors a downed player comes back through.
 *
 * A cast revive re-arms the buff expiry checks that dying swept off the queue.
 * Nothing else prunes a buff, so every other path that puts a corpse back on its
 * feet owes the same re-arming: clearing a dungeon heals the whole party
 * (survivors and corpses alike), and a wipe restart resets the party while
 * deliberately keeping its still-running buffs. Both left a timed buff running
 * for the rest of the run — an accuracy or damage aura that never lapses is a
 * free permanent upgrade the player does not have.
 */
describe('a buff does not outlive its duration when a downed player is put back up', () => {
    const DUNGEON_HRID = '/actions/combat/golden_crypt';
    const TEST_BUFF = {
        uniqueHrid: '/buff_uniques/test_aura',
        typeHrid: '/buff_types/damage',
        flatBoost: 0,
        ratioBoost: 0.3,
        duration: 10 * ONE_SECOND,
    };

    /** A two-wave dungeon of fixed rosters — the wave draw is not what is under test. */
    function installDungeon() {
        installGameData();
        getGameData().actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { bossSpawns: null },
                dungeonInfo: {
                    maxWaves: 2,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
    }

    /**
     * A seeded dungeon sim with `count` players, each buffed and ready to fight.
     * @param {number} count - Party size
     * @returns {{sim: CombatSimulator, zone: Zone, players: Player[]}}
     */
    function buffedParty(count) {
        installDungeon();
        seedSimRng(3);
        const zone = new Zone(DUNGEON_HRID, 0);
        const players = Array.from({ length: count }, (_, i) => {
            const player = fixturePlayer();
            player.hrid = 'player' + (i + 1);
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            return player;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((player) => player.reset(sim.simulationTime));
        players.forEach((player) => player.addBuff(TEST_BUFF, sim.simulationTime));
        return { sim, zone, players };
    }

    /**
     * The buff-expiry checks standing for one unit.
     * @param {CombatSimulator} sim - The simulator to read
     * @param {Object} unit - The unit the checks must name
     * @returns {number[]} Their event times
     */
    function expiryChecks(sim, unit) {
        return sim.eventQueue.minHeap.data
            .filter((event) => event.type === 'checkBuffExpiration' && event.source === unit)
            .map((event) => event.time);
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('clearing the dungeon re-arms the checks of a party member who died on the way', () => {
        const { sim, zone, players } = buffedParty(2);
        const expiry = sim.simulationTime + TEST_BUFF.duration;

        // One player goes down mid-run; in a dungeon nobody respawns, so they
        // stay down until the clear. Dying is what sweeps their expiry check.
        const victim = players[1];
        victim.combatDetails.currentHitpoints = 0;
        sim.eventQueue.clearEventsForUnit(victim);
        expect(expiryChecks(sim, victim)).toEqual([]);

        // The next wave wraps past maxWaves — the clear that heals the party
        zone.encountersKilled = 3;
        sim.enemies = null;
        sim.simulationTime += ONE_SECOND;
        sim.startNewEncounter();

        expect(zone.dungeonsCompleted).toBe(1);
        expect(victim.combatDetails.currentHitpoints).toBe(victim.combatDetails.maxHitpoints);
        expect(expiryChecks(sim, victim)).toContain(expiry);

        // And the buff really goes when that check fires
        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeUndefined();
    });

    test('a wipe restart re-arms the checks the wipe itself threw away', () => {
        const { sim, players } = buffedParty(1);
        const expiry = sim.simulationTime + TEST_BUFF.duration;

        const victim = players[0];
        victim.combatDetails.currentHitpoints = 0;
        sim.eventQueue.clearEventsForUnit(victim);
        sim.allPlayersDead = true;
        sim.enemies = null;

        // The CombatStartEvent the wipe schedules. reset() keeps the buff by
        // design (it is still inside its duration), so the check must come back.
        sim.simulationTime += ONE_SECOND;
        sim.processCombatStartEvent({ time: sim.simulationTime });

        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeDefined();
        expect(expiryChecks(sim, victim)).toContain(expiry);

        sim.simulationTime = expiry;
        victim.removeExpiredBuffs(sim.simulationTime);
        expect(victim.combatBuffs[TEST_BUFF.uniqueHrid]).toBeUndefined();
    });
});

/**
 * What survives a wave transition, and what the killing blow re-arms.
 *
 * Two things are pinned here, both of them ordering rather than arithmetic, and
 * both invisible to every other test in this file.
 *
 * 1. Clearing the queued swings wholesale at a wave clear used to hand every
 *    player a fresh full attack interval at the next spawn, shaving part of a
 *    swing off each of a run's waves. Only the departing monsters' swings are
 *    retired now, so every survivor carries its own rhythm across. A revert to
 *    clearing `AutoAttackEvent` by type shows up here as an empty respawn gap.
 * 2. `processAutoAttackEvent` re-arms its source *before* tearing the encounter
 *    down, as the ability path always has. That ordering is load bearing twice
 *    over: `addNextAttackEvent` reads `this.enemies` to pick a target and bails
 *    out entirely on a null enemy list, so running it after the teardown queues
 *    nothing at all; and an attacker whose own killing blow left it un-armed
 *    restarted its clock from the respawn instead of from the blow.
 *
 * A swing that falls inside the respawn gap is consumed with no re-arm — the
 * event handler returns early on the null enemy list. So for a build whose
 * attack interval is shorter than the gap (the fixture's is, at ~2.90 s against
 * a 3.04 s gap) the killer's re-armed swing is discarded exactly as it would
 * have been, and nothing about the run moves. It is builds slower than the gap
 * that gain, which is why this pins the re-arm *time* rather than a total.
 *
 * The fixture party is deliberately sturdy and ability-less: nobody dies, is
 * stunned, blinded or silenced, so a missing swing means a missing swing.
 */
describe('a wave transition and the swings that cross it', () => {
    const PARTY_SECONDS = 600;
    const RESPAWN_GAP = 3.0369 * ONE_SECOND;

    /**
     * A party member tough enough to survive the fixture zone for a whole run.
     * @param {string} hrid - Unique player identifier
     * @returns {Player} The party member
     */
    function partyPlayer(hrid) {
        return Player.createFromDTO({
            hrid,
            staminaLevel: 110,
            intelligenceLevel: 40,
            attackLevel: 70,
            meleeLevel: 70,
            defenseLevel: 100,
            rangedLevel: 1,
            magicLevel: 1,
            equipment: {},
            food: [null, null, null],
            drinks: [null, null, null],
            abilities: [null, null, null, null],
            houseRooms: {},
            debuffOnLevelGap: 0,
        });
    }

    /**
     * One seeded party run, with every respawn gap recorded.
     *
     * A gap opens on the pass that sets `this.enemies` to null — in this open
     * zone that is the wave-cleared branch and nothing else — and every auto
     * attack processed while the list is null fell inside it. Gaps opened while
     * somebody was down are dropped: a corpse has no swing to carry.
     * @param {number} seed - RNG seed
     * @param {number} partySize - Number of players in the party
     * @returns {Object} The run's result, players, gaps and attack interval
     */
    function partyRun(seed, partySize) {
        installGameData();
        seedSimRng(seed);

        const zone = new Zone(ZONE_HRID, 0);
        const players = [];
        for (let i = 1; i <= partySize; i++) {
            const player = partyPlayer(`party${i}`);
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            players.push(player);
        }

        const simulator = new CombatSimulator(players, zone);
        const gaps = [];
        let openGap = null;
        const processAutoAttack = simulator.processAutoAttackEvent.bind(simulator);
        simulator.processAutoAttackEvent = (event) => {
            const hadEnemies = Boolean(simulator.enemies);
            if (!hadEnemies && openGap) {
                openGap.swings.push(event.source.hrid);
            }
            processAutoAttack(event);
            if (hadEnemies && !simulator.enemies) {
                openGap = {
                    killer: event.source.hrid,
                    killedAt: simulator.simulationTime,
                    // Whatever the killer's own re-arm put on the queue, read
                    // before anything downstream can consume it
                    rearm: simulator.eventQueue.getByTypeAndSource(AutoAttackEvent.type, event.source)?.time ?? null,
                    aliveAtOpen: players.filter((player) => player.combatDetails.currentHitpoints > 0).length,
                    swings: [],
                };
                gaps.push(openGap);
            }
        };

        const result = simulator.simulate(PARTY_SECONDS * ONE_SECOND);
        return {
            result,
            players,
            gaps: gaps.filter((gap) => gap.aliveAtOpen === partySize),
            attackInterval: players[0].combatDetails.combatStats.attackInterval,
        };
    }

    test('every player who did not land the killing blow carries its swing into the gap', () => {
        const partySize = 3;
        const { gaps, players, attackInterval } = partyRun(20260806, partySize);

        // For this to be a statement about preserved timers at all the interval
        // has to be shorter than the gap: a slower build's carried swing would
        // land past the respawn and never show up inside one
        expect(attackInterval).toBeLessThan(RESPAWN_GAP);
        // Enough waves that this is a pattern rather than an accident
        expect(gaps.length).toBeGreaterThanOrEqual(10);

        const everyone = players.map((player) => player.hrid);
        for (const gap of gaps) {
            const others = everyone.filter((hrid) => hrid !== gap.killer).sort();
            const fired = gap.swings.filter((hrid) => hrid !== gap.killer).sort();

            // Each of the other players, exactly once. Clearing the queue by
            // event type at the wave clear leaves this empty.
            expect(fired).toEqual(others);
        }
    });

    test('the killing blow re-arms its own attacker, from the blow and not from the respawn', () => {
        const { gaps, attackInterval } = partyRun(20260806, 3);

        expect(gaps.length).toBeGreaterThanOrEqual(10);
        for (const gap of gaps) {
            // Non-null proves the re-arm ran while `this.enemies` was still
            // standing: after the teardown `addNextAttackEvent` returns on the
            // null enemy list and queues nothing at all
            expect(gap.rearm).not.toBeNull();
            expect(gap.rearm - gap.killedAt).toBeCloseTo(attackInterval, 0);
        }
    });
});

/**
 * Crowd control across a dungeon clear.
 *
 * Dying sweeps every event that names the unit, which takes the stun, blind and
 * silence expirations with it, and nothing at death lowers the flags those
 * events exist to lower. The dungeon clear then stands the body up. If it does
 * not lower them itself, nothing ever will: there is no event left that could.
 *
 * The flags are not symmetrical in how they disable a player, so the tests are
 * not either. A stuck stun or silence blocks `shouldTrigger`, so abilities and
 * consumables stop forever while autos carry on; a stuck blind sends
 * `addNextAttackEvent` down its else branch, which queues nothing at all — that
 * one is a player who simply stops fighting, which is why the "can they still
 * act" assertion below is written against blind.
 */
describe('crowd control does not survive a dungeon-clear revive', () => {
    const DUNGEON_HRID = '/actions/combat/golden_oubliette';

    /** A two-wave dungeon of fixed rosters — the wave draw is not what is under test. */
    function installDungeon() {
        installGameData();
        getGameData().actionDetailMap[DUNGEON_HRID] = {
            buffs: null,
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { bossSpawns: null },
                dungeonInfo: {
                    maxWaves: 2,
                    fixedSpawnsMap: {
                        1: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0 }],
                        2: [{ combatMonsterHrid: TOAD_HRID, difficultyTier: 0 }],
                    },
                    randomSpawnInfoMap: null,
                },
            },
        };
    }

    /**
     * A seeded dungeon sim with `count` players, one second into the run.
     * @param {number} count - Party size
     * @returns {{sim: CombatSimulator, zone: Zone, players: Player[]}}
     */
    function party(count) {
        installDungeon();
        seedSimRng(11);
        const zone = new Zone(DUNGEON_HRID, 0);
        const players = Array.from({ length: count }, (_, i) => {
            const player = fixturePlayer();
            player.hrid = 'player' + (i + 1);
            player.zoneBuffs = zone.buffs;
            player.extraBuffs = [];
            return player;
        });
        const sim = new CombatSimulator(players, zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        players.forEach((player) => player.reset(sim.simulationTime));
        return { sim, zone, players };
    }

    /**
     * Wrap the wave counter past maxWaves and spawn, which is the clear.
     * @param {CombatSimulator} sim - The simulator to advance
     * @param {Zone} zone - Its zone
     */
    function clearTheDungeon(sim, zone) {
        zone.encountersKilled = 3;
        sim.enemies = null;
        sim.simulationTime += ONE_SECOND;
        sim.startNewEncounter();
        expect(zone.dungeonsCompleted).toBe(1);
    }

    /**
     * Kill a player the way the engine does: zero them and sweep their events,
     * their queued crowd-control expiration among them.
     * @param {CombatSimulator} sim - The simulator holding the queue
     * @param {Object} victim - The player to put down
     */
    function kill(sim, victim) {
        victim.combatDetails.currentHitpoints = 0;
        sim.eventQueue.clearEventsForUnit(victim);
    }

    /**
     * Events of one type standing for one unit.
     * @param {CombatSimulator} sim - The simulator to read
     * @param {string} type - The event type
     * @param {Object} unit - The unit the events must name
     * @returns {Object[]} The matching events
     */
    function eventsFor(sim, type, unit) {
        return sim.eventQueue.minHeap.data.filter((event) => event.type === type && event.source === unit);
    }

    afterEach(() => {
        clearSimRng();
        setGameData(null);
    });

    test('a player stunned, then killed, is not still stunned after the clear', () => {
        const { sim, zone, players } = party(2);
        const victim = players[1];

        victim.isStunned = true;
        victim.stunExpireTime = sim.simulationTime + 3 * ONE_SECOND;
        sim.eventQueue.addEvent(new StunExpirationEvent(victim.stunExpireTime, victim));

        kill(sim, victim);
        expect(eventsFor(sim, StunExpirationEvent.type, victim)).toEqual([]);

        clearTheDungeon(sim, zone);

        expect(victim.combatDetails.currentHitpoints).toBe(victim.combatDetails.maxHitpoints);
        expect(victim.isStunned).toBe(false);
        // Not merely lowered: no stale time left behind either. A trigger reads
        // `stunExpireTime === currentTime`, so a stale one is a live landmine.
        expect(victim.stunExpireTime).toBeNull();
    });

    test('a player blinded, then killed, is not still blinded after the clear', () => {
        const { sim, zone, players } = party(2);
        const victim = players[1];

        victim.isBlinded = true;
        victim.blindExpireTime = sim.simulationTime + 3 * ONE_SECOND;
        sim.eventQueue.addEvent(new BlindExpirationEvent(victim.blindExpireTime, victim));

        kill(sim, victim);
        clearTheDungeon(sim, zone);

        expect(victim.isBlinded).toBe(false);
        expect(victim.blindExpireTime).toBeNull();
    });

    test('a player silenced, then killed, is not still silenced after the clear', () => {
        const { sim, zone, players } = party(2);
        const victim = players[1];

        victim.isSilenced = true;
        victim.silenceExpireTime = sim.simulationTime + 3 * ONE_SECOND;
        sim.eventQueue.addEvent(new SilenceExpirationEvent(victim.silenceExpireTime, victim));

        kill(sim, victim);
        clearTheDungeon(sim, zone);

        expect(victim.isSilenced).toBe(false);
        expect(victim.silenceExpireTime).toBeNull();
    });

    test('the revived player can actually act on the next wave, not merely read as free', () => {
        // Blind is the flag that proves it. A lowered `isBlinded` and a queued
        // swing are two different things: `addNextAttackEvent` queues nothing
        // while the flag is up, so a half-fix that only lowered flags after
        // `startAttacks` had already run would pass the assertions above and
        // still leave this player standing there doing nothing.
        const { sim, zone, players } = party(2);
        const victim = players[1];

        victim.isBlinded = true;
        victim.blindExpireTime = sim.simulationTime + 3 * ONE_SECOND;
        sim.eventQueue.addEvent(new BlindExpirationEvent(victim.blindExpireTime, victim));

        kill(sim, victim);
        clearTheDungeon(sim, zone);

        expect(eventsFor(sim, AutoAttackEvent.type, victim).length).toBe(1);
        expect(victim.isOutOfMana).toBe(false);
    });

    test('a player still standing keeps the stun that is legitimately running', () => {
        const { sim, zone, players } = party(2);
        const [standing, victim] = players;

        standing.isStunned = true;
        standing.stunExpireTime = sim.simulationTime + 30 * ONE_SECOND;
        sim.eventQueue.addEvent(new StunExpirationEvent(standing.stunExpireTime, standing));
        const expireTime = standing.stunExpireTime;

        // Somebody has to be down, or the revive branch is not exercised at all
        kill(sim, victim);
        clearTheDungeon(sim, zone);

        expect(standing.isStunned).toBe(true);
        expect(standing.stunExpireTime).toBe(expireTime);
        expect(eventsFor(sim, StunExpirationEvent.type, standing).map((event) => event.time)).toEqual([expireTime]);
    });

    test('the clear does not quietly cancel a curse the revived player is carrying', () => {
        // `clearCCs` would have: it zeroes `damageTaken`, which is not a status
        // but the folded value of a buff this branch keeps on purpose. Zeroed
        // here, it would come back at the next `updateCombatDetails` — a stat
        // that disagrees with the buff behind it, for an interval nobody set.
        const { sim, zone, players } = party(2);
        const victim = players[1];

        victim.addBuff(
            {
                uniqueHrid: '/buff_uniques/curse',
                typeHrid: '/buff_types/damage_taken',
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
                flatBoost: 0.25,
                flatBoostLevelBonus: 0,
                duration: 15000000000,
            },
            sim.simulationTime
        );
        expect(victim.combatDetails.combatStats.damageTaken).toBeCloseTo(0.25, 10);

        victim.isStunned = true;
        victim.stunExpireTime = sim.simulationTime + 3 * ONE_SECOND;
        kill(sim, victim);
        clearTheDungeon(sim, zone);

        expect(victim.isStunned).toBe(false);
        expect(victim.combatBuffs['/buff_uniques/curse']).toBeDefined();
        expect(victim.combatDetails.combatStats.damageTaken).toBeCloseTo(0.25, 10);
    });
});

/**
 * `isOutOfMana` is the fork's own bookkeeping for a unit parked waiting on
 * mana. Three mana-restoration paths read it to decide whether to wake the
 * unit, and the exhaustion window it opens is what `timeOutOfManaSeconds` and
 * `manaExhaustionFraction` report to the food optimizer. So it has to mean
 * exactly one thing, and blindness is not that thing.
 */
describe('out-of-mana is a mana state and nothing else', () => {
    /**
     * A solo fight standing one second in, with the player's own events swept
     * so `addNextAttackEvent` is reached rather than short-circuited by the
     * swing already queued for them.
     * @returns {{sim: CombatSimulator, player: Object}} The simulator and its player
     */
    function soloFight() {
        installGameData();
        seedSimRng(11);
        const zone = new Zone(ZONE_HRID, 0);
        const player = fixturePlayer();
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const sim = new CombatSimulator([player], zone);
        sim.reset();
        sim.simulationTime = ONE_SECOND;
        player.reset(sim.simulationTime);
        sim.startNewEncounter();
        sim.eventQueue.clearEventsForUnit(player);
        return { sim, player };
    }

    /**
     * The least an ability has to be for `addNextAttackEvent` to consider it:
     * it triggers, it costs, and it takes no time to cast.
     * @param {number} manaCost - What the cast costs
     * @returns {Object} A stand-in ability
     */
    function alwaysTriggers(manaCost) {
        return {
            hrid: '/abilities/fixture',
            manaCost,
            castDuration: 0,
            lastUsed: 0,
            shouldTrigger: () => true,
        };
    }

    /**
     * Events of one type standing for one unit.
     * @param {CombatSimulator} sim - The simulator to read
     * @param {string} type - The event type
     * @param {Object} unit - The unit the events must name
     * @returns {Object[]} The matching events
     */
    function queued(sim, type, unit) {
        return sim.eventQueue.minHeap.data.filter((event) => event.type === type && event.source === unit);
    }

    test('blindness does not mark a unit out of mana', () => {
        // Deliberately NOT asserted here: whether a blinded unit queues a swing
        // at all. The engine currently queues nothing, that is inherited and
        // unmeasured (claim 6 in docs/sim-claim-verification.md), and pinning
        // it would make the eventual correction look like a regression. The
        // flag is what this change is about and the flag is all this checks.
        const { sim, player } = soloFight();
        player.isBlinded = true;
        player.combatDetails.currentManapoints = player.combatDetails.maxManapoints;

        sim.addNextAttackEvent(player);

        expect(player.isOutOfMana).toBe(false);
    });

    test('blindness does not mark a unit out of mana when its ability was also unaffordable', () => {
        // The two states at once, which is where the old code was worst: a
        // blinded unit that also could not afford its ability. Giving it mana
        // to spare instead would not test this at all — the cast would succeed
        // and return before the blind branch is ever reached.
        const { sim, player } = soloFight();
        player.abilities = [alwaysTriggers(10)];
        player.combatDetails.currentManapoints = 4;
        player.isBlinded = true;

        sim.addNextAttackEvent(player);

        // The unit flag stays down. What the ability actually cost this unit is
        // `simResult`'s business, and `canUseAbility` records that honestly on
        // its own — the flag is the wake gate, not the ledger.
        expect(player.isOutOfMana).toBe(false);
    });

    test('a unit that cannot afford its triggered ability still swings', () => {
        // Measured on the live game, and the reason this is a test rather than
        // a detail: a character whose cheapest ability costs 10 mana was driven
        // down to exhaustion and its `atkCounter` kept rising at 34, 24, 14 and
        // 4 mana — below every ability it owned — with an unbroken cadence. A
        // unit idling for mana would have produced no attacks there. Anyone
        // making the unaffordable case pause instead breaks this.
        const { sim, player } = soloFight();
        player.abilities = [alwaysTriggers(10)];
        player.combatDetails.currentManapoints = 4;

        sim.addNextAttackEvent(player);

        expect(queued(sim, AutoAttackEvent.type, player).length).toBe(1);
        expect(queued(sim, AbilityCastEndEvent.type, player)).toEqual([]);
    });

    test('an affordable cast clears a stale out-of-mana flag', () => {
        const { sim, player } = soloFight();
        player.abilities = [alwaysTriggers(10)];
        player.combatDetails.currentManapoints = 500;
        player.isOutOfMana = true;

        sim.addNextAttackEvent(player);

        expect(queued(sim, AbilityCastEndEvent.type, player).length).toBe(1);
        expect(player.isOutOfMana).toBe(false);
    });

    test('the fallback swing does not clear the flag, because it is the starved case', () => {
        // The commonest way to reach the auto attack with the flag already up
        // is that the ability was unaffordable — which is precisely what the
        // flag means. Clearing it here would suppress the wake that mana
        // restoration owes this unit, so the flag is lowered only by the one
        // event that proves the unit is no longer blocked: an affordable cast.
        const { sim, player } = soloFight();
        player.abilities = [alwaysTriggers(10)];
        player.combatDetails.currentManapoints = 4;
        player.isOutOfMana = true;

        sim.addNextAttackEvent(player);

        expect(queued(sim, AutoAttackEvent.type, player).length).toBe(1);
        expect(player.isOutOfMana).toBe(true);
    });
});
