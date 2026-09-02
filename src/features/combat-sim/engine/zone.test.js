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

/**
 * Dungeon waves: which table a wave draws from, and what a strength overflow does.
 *
 * These pin the current reading of `randomSpawnInfoMap` — keys are exclusive
 * ranges, and a draw that would break `maxTotalStrength` ends the wave. Both are
 * inferences, not documented rules, and 51 ordinary waves recorded live in
 * Chimerical Den disagree with the first of them (see the note in zone.js), so
 * anything that changes them has to be deliberate rather than incidental.
 */
describe('dungeon waves', () => {
    const DUNGEON_HRID = '/actions/combat/test_dungeon';
    const EARLY = '/monsters/early';
    const MID = '/monsters/mid';
    const LATE = '/monsters/late';
    const FIXED = '/monsters/fixed';
    const CHEAP = '/monsters/cheap';
    const HEAVY = '/monsters/heavy';

    /**
     * One entry per band, each band a single identifiable species so a wave's
     * roster names the table it was drawn from.
     * @param {string} hrid - The band's only species
     * @param {Object} [over] - Overrides for maxSpawnCount/maxTotalStrength/spawns
     * @returns {Object} A randomSpawnInfoMap entry
     */
    function band(hrid, over = {}) {
        return {
            maxSpawnCount: 1,
            maxTotalStrength: 10,
            spawns: [{ combatMonsterHrid: hrid, difficultyTier: 0, rate: 1, strength: 1 }],
            ...over,
        };
    }

    /**
     * Install a dungeon and return a Zone for it.
     * @param {Object} dungeonInfo - The zone's combatZoneInfo.dungeonInfo
     * @returns {Zone}
     */
    function installDungeon(dungeonInfo) {
        const hrids = [EARLY, MID, LATE, FIXED, CHEAP, HEAVY];
        setGameData({
            actionDetailMap: {
                [DUNGEON_HRID]: {
                    buffs: null,
                    combatZoneInfo: { isDungeon: true, fightInfo: null, dungeonInfo },
                },
            },
            combatMonsterDetailMap: Object.fromEntries(hrids.map((hrid) => [hrid, { enrageTime: 0, abilities: [] }])),
        });
        return new Zone(DUNGEON_HRID, 0);
    }

    /**
     * The dungeon used for band selection: three tables keyed 0 / 10 / 30, and a
     * fixed roster on every fifth wave, the way the real dungeons are shaped.
     * @returns {Zone}
     */
    function installBandedDungeon() {
        const fixedSpawnsMap = {};
        for (let wave = 5; wave <= 50; wave += 5) {
            fixedSpawnsMap[String(wave)] = [{ combatMonsterHrid: FIXED, difficultyTier: 0 }];
        }
        return installDungeon({
            maxWaves: 50,
            fixedSpawnsMap,
            randomSpawnInfoMap: { 0: band(EARLY), 10: band(MID), 30: band(LATE) },
        });
    }

    /**
     * Roll `count` waves and name the species each one produced.
     * @param {Zone} zone - The dungeon to roll
     * @param {number} count - Waves to draw
     * @returns {string[]} One hrid per wave (waves are single-monster here)
     */
    function waveSpecies(zone, count) {
        return Array.from({ length: count }, () => zone.getNextWave()[0].hrid);
    }

    test('a wave with a fixed roster ignores the random tables', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 10);

        expect(species[4]).toBe(FIXED);
        expect(species[9]).toBe(FIXED);
    });

    test('a random wave draws from the highest-keyed table it has reached', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 50);

        // waves 1-9 -> key 0, 10-29 -> key 10, 30-50 -> key 30; every fifth wave is fixed
        const bandOf = (wave) => species[wave - 1];
        expect([1, 2, 3, 4, 6, 7, 8, 9].map(bandOf)).toEqual(Array(8).fill(EARLY));
        expect([11, 12, 19, 28, 29].map(bandOf)).toEqual(Array(5).fill(MID));
        expect([31, 32, 41, 49].map(bandOf)).toEqual(Array(4).fill(LATE));
    });

    test('no table is drawn from before the wave its key names', () => {
        seedSimRng(11);
        const species = waveSpecies(installBandedDungeon(), 50);

        // Confirmed against 138 live Chimerical Den waves: a species never
        // appears below its own key's wave, and the key-30 species first show up
        // on wave 31. Only the upper bound of this rule is in doubt.
        expect(species.slice(0, 9)).not.toContain(MID);
        expect(species.slice(0, 9)).not.toContain(LATE);
        expect(species.slice(0, 29)).not.toContain(LATE);
    });

    test('the counter wraps at maxWaves and records the clear', () => {
        seedSimRng(11);
        const zone = installBandedDungeon();
        waveSpecies(zone, 50);

        expect(zone.dungeonsCompleted).toBe(0);
        expect(zone.getNextWave()[0].hrid).toBe(EARLY);
        expect(zone.dungeonsCompleted).toBe(1);
    });

    test('a draw that would break maxTotalStrength ends the wave rather than being skipped', () => {
        // A cheap monster fits five times over; a heavy one never fits at all,
        // so every heavy draw is an overflow wherever it lands in the wave.
        const overflowDungeon = () =>
            installDungeon({
                maxWaves: 1000,
                fixedSpawnsMap: {},
                randomSpawnInfoMap: {
                    0: band(CHEAP, {
                        maxSpawnCount: 5,
                        maxTotalStrength: 100,
                        spawns: [
                            { combatMonsterHrid: CHEAP, difficultyTier: 0, rate: 1, strength: 1 },
                            { combatMonsterHrid: HEAVY, difficultyTier: 0, rate: 1, strength: 101 },
                        ],
                    }),
                },
            });

        seedSimRng(1);
        // Draw two was heavy; skipping it would have let draws three to five keep filling the wave.
        expect(
            overflowDungeon()
                .getNextWave()
                .map((monster) => monster.hrid)
        ).toEqual([CHEAP]);

        seedSimRng(1);
        const zone = overflowDungeon();
        const sizes = Array.from({ length: 400 }, () => zone.getNextWave().length);
        // Stopping at the first overflow leaves E[size] = sum of 2^-k for k=1..5, ~0.97;
        // skipping and continuing would keep all five draws and average 2.5.
        const mean = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
        expect(mean).toBeGreaterThan(0.8);
        expect(mean).toBeLessThan(1.2);
        // A heavy first draw ends the wave before anything is added at all.
        expect(sizes.some((size) => size === 0)).toBe(true);
    });
});
