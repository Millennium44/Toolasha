/** @vitest-environment happy-dom */

/**
 * The Next Goal Step tile.
 *
 * The planner has already ordered each plan's steps, so the tile's whole job is
 * picking the right one out of the list — the first step that is not done, of
 * the first goal that is not finished. The cases worth holding down are the ones
 * where "first" is not "first in the array": a plan whose opening steps are
 * already satisfied, and a goal list whose head is a goal already met.
 *
 * The empty case is the other half. A player with no goals is the one player who
 * needs the tile to say something, so it draws its own line rather than standing
 * down to a dim strip carrying nothing but the row's name.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    goals: [],
    plans: [],
    pricedAt: null,
    toggles: 0,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('./goal-planner-ui.js', () => ({
    default: {
        get goals() {
            return game.goals;
        },
        get plans() {
            return game.plans;
        },
        get pricedAt() {
            return game.pricedAt;
        },
        toggle: () => {
            game.toggles += 1;
        },
    },
}));

const { nextGoalStep } = await import('./goal-planner-row.js');

/**
 * A step as the planner emits one.
 * @param {string} id - Step id
 * @param {string} description - What it says
 * @param {boolean} [done] - Whether it is already satisfied
 * @returns {Object} A step
 */
function step(id, description, done = false) {
    return { id, kind: 'buy', description, goldDelta: -1, timeHours: 1, prerequisites: [], done };
}

/**
 * A plan as `planGoal` returns one.
 * @param {string} goalId - Goal id
 * @param {string} title - Goal title
 * @param {Array<Object>} steps - Its ordered steps
 * @param {boolean} [satisfied] - Whether the goal is already met
 * @returns {Object} A plan
 */
function plan(goalId, title, steps, satisfied = false) {
    return { goalId, title, type: 'equipment', steps, satisfied, totals: {}, warnings: [] };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.goalNextStep.render(container);
    return container;
}

describe('the next goal step tile', () => {
    beforeEach(() => {
        game.goals = [];
        game.plans = [];
        game.pricedAt = null;
        game.toggles = 0;
    });

    test('registers, off by default', () => {
        expect(game.rows.goalNextStep).toBeDefined();
        expect(game.rows.goalNextStep.defaultVisible).toBe(false);
    });

    test('with no goals it invites you to make one rather than going quiet', () => {
        const container = draw();

        expect(container.textContent).toBe('No goals — click to plan');
        expect(container.title).toContain('Double-click to add a goal');
    });

    test('the head of the ordered list is what it draws', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [
            plan('g1', 'Own Blazing Trident +7', [
                step('earn', 'Earn 40M from milking'),
                step('buy', 'Buy Blazing Trident +7 — 310M'),
            ]),
        ];

        expect(draw().textContent).toContain('Earn 40M from milking');
    });

    test('steps already satisfied are stepped over, not counted as next', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [
            plan('g1', 'Own Blazing Trident +7', [
                step('own', 'Already own the base item', true),
                step('buy', 'Buy Blazing Trident +7 — 310M'),
            ]),
        ];

        const next = nextGoalStep();
        expect(next.step.description).toBe('Buy Blazing Trident +7 — 310M');
        expect(next.index).toBe(1);
        expect(next.remaining).toBe(1);
        expect(draw().textContent).toContain('Buy Blazing Trident +7 — 310M');
    });

    test('a goal already met is skipped in favour of the next one with work in it', () => {
        game.goals = [{ id: 'g1' }, { id: 'g2' }];
        game.plans = [
            plan('g1', 'Have 10M coins', [step('done', 'Already have 10M', true)], true),
            plan('g2', 'Milking 90', [step('train', 'Train Milking 80 → 90')]),
        ];

        expect(draw().textContent).toContain('Train Milking 80 → 90');
    });

    test('goals that are all finished say so rather than reading as unplanned', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [plan('g1', 'Have 10M coins', [step('done', 'Already have 10M', true)], true)];

        const container = draw();
        expect(container.textContent).toContain('Every goal is done');
        expect(container.textContent).not.toContain('No goals');
    });

    test('goals that exist but have not been planned yet fall back to the finished line', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [];

        expect(nextGoalStep()).toBeNull();
        expect(draw().textContent).toContain('Every goal is done');
    });

    test('how many steps are left is on the tile, and where it sits is in the tooltip', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [
            plan('g1', 'Own Blazing Trident +7', [
                step('a', 'Step one'),
                step('b', 'Step two'),
                step('c', 'Step three'),
            ]),
        ];

        const container = draw();
        expect(container.textContent).toContain('3');
        expect(container.title).toContain('step 1 of 3');
    });

    test('a stale pricing says how old it is', () => {
        game.goals = [{ id: 'g1' }];
        game.plans = [plan('g1', 'Own Blazing Trident +7', [step('buy', 'Buy it')])];
        game.pricedAt = Date.now() - 3 * 60 * 60 * 1000;

        expect(draw().title).toContain('Priced 3h ago');
    });

    test('opening the tile toggles the planner, and drawing it does not', () => {
        game.rows.goalNextStep.onOpen();
        expect(game.toggles).toBe(1);

        draw();
        expect(game.toggles).toBe(1);
    });
});
