// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Tests for Zone spawn determinism under a seeded RNG.
 * Two sims compared against each other must fight the same monster sequence,
 * or the difference between them is partly just a different set of enemies.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from './game-data.js';
import { clearSimRng, random, seedSimRng } from './rng.js';
import Zone from './zone.js';

const ZONE_HRID = '/actions/combat/test_zone';

const MONSTERS = ['/monsters/a', '/monsters/b', '/monsters/c', '/monsters/d'];

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
                            maxSpawnCount: 3,
                            maxTotalStrength: 6,
                            spawns: MONSTERS.map((hrid, i) => ({
                                combatMonsterHrid: hrid,
                                difficultyTier: 0,
                                rate: i + 1,
                                strength: 2,
                            })),
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: Object.fromEntries(MONSTERS.map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])),
    });
}

/**
 * Roll a run of encounters and flatten them to monster hrids.
 * @param {number} count - Encounters to draw
 * @returns {string[][]}
 */
function rollEncounters(count) {
    const zone = new Zone(ZONE_HRID, 0);
    return Array.from({ length: count }, () => zone.getRandomEncounter().map((monster) => monster.hrid));
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('Zone spawns with a seeded RNG', () => {
    test('same seed replays the same encounter sequence', () => {
        installGameData();

        seedSimRng(4242);
        const first = rollEncounters(40);

        seedSimRng(4242);
        expect(rollEncounters(40)).toEqual(first);
    });

    test('different seeds give different encounter sequences', () => {
        installGameData();

        seedSimRng(1);
        const first = rollEncounters(40);

        seedSimRng(2);
        expect(rollEncounters(40)).not.toEqual(first);
    });

    test('combat rolls do not shift the spawn sequence', () => {
        installGameData();

        seedSimRng(777);
        const clean = rollEncounters(30);

        // Stand in for a stronger loadout burning a different number of combat
        // rolls between encounters — the spawns must not move
        seedSimRng(777);
        const zone = new Zone(ZONE_HRID, 0);
        const interleaved = [];
        for (let i = 0; i < 30; i++) {
            for (let r = 0; r < i * 3; r++) random();
            interleaved.push(zone.getRandomEncounter().map((monster) => monster.hrid));
        }

        expect(interleaved).toEqual(clean);
    });

    test('unseeded runs stay independent samples', () => {
        installGameData();

        const first = rollEncounters(60);
        const second = rollEncounters(60);
        expect(second).not.toEqual(first);
    });
});

/**
 * How often a boss comes round, and where that number comes from.
 *
 * `monsterSpawnInfo` is a live reference into the shared actionDetailMap, so
 * writing the boss cadence onto it rewrote the game data for every other reader
 * — utils/combat-drop-model.js and utils/expected-kills.js both read the fight's
 * own `battlesPerBoss`, and both saw whatever the last Zone constructed had
 * stamped there.
 */
describe('boss cadence', () => {
    const BOSS_HRID = '/monsters/boss';

    /**
     * Game data whose fight carries an explicit battlesPerBoss.
     * @param {number|undefined} battlesPerBoss - The zone's own cadence, or undefined for none
     * @returns {Object} The fightInfo object the zone will read
     */
    function installBossZone(battlesPerBoss) {
        const fightInfo = {
            bossSpawns: [{ combatMonsterHrid: BOSS_HRID, difficultyTier: 0 }],
            randomSpawnInfo: {
                maxSpawnCount: 1,
                maxTotalStrength: 2,
                spawns: [{ combatMonsterHrid: MONSTERS[0], difficultyTier: 0, rate: 1, strength: 1 }],
            },
        };
        if (battlesPerBoss !== undefined) fightInfo.battlesPerBoss = battlesPerBoss;

        setGameData({
            actionDetailMap: {
                [ZONE_HRID]: {
                    buffs: null,
                    combatZoneInfo: { isDungeon: false, dungeonInfo: null, fightInfo },
                },
            },
            combatMonsterDetailMap: Object.fromEntries(
                [...MONSTERS, BOSS_HRID].map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])
            ),
        });
        return fightInfo;
    }

    /**
     * Which of `count` encounters were the boss.
     * @param {Zone} zone - The zone to roll
     * @param {number} count - Encounters to draw
     * @returns {number[]} 1-based positions of the boss encounters
     */
    function bossAt(zone, count) {
        const at = [];
        for (let i = 1; i <= count; i++) {
            if (zone.getRandomEncounter().some((monster) => monster.hrid === BOSS_HRID)) at.push(i);
        }
        return at;
    }

    test('constructing a zone leaves the shared game data alone', () => {
        const fightInfo = installBossZone(undefined);

        new Zone(ZONE_HRID, 0);

        expect('battlesPerBoss' in fightInfo).toBe(false);
    });

    test('a zone with its own cadence uses it', () => {
        installBossZone(5);
        seedSimRng(5);

        expect(bossAt(new Zone(ZONE_HRID, 0), 12)).toEqual([5, 10]);
    });

    test('and one without falls back to ten, the same default the drop model uses', () => {
        installBossZone(undefined);
        seedSimRng(5);

        expect(bossAt(new Zone(ZONE_HRID, 0), 12)).toEqual([10]);
    });
});
