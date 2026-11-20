import { describe, test, expect } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../__fixtures__/talisman-reroll.js';
import { advise, buildProblem, meetsTarget, normalizeTarget, solve } from './talisman-reroll-solver.js';

// "Need any K of the pool": the goal is at least K of the wanted lines, not every one of them

const M = (name) => `/talisman_modifiers/${name}`;
const COMBAT = '/talisman_types/combat';
const VALUE_WEIGHTS = Object.fromEntries(Object.entries(ORB_ITEMS).map(([hrid, item]) => [hrid, item.sellPrice]));
const line = (name, grade) => ({ hrid: M(name), grade });
const want = (name, minGrade) => ({ hrid: M(name), minGrade });

function problemFor(targets, need, lineCount, weights = VALUE_WEIGHTS) {
    return buildProblem({
        talismanTypeHrid: COMBAT,
        lineCount,
        targets,
        need,
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        weights,
    });
}

const solved = new Map();
function solutionFor(targets, need, lineCount, weights) {
    const key = JSON.stringify([targets, need, lineCount, weights]);
    if (!solved.has(key)) {
        const built = problemFor(targets, need, lineCount, weights);
        expect(built.status).toBe('ok');
        solved.set(key, solve(built.problem));
    }
    return solved.get(key);
}

const POOL = [want('armor', 3), want('melee_evasion', 3), want('melee_accuracy', 3)];
const NOTHING = [line('smite', 1), line('ability_damage', 1), line('ability_haste', 1)];

describe('normalizeTarget', () => {
    test('a type listed twice counts once, the first minimum stands, blanks go', () => {
        const result = normalizeTarget([want('armor', 2), { hrid: '' }, null, want('armor', 5), want('smite', 1)]);
        expect(result.pool).toEqual([want('armor', 2), want('smite', 1)]);
    });

    test('need is the pool size unless a whole number from 1 says otherwise, and never more than the pool', () => {
        expect(normalizeTarget(POOL).need).toBe(3);
        expect(normalizeTarget(POOL, null).need).toBe(3);
        expect(normalizeTarget(POOL, 0).need).toBe(3);
        expect(normalizeTarget(POOL, 'x').need).toBe(3);
        expect(normalizeTarget(POOL, 2.9).need).toBe(2);
        expect(normalizeTarget(POOL, 1).need).toBe(1);
        expect(normalizeTarget(POOL, 9).need).toBe(3);
        expect(normalizeTarget([], 2).need).toBe(0);
        // A repeated type shrinks the pool, and K with it
        expect(normalizeTarget([want('armor', 1), want('armor', 1)], 2).need).toBe(1);
    });
});

describe('meetsTarget with a need', () => {
    test('K of the pool at their grades, any K, not a particular K', () => {
        const mods = [line('armor', 3), line('melee_accuracy', 4), line('smite', 6)];
        expect(meetsTarget(mods, POOL, 2)).toBe(true);
        expect(meetsTarget(mods, POOL, 1)).toBe(true);
        expect(meetsTarget(mods, POOL, 3)).toBe(false);
        expect(meetsTarget(mods, POOL)).toBe(false);
        expect(meetsTarget(mods, POOL, null)).toBe(false);
    });

    test('a talisman holding K-1 of the pool does not meet K', () => {
        expect(meetsTarget([line('armor', 3), line('smite', 6)], POOL, 2)).toBe(false);
    });

    test('a grade just below the minimum does not count', () => {
        expect(meetsTarget([line('armor', 3), line('melee_evasion', 2)], POOL, 2)).toBe(false);
        expect(meetsTarget([line('armor', 3), line('melee_evasion', 3)], POOL, 2)).toBe(true);
    });

    test('a line listed twice in the pool counts once', () => {
        const dup = [want('armor', 3), want('armor', 3)];
        expect(meetsTarget([line('armor', 3)], dup, 2)).toBe(true);
        // Two pool entries for one type never make "two of them"
        const mixed = [want('armor', 3), want('armor', 3), want('smite', 4)];
        expect(meetsTarget([line('armor', 3)], mixed, 2)).toBe(false);
        expect(meetsTarget([line('armor', 3), line('smite', 4)], mixed, 2)).toBe(true);
    });

    test('an empty pool never meets anything', () => {
        expect(meetsTarget([line('armor', 6)], [], 1)).toBe(false);
    });
});

describe('buildProblem with a need', () => {
    test('need is carried, and K = pool size is the same problem as no need at all', () => {
        const all = problemFor(POOL, undefined, 3);
        expect(all.problem.need).toBe(3);
        expect(problemFor(POOL, 3, 3).problem).toEqual(all.problem);
        expect(problemFor(POOL, 9, 3).problem).toEqual(all.problem);
        expect(problemFor(POOL, 2, 3).problem).toMatchObject({ need: 2, m: 3 });
    });

    test('a type listed twice is one wanted line, not an error', () => {
        const built = problemFor([want('armor', 2), want('armor', 3)], null, 4);
        expect(built.status).toBe('ok');
        expect(built.problem).toMatchObject({ m: 1, need: 1 });
        expect(built.problem.wanted[0].minGrade).toBe(2);
    });

    test('a line that can never count is left out while K of the others remain', () => {
        const pool = [want('armor', 3), want('milking_speed', 1), want('melee_evasion', 7)];
        expect(problemFor(pool, 1, 3).problem).toMatchObject({ m: 1, need: 1 });
        // The unrollable lines then fall into the junk pool: they can never be wanted
        expect(problemFor(pool, 1, 3).problem.wanted.map((w) => w.hrid)).toEqual([M('armor')]);
    });

    test('too few rollable lines: every-line targets name the first failure as before, a K says how many', () => {
        const pool = [want('armor', 3), want('milking_speed', 1), want('melee_evasion', 7)];
        expect(problemFor(pool, null, 3)).toMatchObject({
            status: 'impossible',
            reason: 'notInPool',
            hrid: M('milking_speed'),
        });
        expect(problemFor(pool, 2, 3)).toMatchObject({ status: 'impossible', reason: 'tooFewRollable', rollable: 1 });
    });

    test('K more than the talisman has lines is unreachable; a bigger pool than the lines is fine', () => {
        expect(problemFor(POOL, 3, 2)).toMatchObject({ status: 'impossible', reason: 'needsMoreLines' });
        expect(problemFor(POOL, 2, 2).status).toBe('ok');
    });

    test('an empty pool is no target whatever the need', () => {
        expect(problemFor([], 2, 3).status).toBe('noTarget');
        expect(problemFor([{ hrid: '' }], 1, 3).status).toBe('noTarget');
    });
});

describe('solving for any K', () => {
    test('fewer needed costs strictly less, and K = pool size matches the old every-line value', () => {
        const talisman = talismanRow(1, NOTHING);
        const value = (need) => advise(solutionFor(POOL, need, 3), talisman, POOL, need).value;
        const one = value(1);
        const two = value(2);
        const three = value(3);
        expect(one).toBeGreaterThan(0);
        expect(one).toBeLessThan(two);
        expect(two).toBeLessThan(three);
        expect(value(undefined)).toBe(three);
        expect(value(null)).toBe(three);
    });

    test('a talisman already holding K-1 of the pool is cheaper than one holding none', () => {
        const none = advise(solutionFor(POOL, 2, 3), talismanRow(1, NOTHING), POOL, 2).value;
        const one = advise(
            solutionFor(POOL, 2, 3),
            talismanRow(1, [line('armor', 3), line('ability_damage', 1), line('ability_haste', 1)]),
            POOL,
            2
        );
        expect(one.status).toBe('move');
        expect(one.value).toBeLessThan(none);
    });

    test('met by the current lines: nothing to do, with or without a pending roll', () => {
        const solution = solutionFor(POOL, 2, 3);
        const met = [line('armor', 3), line('melee_accuracy', 5), line('smite', 1)];
        expect(advise(solution, talismanRow(1, met), POOL, 2)).toMatchObject({ status: 'met', counts: {} });
        // K-1 of the pool is not met
        expect(advise(solution, talismanRow(1, [line('armor', 3), ...NOTHING.slice(0, 2)]), POOL, 2).status).toBe(
            'move'
        );
        // The same lines meet every-line only if all three are there
        expect(advise(solutionFor(POOL, 3, 3), talismanRow(1, met), POOL, 3).status).not.toBe('met');
    });

    test('a pending roll that meets K is always taken; one a grade short is judged, not taken as met', () => {
        const solution = solutionFor(POOL, 2, 3);
        const current = [line('armor', 3), line('ability_damage', 1), line('ability_haste', 1)];
        const meets = [line('armor', 3), line('melee_evasion', 3), line('ability_haste', 1)];
        expect(advise(solution, talismanRow(1, current, { pendingModifiers: meets }), POOL, 2)).toMatchObject({
            status: 'accept',
            met: true,
        });
        const short = [line('armor', 3), line('melee_evasion', 2), line('ability_haste', 1)];
        const advice = advise(solution, talismanRow(1, current, { pendingModifiers: short }), POOL, 2);
        expect(advice.met).toBeUndefined();
        expect(['accept', 'discard']).toContain(advice.status);
    });

    test('the current lines meeting K beat a pending roll that does not', () => {
        const solution = solutionFor(POOL, 2, 3);
        const met = [line('armor', 3), line('melee_evasion', 3), line('ability_haste', 1)];
        const worse = [line('ability_damage', 1), line('ability_haste', 1), line('smite', 1)];
        expect(advise(solution, talismanRow(1, met, { pendingModifiers: worse }), POOL, 2).status).toBe('discard');
    });

    test('unreachable: no orb that can add a missing type, and fewer than K already there', () => {
        const weights = { '/items/attunement_orb': 1, '/items/exchange_orb': 1 };
        const pool = [want('armor', 1), want('smite', 1)];
        const solution = solutionFor(pool, 1, 2, weights);
        const advice = advise(solution, talismanRow(1, [line('melee_evasion', 3), line('melee_accuracy', 2)]), pool, 1);
        expect(advice.status).toBe('unreachable');
    });

    test('K = 1 of a one-line pool is the old single-line target', () => {
        const pool = [want('armor', 3)];
        const talisman = talismanRow(1, NOTHING);
        expect(advise(solutionFor(pool, 1, 3), talisman, pool, 1)).toEqual(
            advise(solutionFor(pool, undefined, 3), talisman, pool)
        );
    });

    test('the first move for any K is one the talisman can make now', () => {
        const advice = advise(solutionFor(POOL, 1, 3), talismanRow(1, NOTHING), POOL, 1);
        expect(advice.status).toBe('move');
        expect(Object.keys(advice.counts).length).toBeGreaterThan(0);
    });
});
