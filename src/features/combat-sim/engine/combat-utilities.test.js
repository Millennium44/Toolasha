// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * The damage roll, and what happens when the engine meets a mechanic it does
 * not know.
 *
 * Both groups here are about numbers the engine used to get wrong in opposite
 * directions: taskDamage was first left out of the attacker's roll entirely and
 * then applied to every fight regardless of whether one was on task, and an
 * unrecognized combat style took the whole simulation down rather than one
 * attack. Seeding the RNG is what makes the first measurable — two attacks with
 * the same seed draw the same numbers, so the only difference left between them
 * is the stat under test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import CombatUtilities from './combat-utilities.js';
import { clearSimRng, seedSimRng } from './rng.js';
import { getSimWarnings, resetSimWarnings, resetWarnedTypes } from './sim-warnings.js';

const SEED = 20260804;

/** Every combat stat processAttack reads, all switched off. */
function zeroStats(overrides = {}) {
    return {
        combatStyleHrid: '/combat_styles/stab',
        damageType: '/damage_types/physical',
        physicalAmplify: 0,
        armorPenetration: 0,
        physicalThorns: 0,
        elementalThorns: 0,
        criticalRate: 0,
        criticalDamage: 0,
        taskDamage: 0,
        damageTaken: 0,
        autoAttackDamage: 0,
        abilityDamage: 0,
        lifeSteal: 0,
        manaLeech: 0,
        retaliation: 0,
        ...overrides,
    };
}

function unit(statOverrides = {}) {
    return {
        hrid: 'player1',
        isPlayer: true,
        combatDetails: {
            currentHitpoints: 1_000_000,
            maxHitpoints: 1_000_000,
            stabAccuracyRating: 1_000_000,
            stabMaxDamage: 500,
            stabEvasionRating: 1,
            totalArmor: 0,
            defensiveMaxDamage: 0,
            combatStats: zeroStats(statOverrides),
        },
        addHitpoints: () => 0,
        addManapoints: () => 0,
    };
}

/** One attack from a freshly reseeded stream, so draws repeat exactly. */
function attackWith(statOverrides, isTaskFight = false) {
    seedSimRng(SEED);
    return CombatUtilities.processAttack(unit(statOverrides), unit(), null, isTaskFight);
}

afterEach(() => {
    clearSimRng();
});

describe('taskDamage in the damage roll', () => {
    test('a task trinket raises the damage a hit does — on a task fight', () => {
        const plain = attackWith({}, true);
        const withTask = attackWith({ taskDamage: 0.5 }, true);

        expect(plain.didHit).toBe(true);
        expect(withTask.didHit).toBe(true);
        expect(plain.damageDone).toBeGreaterThan(0);
        // The reference sims drop this multiplier; the game does not, and
        // neither do this engine's thorns and retaliation paths
        expect(withTask.damageDone).toBeGreaterThan(plain.damageDone);
    });

    test('and scales with how much of it there is', () => {
        const small = attackWith({ taskDamage: 0.1 }, true);
        const large = attackWith({ taskDamage: 1 }, true);

        expect(large.damageDone).toBeGreaterThan(small.damageDone);
    });

    test('but off task the same trinket does nothing at all', () => {
        // The other branch, and the reason the flag exists: the game pays
        // taskDamage only while the monster is your task, so a generic zone sim
        // — and every upgrade ranking built on one — must measure a task badge
        // as inert rather than rank it on damage it would never deal
        const plain = attackWith({});
        const withTask = attackWith({ taskDamage: 0.5 });

        expect(plain.damageDone).toBeGreaterThan(0);
        expect(withTask.damageDone).toBe(plain.damageDone);
    });

    test('and the flag defaults off, so a caller who says nothing gets no bonus', () => {
        seedSimRng(SEED);
        const defaulted = CombatUtilities.processAttack(unit({ taskDamage: 0.5 }), unit());

        expect(defaulted.damageDone).toBe(attackWith({}).damageDone);
    });

    test('while no task bonus leaves the roll where it was', () => {
        const explicitZero = attackWith({ taskDamage: 0 }, true);
        const absent = attackWith({}, true);

        expect(explicitZero.damageDone).toBe(absent.damageDone);
    });
});

describe('mechanics the engine does not know', () => {
    beforeEach(() => {
        resetSimWarnings();
        resetWarnedTypes();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('an unknown combat style skips the attack instead of ending the run', () => {
        const source = unit({ combatStyleHrid: '/combat_styles/telekinesis' });
        const target = unit();

        const result = CombatUtilities.processAttack(source, target);

        expect(result.didHit).toBe(false);
        expect(result.damageDone).toBe(0);
        expect(target.combatDetails.currentHitpoints).toBe(1_000_000);
        expect(getSimWarnings()).toEqual([expect.stringContaining('telekinesis')]);
    });

    test('as does an unknown damage type', () => {
        const source = unit({ damageType: '/damage_types/void' });

        const result = CombatUtilities.processAttack(source, unit());

        expect(result.damageDone).toBe(0);
        expect(getSimWarnings()).toEqual([expect.stringContaining('void')]);
    });

    test('and the console hears about each unknown type once, not once per swing', () => {
        const source = unit({ combatStyleHrid: '/combat_styles/telekinesis' });
        for (let i = 0; i < 50; i++) {
            CombatUtilities.processAttack(source, unit());
        }

        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(getSimWarnings()).toHaveLength(1);
    });
});

describe('calculateTickValue distributes a total across ticks', () => {
    /**
     * Sum every tick's delivery over the ticks the engine actually runs:
     * ceil(totalTicks), matching the `currentTick < totalTicks` reschedule guard.
     */
    function sumOverRun(totalValue, totalTicks) {
        const ticks = Math.ceil(totalTicks);
        let sum = 0;
        const perTick = [];
        for (let currentTick = 1; currentTick <= ticks; currentTick++) {
            const value = CombatUtilities.calculateTickValue(totalValue, totalTicks, currentTick);
            perTick.push(value);
            sum += value;
        }
        return { sum, perTick };
    }

    test('a whole tick count sums to exactly the total', () => {
        const { sum } = sumOverRun(100, 5);
        expect(sum).toBe(100);
    });

    test('each whole-count tick is byte-identical to the plain cumulative floors', () => {
        // The pre-fix formula, reproduced verbatim, must match tick for tick — for
        // an integer total and a fractional one (a DoT total can be fractional).
        for (const [totalValue, totalTicks] of [
            [97, 5],
            [100, 5],
            [253.7, 5],
            [88.125, 3],
        ]) {
            for (let currentTick = 1; currentTick <= totalTicks; currentTick++) {
                const plain =
                    Math.floor((currentTick * totalValue) / totalTicks) -
                    Math.floor(((currentTick - 1) * totalValue) / totalTicks);
                expect(CombatUtilities.calculateTickValue(totalValue, totalTicks, currentTick)).toBe(plain);
            }
        }
    });

    test('a fractional tick count still sums to exactly the total, never more', () => {
        // 3.6 ticks runs ceil = 4 ticks; the pre-fix final tick over-delivered.
        const { sum } = sumOverRun(100, 3.6);
        expect(sum).toBe(100);
    });

    test('the final fractional tick never pushes the cumulative sum past the total', () => {
        for (const totalTicks of [3.6, 4.2, 2.5, 5.9]) {
            const { sum } = sumOverRun(1000, totalTicks);
            expect(sum).toBe(1000);
        }
    });
});
