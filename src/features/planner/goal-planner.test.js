/**
 * What the planner decides, given what it is told.
 *
 * Every test here builds its own context, which is the point of the engine
 * taking one: the interesting behaviour is a *choice between costed options*,
 * and a choice can only be tested when the fixture can move the prices. "Buying
 * is cheaper" and "crafting is cheaper" are the same code twice.
 *
 * The enhancement figures are pulled through the real Markov calculator rather
 * than typed in, so a change to the chain shows up here as a changed plan rather
 * than as a plan that quietly disagrees with every other surface in the script.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import * as mathjs from 'mathjs';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { planGoal, normalizeGoal, orderSteps, summarize, GOAL_TYPES } from './goal-planner.js';

beforeAll(() => {
    globalThis.math = mathjs;
});

/** A level table where each level costs 1,000 more experience than the last */
const LEVEL_TABLE = Array.from({ length: 201 }, (_, level) => level * 1000);

/**
 * A context with nothing in it, so each test only states what it cares about.
 * @param {Object} [overrides] - Fields to replace
 * @returns {Object} A planning context
 */
function context(overrides = {}) {
    return {
        now: 1_700_000_000_000,
        gold: 0,
        levelExperienceTable: LEVEL_TABLE,
        itemName: (hrid) => hrid.split('/').pop(),
        skillName: (hrid) =>
            hrid
                .split('/')
                .pop()
                .replace(/^./, (letter) => letter.toUpperCase()),
        houseRoomName: (hrid) => hrid.split('/').pop(),
        skill: () => ({ level: 1, experience: 0 }),
        owned: () => 0,
        ownedEnhancementLevel: () => -1,
        houseLevel: () => 0,
        goldRates: () => [],
        xpRates: () => [],
        acquire: () => null,
        enhance: () => null,
        houseCost: () => null,
        ...overrides,
    };
}

/**
 * @param {Object} plan - A plan
 * @param {string} id - A step id
 * @returns {Object|undefined} That step
 */
const step = (plan, id) => plan.steps.find((entry) => entry.id === id);

describe('normalizeGoal', () => {
    test('names every type it can plan', () => {
        expect(Object.keys(GOAL_TYPES).sort()).toEqual(['equipment', 'gold', 'house', 'skill']);
    });

    test('rejects a goal it cannot plan rather than half-building it', () => {
        expect(normalizeGoal({ type: 'gold', amount: 0 })).toBeNull();
        expect(normalizeGoal({ type: 'equipment' })).toBeNull();
        expect(normalizeGoal({ type: 'nonsense', amount: 5 })).toBeNull();
        expect(normalizeGoal(null)).toBeNull();
    });

    test('clamps an enhancement level to what the game allows', () => {
        expect(normalizeGoal({ type: 'equipment', itemHrid: '/items/x', enhancementLevel: 99 }).enhancementLevel).toBe(
            20
        );
    });
});

describe('a gold target', () => {
    test('picks the best of the rates it is given', () => {
        const plan = planGoal(
            { type: 'gold', amount: 500_000_000 },
            context({
                gold: 100_000_000,
                goldRates: () => [
                    { label: 'Slow', goldPerHour: 1_000_000 },
                    { label: 'Fast', goldPerHour: 4_000_000 },
                    { label: 'Middling', goldPerHour: 2_000_000 },
                ],
            })
        );

        const earn = step(plan, 'earn');
        expect(earn.details.rate.label).toBe('Fast');
        expect(earn.goldDelta).toBe(400_000_000);
        expect(earn.timeHours).toBeCloseTo(100, 6);
        expect(earn.description).toContain('Fast');
    });

    test('a target already met comes back done, with nothing left to do', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 250 }));

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'earn').done).toBe(true);
        expect(plan.totals.timeHours).toBe(0);
        expect(plan.totals.stepsDone).toBe(1);
    });

    test('says so when there is no rate to measure against', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 0 }));

        expect(step(plan, 'earn').timeHours).toBeNull();
        expect(plan.warnings.join(' ')).toContain('No earning rate');
    });
});

describe('an equipment target', () => {
    const cape = '/items/sinister_cape';

    /**
     * @param {Object} acquisition - What `acquire` should answer
     * @param {Object} [extra] - Further context overrides
     * @returns {Object} A plan for the bare cape
     */
    const planFor = (acquisition, extra = {}) =>
        planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({ gold: 1_000_000_000, acquire: () => acquisition, ...extra })
        );

    test('buys the base when buying is cheaper', () => {
        const plan = planFor({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: 1500 });

        expect(step(plan, 'base').description).toContain('Buy');
        expect(step(plan, 'base').goldDelta).toBe(-1000);
    });

    test('and crafts it when the same call says crafting is', () => {
        // The only difference is the prices; the flip is the behaviour under test
        const plan = planFor({ strategy: 'craft', totalCost: 900, buyPrice: 1500, craftCost: 900 });

        expect(step(plan, 'base').description).toContain('Craft');
        expect(step(plan, 'base').goldDelta).toBe(-900);
    });

    test('costs the enhancement run through the real Markov chain', () => {
        // +0 → +2 at level == item level: E0 = 20/3 attempts, hand-solved in the
        // enhancement calculator's own tests
        const materialPerAttempt = 300;
        const baseCost = 1000;

        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 2 },
            context({
                gold: 1_000_000_000,
                acquire: () => ({ strategy: 'buy', totalCost: baseCost, buyPrice: baseCost, craftCost: null }),
                enhance: ({ targetLevel, startLevel }) => {
                    const run = calculateEnhancement({
                        enhancingLevel: 50,
                        itemLevel: 50,
                        toolBonus: 0,
                        speedBonus: 0,
                        targetLevel,
                        startLevel,
                    });
                    return {
                        attempts: run.attempts,
                        totalTimeSeconds: run.totalTime,
                        materialCost: run.attempts * materialPerAttempt,
                        protectionCost: 0,
                        protectionCount: 0,
                        protectFrom: 0,
                        baseCost,
                        totalCost: baseCost + run.attempts * materialPerAttempt,
                    };
                },
            })
        );

        const enhance = step(plan, 'enhance');
        expect(enhance.details.attempts).toBeCloseTo(20 / 3, 6);
        // The base is bought by its own step, so the run must not be billed for it again
        expect(enhance.goldDelta).toBeCloseTo(-((20 / 3) * materialPerAttempt), 6);
        expect(step(plan, 'base').goldDelta).toBe(-baseCost);
        expect(plan.totals.goldSpend).toBeCloseTo(baseCost + (20 / 3) * materialPerAttempt, 6);
    });

    test('an item already owned at the target level needs no steps', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 10 },
            context({ ownedEnhancementLevel: () => 12 })
        );

        expect(plan.satisfied).toBe(true);
        expect(plan.steps.every((entry) => entry.done)).toBe(true);
        expect(plan.totals.goldSpend).toBe(0);
    });

    test('a base already held is struck through rather than dropped', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 5 },
            context({
                gold: 1_000_000,
                ownedEnhancementLevel: () => 0,
                enhance: () => ({ attempts: 10, totalTimeSeconds: 120, totalCost: 500, baseCost: 0, protectFrom: 0 }),
            })
        );

        // The step is still there — that is what makes it the same plan
        expect(step(plan, 'base').done).toBe(true);
        expect(step(plan, 'base').goldDelta).toBe(0);
        expect(step(plan, 'enhance').done).toBe(false);
        expect(plan.totals.stepsDone).toBe(1);
    });

    test('a craft the character cannot perform becomes a level step first', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 1_000_000,
                skill: () => ({ level: 40, experience: 40_000 }),
                acquire: () => ({
                    strategy: 'craft',
                    totalCost: 900,
                    buyPrice: 5000,
                    craftCost: 900,
                    actionHrid: '/actions/crafting/sinister_cape',
                    requires: [{ skillHrid: '/skills/crafting', level: 70 }],
                }),
                xpRates: () => [
                    {
                        label: 'Sinister Cape',
                        requiredLevel: 1,
                        xpPerHour: 10_000,
                        xpPerAction: 100,
                        actionTime: 10,
                        totalEfficiency: 0,
                        goldPerHour: 0,
                    },
                ],
            })
        );

        const ids = plan.steps.map((entry) => entry.id);
        expect(ids).toContain('train-crafting');
        expect(ids.indexOf('train-crafting')).toBeLessThan(ids.indexOf('base'));
        expect(step(plan, 'train-crafting').description).toContain('Crafting 70');
    });

    test('a plan that spends more than is held earns the shortfall first', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 200,
                acquire: () => ({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: null }),
                goldRates: () => [{ label: 'Milking', goldPerHour: 400 }],
            })
        );

        const ids = plan.steps.map((entry) => entry.id);
        expect(ids[0]).toBe('fund');
        expect(step(plan, 'fund').goldDelta).toBe(800);
        expect(step(plan, 'fund').timeHours).toBeCloseTo(2, 6);
        expect(step(plan, 'base').prerequisites).toContain('fund');
    });

    test('and does not, when the coins are already there', () => {
        const plan = planGoal(
            { type: 'equipment', itemHrid: cape, enhancementLevel: 0 },
            context({
                gold: 5000,
                acquire: () => ({ strategy: 'buy', totalCost: 1000, buyPrice: 1000, craftCost: null }),
                goldRates: () => [{ label: 'Milking', goldPerHour: 400 }],
            })
        );

        expect(plan.steps.map((entry) => entry.id)).not.toContain('fund');
    });
});

describe('a skill target', () => {
    const rate = (label, xpPerHour, requiredLevel = 1, extra = {}) => ({
        label,
        requiredLevel,
        xpPerHour,
        xpPerAction: 100,
        actionTime: 10,
        totalEfficiency: 0,
        goldPerHour: 0,
        ...extra,
    });

    test('picks the fastest action the level already allows', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/cooking', targetLevel: 60 },
            context({
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Slow', 1000), rate('Locked', 99_999, 80), rate('Best available', 5000)],
            })
        );

        expect(step(plan, 'train').details.rate.label).toBe('Best available');
    });

    test('a level already reached comes back done', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/cooking', targetLevel: 40 },
            context({ skill: () => ({ level: 50, experience: 50_000 }) })
        );

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'train').done).toBe(true);
    });

    test('a flat rate is timed straight off experience per hour', () => {
        // 10 levels at 1,000 experience each, from a standing start of 50,000
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 60 },
            context({
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Cheese Sword +0 → +5', 5000, 1, { flatRate: true })],
            })
        );

        expect(step(plan, 'train').timeHours).toBeCloseTo(10_000 / 5000, 6);
    });

    test('carries what the grind costs, when it costs', () => {
        const plan = planGoal(
            { type: 'skill', skillHrid: '/skills/enhancing', targetLevel: 60 },
            context({
                gold: 1_000_000,
                skill: () => ({ level: 50, experience: 50_000 }),
                xpRates: () => [rate('Burning coins', 5000, 1, { flatRate: true, goldPerHour: -100_000 })],
            })
        );

        expect(step(plan, 'train').goldDelta).toBeCloseTo(-200_000, 6);
    });
});

describe('a house room target', () => {
    const observatory = '/house_rooms/observatory';

    test('bills the materials it is short of and the coins on top', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 8 },
            context({
                gold: 1_000_000_000,
                houseLevel: () => 6,
                owned: (hrid) => (hrid === '/items/cheese' ? 100 : 0),
                houseCost: () => ({
                    coins: 5_000_000,
                    totalValue: 9_000_000,
                    materials: [
                        { itemHrid: '/items/cheese', count: 40, marketPrice: 1000, totalValue: 40_000 },
                        { itemHrid: '/items/log', count: 50, marketPrice: 2000, totalValue: 100_000 },
                    ],
                }),
            })
        );

        // The cheese is already in the bag, so only the logs are a purchase
        expect(step(plan, 'materials').goldDelta).toBe(-100_000);
        expect(step(plan, 'materials').details.materials.map((entry) => entry.itemHrid)).toEqual(['/items/log']);
        expect(step(plan, 'build').goldDelta).toBe(-5_000_000);
        expect(plan.totals.goldSpend).toBe(5_100_000);
    });

    test('materials already held mark their step done', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 7 },
            context({
                gold: 1_000_000_000,
                houseLevel: () => 6,
                owned: () => 1000,
                houseCost: () => ({
                    coins: 1000,
                    totalValue: 2000,
                    materials: [{ itemHrid: '/items/cheese', count: 40, marketPrice: 1000, totalValue: 40_000 }],
                }),
            })
        );

        expect(step(plan, 'materials').done).toBe(true);
        expect(step(plan, 'build').prerequisites).toContain('materials');
    });

    test('a room already at the target needs nothing', () => {
        const plan = planGoal(
            { type: 'house', roomHrid: observatory, targetLevel: 5 },
            context({ houseLevel: () => 8 })
        );

        expect(plan.satisfied).toBe(true);
        expect(step(plan, 'build').done).toBe(true);
    });
});

describe('orderSteps', () => {
    const node = (id, prerequisites = []) => ({ id, prerequisites, done: false, goldDelta: 0, timeHours: 0 });

    test('puts prerequisites first', () => {
        const ordered = orderSteps([node('c', ['b']), node('a'), node('b', ['a'])]);
        expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    });

    test('leaves independent steps in the order they were emitted', () => {
        const ordered = orderSteps([node('x'), node('y'), node('z')]);
        expect(ordered.map((entry) => entry.id)).toEqual(['x', 'y', 'z']);
    });

    test('keeps a step whose prerequisite is not in the list', () => {
        const ordered = orderSteps([node('only', ['missing'])]);
        expect(ordered.map((entry) => entry.id)).toEqual(['only']);
    });

    test('a cycle loses nothing', () => {
        const ordered = orderSteps([node('a', ['b']), node('b', ['a'])]);
        expect(ordered.map((entry) => entry.id).sort()).toEqual(['a', 'b']);
    });
});

describe('summarize', () => {
    test('totals only what is left to do', () => {
        const totals = summarize([
            { done: true, goldDelta: -500, timeHours: 5 },
            { done: false, goldDelta: 1000, timeHours: 2 },
            { done: false, goldDelta: -300, timeHours: 1 },
        ]);

        expect(totals).toMatchObject({
            goldEarn: 1000,
            goldSpend: 300,
            netGold: 700,
            timeHours: 3,
            timeKnown: true,
            stepsDone: 1,
            stepCount: 3,
        });
    });

    test('an untimeable step makes the total a floor rather than a figure', () => {
        expect(summarize([{ done: false, goldDelta: 0, timeHours: null }]).timeKnown).toBe(false);
    });
});

describe('the confidence note', () => {
    test('says the numbers move with the market', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 0 }));
        expect(plan.confidence.priceDependent).toBe(true);
        expect(plan.confidence.note).toMatch(/market/i);
    });

    test('carries whatever the context has to say about its prices', () => {
        const plan = planGoal({ type: 'gold', amount: 100 }, context({ gold: 500, pricingNote: 'Priced at 10:00.' }));
        expect(plan.confidence.note).toBe('Priced at 10:00.');
    });
});
