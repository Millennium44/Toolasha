/**
 * Triggers that read a whole side of the fight.
 *
 * A single-target trigger reads one unit; an all_allies / all_enemies trigger
 * reads several and has to combine them. Buff conditions return the buff
 * OBJECT, so the old reduce summed objects into the string "0[object Object]" —
 * truthy for every comparator that asked whether the buff was active, and never
 * greater than anything for the ones that asked how many.
 */

import { describe, test, expect, afterEach } from 'vitest';

import { setGameData } from './game-data.js';
import Trigger from './trigger.js';

const SELF = '/combat_trigger_dependencies/self';
const ALL_ALLIES = '/combat_trigger_dependencies/all_allies';

const IS_ACTIVE = '/combat_trigger_comparators/is_active';
const IS_INACTIVE = '/combat_trigger_comparators/is_inactive';
const AT_LEAST = '/combat_trigger_comparators/greater_than_equal';

const BERSERK = '/combat_trigger_conditions/berserk';
const BERSERK_BUFF = '/buff_uniques/berserk';
const CURRENT_HP = '/combat_trigger_conditions/current_hp';

function installGameData() {
    setGameData({
        combatTriggerDependencyDetailMap: {
            [SELF]: { isSingleTarget: true },
            [ALL_ALLIES]: { isSingleTarget: false },
        },
    });
}

/**
 * A stand-in unit carrying just what a trigger reads.
 * @param {number} currentHitpoints - Hitpoints it is standing on
 * @param {boolean} berserk - Whether it carries the berserk buff
 * @returns {Object}
 */
function unit(currentHitpoints, berserk) {
    return {
        combatDetails: { currentHitpoints, maxHitpoints: 100 },
        combatBuffs: berserk
            ? { [BERSERK_BUFF]: { uniqueHrid: BERSERK_BUFF, typeHrid: '/buff_types/damage', flatBoost: 0 } }
            : {},
    };
}

/**
 * Whether the trigger fires over a party.
 * @param {string} conditionHrid - Condition to read
 * @param {string} comparatorHrid - Comparator to apply
 * @param {number} value - Comparison value
 * @param {Object[]} friendlies - The party
 * @returns {boolean}
 */
function overParty(conditionHrid, comparatorHrid, value, friendlies) {
    const trigger = new Trigger(ALL_ALLIES, conditionHrid, comparatorHrid, value);
    return trigger.isActive(friendlies[0], null, friendlies, null, 0);
}

afterEach(() => {
    setGameData(null);
});

describe('a buff-status trigger read across the whole party', () => {
    test('is active when any living ally carries the buff', () => {
        installGameData();

        expect(overParty(BERSERK, IS_ACTIVE, 0, [unit(50, false), unit(50, true)])).toBe(true);
    });

    test('and inactive when none of them does', () => {
        installGameData();

        // The old reduce produced the string "0[object Object]" for the case
        // above and plain "0" here — the first read as active, and so did any
        // party at all once one buff object was in the sum
        expect(overParty(BERSERK, IS_ACTIVE, 0, [unit(50, false), unit(50, false)])).toBe(false);
        expect(overParty(BERSERK, IS_INACTIVE, 0, [unit(50, false), unit(50, false)])).toBe(true);
    });

    test('a corpse carrying the buff does not count', () => {
        installGameData();

        expect(overParty(BERSERK, IS_ACTIVE, 0, [unit(50, false), unit(0, true)])).toBe(false);
    });

    test('and a count comparison counts the allies who have it', () => {
        installGameData();

        const twoOfThree = [unit(50, true), unit(50, true), unit(50, false)];
        expect(overParty(BERSERK, AT_LEAST, 2, twoOfThree)).toBe(true);
        expect(overParty(BERSERK, AT_LEAST, 3, twoOfThree)).toBe(false);
    });
});

describe('numeric conditions still add up', () => {
    test('the party total is the sum over the living', () => {
        installGameData();

        const party = [unit(40, false), unit(30, false), unit(0, false)];
        expect(overParty(CURRENT_HP, AT_LEAST, 70, party)).toBe(true);
        expect(overParty(CURRENT_HP, AT_LEAST, 71, party)).toBe(false);
    });
});

describe('the single-target path it mirrors', () => {
    test('reads the same buff as active on the one unit', () => {
        installGameData();

        const trigger = new Trigger(SELF, BERSERK, IS_ACTIVE, 0);
        expect(trigger.isActive(unit(50, true), null, null, null, 0)).toBe(true);
        expect(trigger.isActive(unit(50, false), null, null, null, 0)).toBe(false);
    });
});
