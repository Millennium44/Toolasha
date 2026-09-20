// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * The damage roll, and what happens when the engine meets a mechanic it does
 * not know.
 *
 * The taskDamage groups here are about a number the engine got wrong in three
 * directions in turn: left out of the attacker's roll entirely, then applied to
 * every fight regardless, then made a whole-run flag that was wrong in both
 * positions once a zone held more than one kind of monster. It is now decided
 * per encounter, against the monster actually being hit, and the flag survives
 * only as an override. The last group is about an unrecognized combat style
 * taking the whole simulation down rather than one attack. Seeding the RNG is
 * what makes the damage comparisons measurable — two attacks with the same seed
 * draw the same numbers, so the only difference left between them is the stat
 * under test.
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

/**
 * A monster, for the per-encounter task rule. Carries enough defensive damage
 * for the thorns and retaliation paths to have something to work with.
 */
function monster(hrid, statOverrides = {}) {
    const enemy = unit(statOverrides);
    enemy.hrid = hrid;
    enemy.isPlayer = false;
    enemy.combatDetails.defensiveMaxDamage = 300;
    // Without this the retaliation hit roll is NaN and never lands
    enemy.combatDetails.smashEvasionRating = 1;
    return enemy;
}

/** One attack from a freshly reseeded stream, so draws repeat exactly. */
function attackWith(statOverrides, forceTaskFight = false) {
    seedSimRng(SEED);
    return CombatUtilities.processAttack(unit(statOverrides), unit(), null, forceTaskFight);
}

/** One attack from a freshly reseeded stream, against a named monster. */
function attackMonster(statOverrides, tasks, monsterHrid, forceTaskFight = false) {
    seedSimRng(SEED);
    const source = unit(statOverrides);
    source.taskMonsterHrids = tasks ? new Set(tasks) : null;
    return CombatUtilities.processAttack(source, monster(monsterHrid), null, forceTaskFight);
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

    test('but with no override and no task list the same trinket does nothing', () => {
        // The other branch: the game pays taskDamage only while the monster is
        // your task, so an attacker with no task to its name must measure a
        // task badge as inert rather than rank it on damage it would never deal
        const plain = attackWith({});
        const withTask = attackWith({ taskDamage: 0.5 });

        expect(plain.damageDone).toBeGreaterThan(0);
        expect(withTask.damageDone).toBe(plain.damageDone);
    });

    test('and the override defaults off, so a caller who says nothing gets no bonus', () => {
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

const TASK_MONSTER = '/monsters/jungle_sprite';
const OTHER_MONSTER = '/monsters/myconid';

describe('taskDamage is decided per encounter, not per run', () => {
    test('a task trinket pays against the monster the task names', () => {
        const plain = attackMonster({}, [TASK_MONSTER], TASK_MONSTER);
        const withTask = attackMonster({ taskDamage: 0.5 }, [TASK_MONSTER], TASK_MONSTER);

        expect(plain.didHit).toBe(true);
        expect(plain.damageDone).toBeGreaterThan(0);
        expect(withTask.damageDone).toBeGreaterThan(plain.damageDone);
    });

    test('and pays nothing against a different monster in the same wave', () => {
        // The whole point. A zone, and a dungeon wave, is a mix; crediting the
        // bonus on every spawn overstates the run by however many of them are
        // not yours, and crediting it on none understates the one that is.
        const plain = attackMonster({}, [TASK_MONSTER], OTHER_MONSTER);
        const withTask = attackMonster({ taskDamage: 0.5 }, [TASK_MONSTER], OTHER_MONSTER);

        expect(plain.damageDone).toBeGreaterThan(0);
        expect(withTask.damageDone).toBe(plain.damageDone);
    });

    test('a mixed wave pays on the task spawns and on no others', () => {
        const thirdMonster = '/monsters/centaur';
        const tasks = [TASK_MONSTER, thirdMonster];
        const taskBaseline = attackMonster({}, tasks, TASK_MONSTER).damageDone;
        const otherBaseline = attackMonster({}, tasks, OTHER_MONSTER).damageDone;
        const thirdBaseline = attackMonster({}, tasks, thirdMonster).damageDone;

        expect(attackMonster({ taskDamage: 0.5 }, tasks, TASK_MONSTER).damageDone).toBeGreaterThan(taskBaseline);
        expect(attackMonster({ taskDamage: 0.5 }, tasks, thirdMonster).damageDone).toBeGreaterThan(thirdBaseline);
        expect(attackMonster({ taskDamage: 0.5 }, tasks, OTHER_MONSTER).damageDone).toBe(otherBaseline);
    });

    test('with no combat task at all, nobody gets it', () => {
        const plain = attackMonster({}, null, TASK_MONSTER);

        expect(plain.damageDone).toBeGreaterThan(0);
        expect(attackMonster({ taskDamage: 0.5 }, null, TASK_MONSTER).damageDone).toBe(plain.damageDone);
        // An empty list is the same answer as no list
        expect(attackMonster({ taskDamage: 0.5 }, [], TASK_MONSTER).damageDone).toBe(plain.damageDone);
    });

    test("one party member's task does not leak onto another's swings", () => {
        // Each player carries their own task board on their own unit, so the
        // attacker's set is the only one ever consulted.
        const mine = unit({ taskDamage: 0.5 });
        mine.taskMonsterHrids = new Set([TASK_MONSTER]);
        const theirs = unit({ taskDamage: 0.5 });
        theirs.taskMonsterHrids = new Set([OTHER_MONSTER]);

        expect(CombatUtilities.appliesTaskDamage(mine, monster(TASK_MONSTER))).toBe(true);
        expect(CombatUtilities.appliesTaskDamage(theirs, monster(TASK_MONSTER))).toBe(false);
    });

    test("a player is never anyone's task monster", () => {
        const attacker = monster(TASK_MONSTER, { taskDamage: 0.5 });
        attacker.taskMonsterHrids = new Set(['player1']);

        expect(CombatUtilities.appliesTaskDamage(attacker, unit())).toBe(false);
    });

    test('the Task Fight override still forces it on every fight', () => {
        const plain = attackMonster({}, null, OTHER_MONSTER, true);
        const withTask = attackMonster({ taskDamage: 0.5 }, null, OTHER_MONSTER, true);

        expect(withTask.damageDone).toBeGreaterThan(plain.damageDone);
    });
});

describe('taskDamage on the thorns and retaliation paths', () => {
    /**
     * A monster swinging at a player who thorns and retaliates back. The player
     * is the DEFENDER here, so it is the player's own task list — checked
     * against the attacking monster — that decides their bonus.
     *
     * @param {Object} playerStats - Combat stat overrides for the defender
     * @param {Array<string>|null} playerTasks - The defender's task monsters
     * @param {string} attackingMonsterHrid - Who is swinging at them
     * @returns {Object} Attack result
     */
    function monsterAttacksPlayer(playerStats, playerTasks, attackingMonsterHrid) {
        seedSimRng(SEED);
        const attacker = monster(attackingMonsterHrid);
        const defender = unit({ physicalThorns: 0.5, retaliation: 0.5, ...playerStats });
        defender.combatDetails.defensiveMaxDamage = 300;
        defender.combatDetails.smashAccuracyRating = 1_000_000;
        defender.taskMonsterHrids = playerTasks ? new Set(playerTasks) : null;
        return CombatUtilities.processAttack(attacker, defender, null, false);
    }

    test("the defender's thorns and retaliation pay when the attacker is their task", () => {
        const plain = monsterAttacksPlayer({}, [TASK_MONSTER], TASK_MONSTER);
        const withTask = monsterAttacksPlayer({ taskDamage: 0.5 }, [TASK_MONSTER], TASK_MONSTER);

        expect(plain.thornDamageDone).toBeGreaterThan(0);
        expect(withTask.thornDamageDone).toBeGreaterThan(plain.thornDamageDone);
        expect(plain.retaliationDamageDone).toBeGreaterThan(0);
        expect(withTask.retaliationDamageDone).toBeGreaterThan(plain.retaliationDamageDone);
    });

    test('and pay nothing when the attacker is some other monster in the wave', () => {
        const plain = monsterAttacksPlayer({}, [TASK_MONSTER], OTHER_MONSTER);
        const withTask = monsterAttacksPlayer({ taskDamage: 0.5 }, [TASK_MONSTER], OTHER_MONSTER);

        expect(plain.thornDamageDone).toBeGreaterThan(0);
        expect(withTask.thornDamageDone).toBe(plain.thornDamageDone);
        expect(withTask.retaliationDamageDone).toBe(plain.retaliationDamageDone);
    });

    test("the roles are the right way round: the attacking monster's own list is ignored", () => {
        // Reversed, this would read the swinging unit's task list against the
        // unit it is hitting — which is how the same stat ends up paying on the
        // wrong side of the exchange.
        seedSimRng(SEED);
        const attacker = monster(TASK_MONSTER, { taskDamage: 0.5 });
        attacker.taskMonsterHrids = new Set(['player1']);
        const defender = unit({ physicalThorns: 0.5, retaliation: 0.5 });
        defender.combatDetails.defensiveMaxDamage = 300;
        defender.combatDetails.smashAccuracyRating = 1_000_000;
        defender.taskMonsterHrids = null;

        const result = CombatUtilities.processAttack(attacker, defender, null, false);
        const plain = monsterAttacksPlayer({}, null, TASK_MONSTER);

        expect(result.thornDamageDone).toBe(plain.thornDamageDone);
        expect(result.retaliationDamageDone).toBe(plain.retaliationDamageDone);
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

/**
 * Life Drain rounds its heal up, and life steal does not.
 *
 * Fifteen of fifteen captured Life Drain casts came back at the ceiling of
 * ratio x damage x healing amplify (observation from the metz-combat-simulator
 * accuracy page). The life steal combat stat has never been measured against
 * the game, so it stays floored — this pins the asymmetry so it is not
 * "tidied" into agreement.
 */
describe('drain and steal rounding', () => {
    /**
     * A unit that records every heal it is asked for instead of applying it.
     * @param {Object} statOverrides - Combat stat overrides
     * @returns {{unit: Object, heals: number[]}}
     */
    function recordingSource(statOverrides = {}) {
        const heals = [];
        // healingAmplify is not in zeroStats; without it the drain math is NaN
        const source = unit({ healingAmplify: 0, ...statOverrides });
        source.addHitpoints = (amount) => {
            heals.push(amount);
            return amount;
        };
        return { unit: source, heals };
    }

    /** An ability effect that hits like an auto attack and drains on hit. */
    function drainEffect(hpDrainRatio) {
        return {
            combatStyleHrid: '/combat_styles/stab',
            damageType: '/damage_types/physical',
            damageFlat: 0,
            damageRatio: 1,
            armorDamageRatio: 0,
            bonusAccuracyRatio: 0,
            hpDrainRatio,
        };
    }

    test('a Life Drain heal rounds up', () => {
        // A ratio whose product with any whole damage number lands off an
        // integer, so floor and ceil cannot agree by luck
        const ratio = 0.333;
        const { unit: source, heals } = recordingSource();
        seedSimRng(SEED);
        const result = CombatUtilities.processAttack(source, unit(), drainEffect(ratio));

        expect(result.didHit).toBe(true);
        expect(result.damageDone).toBeGreaterThan(0);
        expect(heals).toHaveLength(1);
        expect(heals[0]).toBe(Math.ceil(ratio * result.damageDone));
        expect(heals[0]).toBeGreaterThan(Math.floor(ratio * result.damageDone));
    });

    test('healing amplify is inside the rounding, not applied after it', () => {
        const ratio = 0.25;
        const { unit: source, heals } = recordingSource({ healingAmplify: 0.13 });
        seedSimRng(SEED);
        const result = CombatUtilities.processAttack(source, unit(), drainEffect(ratio));

        expect(heals[0]).toBe(Math.ceil(ratio * result.damageDone * 1.13));
    });

    test('life steal still rounds down — it has never been measured', () => {
        const lifeSteal = 0.333;
        const { unit: source, heals } = recordingSource({ lifeSteal });
        seedSimRng(SEED);
        const result = CombatUtilities.processAttack(source, unit());

        expect(result.didHit).toBe(true);
        expect(heals).toHaveLength(1);
        expect(heals[0]).toBe(Math.floor(lifeSteal * result.damageDone));
        expect(heals[0]).toBeLessThan(Math.ceil(lifeSteal * result.damageDone));
    });
});
