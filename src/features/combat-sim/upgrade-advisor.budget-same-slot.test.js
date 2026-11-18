/**
 * Budget plan: mutually exclusive options for one ability (Life Drain 100→105 vs 110) must be chosen for the
 * best total within the budget, not by whichever has the better gain per coin first.
 * Live case (2026-11-18): Life Drain 105 (881.2M, -1.2) locked out Life Drain 110 (2.1B, -2.4), though
 * 110 + Entangle (8.3B, -3.4) fit a 10B budget and beat 105 + Entangle (7.1B, -2.2).
 */

import { describe, test, expect } from 'vitest';
import { planWithinBudget, candidateKey } from './upgrade-advisor.js';

const LIFE_DRAIN = '/abilities/life_drain';
const ability = (name, slot, hrid, level, cost, saved, over = {}) => ({
    candidate: {
        type: 'ability_level',
        slot,
        upgradeHrid: hrid,
        upgradeLevel: level,
        description: `${name} to ${level}`,
    },
    cost,
    attemptsDelta: -saved,
    significant: true,
    ...over,
});
const M = 1e6;
const B = 1e9;
const ld105 = (over) => ability('Life Drain', 'ability_1', LIFE_DRAIN, 105, 881.2 * M, 1.2, over);
const ld110 = (over) => ability('Life Drain', 'ability_1', LIFE_DRAIN, 110, 2.1 * B, 2.4, over);
const entangle = (over) => ability('Entangle', 'ability_2', '/abilities/entangle', 105, 6.2 * B, 1.0, over);
const names = (plan) => plan.picks.map((p) => p.candidate.description).sort();

describe('same-slot options in a budget plan', () => {
    test('the higher level wins when it and the rest still fit the budget', () => {
        const plan = planWithinBudget([ld105(), ld110(), entangle()], 10 * B);

        expect(names(plan)).toEqual(['Entangle to 105', 'Life Drain to 110']);
        expect(plan.totalCost).toBeCloseTo(8.3 * B, -5);
        expect(plan.attemptsSaved).toBeCloseTo(3.4, 6);
        expect(plan.skipped.some((s) => s.result.candidate.upgradeLevel === 105)).toBe(true);
    });

    test('order of the rows does not matter', () => {
        const plan = planWithinBudget([entangle(), ld110(), ld105()], 10 * B);

        expect(names(plan)).toEqual(['Entangle to 105', 'Life Drain to 110']);
    });

    test('the dearer level alone beats the cheaper pair when only that fits', () => {
        // At 7.5B, 105 + Entangle (7.1B) saves 2.2 but 110 alone (2.1B) saves 2.4
        const plan = planWithinBudget([ld105(), ld110(), entangle()], 7.5 * B);

        expect(names(plan)).toEqual(['Life Drain to 110']);
        expect(plan.attemptsSaved).toBeCloseTo(2.4, 6);
        expect(plan.totalCost).toBeLessThanOrEqual(7.5 * B);
    });

    test('the upgrade is not taken when it adds nothing over the cheaper option', () => {
        const plan = planWithinBudget([ld105(), ld110({ attemptsDelta: -1.2 }), entangle()], 10 * B);

        expect(names(plan)).toEqual(['Entangle to 105', 'Life Drain to 105']);
    });

    test('a within-noise row is still skipped, and an unpriced one never planned', () => {
        const plan = planWithinBudget(
            [ld105(), ld110({ significant: false }), ld110({ cost: null }), entangle()],
            10 * B
        );

        expect(names(plan)).toEqual(['Entangle to 105', 'Life Drain to 105']);
        expect(plan.skipped.some((s) => s.reason.includes('noise'))).toBe(true);
    });

    test('an empty budget buys nothing', () => {
        const plan = planWithinBudget([ld105(), ld110(), entangle()], 0);

        expect(plan.picks).toHaveLength(0);
        expect(plan.totalCost).toBe(0);
    });

    test('a pinned option is never swapped out', () => {
        const plan = planWithinBudget([ld105(), ld110(), entangle()], 10 * B, { required: [candidateKey(ld105())] });

        expect(names(plan)).toEqual(['Entangle to 105', 'Life Drain to 105']);
    });
});
