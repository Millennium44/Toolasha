/**
 * The leveling-route optimizer, against fixtures whose answers can be worked out by hand.
 *
 * Rates are in the shape `measureXpRates` returns (see goal-planner-context.js), with the
 * level they were measured at; the level table is the game's shape (cumulative experience,
 * indexed by level), linear here so one level is always 1,000 experience.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import {
    prepareRouteInput,
    routeCacheKey,
    runRouteSearch,
    costRoute,
    exhaustiveBest,
    searchBest,
} from './leveling-route.js';
import { planGoal } from './goal-planner.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

const TABLE = Array.from({ length: 201 }, (_, level) => level * 1000);
const SKILL = '/skills/cooking';

/**
 * A rate as `measureXpRates` builds it; experience and completions per hour follow from the overrides.
 * @param {string} name - Label (and action hrid suffix)
 * @param {Object} [over] - Fields to set
 * @returns {Object} A rate
 */
function rate(name, over = {}) {
    const actionTime = over.actionTime ?? 10;
    const totalEfficiency = over.totalEfficiency ?? 0;
    const xpPerAction = over.xpPerAction ?? 100;
    const actionsPerHour = (3600 / actionTime) * (1 + totalEfficiency / 100);
    return {
        actionHrid: `/actions/cooking/${name.toLowerCase().replace(/ /g, '_')}`,
        label: name,
        requiredLevel: 1,
        teaSkillLevelBonus: 0,
        actionLevelBonus: 0,
        xpPerAction,
        actionTime,
        totalEfficiency,
        actionsPerHour,
        xpPerHour: actionsPerHour * xpPerAction,
        goldPerHour: 0,
        drinkCostPerHour: 0,
        upfrontCost: 0,
        goldKnown: true,
        ...over,
    };
}

/**
 * @param {Object} spec - `{rates, level, experience, target, gold, heldOf}`
 * @returns {Object} Route input
 */
function input({ rates, level = 1, experience, target = 10, gold = 1e12, heldOf }) {
    return prepareRouteInput({
        skillHrid: SKILL,
        targetLevel: target,
        level,
        experience: experience ?? TABLE[level],
        rates,
        table: TABLE,
        gold,
        measuredAtLevel: level,
        heldOf,
    });
}

const run = (spec, options) => runRouteSearch(input(spec), options);
const labels = (route) => route.stages.map((stage) => `${stage.label} ${stage.fromLevel}-${stage.toLevel}`);

describe('switching at an unlock', () => {
    const A = rate('Stew');
    const B = rate('Roast', { requiredLevel: 5, xpPerAction: 200 });

    test('trains A, switches to B no earlier than its unlock, and beats the fixed action', async () => {
        const result = await run({ rates: [A, B] });
        expect(result.status).toBe('route');
        const fastest = result.routes.fastest;
        expect(labels(fastest)).toEqual(['Stew 1-5', 'Roast 5-10']);
        expect(fastest.stages[1].why).toContain('unlocks at 5');
        expect(fastest.totals.timeHours).toBeLessThan(result.baseline.totals.timeHours);
        expect(labels(result.baseline)).toEqual(['Stew 1-10']);
    });

    test('a skill-level tea opens B earlier; an Action Level tea later', async () => {
        const early = await run({ rates: [A, { ...B, teaSkillLevelBonus: 2 }] });
        expect(labels(early.routes.fastest)).toEqual(['Stew 1-3', 'Roast 3-10']);
        // 5 + trunc(2.5) = 7 to start, whatever the fraction
        const late = await run({ rates: [A, { ...B, actionLevelBonus: 2.5 }] });
        expect(labels(late.routes.fastest)).toEqual(['Stew 1-7', 'Roast 7-10']);
    });

    test('partial experience shortens the first stage', async () => {
        const fresh = await run({ rates: [A], target: 2 });
        const partway = await run({ rates: [A], target: 2, experience: 1500 });
        expect(fresh.routes.fastest.stages[0].actions).toBe(10);
        expect(partway.routes.fastest.stages[0].actions).toBe(5);
    });

    test('experience already past a level boundary starts from the level it has reached', async () => {
        const result = await run({ rates: [A, B], level: 4, experience: 5200 });
        expect(result.fromLevel).toBe(5);
        expect(labels(result.routes.fastest)).toEqual(['Roast 5-10']);
    });
});

describe('every way it can end', () => {
    test('target already reached', async () => {
        const result = await run({ rates: [rate('Stew')], level: 10, target: 10 });
        expect(result.status).toBe('reached');
        expect(result.routes.fastest).toBeNull();
    });

    test('no action can be started yet', async () => {
        const result = await run({ rates: [rate('Roast', { requiredLevel: 20 })] });
        expect(result.status).toBe('no-action');
        expect(result.message).toContain('level 1');
    });

    test('no actions at all', async () => {
        const result = await run({ rates: [] });
        expect(result.status).toBe('no-action');
    });

    test('a rate with no experience is left out and said so', async () => {
        const result = await run({ rates: [rate('Nothing', { xpPerAction: 0 })] });
        expect(result.status).toBe('no-action');
        expect(result.excluded).toEqual([{ label: 'Nothing', reason: 'gives no experience per hour' }]);
    });

    test('no experience table', async () => {
        const result = await runRouteSearch(
            prepareRouteInput({ skillHrid: SKILL, targetLevel: 10, level: 1, experience: 0, rates: [rate('Stew')] })
        );
        expect(result.status).toBe('no-table');
    });

    test('stopped between slices', async () => {
        let clock = 0;
        const progress = [];
        const result = await run(
            { rates: [rate('Stew'), rate('Roast', { requiredLevel: 5, xpPerAction: 200 })], target: 60 },
            {
                now: () => (clock += 5),
                sliceMs: 1,
                yieldToBrowser: async () => {},
                onProgress: (step) => progress.push(step),
                shouldStop: () => progress.length >= 2,
            }
        );
        expect(result.status).toBe('stopped');
        expect(progress.length).toBe(2);
        expect(progress[1].done).toBeLessThan(progress[1].total);
    });

    test('unknown prices: Fastest may use them, Cheapest and Within budget may not', async () => {
        const A = rate('Stew', { goldPerHour: -1000 });
        const B = rate('Roast', { requiredLevel: 5, xpPerAction: 200, goldPerHour: null, goldKnown: false });
        const result = await run({ rates: [A, B] });
        expect(labels(result.routes.fastest)).toEqual(['Stew 1-5', 'Roast 5-10']);
        expect(result.routes.fastest.totals.costKnown).toBe(false);
        expect(labels(result.routes.cheapest)).toEqual(['Stew 1-10']);
        expect(result.routes.cheapest.totals.costKnown).toBe(true);
        expect(result.routes.budget.totals.budgetSafe).toBe(true);
    });

    test('every route unpriced: no Cheapest, no Within budget, and why', async () => {
        const result = await run({ rates: [rate('Stew', { goldPerHour: null, goldKnown: false })] });
        expect(result.routes.fastest).not.toBeNull();
        expect(result.routes.cheapest).toBeNull();
        expect(result.routes.budget).toBeNull();
        expect(result.unavailable.cheapest).toContain('fully priced');
    });

    test('nothing fits the budget', async () => {
        const result = await run({ rates: [rate('Stew', { goldPerHour: -36_000 })], gold: 10 });
        expect(result.routes.budget).toBeNull();
        expect(result.unavailable.budget).toContain('coins above zero');
        expect(result.routes.fastest.totals.lowestCash).toBeLessThan(0);
    });
});

describe('three objectives', () => {
    // Fast and dear, slow and free; 9 levels at 1,000 XP each
    const fast = rate('Fast', { xpPerAction: 200, goldPerHour: -72_000 }); // 1,000 coins per level
    const slow = rate('Slow', { xpPerAction: 100, goldPerHour: 0 });

    test('diverge: fastest is dear, cheapest is slow, within budget mixes them', async () => {
        const result = await run({ rates: [fast, slow], gold: 4000 });
        const { fastest, cheapest, budget } = result.routes;
        expect(labels(fastest)).toEqual(['Fast 1-10']);
        expect(labels(cheapest)).toEqual(['Slow 1-10']);
        expect(fastest.totals.lowestCash).toBeLessThan(0);
        expect(budget.totals.budgetSafe).toBe(true);
        expect(budget.totals.goldDelta).toBeCloseTo(-4000, 6);
        expect(budget.totals.timeHours).toBeLessThan(cheapest.totals.timeHours);
        expect(budget.totals.timeHours).toBeGreaterThan(fastest.totals.timeHours);
    });

    test('an early shortfall is rejected even when the route ends in profit', async () => {
        // Losing 1,000 a level to 5, then a craft that pays 10,000 a level: +31,000 overall
        const loss = rate('Loss', { goldPerHour: -36_000 });
        const free = rate('Free', { xpPerAction: 50, goldPerHour: 0 });
        const pays = rate('Pays', { requiredLevel: 5, xpPerAction: 200, goldPerHour: 720_000 });
        const result = await run({ rates: [loss, free, pays], gold: 1000 });
        const { fastest, budget } = result.routes;
        expect(labels(fastest)).toEqual(['Loss 1-5', 'Pays 5-10']);
        expect(fastest.totals.goldDelta).toBeGreaterThan(0);
        expect(fastest.totals.lowestCash).toBeLessThan(0);
        expect(budget.totals.budgetSafe).toBe(true);
        expect(budget.stages.at(-1).label).toBe('Pays');
        // One level of Loss is all 1,000 coins pay for
        expect(budget.stages.filter((stage) => stage.label === 'Loss').length).toBeLessThanOrEqual(1);
    });

    test('a profitable action that needs inputs bought first cannot start with no coins', async () => {
        const craft = rate('Craft', { xpPerAction: 200, goldPerHour: 72_000, upfrontCost: 500 });
        const gather = rate('Gather', { xpPerAction: 100 });
        const result = await run({ rates: [craft, gather], gold: 0 });
        expect(labels(result.routes.fastest)).toEqual(['Craft 1-10']);
        expect(labels(result.routes.budget)).toEqual(['Gather 1-10']);
        const funded = await run({ rates: [craft, gather], gold: 500 });
        expect(labels(funded.routes.budget)).toEqual(['Craft 1-10']);
    });
});

describe('totals reconcile with the stages', () => {
    test('time, completions, materials, drinks, proceeds and cash', async () => {
        const A = rate('Stew', {
            goldPerHour: -20_000,
            drinkCostPerHour: 1_500,
            upfrontCost: 100,
            totalEfficiency: 20,
        });
        const B = rate('Roast', {
            requiredLevel: 6,
            xpPerAction: 250,
            goldPerHour: 50_000,
            drinkCostPerHour: 1_500,
            upfrontCost: 300,
            saleProceedsPerHour: 200_000,
            saleCapPerHour: 150_000,
        });
        const result = await run({ rates: [A, B], gold: 1e7, target: 30 });
        const route = result.routes.fastest;
        expect(route.stages.length).toBe(2);
        const sum = (field) => route.stages.reduce((total, stage) => total + stage[field], 0);
        for (const field of ['timeHours', 'actions', 'goldDelta', 'materialCost', 'drinkCost', 'proceeds']) {
            expect(route.totals[field]).toBeCloseTo(sum(field), 6);
        }
        for (const stage of route.stages) {
            expect(stage.materialCost).toBeCloseTo(stage.upfront * stage.actions, 6);
            expect(stage.drinkCost).toBeCloseTo(1_500 * stage.timeHours, 6);
            expect(stage.proceeds - stage.materialCost - stage.drinkCost).toBeCloseTo(stage.goldDelta, 6);
        }
        expect(route.stages[1].unsoldProceeds).toBeGreaterThan(0);
        expect(route.stages[0].cashEnd).toBeCloseTo(route.stages[1].cashStart, 6);
        expect(route.stages[1].cashEnd).toBeCloseTo(1e7 + route.totals.goldDelta, 6);
        expect(route.totals.lowestCash).toBeCloseTo(Math.min(1e7, ...route.stages.map((s) => s.cashLow)), 6);
    });

    test('a one-stage route is the quick estimate, to the coin and the second', async () => {
        const stew = rate('Stew', {
            goldPerHour: -54_000,
            totalEfficiency: 50,
            drinkCostPerHour: 2_000,
            saleProceedsPerHour: 10_000,
            saleCapPerHour: 6_000,
        });
        const result = await run({ rates: [stew], target: 40 });
        const plan = planGoal(
            { type: 'skill', skillHrid: SKILL, targetLevel: 40 },
            {
                gold: 1e12,
                levelExperienceTable: TABLE,
                skill: () => ({ level: 1, experience: 1000 }),
                xpRates: () => [stew],
                owned: () => 0,
                goldRates: () => [],
            }
        );
        const train = plan.steps.find((entry) => entry.id === 'train');
        expect(result.baseline.totals.timeHours).toBe(train.timeHours);
        expect(result.baseline.totals.goldDelta).toBe(train.goldDelta);
        expect(result.baseline.totals.actions).toBe(train.details.actionsNeeded);
        expect(result.routes.fastest.totals.timeHours).toBe(train.timeHours);
    });

    test('a profitable route is a positive net, and its cash only rises', async () => {
        const result = await run({ rates: [rate('Sell', { goldPerHour: 36_000 })], gold: 0 });
        const route = result.routes.budget;
        expect(route.totals.goldDelta).toBeGreaterThan(0);
        expect(route.totals.lowestCash).toBe(0);
    });

    test('held recurring tea is drawn from one pool across stages, never counted twice', () => {
        const teaBill = [{ itemHrid: '/items/enhancing_tea', perHour: 12, unitPrice: 1_000 }];
        const enhance = {
            ...rate('Enhance', { flatRate: true, xpPerHour: 1000, xpPerAction: 10 }),
            goldPerHour: -12_000 - 5_000,
            drinkCostPerHour: 12_000,
            teaBill,
        };
        const routeInput = input({ rates: [enhance], target: 3, heldOf: () => 15 });
        const route = costRoute(routeInput, [
            { rate: routeInput.rates[0], toLevel: 2 },
            { rate: routeInput.rates[0], toLevel: 3 },
        ]);
        // 12 teas an hour, one hour a level: 15 held cover the first 12 and 3 of the second 12
        expect(route.stages[0].teas[0].held).toBe(12);
        expect(route.stages[1].teas[0].held).toBe(3);
        const heldCredit = route.stages.reduce((total, stage) => total + stage.teas[0].held, 0) * 1_000;
        expect(route.totals.goldDelta).toBeCloseTo(-17_000 * 2 + heldCredit, 6);
        expect(route.totals.materialCost).toBeCloseTo(10_000, 6);
    });
});

describe('an unpriced recurring tea', () => {
    // Enhancing: one level of 1,000 XP at 1,000 XP/hr drinks 12 teas, and the tea has no price
    const enhance = (extra = {}) => ({
        ...rate('Enhance', { flatRate: true, xpPerHour: 1000, xpPerAction: 10 }),
        goldPerHour: -5_000,
        drinkCostPerHour: 0,
        teaBill: [{ itemHrid: '/items/enhancing_tea', perHour: 12, unitPrice: null }],
        ...extra,
    });

    test('held for the whole climb, it is covered and the route is priced', async () => {
        // The quick estimate's pick is a faster, dearer item with a priced tea; the cheap one drinks the
        // unpriced tea the bag holds enough of, so only covering it lets Cheapest find it
        const dear = {
            ...rate('Dear', { flatRate: true, xpPerHour: 2000, xpPerAction: 10 }),
            goldPerHour: -50_000,
            teaBill: [{ itemHrid: '/items/wisdom_tea', perHour: 12, unitPrice: 100 }],
        };
        const result = await run({ rates: [dear, enhance()], target: 2, heldOf: () => 12 });
        expect(labels(result.routes.fastest)).toEqual(['Dear 1-2']);
        expect(labels(result.routes.cheapest)).toEqual(['Enhance 1-2']);
        expect(result.routes.cheapest.totals.costKnown).toBe(true);
        expect(result.routes.budget.totals.budgetSafe).toBe(true);
    });

    test('short of the whole climb, it is unknown and only Fastest offers the route', async () => {
        const result = await run({ rates: [enhance()], target: 2, heldOf: () => 11 });
        expect(result.routes.fastest.totals.costKnown).toBe(false);
        expect(result.routes.cheapest).toBeNull();
        expect(result.routes.budget).toBeNull();
    });
});

describe('held teas inside the search', () => {
    // 2,000 XP to climb; both items drink 12 teas an hour at 1,000 each, inside their hourly figure
    const tea = [{ itemHrid: '/items/enhancing_tea', perHour: 12, unitPrice: 1_000 }];
    const item = (name, xpPerHour, goldPerHour) => ({
        ...rate(name, { flatRate: true, xpPerHour, xpPerAction: 10 }),
        goldPerHour,
        drinkCostPerHour: 12_000,
        teaBill: tea,
    });
    const A = item('Quick', 2_000, -22_000);
    const B = item('Slow', 1_000, -14_000);

    test('24 held teas make the slow item the cheapest, and the one 6,000 coins can afford', async () => {
        const result = await run({ rates: [A, B], target: 3, gold: 6_000, heldOf: () => 24 });
        // Quick: 1 h, 22,000 less 12 held teas = 10,000. Slow: 2 h, 28,000 less 24 held = 4,000
        expect(labels(result.routes.fastest)).toEqual(['Quick 1-3']);
        expect(result.routes.fastest.totals.goldDelta).toBeCloseTo(-10_000, 6);
        expect(labels(result.routes.cheapest)).toEqual(['Slow 1-3']);
        expect(result.routes.cheapest.totals.goldDelta).toBeCloseTo(-4_000, 6);
        expect(labels(result.routes.budget)).toEqual(['Slow 1-3']);
        expect(result.routes.budget.totals.budgetSafe).toBe(true);
    });

    test('the search and exhaustive search agree once the pool is in the labels', async () => {
        // 4,000 XP, 30 teas held: all-Quick nets 20,000, all-Slow 26,000, mixes fall between
        const routeInput = input({ rates: [A, B], target: 5, gold: 25_000, heldOf: () => 30 });
        for (const objective of ['fastest', 'cheapest', 'budget']) {
            const exhaustive = exhaustiveBest(routeInput, objective);
            const searched = await searchBest(routeInput, objective);
            expect(exhaustive).not.toBeNull();
            expect(searched).not.toBeNull();
            const key = objective === 'cheapest' ? 'spent' : 'hours';
            expect(searched[key]).toBeCloseTo(exhaustive[key], 6);
        }
    });

    test('rates that drink differently are compared tea by tea, and still agree with exhaustive search', async () => {
        // A third item drinks no tea: the pool no longer follows hours, so the general comparison runs
        const plain = {
            ...rate('Plain', { flatRate: true, xpPerHour: 1_500, xpPerAction: 10 }),
            goldPerHour: -9_000,
        };
        const routeInput = input({ rates: [A, B, plain], target: 6, gold: 40_000, heldOf: () => 30 });
        for (const objective of ['fastest', 'cheapest', 'budget']) {
            const exhaustive = exhaustiveBest(routeInput, objective);
            const searched = await searchBest(routeInput, objective);
            expect(exhaustive).not.toBeNull();
            const key = objective === 'cheapest' ? 'spent' : 'hours';
            expect(searched[key]).toBeCloseTo(exhaustive[key], 6);
        }
    });
});

describe('the search against exhaustive search', () => {
    const cases = [
        {
            name: 'dividing evenly',
            rates: [
                rate('A', { xpPerAction: 100, goldPerHour: -3_600 }),
                rate('B', { requiredLevel: 2, xpPerAction: 200, goldPerHour: -50_000, upfrontCost: 50 }),
                rate('C', { requiredLevel: 3, xpPerAction: 250, actionTime: 12, goldPerHour: 10_000 }),
            ],
        },
        {
            name: 'with leftover experience and efficiency',
            rates: [
                rate('A', { xpPerAction: 130, totalEfficiency: 15, goldPerHour: -3_000 }),
                rate('B', { requiredLevel: 2, xpPerAction: 330, goldPerHour: -90_000, drinkCostPerHour: 500 }),
                rate('C', { requiredLevel: 4, xpPerAction: 410, actionTime: 14, goldPerHour: 4_000 }),
            ],
        },
    ];

    for (const { name, rates } of cases) {
        for (const gold of [500, 2_000, 1e9]) {
            test(`${name}, ${gold} coins: every objective matches`, async () => {
                const routeInput = input({ rates, target: 7, gold });
                for (const objective of ['fastest', 'cheapest', 'budget']) {
                    const exhaustive = exhaustiveBest(routeInput, objective);
                    const searched = await searchBest(routeInput, objective);
                    if (!exhaustive) {
                        expect(searched).toBeNull();
                        continue;
                    }
                    const key = objective === 'cheapest' ? 'spent' : 'hours';
                    // Leftover experience is carried but not compared: within one action a level
                    const slack = name.startsWith('dividing') ? 1e-9 : (7 * 14) / 3600;
                    expect(searched[key]).toBeGreaterThanOrEqual(exhaustive[key] - 1e-9);
                    expect(searched[key]).toBeLessThanOrEqual(exhaustive[key] + (key === 'spent' ? 1e-6 : slack));
                }
            });
        }
    }

    test('a tight frontier cap says the search was bounded', async () => {
        const rates = Array.from({ length: 6 }, (_, index) =>
            rate(`R${index}`, { xpPerAction: 100 + index * 37, goldPerHour: -(index * index * 9_000) })
        );
        const result = await run({ rates, gold: 30_000, target: 20 }, { frontierCap: 2 });
        expect(result.bounded).toBe(true);
        expect(result.notes.join(' ')).toContain('may not be the fastest affordable route');
        const loose = await run({ rates, gold: 30_000, target: 20 }, { frontierCap: 100_000 });
        expect(loose.bounded).toBe(false);
    });
});

describe('the cache key', () => {
    const base = { rates: [rate('Stew', { goldPerHour: -100 })], gold: 1000 };

    test('is the same for the same inputs', () => {
        expect(routeCacheKey(input(base))).toBe(routeCacheKey(input(base)));
    });

    test('changes with the level, experience, coins, a price, a tea bonus, or held tea', () => {
        const key = routeCacheKey(input(base));
        expect(routeCacheKey(input({ ...base, level: 2 }))).not.toBe(key);
        expect(routeCacheKey(input({ ...base, experience: 1001 }))).not.toBe(key);
        expect(routeCacheKey(input({ ...base, gold: 1001 }))).not.toBe(key);
        expect(routeCacheKey(input({ ...base, rates: [rate('Stew', { goldPerHour: -101 })] }))).not.toBe(key);
        expect(
            routeCacheKey(input({ ...base, rates: [rate('Stew', { goldPerHour: -100, teaSkillLevelBonus: 1 })] }))
        ).not.toBe(key);
        const tea = { teaBill: [{ itemHrid: '/items/tea', perHour: 1, unitPrice: 1 }], goldPerHour: -100 };
        expect(routeCacheKey(input({ ...base, rates: [rate('Stew', tea)], heldOf: () => 1 }))).not.toBe(
            routeCacheKey(input({ ...base, rates: [rate('Stew', tea)], heldOf: () => 2 }))
        );
    });
});
