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

import CombatSimulator from './combat-simulator.js';
import { setGameData } from './game-data.js';
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
