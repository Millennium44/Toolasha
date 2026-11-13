import { describe, test, expect } from 'vitest';
import { TALISMAN_INFO, REROLL_MODIFIERS, ORB_ITEMS, talismanRow } from '../__fixtures__/talisman-reroll.js';
import { OrbCostSolver, freshCores, freshTalismanCost, referenceOrb, solveShape } from './talisman-orb-costs.js';
import { encodeLines } from './talisman-reroll-solver.js';

const COMBAT = '/talisman_types/combat';
const H = (key) => `/talisman_modifiers/${key}`;
const line = (key, grade) => ({ hrid: H(key), grade });
const weights = {};
for (const hrid of [...Object.keys(TALISMAN_INFO.rerollInputMap), TALISMAN_INFO.lockInputItemHrid]) {
    weights[hrid] = ORB_ITEMS[hrid].sellPrice;
}
const solver = (extra = {}) =>
    new OrbCostSolver({
        info: TALISMAN_INFO,
        modifierDetailMap: REROLL_MODIFIERS,
        scale: { weights, prices: {}, scale: 'itemValue' },
        yieldNow: async () => {},
        ...extra,
    });

describe('orb costs', () => {
    test('counted in Reforging Orbs', () => {
        expect(referenceOrb(TALISMAN_INFO, weights)).toEqual({ hrid: '/items/reforging_orb', weight: 300000 });
    });

    test('a fresh talisman takes 6 Basic, 1 Advanced and 1 Expert core (create, then lines 2, 3 and 4)', () => {
        expect(freshCores(TALISMAN_INFO, 4)).toEqual({
            '/items/basic_talisman_core': 6,
            '/items/advanced_talisman_core': 1,
            '/items/expert_talisman_core': 1,
        });
    });

    test('lines of the same draw weight and grade share one solve, renamed to the asked hrids', async () => {
        const s = solver();
        const a = await s.freshCost(COMBAT, [{ hrid: H('critical_damage'), minGrade: 3 }]);
        const b = await s.freshCost(COMBAT, [{ hrid: H('armor'), minGrade: 3 }]);
        expect(s.solves).toBe(1);
        expect(b.orbs).toBeCloseTo(a.orbs, 9);
        expect(a.fresh).toBe(true);
        // A Special line (weight 0.1) is a different shape, and dearer
        const smite = await s.freshCost(COMBAT, [{ hrid: H('smite'), minGrade: 3 }]);
        expect(s.solves).toBe(2);
        expect(smite.orbs).toBeGreaterThan(a.orbs);
        expect(solveShape(4, [{ hrid: H('armor'), minGrade: 3 }], REROLL_MODIFIERS).key).toBe(
            solveShape(4, [{ hrid: H('critical_damage'), minGrade: 3 }], REROLL_MODIFIERS).key
        );
    });

    test('the fresh start covers every first draw (probabilities add to 1), cheaper than rerolling an all-junk talisman', async () => {
        const s = solver();
        const solution = await s.solutionFor(COMBAT, 4, [{ hrid: H('critical_damage'), minGrade: 3 }]);
        const fresh = freshTalismanCost(solution);
        expect(fresh.mass).toBeCloseTo(1, 9);
        const junk = await s.ownedCost(
            talismanRow(1, [
                { hrid: H('armor'), grade: 1 },
                { hrid: H('tenacity'), grade: 1 },
                { hrid: H('max_hitpoints'), grade: 1 },
                { hrid: H('hp_regen'), grade: 1 },
            ]),
            [{ hrid: H('critical_damage'), minGrade: 3 }]
        );
        expect(fresh.value / 300000).toBeLessThan(junk.orbs);
    });

    test('an owned talisman that meets the target costs nothing more', async () => {
        const s = solver();
        const cost = await s.ownedCost(talismanRow(1, [{ hrid: H('armor'), grade: 4 }]), [
            { hrid: H('armor'), minGrade: 3 },
        ]);
        expect(cost).toMatchObject({ status: 'met', orbs: 0 });
    });

    test('Stop before a solve: nothing, and the solver says it was cancelled', async () => {
        let stop = false;
        const s = solver({ abortSignal: () => stop });
        stop = true;
        expect(await s.freshCost(COMBAT, [{ hrid: H('armor'), minGrade: 3 }])).toBeNull();
        expect(s.stopped()).toBe(true);
    });

    test('over the solve limit: nothing, and the solver says it was limited', async () => {
        const s = solver({ maxSolves: 1 });
        await s.freshCost(COMBAT, [{ hrid: H('armor'), minGrade: 3 }]);
        expect(await s.freshCost(COMBAT, [{ hrid: H('smite'), minGrade: 3 }])).toBeNull();
        expect(s.limited).toBe(true);
    });
});

describe('a fresh talisman starts at G1-G3 (measured 2026-11-13)', () => {
    test('the measured table: 396 lines, capped at G3', async () => {
        const { MEASURED_ODDS } = await import('./talisman-reroll-solver.js');
        expect(MEASURED_ODDS.freshLineGrades).toMatchObject({ cap: 3, lines: 396, talismans: 99 });
        expect(MEASURED_ODDS.freshLineGrades.odds).toEqual([0.571, 0.275, 0.154]);
    });

    test('a G4 target is never met by the first lines; a G3 one sometimes is', async () => {
        const s = solver();
        const g4 = freshTalismanCost(await s.solutionFor(COMBAT, 4, [{ hrid: H('armor'), minGrade: 4 }]));
        const g3 = freshTalismanCost(await s.solutionFor(COMBAT, 4, [{ hrid: H('armor'), minGrade: 3 }]));
        expect(g4.metAtStart).toBe(0);
        expect(g3.metAtStart).toBeGreaterThan(0);
        expect(g4.mass).toBeCloseTo(1, 9);
    });
});

describe('freshTalismanCost against a hand enumeration', () => {
    // A pool of equal-weight lines only, so the solver's junk lumping is exact and the enumeration below is the truth
    const POOL = Object.fromEntries(
        Object.entries(REROLL_MODIFIERS).filter(
            ([, d]) =>
                d.talismanTypeHrid === COMBAT &&
                Number(d.weight) === 1 &&
                d.groupHrid !== '/talisman_modifier_groups/special'
        )
    );
    const types = Object.keys(POOL);
    // The measured Reforging curve cut at G3 and renormalized, worked out by hand (the measured fresh lines match it)
    const cut = [0.51, 0.239, 0.141];
    const grades = cut.map((p) => p / (0.51 + 0.239 + 0.141));

    /** Every first-line draw of an n-line talisman, by explicit type and grade, with its probability */
    function draws(n) {
        const out = [];
        const rec = (picked, p) => {
            if (picked.length === n) {
                out.push({ lines: picked, p });
                return;
            }
            const left = types.filter((t) => !picked.some((l) => l.hrid === t));
            for (const hrid of left) {
                grades.forEach((q, g) => rec([...picked, { hrid, grade: g + 1 }], (p * q) / left.length));
            }
        };
        rec([], 1);
        return out;
    }

    async function check(n, targets) {
        const s = new OrbCostSolver({
            info: TALISMAN_INFO,
            modifierDetailMap: POOL,
            scale: { weights, prices: {}, scale: 'itemValue' },
            yieldNow: async () => {},
        });
        const solution = await s.solutionFor(COMBAT, n, targets);
        let expected = 0;
        let mass = 0;
        for (const { lines, p } of draws(n)) {
            const { index } = encodeLines(solution, lines, '');
            expected += p * solution.V[index];
            mass += p;
        }
        const fresh = freshTalismanCost(solution);
        expect(mass).toBeCloseTo(1, 9);
        expect(fresh.value).toBeCloseTo(expected, 6);
    }

    test('one line, one wanted at G2', async () => {
        await check(1, [{ hrid: H('armor'), minGrade: 2 }]);
    });

    test('two lines, two wanted at G1 and G3', async () => {
        await check(2, [
            { hrid: H('armor'), minGrade: 1 },
            { hrid: H('critical_damage'), minGrade: 3 },
        ]);
    });
});

describe('every cost carries the solver limits', () => {
    test('a four-line G3 target clamps grades and leaves Mutation out: both said, as an upper bound', async () => {
        const s = solver();
        const targets = ['armor', 'critical_damage', 'critical_rate', 'tenacity'].map((k) => ({
            hrid: H(k),
            minGrade: 3,
        }));
        const fresh = await s.freshCost(COMBAT, targets);
        expect(fresh.limits.gradeClamped).toBe(true);
        expect(fresh.limits.clampGrade).toBeLessThan(6);
        expect(fresh.limits.mutationLeftOut).toBe(true);
        expect(fresh.upperBound).toBe(true);
        const owned = await s.ownedCost(
            talismanRow(1, [line('armor', 1), line('tenacity', 1), line('max_hitpoints', 1), line('hp_regen', 1)]),
            targets
        );
        expect(owned.limits.gradeClamped).toBe(true);
        expect(owned.upperBound).toBe(true);
    });

    test('a one-line target is solved exactly: no limits', async () => {
        const fresh = await solver().freshCost(COMBAT, [{ hrid: H('armor'), minGrade: 3 }]);
        expect(fresh.limits).toEqual({ gradeClamped: false, clampGrade: 6, mutationLeftOut: false });
        expect(fresh.upperBound).toBe(false);
    });
});
