/**
 * Token buff levels as a simulation argument.
 *
 * The Configure tab's Labyrinth Buffs section used to be a readout of what the
 * live run had bought, and a simulator whose buffs can only be the ones you
 * already own cannot answer the question people bring to it. What is worth
 * asserting here is the arithmetic behind the inputs rather than the inputs:
 * that an override lands on the buff array a simulation takes, that the array
 * is the *same shape* the live getter produces (or every reader of it starts
 * disagreeing with the tile badges), and that a level nobody typed is the live
 * level rather than a zero.
 */

import { describe, test, expect } from 'vitest';
import {
    MAX_LAB_TOKEN_LEVEL,
    LAB_TOKEN_BUFF_GROUPS,
    LAB_TOKEN_COMBAT_DEFS,
    isCombatTokenBuff,
    readLiveTokenLevels,
    sanitizeTokenLevels,
    resolveTokenLevels,
    buildLabyrinthCombatBuffs,
    tokenLevelDifferences,
    describeTokenOverrides,
} from './lab-token-buffs.js';

/** A characterInfo carrying only the keys a test cares about. */
const info = (levels = {}) => ({ ...levels });

describe('what the live run is carrying', () => {
    test('every token is reported, whether or not the character has one', () => {
        const levels = readLiveTokenLevels(info({ labyrinthCombatDamageLevel: 5 }));

        expect(levels.labyrinthCombatDamageLevel).toBe(5);
        expect(levels.labyrinthAttackSpeedLevel).toBe(0);
        expect(levels.labyrinthAutomationLevel).toBe(0);
    });

    test('no character data at all reads as no tokens rather than as NaN', () => {
        const levels = readLiveTokenLevels(undefined);

        expect(Object.values(levels).every((level) => level === 0)).toBe(true);
    });

    test('a level past the game’s cap is not carried past it', () => {
        expect(readLiveTokenLevels(info({ labyrinthCombatDamageLevel: 40 })).labyrinthCombatDamageLevel).toBe(
            MAX_LAB_TOKEN_LEVEL
        );
    });
});

describe('the levels typed over them', () => {
    test('a token this game has never heard of is dropped rather than simulated', () => {
        expect(sanitizeTokenLevels({ labyrinthWishfulThinkingLevel: 9 })).toEqual({});
    });

    test('a blank box is not an override — it is the absence of one', () => {
        expect(sanitizeTokenLevels({ labyrinthCastSpeedLevel: '' })).toEqual({});
        expect(sanitizeTokenLevels({ labyrinthCastSpeedLevel: null })).toEqual({});
    });

    test('zero is an override, because "simulate without this token" is a question', () => {
        expect(sanitizeTokenLevels({ labyrinthCastSpeedLevel: 0 })).toEqual({ labyrinthCastSpeedLevel: 0 });
    });

    test('and anything out of range is clamped rather than refused', () => {
        expect(sanitizeTokenLevels({ labyrinthCastSpeedLevel: 99, labyrinthTorchLevel: -3 })).toEqual({
            labyrinthCastSpeedLevel: MAX_LAB_TOKEN_LEVEL,
            labyrinthTorchLevel: 0,
        });
    });

    test('what is not typed stays whatever the run owns', () => {
        const resolved = resolveTokenLevels(info({ labyrinthCombatDamageLevel: 3, labyrinthAttackSpeedLevel: 2 }), {
            labyrinthAttackSpeedLevel: 11,
        });

        expect(resolved.labyrinthCombatDamageLevel).toBe(3);
        expect(resolved.labyrinthAttackSpeedLevel).toBe(11);
    });
});

describe('the buff array a simulation is handed', () => {
    test('a token at zero grants nothing, exactly as the live getter has it', () => {
        expect(buildLabyrinthCombatBuffs({})).toEqual([]);
    });

    test('a damage level becomes a ratio boost of one percent per level', () => {
        const [buff] = buildLabyrinthCombatBuffs({ labyrinthCombatDamageLevel: 7 });

        expect(buff.uniqueHrid).toBe('/buff_uniques/labyrinth_upgrade_combat_damage');
        expect(buff.typeHrid).toBe('/buff_types/damage');
        expect(buff.ratioBoost).toBeCloseTo(0.07, 10);
        expect(buff.flatBoost).toBe(0);
    });

    test('cast speed and crit rate go on the flat side, which is where the engine reads them', () => {
        const buffs = buildLabyrinthCombatBuffs({ labyrinthCastSpeedLevel: 4, labyrinthCriticalRateLevel: 2 });
        const byType = Object.fromEntries(buffs.map((buff) => [buff.typeHrid, buff]));

        expect(byType['/buff_types/cast_speed'].flatBoost).toBeCloseTo(0.04, 10);
        expect(byType['/buff_types/cast_speed'].ratioBoost).toBe(0);
        expect(byType['/buff_types/critical_rate'].flatBoost).toBeCloseTo(0.02, 10);
    });

    test('the level-bonus fields stay zeroed, or a reader that applies them double-counts', () => {
        const [buff] = buildLabyrinthCombatBuffs({ labyrinthCombatDamageLevel: 1 });

        expect(buff.ratioBoostLevelBonus).toBe(0);
        expect(buff.flatBoostLevelBonus).toBe(0);
        expect(buff.duration).toBe(0);
    });

    test('only the four combat tokens reach a fight at all', () => {
        const everything = Object.fromEntries(
            LAB_TOKEN_BUFF_GROUPS.flatMap((group) => group.buffs).map((buff) => [buff.key, 5])
        );

        expect(buildLabyrinthCombatBuffs(everything)).toHaveLength(LAB_TOKEN_COMBAT_DEFS.length);
        expect(LAB_TOKEN_COMBAT_DEFS).toHaveLength(4);
        expect(isCombatTokenBuff('labyrinthCastSpeedLevel')).toBe(true);
        expect(isCombatTokenBuff('labyrinthTorchLevel')).toBe(false);
    });
});

describe('saying out loud that this is not the live character', () => {
    test('an override equal to what is owned is not a difference worth flagging', () => {
        expect(
            tokenLevelDifferences(info({ labyrinthCombatDamageLevel: 6 }), { labyrinthCombatDamageLevel: 6 })
        ).toEqual([]);
        expect(describeTokenOverrides(info({ labyrinthCombatDamageLevel: 6 }), { labyrinthCombatDamageLevel: 6 })).toBe(
            ''
        );
    });

    test('one that is not says which token, and from what to what', () => {
        expect(describeTokenOverrides(info({ labyrinthCombatDamageLevel: 3 }), { labyrinthCombatDamageLevel: 8 })).toBe(
            'Damage 3→8'
        );
    });

    test('several are listed in the order the section draws them', () => {
        const summary = describeTokenOverrides(info({}), {
            labyrinthCriticalRateLevel: 4,
            labyrinthCombatDamageLevel: 2,
        });

        expect(summary).toBe('Damage 0→2, Crit Rate 0→4');
    });

    test('and a token turned off is a difference too', () => {
        expect(describeTokenOverrides(info({ labyrinthAttackSpeedLevel: 9 }), { labyrinthAttackSpeedLevel: 0 })).toBe(
            'Atk Speed 9→0'
        );
    });
});
