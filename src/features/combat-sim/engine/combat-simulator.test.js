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
import { setGameData } from './game-data.js';
import Labyrinth from './labyrinth.js';
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
            player1: 16565,
            '/monsters/golden_toad': 6123,
            '/monsters/golden_rat': 3815,
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
