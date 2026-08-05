/**
 * Kills against what the zone owed you.
 *
 * The count on its own is not a fact about the run — seven Eyes is a lot or a
 * little depending on how often the zone spawns them. The cases worth a test are
 * the ones where the naive arithmetic is off by a whole wave: the battle still
 * being fought, a boss wave that replaces an ordinary one rather than joining
 * it, and a zone that cannot be modelled at all.
 */

import { describe, test, expect } from 'vitest';
import { expectedKills, killComparison } from './expected-kills.js';

const MONSTERS = { '/monsters/eye': { name: 'Eye' }, '/monsters/veyes': { name: 'Veyes' } };

/**
 * A zone that spawns exactly one monster per wave.
 * @param {Object} [fight] - Extra `fightInfo` fields
 * @returns {Object} An `actionDetailMap` entry
 */
function zone(fight = {}) {
    return {
        combatZoneInfo: {
            fightInfo: {
                randomSpawnInfo: {
                    maxSpawnCount: 1,
                    maxTotalStrength: 10,
                    spawns: [{ combatMonsterHrid: '/monsters/eye', rate: 1, strength: 1 }],
                },
                ...fight,
            },
        },
    };
}

describe('what a run should have produced', () => {
    test('one monster a wave over ten waves is ten monsters', () => {
        const expected = expectedKills({ actionDetail: zone(), monsterDetailMap: MONSTERS, battles: 11 });
        expect(expected).toEqual({ Eye: 10 });
    });

    test('the battle in progress is not counted', () => {
        // Its monsters are partly dead and partly not. Counting it in full makes
        // every zone look unlucky by roughly one wave, which at seven battles is
        // fifteen per cent of the reading.
        const expected = expectedKills({ actionDetail: zone(), monsterDetailMap: MONSTERS, battles: 7 });
        expect(expected.Eye).toBe(6);
    });

    test('the first battle of a session expects nothing yet', () => {
        expect(expectedKills({ actionDetail: zone(), monsterDetailMap: MONSTERS, battles: 1 })).toEqual({});
    });

    test('a boss wave replaces an ordinary one rather than joining it', () => {
        // Twenty finished battles with a boss every ten is eighteen ordinary
        // waves and two bosses — not twenty and two
        const expected = expectedKills({
            actionDetail: zone({ bossSpawns: [{ combatMonsterHrid: '/monsters/veyes' }], battlesPerBoss: 10 }),
            monsterDetailMap: MONSTERS,
            battles: 21,
        });

        expect(expected).toEqual({ Eye: 18, Veyes: 2 });
    });

    test('a monster with no entry in the game data is still named', () => {
        const expected = expectedKills({ actionDetail: zone(), monsterDetailMap: {}, battles: 3 });
        expect(Object.keys(expected)).toEqual(['eye']);
    });

    test('a dungeon is not modelled at all', () => {
        // It runs a script and pays out at the end, so a spawn table would be
        // the wrong model rather than an imprecise one
        const detail = zone();
        detail.combatZoneInfo.isDungeon = true;

        expect(expectedKills({ actionDetail: detail, monsterDetailMap: MONSTERS, battles: 20 })).toEqual({});
    });

    test('nor is a zone with no spawn table', () => {
        expect(
            expectedKills({ actionDetail: { combatZoneInfo: {} }, monsterDetailMap: MONSTERS, battles: 20 })
        ).toEqual({});
    });
});

describe('setting the two side by side', () => {
    test('a monster killed more often than it was due reads positive', () => {
        const rows = killComparison([{ name: 'Eye', kills: 7 }], { Eye: 5 });
        expect(rows[0]).toEqual({ name: 'Eye', kills: 7, expected: 5, share: 0.4 });
    });

    test('a monster the zone expects but which has not died is kept, at zero', () => {
        // A rare spawn you have not seen once is exactly what somebody checking
        // this is looking for, and an absent row reads as "not in this zone"
        const rows = killComparison([{ name: 'Eye', kills: 7 }], { Eye: 5, Veyes: 2 });
        expect(rows.find((row) => row.name === 'Veyes')).toEqual({
            name: 'Veyes',
            kills: 0,
            expected: 2,
            share: -1,
        });
    });

    test('with no model there is no comparison rather than a comparison against zero', () => {
        const rows = killComparison([{ name: 'Eye', kills: 7 }], {});
        expect(rows[0]).toEqual({ name: 'Eye', kills: 7, expected: null, share: null });
    });

    test('a monster the zone does not spawn is neither over nor under', () => {
        // It cannot be a percentage of nothing
        const rows = killComparison(
            [
                { name: 'Eye', kills: 7 },
                { name: 'Stray', kills: 1 },
            ],
            { Eye: 5 }
        );
        expect(rows.find((row) => row.name === 'Stray')).toMatchObject({ expected: 0, share: null });
    });

    test('the biggest count leads', () => {
        const rows = killComparison(
            [
                { name: 'Veyes', kills: 2 },
                { name: 'Eye', kills: 9 },
            ],
            {}
        );
        expect(rows.map((row) => row.name)).toEqual(['Eye', 'Veyes']);
    });
});
