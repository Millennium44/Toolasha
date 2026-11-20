import { describe, test, expect } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../__fixtures__/talisman-reroll.js';
import {
    advise,
    buildProblem,
    countStates,
    effectiveStates,
    MAX_STATES,
    MAX_WANTED_LINES,
    meetsTarget,
    normalizeTarget,
    solveSteps,
    solve,
} from './talisman-reroll-solver.js';

// Required lines: the goal is every required line AND at least K lines of the pool

const M = (name) => `/talisman_modifiers/${name}`;
const COMBAT = '/talisman_types/combat';
const VALUE_WEIGHTS = Object.fromEntries(Object.entries(ORB_ITEMS).map(([hrid, item]) => [hrid, item.sellPrice]));
const line = (name, grade) => ({ hrid: M(name), grade });
const want = (name, minGrade, required) => ({ hrid: M(name), minGrade, ...(required ? { required: true } : {}) });

function problemFor(targets, need, lineCount = 3) {
    return buildProblem({
        talismanTypeHrid: COMBAT,
        lineCount,
        targets,
        need,
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        weights: VALUE_WEIGHTS,
    });
}

const solved = new Map();
function solutionFor(targets, need, lineCount = 3) {
    const key = JSON.stringify([targets, need, lineCount]);
    if (!solved.has(key)) {
        const built = problemFor(targets, need, lineCount);
        expect(built.status).toBe('ok');
        solved.set(key, solve(built.problem));
    }
    return solved.get(key);
}

const NOTHING = [line('smite', 1), line('ability_damage', 1), line('ability_haste', 1)];
const valueOf = (targets, need) => advise(solutionFor(targets, need), talismanRow(1, NOTHING), targets, need).value;

describe('normalizeTarget with required lines', () => {
    test('a required flag survives; a false or absent one leaves the entry as given', () => {
        const pool = normalizeTarget([
            want('armor', 3, true),
            want('smite', 2),
            { ...want('smite', 2), required: false },
        ]);
        expect(pool.pool).toEqual([want('armor', 3, true), want('smite', 2)]);
        expect(pool.requiredCount).toBe(1);
        const plain = normalizeTarget([{ ...want('armor', 3), required: false }]);
        expect(plain.pool).toEqual([want('armor', 3)]);
        expect('required' in plain.pool[0]).toBe(false);
    });

    test('a duplicate keeps the first grade and is required when any copy is', () => {
        const result = normalizeTarget([want('armor', 2), want('armor', 5, true), want('smite', 1)]);
        expect(result.pool).toEqual([want('armor', 2, true), want('smite', 1)]);
        expect(result.requiredCount).toBe(1);
        // The other order too
        expect(normalizeTarget([want('armor', 2, true), want('armor', 5)]).pool).toEqual([want('armor', 2, true)]);
    });

    test('K below the required count is raised to it; none required leaves K alone', () => {
        const pool = [
            want('armor', 3, true),
            want('melee_evasion', 3, true),
            want('smite', 3),
            want('melee_accuracy', 3),
        ];
        expect(normalizeTarget(pool, 1).need).toBe(2);
        expect(normalizeTarget(pool, 3).need).toBe(3);
        expect(normalizeTarget(pool).need).toBe(4);
        expect(
            normalizeTarget(
                pool.map((t) => want(t.hrid.split('/').pop(), t.minGrade)),
                1
            ).need
        ).toBe(1);
        // Every line required: K can only be all of them
        expect(normalizeTarget([want('armor', 3, true), want('smite', 3, true)], 1).need).toBe(2);
    });
});

describe('meetsTarget with required lines', () => {
    const pool = [want('armor', 3, true), want('melee_evasion', 3), want('melee_accuracy', 3), want('smite', 3)];

    test('K of the pool without the required line is not a goal', () => {
        const mods = [line('melee_evasion', 3), line('melee_accuracy', 3), line('smite', 3)];
        expect(meetsTarget(mods, pool, 3)).toBe(false);
        expect(meetsTarget([line('armor', 3), ...mods.slice(0, 2)], pool, 3)).toBe(true);
    });

    test('the required line at too low a grade does not count', () => {
        expect(meetsTarget([line('armor', 2), line('melee_evasion', 3)], pool, 2)).toBe(false);
        expect(meetsTarget([line('armor', 3), line('melee_evasion', 3)], pool, 2)).toBe(true);
    });

    test('K below the required count: the required lines are still all needed', () => {
        const two = [want('armor', 3, true), want('smite', 3, true), want('melee_evasion', 3)];
        expect(meetsTarget([line('armor', 3)], two, 1)).toBe(false);
        expect(meetsTarget([line('armor', 3), line('smite', 3)], two, 1)).toBe(true);
    });

    test('every line required is the old all-of-them meaning', () => {
        const all = [want('armor', 3, true), want('smite', 3, true)];
        expect(meetsTarget([line('armor', 3)], all, 1)).toBe(false);
        expect(meetsTarget([line('armor', 3), line('smite', 3)], all, 1)).toBe(true);
    });
});

describe('buildProblem with required lines', () => {
    test('the required flag reaches the solver slots; none required adds no flag', () => {
        const built = problemFor([want('armor', 3, true), want('smite', 2), want('melee_evasion', 3)], 2);
        expect(built.problem.wanted.map((w) => w.required === true)).toEqual([true, false, false]);
        expect(problemFor([want('armor', 3), want('smite', 2)], 1).problem.wanted.some((w) => 'required' in w)).toBe(
            false
        );
    });

    test('a required line that cannot roll here is unreachable whatever K says', () => {
        const pool = [want('armor', 3), want('melee_evasion', 3), want('milking_speed', 1, true)];
        expect(problemFor(pool, 1)).toMatchObject({
            status: 'impossible',
            reason: 'requiredNotRollable',
            cause: 'notInPool',
            hrid: M('milking_speed'),
        });
        // The same line unrequired is left out while K of the others remain
        expect(problemFor([want('armor', 3), want('melee_evasion', 3), want('milking_speed', 1)], 1).status).toBe('ok');
        // A required grade above the cap
        expect(problemFor([want('armor', 7, true), want('melee_evasion', 3)], 1)).toMatchObject({
            reason: 'requiredNotRollable',
            cause: 'gradeAboveCap',
        });
    });

    test('K raised to the required count is carried; more required than the talisman has lines is unreachable', () => {
        const pool = [want('armor', 3, true), want('melee_evasion', 3, true), want('smite', 3)];
        expect(problemFor(pool, 1).problem.need).toBe(2);
        expect(problemFor(pool, 1, 1)).toMatchObject({ status: 'impossible', reason: 'needsMoreLines' });
    });

    test('a pool above the solver limit is refused with the limit named', () => {
        const names = Object.keys(REROLL_MODIFIERS)
            .filter((h) => REROLL_MODIFIERS[h].talismanTypeHrid === COMBAT && REROLL_MODIFIERS[h].weight > 0)
            .slice(0, MAX_WANTED_LINES + 1);
        const pool = names.map((hrid) => ({ hrid, minGrade: 1 }));
        expect(problemFor(pool, 2, 4)).toMatchObject({ status: 'impossible', reason: 'poolTooLarge', max: 6 });
    });
});

describe('solving with required lines', () => {
    const POOL = [want('armor', 3), want('melee_evasion', 3), want('melee_accuracy', 3)];
    const required = (index) => POOL.map((t, i) => (i === index ? { ...t, required: true } : t));

    test('all required costs what every-line costs; none required costs what any-K costs', () => {
        const allRequired = POOL.map((t) => ({ ...t, required: true }));
        expect(valueOf(allRequired, 1)).toBeCloseTo(valueOf(POOL, 3), 9);
        expect(valueOf(allRequired, undefined)).toBeCloseTo(valueOf(POOL, undefined), 9);
        const one = valueOf(POOL, 2);
        const noneFlag = POOL.map((t) => ({ ...t }));
        expect(valueOf(noneFlag, 2)).toBe(one);
    });

    test('a required line costs more than any-K and no more than every line', () => {
        const any2 = valueOf(POOL, 2);
        const req = valueOf(required(0), 2);
        const all3 = valueOf(POOL, 3);
        expect(req).toBeGreaterThan(any2);
        expect(req).toBeLessThanOrEqual(all3 + 1e-9);
    });

    test('K below the required count costs the same as K at it', () => {
        const two = POOL.map((t, i) => (i < 2 ? { ...t, required: true } : t));
        expect(valueOf(two, 1)).toBeCloseTo(valueOf(two, 2), 9);
    });

    test('met needs the required line; K others without it is a move, not met', () => {
        const target = required(0);
        const solution = solutionFor(target, 2);
        const withoutIt = talismanRow(1, [line('melee_evasion', 3), line('melee_accuracy', 3), line('smite', 1)]);
        expect(advise(solution, withoutIt, target, 2).status).toBe('move');
        const withIt = talismanRow(1, [line('armor', 3), line('melee_accuracy', 3), line('smite', 1)]);
        expect(advise(solution, withIt, target, 2).status).toBe('met');
    });

    test('a pending roll with K lines but not the required one is not an automatic accept', () => {
        const target = required(0);
        const solution = solutionFor(target, 2);
        const current = [line('armor', 3), line('smite', 1), line('ability_haste', 1)];
        const pending = [line('melee_evasion', 3), line('melee_accuracy', 3), line('ability_haste', 1)];
        const advice = advise(solution, talismanRow(1, current, { pendingModifiers: pending }), target, 2);
        expect(advice.met).toBeUndefined();
        // The current lines hold the required line and one short of K: the K-line roll without it is judged
        expect(['accept', 'discard']).toContain(advice.status);
    });
});

describe('the largest pool', () => {
    test('six wanted lines (the keep-mask bit limit) solve, with a required pair and K 4', () => {
        const names = Object.keys(REROLL_MODIFIERS)
            .filter((h) => REROLL_MODIFIERS[h].talismanTypeHrid === COMBAT && REROLL_MODIFIERS[h].weight > 0)
            .slice(0, MAX_WANTED_LINES);
        const pool = names.map((hrid, i) => ({ hrid, minGrade: 2, ...(i < 2 ? { required: true } : {}) }));
        const built = problemFor(pool, 4, 4);
        expect(built.status).toBe('ok');
        expect(built.problem).toMatchObject({ m: 6, need: 4 });
        const solution = solve(built.problem);
        const holds = (list) =>
            talismanRow(
                1,
                list.map((hrid) => ({ hrid, grade: 2 }))
            );
        const start = talismanRow(1, [
            { hrid: names[0], grade: 2 },
            { hrid: names[1], grade: 2 },
            line('smite', 1),
            line('ability_haste', 1),
        ]);
        const advice = advise(solution, start, pool, 4);
        expect(advice.status).toBe('move');
        expect(Number.isFinite(advice.value)).toBe(true);
        // Both required lines and two others: met; the required pair missing: not met
        expect(advise(solution, holds(names.slice(0, 4)), pool, 4).status).toBe('met');
        expect(advise(solution, holds(names.slice(2, 6)), pool, 4).status).not.toBe('met');
    }, 60000);
});

describe('the state ceiling', () => {
    const names = Object.keys(REROLL_MODIFIERS)
        .filter((h) => REROLL_MODIFIERS[h].talismanTypeHrid === COMBAT && REROLL_MODIFIERS[h].weight > 0)
        .slice(0, MAX_WANTED_LINES);
    const poolOf = (count, minGrade) => names.slice(0, count).map((hrid) => ({ hrid, minGrade }));

    test('six lines at G6 on four lines is refused with the numbers; five lines at G6 is allowed', () => {
        expect(MAX_STATES).toBe(150000);
        expect(problemFor(poolOf(6, 6), 4, 4)).toMatchObject({
            status: 'impossible',
            reason: 'tooManyStates',
            rollable: 6,
            states: 289290,
            max: MAX_STATES,
        });
        const five = problemFor(poolOf(5, 6), 4, 4);
        expect(five.status).toBe('ok');
        expect(countStates(4, 5, five.problem.G)).toBe(140442);
    });

    test('a lower grade clamps the space under the ceiling instead of refusing', () => {
        expect(problemFor(poolOf(6, 4), 4, 4).status).toBe('ok');
        expect(effectiveStates(4, 6, 2, 6)).toEqual({ G: 3, states: countStates(4, 6, 3) });
        // Never clamped below the highest minimum grade
        expect(effectiveStates(4, 6, 6, 6).G).toBe(6);
    });

    test('the solver yields while it enumerates: the first slice is a small part of a 59,958-state problem', () => {
        const built = problemFor(poolOf(4, 6), 4, 4);
        const run = solveSteps(built.problem);
        let yields = 0;
        let step = run.next();
        // The whole of enumeration, allocation and the goal scan used to be two or three yields; now it is dozens
        while (!step.done && yields < 150) {
            yields++;
            step = run.next();
        }
        expect(step.done).toBe(false);
        expect(yields).toBe(150);
    });
});

describe('optional lines when the required ones fill K', () => {
    const ones = Object.fromEntries(Object.keys(VALUE_WEIGHTS).map((hrid) => [hrid, 1]));
    const withOnes = (targets, need, lineCount) =>
        buildProblem({
            talismanTypeHrid: COMBAT,
            lineCount,
            targets,
            need,
            info: TALISMAN_INFO,
            modifierDetailMap: REROLL_MODIFIERS,
            weights: ones,
        });
    const both = [want('armor', 6, true), want('melee_evasion', 6)];
    const requiredOnly = [want('armor', 6, true)];
    const held = talismanRow(1, [line('smite', 6)]);

    test('one-line talisman, required Armor + optional Melee Evasion, K 1: the solve is the required-only solve', () => {
        const built = withOnes(both, 1, 1);
        expect(built.status).toBe('ok');
        expect(built.problem.wanted.map((w) => w.hrid)).toEqual([M('armor')]);
        const withOptional = advise(solve(built.problem), held, both, 1);
        const alone = advise(solve(withOnes(requiredOnly, 1, 1).problem), held, requiredOnly, 1);
        expect(withOptional.value).toBeCloseTo(alone.value, 9);
        expect(withOptional.move).toEqual(alone.move);
        expect(withOptional.move.focusHrids ?? []).not.toContain(M('melee_evasion'));
        expect(withOptional.move.itemHrid).toBe('/items/focus_orb');
        expect(withOptional.counts).toEqual(alone.counts);
    });

    test('K above the required count keeps the optional lines in the problem', () => {
        const built = withOnes(both, 2, 2);
        expect(built.problem.wanted.map((w) => w.hrid)).toEqual([M('armor'), M('melee_evasion')]);
        expect(built.problem.need).toBe(2);
        // No required lines: any-K keeps its whole pool
        expect(withOnes([want('armor', 6), want('melee_evasion', 6)], 1, 2).problem.m).toBe(2);
    });

    test('the player-set target is not edited: normalizeTarget still returns every row', () => {
        expect(normalizeTarget(both, 1).pool).toHaveLength(2);
    });
});
