import { describe, test, expect } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../__fixtures__/talisman-reroll.js';
import { advise, buildProblem, focusLabels, solve } from './talisman-reroll-solver.js';

// Issue #1072: a locked optional line that already fills the optional part of K makes the other optional types
// irrelevant to a Focus reroll. Only the locked line survives a reroll, so a held unlocked line never counts.

const M = (name) => `/talisman_modifiers/${name}`;
const COMBAT = '/talisman_types/combat';
const FOCUS = '/items/focus_orb';
// Focus costs 1, every other orb 1000: Focus is the move wherever it can help
const WEIGHTS = Object.fromEntries(Object.keys(ORB_ITEMS).map((hrid) => [hrid, hrid === FOCUS ? 1 : 1000]));
const want = (name, minGrade, required) => ({ hrid: M(name), minGrade, ...(required ? { required: true } : {}) });
const line = (name, grade) => ({ hrid: M(name), grade });

function solveFor(targets, need, lineCount) {
    const built = buildProblem({
        talismanTypeHrid: COMBAT,
        lineCount,
        targets,
        need,
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        weights: WEIGHTS,
    });
    expect(built.status).toBe('ok');
    return { problem: built.problem, solution: solve(built.problem) };
}

const POOL = [want('armor', 6, true), want('melee_evasion', 1), want('melee_accuracy', 1)];

describe('Focus with a held optional line', () => {
    test("Codex's case: locked optional Melee Evasion fills K 2 with required Armor, so only Armor is focused", () => {
        const { solution } = solveFor(POOL, 2, 2);
        const held = talismanRow(1, [line('melee_evasion', 1), line('smite', 6)], {
            lockedModifierHrid: M('melee_evasion'),
        });
        const advice = advise(solution, held, POOL, 2);
        expect(advice.move.itemHrid).toBe(FOCUS);
        expect(advice.move.focusHrids).toEqual([M('armor')]);
        // Armor alone is what advances the goal: 9.3 Focus Orbs (10.1 when it also focused Melee Accuracy)
        expect(advice.counts[FOCUS]).toBeCloseTo(9.3, 1);
        expect(advice.value).toBeCloseTo(9.3, 1);
    });

    test('an unlocked held optional line can be lost, so optional types are still focused', () => {
        const { solution } = solveFor(POOL, 2, 2);
        const held = talismanRow(1, [line('melee_evasion', 1), line('smite', 6)]);
        const advice = advise(solution, held, POOL, 2);
        expect(advice.move.itemHrid).toBe(FOCUS);
        expect(advice.move.focusHrids).toEqual([M('armor'), M('melee_evasion'), M('melee_accuracy')]);
    });

    test('K above the held and required lines keeps the other optional types', () => {
        const pool = [...POOL, want('ability_damage', 1)];
        const { solution } = solveFor(pool, 3, 3);
        const held = talismanRow(1, [line('melee_evasion', 1), line('smite', 6), line('armor', 1)], {
            lockedModifierHrid: M('melee_evasion'),
        });
        const advice = advise(solution, held, pool, 3);
        expect(advice.move.itemHrid).toBe(FOCUS);
        expect(advice.move.focusHrids).toEqual([M('armor'), M('melee_accuracy'), M('ability_damage')]);
    });

    test('a locked optional line below its minimum grade does not fill the quota', () => {
        const pool = [want('armor', 6, true), want('melee_evasion', 3), want('melee_accuracy', 1)];
        const { problem } = solveFor(pool, 2, 2);
        const labels = (grade) => focusLabels(problem, 2, grade);
        expect([...labels(2)]).toEqual([1, 3]);
        expect([...labels(3)]).toEqual([1]);
    });
});

describe('a required line that cannot be focused', () => {
    // Required Smite (a Special: not focusable), optional Melee Evasion and Armor, K 2, Melee Evasion locked
    const pool = [want('smite', 1, true), want('melee_evasion', 1), want('armor', 1)];

    test('Focus stays legal on the optional picks, since a focused reroll can still draw the Special', () => {
        const { solution } = solveFor(pool, 2, 2);
        const held = talismanRow(1, [line('melee_evasion', 1), line('ability_damage', 1)], {
            lockedModifierHrid: M('melee_evasion'),
        });
        const advice = advise(solution, held, pool, 2);
        expect(advice.move.itemHrid).toBe(FOCUS);
        expect(advice.move.focusHrids).toEqual([M('armor')]);
        // Unlocking and rerolling with the 1000-cost orbs was ~1056; Focus on Armor is ~465
        expect(advice.value).toBeLessThan(600);
        expect(advice.value).toBeCloseTo(465, -1);
    });
});
