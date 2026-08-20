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
