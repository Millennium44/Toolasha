/**
 * Goal Planner overlay row
 *
 * The one thing to do next.
 *
 * A plan is a list, and a list is a panel — but the reason to have a plan at
 * all is to answer one question while you are playing, which is "what am I
 * supposed to be doing". That answer is a single line, and a single line is a
 * tile.
 *
 * ## The head of the list, not the head of the goals
 *
 * `orderSteps` has already sorted each plan's steps into the order they can
 * actually be done in, so the first step that is not `done` is the next thing —
 * funding steps included, which is the point: "earn 40M" comes before "buy the
 * trident" because the planner said so, and a tile that skipped to the purchase
 * would be recommending something you cannot afford.
 *
 * Across goals it takes the first plan with work left in it. Goals are held in
 * the order they were added, so that is the oldest unfinished ambition — which
 * is the one a list would have you working on.
 *
 * ## Nothing is computed or read from storage here
 *
 * The planner's panel loads goals and the last plans in `initialize()`, whether
 * or not it is open, and keeps them on the instance. Re-pricing a plan runs the
 * whole buy-vs-craft model over the order book, which is not something a tile
 * redrawn once a second may do; this reads the last plans the panel computed
 * and says how old they are in the tooltip instead.
 */

import { registerRow } from '../../utils/overlay-rows.js';
import { row, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import goalPlannerPanel from './goal-planner-ui.js';

/**
 * The next step of the first goal that still has one.
 *
 * @returns {{plan: Object, step: Object, index: number, remaining: number}|null}
 *   Null when nothing is planned, or when every plan is finished
 */
export function nextGoalStep() {
    const plans = Array.isArray(goalPlannerPanel?.plans) ? goalPlannerPanel.plans : [];

    for (const plan of plans) {
        if (plan?.satisfied) continue;
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        const index = steps.findIndex((step) => step && !step.done);
        if (index < 0) continue;

        return {
            plan,
            step: steps[index],
            index,
            remaining: steps.filter((step) => step && !step.done).length,
        };
    }
    return null;
}

registerRow({
    key: 'goalNextStep',
    name: 'Next Goal Step',
    empty: 'No goals planned',
    defaultVisible: false,
    defaultSize: { width: 240, height: 30 },
    render: (container) => {
        const goals = Array.isArray(goalPlannerPanel?.goals) ? goalPlannerPanel.goals : [];

        // A player with no goals is not a player whose planner is broken, and
        // the tile is the only place they would find out the planner exists —
        // so this is drawn rather than left to the empty-tile machinery, which
        // would give a dim strip saying nothing but the row's own name
        if (!goals.length) {
            row(container, [{ text: 'No goals — click to plan', color: ROW_COLORS.dim, ellipsis: true }]);
            container.title = 'The goal planner has nothing to plan.\nDouble-click to add a goal.';
            return;
        }

        const next = nextGoalStep();
        if (!next) {
            row(container, [{ text: 'Every goal is done', color: ROW_COLORS.good, ellipsis: true }]);
            container.title =
                `${goals.length} goal${goals.length === 1 ? '' : 's'}, none with work left.` +
                '\nDouble-click for the planner.';
            return;
        }

        // The description already carries its own cost — "Buy Blazing Trident
        // +7 for 310M" — so nothing is appended to it here. Two prices on one
        // tile, one from the step and one from the plan's total, read as a
        // disagreement rather than as detail.
        row(container, [
            { text: next.step.description || next.plan.title || 'Next step', ellipsis: true },
            { text: `${next.remaining}`, color: ROW_COLORS.dim, push: true },
        ]);

        const pricedAt = goalPlannerPanel?.pricedAt;
        container.title =
            `${next.plan.title}: step ${next.index + 1} of ${next.plan.steps.length}, ` +
            `${next.remaining} still to do.\n` +
            `${next.step.description || ''}` +
            (pricedAt
                ? `\nPriced ${shortDuration((Date.now() - pricedAt) / 1000)} ago; re-price in the planner.`
                : '') +
            '\nDouble-click for the planner.';
    },
    onOpen: () => goalPlannerPanel.toggle(),
});
