import { describe, test, expect } from 'vitest';
import { ANY_K_MAX_POOL, planAnyKTarget } from './talisman-line-sets.js';
import { MAX_WANTED_LINES } from './talisman-reroll-solver.js';

// "Aim for any K": the pool, the required lines and K from a ranking's gains and noise

const H = (key) => `/talisman_modifiers/${key}`;
const G = 6;

/** A ranking row at the simulated grade (G6): its gain, and the ± the table shows beside it */
function row(key, gain, noise = 0.86, extra = {}) {
    return {
        hrid: H(key),
        value: gain,
        valuePct: gain,
        errPct: noise,
        byGrade: [0, 0, 0, 0, 0, gain],
        significant: true,
        ...extra,
    };
}

const names = (plan) => plan.targets.map((t) => t.hrid.split('/').pop());
const requiredNames = (plan) => plan.targets.filter((t) => t.required).map((t) => t.hrid.split('/').pop());

describe('planAnyKTarget', () => {
    test('the live melee ranking: OK + Consistency + any 2 of Auto Attack Damage / Attack Speed / Physical Amplify', () => {
        const rows = [
            row('overkill', 71.0),
            row('consistency', 26.3),
            row('auto_attack_damage', 13.5),
            row('attack_speed', 13.5),
            row('physical_amplify', 11.9),
            row('ability_haste', 11.7),
            row('armor', 0, 0, { noEffect: true }),
        ];
        const plan = planAnyKTarget(rows, { grade: G, k: 4 });
        expect(plan.need).toBe(4);
        // Auto Attack Damage and Attack Speed tie at 13.5: their order is by name
        expect(names(plan).slice(0, 2)).toEqual(['overkill', 'consistency']);
        expect(names(plan).slice(2).sort()).toEqual(['attack_speed', 'auto_attack_damage', 'physical_amplify']);
        expect(requiredNames(plan)).toEqual(['overkill', 'consistency']);
        expect(plan.targets.every((t) => t.minGrade === G)).toBe(true);
        expect(plan.leftOut).toBe(0);
        expect(plan.poolSize).toBe(5);
    });

    test('no line overlaps the K-th line: the pool is the K lines, all required (what Aim for this sends)', () => {
        const rows = [row('a', 50), row('b', 40), row('c', 30), row('d', 20), row('e', 5)];
        const plan = planAnyKTarget(rows, { grade: G, k: 4 });
        expect(names(plan)).toEqual(['a', 'b', 'c', 'd']);
        expect(requiredNames(plan)).toEqual(['a', 'b', 'c', 'd']);
        expect(plan.need).toBe(4);
    });

    test('everything overlaps: nothing is required, any K of the pool', () => {
        const rows = [row('a', 10), row('b', 9.9), row('c', 9.8), row('d', 9.7), row('e', 9.6)];
        const plan = planAnyKTarget(rows, { grade: G, k: 2 });
        expect(requiredNames(plan)).toEqual([]);
        expect(plan.need).toBe(2);
        expect(plan.poolSize).toBe(5);
    });

    test('a line with no noise figure is exact: only a tie reaches the K-th line', () => {
        const rows = [
            { hrid: H('a'), value: 10, byGrade: [0, 0, 0, 0, 0, 10] },
            { hrid: H('b'), value: 9, byGrade: [0, 0, 0, 0, 0, 9] },
        ];
        const plan = planAnyKTarget(rows, { grade: G, k: 1 });
        expect(names(plan)).toEqual(['a']);
        expect(requiredNames(plan)).toEqual(['a']);
    });

    test("noise scales with the gain at another grade; the gain is that grade's", () => {
        const rows = [
            { ...row('a', 20, 2), byGrade: [1, 2, 4, 8, 12, 20] },
            { ...row('b', 18, 2), byGrade: [0.9, 1.8, 3.6, 7.2, 10.8, 18] },
            { ...row('c', 5, 0.5), byGrade: [0.25, 0.5, 1, 2, 3, 5] },
        ];
        // At G3 a = 4 ± 0.4, b = 3.6 ± 0.4, c = 1 ± 0.1: a and b overlap for K = 1, c does not
        const plan = planAnyKTarget(rows, { grade: 3, k: 1 });
        expect(names(plan)).toEqual(['a', 'b']);
        expect(plan.targets.every((t) => t.minGrade === 3)).toBe(true);
        expect(plan.need).toBe(1);
        expect(requiredNames(plan)).toEqual([]);
    });

    test('K larger than the lines with a gain is clamped, all of them required', () => {
        const plan = planAnyKTarget([row('a', 5), row('b', 4, 0.1)], { grade: G, k: 4 });
        expect(plan.need).toBe(2);
        expect(requiredNames(plan)).toEqual(['a', 'b']);
    });

    test('lines with no gain, no effect or a gain resting on a free input are out; none left is null', () => {
        expect(
            planAnyKTarget([row('a', 0), row('b', 3, 1, { noEffect: true }), row('c', 3, 1, { gainUnreal: true })], {
                grade: G,
                k: 2,
            })
        ).toBeNull();
        expect(planAnyKTarget([], { grade: G, k: 2 })).toBeNull();
        expect(planAnyKTarget(undefined, { grade: G, k: 2 })).toBeNull();
    });

    test('only the best Special is a candidate (a talisman holds one)', () => {
        const rows = [
            row('s1', 30, 0.5, { special: true }),
            row('s2', 29.9, 0.5, { special: true }),
            row('a', 20, 0.5),
            row('b', 10, 0.5),
        ];
        const plan = planAnyKTarget(rows, { grade: G, k: 2 });
        expect(names(plan)).toEqual(['s1', 'a']);
        expect(requiredNames(plan)).toEqual(['s1', 'a']);
    });

    test('a pool over the limit drops the weakest optional lines, never a required one, and counts them', () => {
        const rows = [row('top', 100, 1)];
        for (let i = 0; i < 9; i++) rows.push(row(`m${i}`, 20 - i * 0.1, 1));
        const plan = planAnyKTarget(rows, { grade: G, k: 4 });
        expect(plan.poolSize).toBe(ANY_K_MAX_POOL);
        expect(plan.leftOut).toBe(10 - ANY_K_MAX_POOL);
        expect(requiredNames(plan)).toEqual(['top']);
        expect(names(plan)).toEqual(['top', 'm0', 'm1', 'm2', 'm3', 'm4']);
        expect(plan.targets.length - plan.leftOut).toBeLessThanOrEqual(ANY_K_MAX_POOL);
        // A smaller limit than the pool, still keeping every required line
        const small = planAnyKTarget(rows, { grade: G, k: 4, maxPool: 4 });
        expect(small.poolSize).toBe(4);
        expect(requiredNames(small)).toEqual(['top']);
    });

    test('K = 1 and a single line with a gain: that line, required, K 1', () => {
        const plan = planAnyKTarget([row('a', 5)], { grade: G, k: 1 });
        expect(plan).toMatchObject({ need: 1, poolSize: 1 });
        expect(requiredNames(plan)).toEqual(['a']);
    });

    test('the pool limit matches the solver limit', () => {
        expect(ANY_K_MAX_POOL).toBe(MAX_WANTED_LINES);
    });
});
