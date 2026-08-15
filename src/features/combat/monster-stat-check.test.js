/**
 * The point of the panel is to make a sim-vs-game gap visible and to say which
 * gaps are buffs and which are bugs. These pin the room-level recovery, the
 * verdict logic, and an end-to-end comparison against a real engine-built
 * monster — so a match reads as a match, a live buff reads as a buff, and a
 * genuine modelling gap reads as a mismatch.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from '../combat-sim/engine/game-data.js';
import Monster from '../combat-sim/engine/monster.js';
import {
    deriveRoomLevel,
    styleKeyOf,
    activeBuffNames,
    statRows,
    compareStat,
    classify,
    buildComparison,
} from './monster-stat-check.js';

describe('deriveRoomLevel', () => {
    test('recovers the room level from the scaled defense', () => {
        // room 212: gameDefense = base * 212/100
        expect(deriveRoomLevel(212, 100)).toBe(212);
        expect(deriveRoomLevel(636, 300)).toBe(212);
    });

    test('treats an unscaled monster as no room level', () => {
        expect(deriveRoomLevel(100, 100)).toBe(0); // scale 1.0
        expect(deriveRoomLevel(105, 100)).toBe(0); // within the ~1.0 floor
    });

    test('guards against missing or zero inputs', () => {
        expect(deriveRoomLevel(0, 100)).toBe(0);
        expect(deriveRoomLevel(200, 0)).toBe(0);
        expect(deriveRoomLevel(undefined, undefined)).toBe(0);
    });
});

describe('styleKeyOf', () => {
    test('reads the array form and the singular form', () => {
        expect(styleKeyOf({ combatStyleHrids: ['/combat_styles/magic'] })).toBe('magic');
        expect(styleKeyOf({ combatStyleHrid: '/combat_styles/smash' })).toBe('smash');
    });

    test('falls back to smash when unstyled', () => {
        expect(styleKeyOf({})).toBe('smash');
        expect(styleKeyOf(null)).toBe('smash');
    });
});

describe('activeBuffNames', () => {
    test('strips the hrid path and underscores', () => {
        expect(activeBuffNames({ '/buff_uniques/curse': {}, '/buff_uniques/guardian_aura': {} })).toEqual([
            'curse',
            'guardian aura',
        ]);
    });

    test('empty when nothing is up', () => {
        expect(activeBuffNames({})).toEqual([]);
        expect(activeBuffNames(null)).toEqual([]);
    });
});

describe('compareStat', () => {
    test('deltaPct is the sim relative to the game', () => {
        expect(compareStat('x', { x: 100 }, { x: 90 }).deltaPct).toBeCloseTo(-10, 6);
        expect(compareStat('x', { x: 100 }, { x: 120 }).deltaPct).toBeCloseTo(20, 6);
        expect(compareStat('x', { x: 100 }, { x: 100 }).deltaPct).toBe(0);
    });

    test('null when a side is missing or the game reads zero', () => {
        expect(compareStat('x', {}, { x: 5 }).deltaPct).toBeNull();
        expect(compareStat('x', { x: 5 }, {}).deltaPct).toBeNull();
        expect(compareStat('x', { x: 0 }, { x: 5 }).deltaPct).toBeNull();
    });
});

describe('classify', () => {
    test('within tolerance is a match', () => {
        expect(classify(0, false)).toBe('match');
        expect(classify(0.5, true)).toBe('match');
    });

    test('sim below the game with buffs up is buff-explained', () => {
        expect(classify(-32, true)).toBe('buff');
    });

    test('a gap with no buffs, or the sim reading high, is a mismatch', () => {
        expect(classify(-32, false)).toBe('mismatch');
        expect(classify(20, true)).toBe('mismatch'); // sim higher is never a buff
    });

    test('no data is unknown', () => {
        expect(classify(null, true)).toBe('unknown');
    });
});

describe('buildComparison against an engine-built monster', () => {
    const HRID = '/monsters/stat_dummy';

    function seed() {
        setGameData({
            abilityDetailMap: {},
            combatMonsterDetailMap: {
                [HRID]: {
                    enrageTime: 0,
                    experience: 100,
                    abilities: [],
                    combatDetails: {
                        staminaLevel: 100,
                        intelligenceLevel: 100,
                        attackLevel: 100,
                        meleeLevel: 100,
                        defenseLevel: 100,
                        rangedLevel: 100,
                        magicLevel: 100,
                        attackInterval: 3e9,
                        combatStats: {
                            combatStyleHrids: ['/combat_styles/magic'],
                            attackInterval: 0,
                            armor: 200,
                            fireResistance: 500,
                            natureResistance: 500,
                            waterResistance: 100,
                        },
                    },
                },
            },
        });
    }

    afterEach(() => setGameData(null));

    /** A game unit whose live combatDetails equal the sim's, before any override */
    function gameUnitMatching(simDetails, extra = {}) {
        return {
            combatBuffMap: {},
            combatDetails: { ...simDetails, combatStats: { combatStyleHrids: ['/combat_styles/magic'] } },
            ...extra,
        };
    }

    test('identical numbers read as all matches', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const result = buildComparison(gameUnitMatching(monster.combatDetails), monster.combatDetails);

        expect(result.hasMismatch).toBe(false);
        const verdicts = result.groups.flatMap((g) => g.rows.map((r) => r.verdict));
        expect(verdicts.every((v) => v === 'match' || v === 'unknown')).toBe(true);
        // The fire-resistance row is present and matched
        const fire = result.groups[0].rows.find((r) => r.key === 'totalFireResistance');
        expect(fire.verdict).toBe('match');
    });

    test('a live resistance buff above the sim baseline reads as buff, not bug', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/toughness': {} },
        });
        // Game's fire resist has ramped 30% above the sim's static baseline
        gameUnit.combatDetails.totalFireResistance = monster.combatDetails.totalFireResistance * 1.3;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const fire = result.groups[0].rows.find((r) => r.key === 'totalFireResistance');
        expect(fire.verdict).toBe('buff');
        expect(result.hasMismatch).toBe(false);
        expect(result.buffs).toContain('toughness');
    });

    test('a gap with no buffs is flagged as a mismatch', () => {
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails); // no buffs
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 1.5;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('mismatch');
        expect(result.hasMismatch).toBe(true);
    });
});

describe('statRows', () => {
    test('offense rows follow the monster style', () => {
        const groups = statRows('magic');
        const offense = groups.find((g) => g.group === 'Offense');
        expect(offense.rows.map(([key]) => key)).toEqual(['magicAccuracyRating', 'magicMaxDamage']);
    });
});
