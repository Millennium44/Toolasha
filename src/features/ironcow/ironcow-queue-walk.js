/**
 * The three steps that fill an Iron Bell queue, walked.
 *
 * The panel can say "queue 1,600 forages, 1,600 decomposes and 480 coinifies"
 * all it likes; typing that in is still three trips through the game's own
 * screens with three numbers to remember. This turns the sizing into a walk:
 * forage, then decompose, then coinify, in the order the loop consumes them.
 *
 * **One user click is one game action, always.** Nothing here presses a game
 * button or queues anything. Each step opens the action and types the count into
 * the game's own count box; the press that queues it is the player's, and the
 * walk only moves on once the server has answered that press. That invariant
 * belongs to `crafting-plan-walk.js`, which is the walker this drives — there is
 * one guided walk in this script, not two, and a second copy of it would be a
 * second place for that rule to be got wrong.
 *
 * ## Alchemy is chosen by item, and that is the whole difficulty
 *
 * `navigateToAction` reaches the alchemy screen — `/actions/alchemy/decompose`
 * and `/actions/alchemy/coinify` are real actions and `handleGoToAction` opens
 * them. What it cannot do is put the Star Fruit in the slot: alchemy is one
 * action for every item in the game and the item is chosen in a slot the game
 * exposes no handler for, only a sprite to read back. Selecting it for the
 * player would mean the script clicking the game's own controls, which is
 * exactly what this project does not do.
 *
 * So the two alchemy steps carry `requiresItemHrid`, and the walker waits: it
 * navigates, it says which item to select, and it types nothing until the panel
 * itself reports that item in the slot. A count typed against the wrong item
 * would be a count the player did not ask for, one press away from queueing it.
 */

import { formatWithSeparator } from '../../utils/formatters.js';
import craftingPlanWalk from '../crafting-plan/crafting-plan-walk.js';

/** The alchemy actions the loop uses. One action apiece, item chosen separately. */
export const DECOMPOSE_ACTION = '/actions/alchemy/decompose';
export const COINIFY_ACTION = '/actions/alchemy/coinify';

/** What the strip says to do about a slot the script is not allowed to fill */
const SELECT_NOTE = 'put it in the alchemy slot';

/**
 * The most one queued action can hold.
 *
 * Not read off the game: nothing in `actionDetailMap`, in the
 * `actions_updated` payload, or on the game's own count box (it carries no
 * `max` attribute — see `ironcow-queue-walk.test.js`) states a repeat cap, and
 * a repo-wide search for a documented one (`maxActionCount`, an int32 bound, a
 * queue-sizing constant in `src/features/actions/*`) turned up nothing either.
 * So this is chosen, not discovered: a round number with wide headroom below
 * the 32-bit signed range (2,147,483,647) that anything this loop asks for in
 * practice — even a week, even at a fast action rate — clears in a small
 * number of repeats rather than a stack of them. If the game ever states the
 * real cap, this is the one constant to correct.
 * @type {number}
 */
export const MAX_STEP_ACTIONS = 100_000;

/**
 * Split one leg's count into repeats no larger than {@link MAX_STEP_ACTIONS}.
 * @param {number} count - Total actions the leg needs
 * @returns {Array<number>} One or more chunk sizes, in order, summing to `count`
 */
function splitCount(count) {
    if (count <= MAX_STEP_ACTIONS) return [count];
    const chunks = [];
    let remaining = count;
    while (remaining > 0) {
        const chunk = Math.min(MAX_STEP_ACTIONS, remaining);
        chunks.push(chunk);
        remaining -= chunk;
    }
    return chunks;
}

/**
 * One leg of the batch, as one or more walk steps — several when the leg's
 * count is over {@link MAX_STEP_ACTIONS}, each with its own key so the walk's
 * existing wait-for-the-item-in-the-slot discipline runs again for every
 * repeat, not just the first.
 *
 * @param {Object} params
 * @param {string} params.key - Base key; a repeat number is appended when there is more than one
 * @param {string} params.actionHrid - The action this leg queues
 * @param {string} params.itemHrid - What the step is named for
 * @param {string} params.itemName - Its display name
 * @param {string} [params.requiresItemHrid] - Set when the action is chosen by item (alchemy)
 * @param {number} params.count - Total actions this leg needs
 * @param {string} params.verb - `forage`, `decompose` or `coinify`
 * @param {string} [params.note] - Extra wording, e.g. the alchemy slot reminder
 * @returns {Array<Object>} Steps for `craftingPlanWalk.start`
 */
function legSteps({ key, actionHrid, itemHrid, itemName, requiresItemHrid, count, verb, note }) {
    const chunks = splitCount(count);
    return chunks.map((chunk, index) => {
        const repeat = chunks.length > 1 ? ` — repeat ${index + 1} of ${chunks.length}` : '';
        const step = {
            key: chunks.length > 1 ? `${key}#${index + 1}` : key,
            kind: 'craft',
            itemHrid,
            itemName,
            actionHrid,
            count: chunk,
            actions: chunk,
            label: `${verb} ${formatWithSeparator(chunk)} × ${itemName}${note ? ` — ${note}` : ''}${repeat}`,
        };
        if (requiresItemHrid) step.requiresItemHrid = requiresItemHrid;
        return step;
    });
}

/**
 * The walk steps for one balanced batch, in the order the loop consumes them.
 *
 * Forage first because the decompose leg eats what it grew, decompose before
 * coinify for the same reason. A leg the balance sized at nothing is not a
 * step: there is nothing to type into it. A leg over {@link MAX_STEP_ACTIONS}
 * becomes several steps of the same action, in loop order, each with its own
 * press — see {@link legSteps}.
 *
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} batch - From `balanceBatch`
 * @returns {Array<Object>} Steps for `craftingPlanWalk.start`, or an empty list
 */
export function buildQueueSteps(loop, batch) {
    if (!loop || loop.missing?.length || !batch) return [];
    const items = loop.items;
    if (!items?.forageActionHrid || !items.starfruitHrid || !items.essenceHrid) return [];

    const fruitName = items.starfruitName || 'Star Fruit';
    const essenceName = items.essenceName || 'essence';
    const steps = [];

    if (batch.forageActions > 0) {
        steps.push(
            ...legSteps({
                key: 'ironbell:forage',
                actionHrid: items.forageActionHrid,
                itemHrid: items.starfruitHrid,
                itemName: fruitName,
                count: batch.forageActions,
                verb: 'forage',
            })
        );
    }

    if (batch.decomposeActions > 0) {
        steps.push(
            ...legSteps({
                key: 'ironbell:decompose',
                actionHrid: DECOMPOSE_ACTION,
                itemHrid: items.starfruitHrid,
                itemName: fruitName,
                requiresItemHrid: items.starfruitHrid,
                count: batch.decomposeActions,
                verb: 'decompose',
                note: SELECT_NOTE,
            })
        );
    }

    if (batch.coinifyActions > 0) {
        steps.push(
            ...legSteps({
                key: 'ironbell:coinify',
                actionHrid: COINIFY_ACTION,
                itemHrid: items.essenceHrid,
                itemName: essenceName,
                requiresItemHrid: items.essenceHrid,
                count: batch.coinifyActions,
                verb: 'coinify',
                note: SELECT_NOTE,
            })
        );
    }

    return steps;
}

/**
 * Walk one balanced batch.
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} batch - From `balanceBatch`
 * @returns {boolean} Whether a walk started
 */
export function startQueueWalk(loop, batch) {
    const steps = buildQueueSteps(loop, batch);
    if (!steps.length) return false;
    return craftingPlanWalk.start(steps);
}

export default { buildQueueSteps, startQueueWalk, DECOMPOSE_ACTION, COINIFY_ACTION, MAX_STEP_ACTIONS };
