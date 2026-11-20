import { describe, test, expect } from 'vitest';
import { ORB_ITEMS, REROLL_MODIFIERS, TALISMAN_INFO, talismanRow } from '../__fixtures__/talisman-reroll.js';
import { MAX_STATES, addLinePlan, advise, buildProblem, effectiveStates, solve } from './talisman-reroll-solver.js';

// Adding lines with cores before rerolling (the `addLine` opt-in)

const M = (name) => `/talisman_modifiers/${name}`;
const COMBAT = '/talisman_types/combat';
const BASIC = '/items/basic_talisman_core';
const ADVANCED = '/items/advanced_talisman_core';
const EXPERT = '/items/expert_talisman_core';
const VALUE_WEIGHTS = Object.fromEntries(Object.entries(ORB_ITEMS).map(([hrid, item]) => [hrid, item.sellPrice]));
const CHEAP_CORES = { [BASIC]: 1000, [ADVANCED]: 5000, [EXPERT]: 20000 };
const DEAR_CORES = { [BASIC]: 1e12, [ADVANCED]: 1e12, [EXPERT]: 1e12 };
const line = (name, grade) => ({ hrid: M(name), grade });
const want = (name, minGrade, required) => ({ hrid: M(name), minGrade, ...(required ? { required: true } : {}) });

function build(targets, need, lineCount, addLine) {
    return buildProblem({
        talismanTypeHrid: COMBAT,
        lineCount,
        targets,
        need,
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        weights: VALUE_WEIGHTS,
        ...(addLine ? { addLine } : {}),
    });
}

const solved = new Map();
function solutionFor(targets, need, lineCount, addLine) {
    const key = JSON.stringify([targets, need, lineCount, addLine]);
    if (!solved.has(key)) {
        const built = build(targets, need, lineCount, addLine);
        expect(built.status).toBe('ok');
        solved.set(key, solve(built.problem));
    }
    return solved.get(key);
}

const POOL3 = [want('armor', 1), want('melee_evasion', 1), want('ranged_evasion', 1)];
const ONE_LINE = talismanRow(1, [line('ability_haste', 2)]);

describe('addLinePlan', () => {
    test('one add per missing line, priced only where the core has a weight', () => {
        expect(addLinePlan(TALISMAN_INFO, 1, { [BASIC]: 1000 })).toEqual([
            { line: 2, itemHrid: BASIC, count: 5, weight: 5000 },
            { line: 3, itemHrid: ADVANCED, count: 1, weight: null },
            { line: 4, itemHrid: EXPERT, count: 1, weight: null },
        ]);
        expect(addLinePlan(TALISMAN_INFO, 4, CHEAP_CORES)).toEqual([]);
        // A missing line cost stops the plan there
        const info = { ...TALISMAN_INFO, addModifierInputMap: { 2: TALISMAN_INFO.addModifierInputMap[2] } };
        expect(addLinePlan(info, 1, CHEAP_CORES)).toHaveLength(1);
    });
});

describe('a target that needs more lines than the talisman has', () => {
    test('without the opt-in it is still refused', () => {
        expect(build(POOL3, 3, 1)).toMatchObject({ status: 'impossible', reason: 'needsMoreLines' });
    });

    test('priced cores: the advice is to add the next line, and the cores are counted', () => {
        const addLine = { coreWeights: CHEAP_CORES };
        const advice = advise(solutionFor(POOL3, 3, 1, addLine), ONE_LINE, POOL3, 3);
        expect(advice.status).toBe('move');
        expect(advice.move).toEqual({ kind: 'add', itemHrid: BASIC, count: 5, lineNumber: 2 });
        expect(Number.isFinite(advice.value)).toBe(true);
        // At least two adds: line 2 (5 basic) and line 3 (1 advanced)
        expect(advice.counts[BASIC]).toBeCloseTo(5, 9);
        expect(advice.counts[ADVANCED]).toBeCloseTo(1, 9);
        // Orbs too: the added lines roll their own types
        const orbsUsed = Object.keys(advice.counts).filter((hrid) => hrid.endsWith('_orb'));
        expect(orbsUsed.length).toBeGreaterThan(0);
    });

    test('unpriced cores: the add is required (not unreachable), with the cores in the counts', () => {
        const addLine = { coreWeights: {} };
        const advice = advise(solutionFor(POOL3, 3, 1, addLine), ONE_LINE, POOL3, 3);
        expect(advice.status).toBe('move');
        expect(advice.move).toEqual({ kind: 'add', itemHrid: BASIC, count: 5, lineNumber: 2 });
        expect(advice.addRequired).toMatchObject({ kind: 'add', lineNumber: 2, need: 3, unpriced: true });
        expect(Number.isFinite(advice.value)).toBe(true);
        expect(advice.counts[BASIC]).toBeCloseTo(5, 9);
        expect(advice.counts[ADVANCED]).toBeCloseTo(1, 9);
    });

    test('unpriced: the required value after the adds matches the priced one with the core weight taken out', () => {
        // Need all 3 of 3 on a 3-line talisman after two adds: priced cores so cheap the plan is the same
        const tiny = { [BASIC]: 1e-6, [ADVANCED]: 1e-6, [EXPERT]: 1e-6 };
        const priced = advise(
            solutionFor(POOL3, 3, 2, { coreWeights: tiny }),
            talismanRow(2, [line('smite', 1), line('critical_rate', 1)]),
            POOL3,
            3
        );
        const unpriced = advise(
            solutionFor(POOL3, 3, 2, { coreWeights: {} }),
            talismanRow(2, [line('smite', 1), line('critical_rate', 1)]),
            POOL3,
            3
        );
        expect(unpriced.move.kind).toBe('add');
        // Unpriced adds only the line the target needs; free adds may add the 4th too, which only lowers the orbs
        expect(priced.value).toBeLessThanOrEqual(unpriced.value * (1 + 1e-9));
    });

    test('a locked line: add with the lock kept (the game adds while a line is locked), no unlock first', () => {
        const locked = talismanRow(2, [line('armor', 2), line('critical_rate', 1)], { lockedModifierHrid: M('armor') });
        const add3 = { kind: 'add', itemHrid: ADVANCED, count: 1, lineNumber: 3 };
        const priced = advise(solutionFor(POOL3, 3, 2, { coreWeights: CHEAP_CORES }), locked, POOL3, 3);
        expect(priced.status).toBe('move');
        expect(priced.move).toEqual(add3);
        // No Binding Orb: the lock is never moved or taken off and put back
        expect(priced.counts['/items/binding_orb'] || 0).toBeLessThan(1);
        const unpriced = advise(solutionFor(POOL3, 3, 2, { coreWeights: {} }), locked, POOL3, 3);
        expect(unpriced.move).toEqual(add3);
        expect(unpriced.addRequired).toMatchObject({ ...add3, unpriced: true, unpricedCores: [ADVANCED] });
        // The same talisman without the lock is told the same
        const free = talismanRow(2, [line('armor', 2), line('critical_rate', 1)]);
        const freeAdvice = advise(solutionFor(POOL3, 3, 2, { coreWeights: CHEAP_CORES }), free, POOL3, 3);
        expect(freeAdvice.move).toEqual(add3);
    });

    test('mixed prices (basic priced, advanced not): unpriced names only the advanced core', () => {
        const addLine = { coreWeights: { [BASIC]: 1000 } };
        const advice = advise(solutionFor(POOL3, 3, 1, addLine), ONE_LINE, POOL3, 3);
        expect(advice.status).toBe('move');
        expect(advice.move).toEqual({ kind: 'add', itemHrid: BASIC, count: 5, lineNumber: 2 });
        // Line 3 has no price, so even the priced first add is not weighed: required, not chosen on cost
        expect(advice.addRequired).toMatchObject({ unpriced: false, unpricedCores: [ADVANCED] });
        expect(advice.counts[BASIC]).toBeCloseTo(5, 9);
        expect(advice.counts[ADVANCED]).toBeCloseTo(1, 9);
        // From two lines the priced core is spent: the add to line 3 is still required and unpriced
        const two = talismanRow(1, [line('ability_haste', 2), line('critical_rate', 1)]);
        const next = advise(solutionFor(POOL3, 3, 2, addLine), two, POOL3, 3);
        expect(next.addRequired).toMatchObject({ lineNumber: 3, unpriced: true, unpricedCores: [ADVANCED] });
    });

    test('a pending roll is decided first: never an add while it waits', () => {
        const pending = talismanRow(1, [line('ability_haste', 2)], { pendingModifiers: [line('armor', 1)] });
        for (const coreWeights of [CHEAP_CORES, {}]) {
            const advice = advise(solutionFor(POOL3, 3, 1, { coreWeights }), pending, POOL3, 3);
            expect(['accept', 'discard']).toContain(advice.status);
            expect(advice.move).toBeUndefined();
            expect(Number.isFinite(advice.value)).toBe(true);
        }
    });

    test('more lines than the talisman can ever hold is still refused', () => {
        const pool = [...POOL3, want('critical_rate', 1), want('smite', 1)];
        expect(build(pool, 5, 1, { coreWeights: CHEAP_CORES })).toMatchObject({
            status: 'impossible',
            reason: 'needsMoreLines',
        });
    });
});

describe('an add competes with rerolls', () => {
    // One rare Special on a one-line talisman: four lines draw it about four times as often per orb
    const SMITE = [want('smite', 1)];

    test('cheap cores: add first', () => {
        const advice = advise(solutionFor(SMITE, 1, 1, { coreWeights: CHEAP_CORES }), ONE_LINE, SMITE, 1);
        expect(advice.move).toEqual({ kind: 'add', itemHrid: BASIC, count: 5, lineNumber: 2 });
    });

    test('cores so dear the add loses: the same advice as without the opt-in', () => {
        const plain = advise(solutionFor(SMITE, 1, 1), ONE_LINE, SMITE, 1);
        const dear = advise(solutionFor(SMITE, 1, 1, { coreWeights: DEAR_CORES }), ONE_LINE, SMITE, 1);
        expect(dear.move.kind).not.toBe('add');
        expect(dear.move).toEqual(plain.move);
        expect(dear.value).toBeCloseTo(plain.value, 6);
        expect(dear.counts).toEqual(plain.counts);
        expect(dear.addSuggestion).toBeUndefined();
    });

    test('unpriced cores: reroll as before, with a suggestion to add first and how much it saves', () => {
        const plain = advise(solutionFor(SMITE, 1, 1), ONE_LINE, SMITE, 1);
        const unpriced = advise(solutionFor(SMITE, 1, 1, { coreWeights: {} }), ONE_LINE, SMITE, 1);
        expect(unpriced.move).toEqual(plain.move);
        expect(unpriced.value).toBeCloseTo(plain.value, 6);
        expect(unpriced.addSuggestion).toMatchObject({
            move: { kind: 'add', itemHrid: BASIC, count: 5, lineNumber: 2 },
        });
        expect(unpriced.addSuggestion.saving).toBeGreaterThan(0);
        expect(unpriced.addSuggestion.value + unpriced.addSuggestion.saving).toBeCloseTo(unpriced.value, 6);
    });
});

describe('a talisman with every line', () => {
    test('four lines: the opt-in changes nothing', () => {
        const targets = [want('armor', 3), want('smite', 1)];
        const four = talismanRow(4, [
            line('critical_rate', 1),
            line('ability_haste', 2),
            line('armor', 1),
            line('cast_speed', 1),
        ]);
        const plainBuild = build(targets, null, 4);
        const optBuild = build(targets, null, 4, { coreWeights: CHEAP_CORES });
        expect(optBuild).toEqual(plainBuild);
        const plain = advise(solutionFor(targets, null, 4), four, targets);
        const opt = advise(solutionFor(targets, null, 4, { coreWeights: CHEAP_CORES }), four, targets);
        expect(opt).toEqual(plain);
    });
});

describe('a line count over the state ceiling', () => {
    // Six lines wanted at G6 cannot clamp: 4 lines are over MAX_STATES, 3 lines are not (checked below)
    const SIX = ['armor', 'melee_evasion', 'ranged_evasion', 'melee_accuracy', 'ability_damage', 'critical_rate'].map(
        (name) => want(name, 6)
    );
    const addLine = { coreWeights: CHEAP_CORES };

    test('the preconditions hold', () => {
        expect(effectiveStates(4, 6, 6, 6).states).toBeGreaterThan(MAX_STATES);
        expect(effectiveStates(3, 6, 6, 6).states).toBeLessThanOrEqual(MAX_STATES);
        expect(effectiveStates(2, 6, 6, 6).states).toBeLessThanOrEqual(MAX_STATES);
    });

    test('a 3-line talisman: the add is left out and the rest is the plain problem', () => {
        const plain = build(SIX, 1, 3);
        const opt = build(SIX, 1, 3, addLine);
        expect(opt.status).toBe('ok');
        expect(opt.problem).toEqual({ ...plain.problem, addLeftOut: true });
    });

    test('a 2-line talisman: the add to line 3 is kept, the one to line 4 left out', () => {
        const opt = build(SIX, 1, 2, addLine);
        expect(opt.status).toBe('ok');
        expect(opt.problem.adds.map((a) => a.line)).toEqual([3]);
        expect(opt.problem.layers.map((l) => l.n)).toEqual([3]);
        expect(opt.problem.addLeftOut).toBe(true);
    });

    test('a target needing a line count that was left out is refused as too large', () => {
        // Its own reason: the talisman's own line count fits, only the lines to add do not
        expect(build(SIX, 4, 2, addLine)).toMatchObject({ status: 'impossible', reason: 'addsTooMany', need: 4 });
    });
});

describe('a pending roll judged on one basis', () => {
    test('one side only reachable through unpriced adds: the side that reaches the target without them wins', () => {
        const solution = solutionFor(POOL3, 3, 1, { coreWeights: {} });
        const pending = talismanRow(1, [line('ability_haste', 2)], { pendingModifiers: [line('armor', 1)] });
        const current = solution.indexOf(-1, [solution.codeOf(0, 2)]);
        const next = solution.indexOf(-1, [solution.codeOf(1, 1)]);
        // Keeping needs unpriced adds (cores left out: cheap-looking); taking reaches it at a finite, all-in cost
        const V = Float64Array.from(solution.V);
        const U = Float64Array.from(solution.U);
        V[current] = Infinity;
        U[current] = 1;
        V[next] = 1000;
        U[next] = 1000;
        const advice = advise({ ...solution, V, U }, pending, POOL3, 3);
        expect(advice.status).toBe('accept');
        expect(advice.value).toBe(1000);
        // And the other way round
        const V2 = Float64Array.from(V);
        const U2 = Float64Array.from(U);
        V2[current] = 1000;
        U2[current] = 1000;
        V2[next] = Infinity;
        U2[next] = 1;
        expect(advise({ ...solution, V: V2, U: U2 }, pending, POOL3, 3).status).toBe('discard');
    });
});
