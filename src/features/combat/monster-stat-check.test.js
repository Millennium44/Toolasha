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
    flaggedRows,
    buildExportPayload,
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
    test('deltaPct is the game relative to the sim baseline', () => {
        // game below baseline (a debuff shredded it) → negative
        expect(compareStat('x', { x: 90 }, { x: 100 }).deltaPct).toBeCloseTo(-10, 6);
        // game above baseline (a buff raised it) → positive
        expect(compareStat('x', { x: 120 }, { x: 100 }).deltaPct).toBeCloseTo(20, 6);
        expect(compareStat('x', { x: 100 }, { x: 100 }).deltaPct).toBe(0);
    });

    test('null when a side is missing, zero when both read zero', () => {
        expect(compareStat('x', {}, { x: 5 }).deltaPct).toBeNull();
        expect(compareStat('x', { x: 5 }, {}).deltaPct).toBeNull();
        expect(compareStat('x', { x: 5 }, { x: 0 }).deltaPct).toBeNull(); // can't divide by a zero baseline
        expect(compareStat('x', { x: 0 }, { x: 0 }).deltaPct).toBe(0);
    });
});

describe('classify', () => {
    test('within tolerance is a match', () => {
        expect(classify(0, false)).toBe('match');
        expect(classify(0.5, true)).toBe('match');
    });

    test('game above the baseline with an effect up is a buff', () => {
        expect(classify(47, true)).toBe('buff');
    });

    test('game below the baseline with an effect up is a debuff', () => {
        // The pestilent-shot case: sim baseline 515, game 413 → −19.8%, effect up
        expect(classify(-19.8, true)).toBe('debuff');
    });

    test('any gap with no active effect is a mismatch', () => {
        expect(classify(-32, false)).toBe('mismatch');
        expect(classify(47, false)).toBe('mismatch');
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

    test('a live resistance shred below the sim baseline reads as debuff, not bug', () => {
        // The pestilent-shot case: the player's debuff lowers the monster's armour
        // ~20% below the sim's unbuffed baseline. That is the debuff working, not a
        // sim error — the panel must not flag it red.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 0.8;

        const result = buildComparison(gameUnit, monster.combatDetails);
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('debuff');
        expect(result.hasMismatch).toBe(false);
    });

    test('with the effect applied to the sim, the debuffed stat matches', () => {
        // The buffed-sim path: inject the same pestilent-shot armour shred into
        // the sim, and the game's debuffed armour should line up — a match, not a
        // flag, because both sides now carry the effect.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.combatBuffs = {
            '/buff_uniques/pestilent_shot_armor': { typeHrid: '/buff_types/armor', ratioBoost: -0.199, flatBoost: 0 },
        };
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });

        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true });
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('match');
        expect(result.hasMismatch).toBe(false);
        expect(result.simBuffed).toBe(true);
    });

    test('in buffed mode a real gap is a mismatch, not a debuff', () => {
        // Effects are already in the sim, so a remaining gap is unexplained — it
        // must read as a mismatch even though an effect is present.
        seed();
        const monster = new Monster(HRID, 0, 200, true);
        monster.updateCombatDetails();
        const gameUnit = gameUnitMatching(monster.combatDetails, {
            combatBuffMap: { '/buff_uniques/pestilent_shot_armor': {} },
        });
        gameUnit.combatDetails.totalArmor = monster.combatDetails.totalArmor * 0.8;

        const result = buildComparison(gameUnit, monster.combatDetails, { simBuffed: true });
        const armor = result.groups[0].rows.find((r) => r.key === 'totalArmor');
        expect(armor.verdict).toBe('mismatch');
        expect(result.hasMismatch).toBe(true);
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

describe('flaggedRows', () => {
    const comparison = {
        groups: [
            {
                group: 'Mitigation',
                rows: [
                    { key: 'a', label: 'A', game: 100, sim: 100, deltaPct: 0, verdict: 'match' },
                    { key: 'b', label: 'B', game: 80, sim: 100, deltaPct: -20, verdict: 'debuff' },
                ],
            },
            {
                group: 'Offense',
                rows: [{ key: 'c', label: 'C', game: 150, sim: 100, deltaPct: 50, verdict: 'mismatch' }],
            },
        ],
    };

    test('keeps buff/debuff/mismatch rows and drops matches', () => {
        const rows = flaggedRows(comparison);
        expect(rows.map((r) => r.key)).toEqual(['b', 'c']);
        expect(rows[0]).toMatchObject({ group: 'Mitigation', stat: 'B', verdict: 'debuff' });
        expect(rows[1]).toMatchObject({ group: 'Offense', stat: 'C', verdict: 'mismatch' });
    });

    test('empty for an all-match comparison', () => {
        expect(flaggedRows({ groups: [{ group: 'x', rows: [{ verdict: 'match' }, { verdict: 'unknown' }] }] })).toEqual(
            []
        );
        expect(flaggedRows(null)).toEqual([]);
    });
});

describe('buildExportPayload', () => {
    test('wraps entries and the current snapshot with a fixed clock', () => {
        const payload = buildExportPayload([{ monsterHrid: '/monsters/x' }], { name: 'X' }, 1234);
        expect(payload).toMatchObject({
            format: 'toolasha-monster-stat-check',
            version: 1,
            exportedAt: 1234,
            current: { name: 'X' },
            entries: [{ monsterHrid: '/monsters/x' }],
        });
    });

    test('tolerates missing inputs', () => {
        const payload = buildExportPayload(null, null, 0);
        expect(payload.entries).toEqual([]);
        expect(payload.current).toBeNull();
    });
});
