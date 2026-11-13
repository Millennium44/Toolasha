import { describe, test, expect } from 'vitest';
import { FULL_MODIFIER_DETAILS } from '../__fixtures__/talisman-full-modifiers.js';
import { TALISMAN_INFO, ORB_ITEMS } from '../__fixtures__/talisman-reroll.js';
import { OrbCostSolver } from './talisman-orb-costs.js';
import { buildProblem, solveSteps } from './talisman-reroll-solver.js';
import { isSpecialLine, planBudgetSet, scaleAcrossGrades } from './talisman-line-sets.js';

const COMBAT = '/talisman_types/combat';
const H = (key) => `/talisman_modifiers/${key}`;
const weights = {};
for (const hrid of [...Object.keys(TALISMAN_INFO.rerollInputMap), TALISMAN_INFO.lockInputItemHrid]) {
    weights[hrid] = ORB_ITEMS[hrid].sellPrice;
}

function row(key, valueAtG6) {
    const detail = FULL_MODIFIER_DETAILS[H(key)];
    return {
        hrid: H(key),
        name: detail.name,
        detail,
        special: isSpecialLine(detail),
        value: valueAtG6,
        byGrade: scaleAcrossGrades(valueAtG6, detail, 6),
        significant: true,
    };
}

function solver(extra = {}) {
    return new OrbCostSolver({
        info: TALISMAN_INFO,
        modifierDetailMap: FULL_MODIFIER_DETAILS,
        scale: { weights, prices: {}, scale: 'itemValue' },
        yieldNow: async () => {},
        ...extra,
    });
}

describe('the orb solve gives the page a turn often', () => {
    test('a solve yields every 128 states or few thousand edges, not once per thousands', () => {
        const built = buildProblem({
            talismanTypeHrid: COMBAT,
            lineCount: 4,
            targets: [{ hrid: H('armor'), minGrade: 2 }],
            info: TALISMAN_INFO,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
            weights,
        });
        const run = solveSteps(built.problem);
        let yields = 0;
        let step = run.next();
        while (!step.done) {
            yields++;
            step = run.next();
        }
        // 10 before the loops were cut finer (2048-state strides, 200 000 edges); the costs it returns are unchanged
        expect(yields).toBeGreaterThan(100);
    });

    test('Stop while a solve is running ends it: no cost, and the budget plan says cancelled', async () => {
        let yields = 0;
        let stop = false;
        const s = solver({
            abortSignal: () => stop,
            yieldNow: async () => {
                yields++;
                stop = true;
            },
            now: (() => {
                // Every reading is 50 ms later, so each step ends a slice
                let t = 0;
                return () => (t += 50);
            })(),
        });
        const plan = await planBudgetSet([row('critical_damage', 30), row('critical_rate', 20)], {
            slots: 2,
            capGrade: 2,
            budget: 100,
            typeHrid: COMBAT,
            orbs: s,
        });
        expect(yields).toBe(1);
        expect(s.stopped()).toBe(true);
        expect(plan).toMatchObject({ set: null, reason: 'cancelled' });
    });

    test('a solve awaits the event loop between slices (the default yield is a timer)', async () => {
        let ticks = 0;
        const timer = setInterval(() => ticks++, 0);
        const s = new OrbCostSolver({
            info: TALISMAN_INFO,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
            scale: { weights, prices: {}, scale: 'itemValue' },
        });
        await s.freshCost(COMBAT, [{ hrid: H('armor'), minGrade: 1 }]);
        clearInterval(timer);
        expect(ticks).toBeGreaterThan(0);
    });
});

describe('Budget sets with the real solver', () => {
    test('the set and its orb costs are pinned (figures from before the yields were added)', async () => {
        const rows = [row('critical_damage', 30), row('critical_rate', 20), row('smite', 60), row('armor', 10)];
        const s = solver();
        const plan = await planBudgetSet(rows, {
            slots: 2,
            capGrade: 1,
            budget: 3,
            typeHrid: COMBAT,
            orbs: s,
        });
        expect({
            cheapest: plan.cheapest,
            overUpperBound: plan.overUpperBound,
            solves: s.solves,
            talismans: plan.set.talismans.map((t) => [t.modifiers, t.value, t.cost.orbs]),
            predicted: plan.set.predicted,
        }).toMatchInlineSnapshot(`
          {
            "cheapest": 0.330409092933863,
            "overUpperBound": 0,
            "predicted": 25,
            "solves": 4,
            "talismans": [
              [
                [
                  {
                    "grade": 1,
                    "hrid": "/talisman_modifiers/critical_damage",
                  },
                  {
                    "grade": 1,
                    "hrid": "/talisman_modifiers/critical_rate",
                  },
                ],
                12.5,
                2.2170021786381047,
              ],
              [
                [
                  {
                    "grade": 1,
                    "hrid": "/talisman_modifiers/critical_damage",
                  },
                  {
                    "grade": 1,
                    "hrid": "/talisman_modifiers/critical_rate",
                  },
                ],
                12.5,
                2.2170021786381047,
              ],
            ],
          }
        `);
    });
});
