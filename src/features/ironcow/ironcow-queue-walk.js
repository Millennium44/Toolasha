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
import { DECOMPOSE_ACTION, COINIFY_ACTION } from './ironbell-cycle.js';
export { DECOMPOSE_ACTION, COINIFY_ACTION };

/**
 * The most one queued action can hold.
 *
 * Not read off the game: nothing in `actionDetailMap`, in the
 * `actions_updated` payload, or on the game's own count box (it carries no
 * `max` attribute — see `ironcow-queue-walk.test.js`) states a repeat cap.
 * This is the 32-bit signed ceiling (2,147,483,647): a leg is one queue row
 * up to it, and only a count above it is split (the split is kept for that,
 * and for the typo guard on the duration). Each queue row is a slot the game
 * limits, so fewer rows is the point. Whether the server stores a count this
 * large as typed is checked after every press (`verifyCount` on each step), not
 * assumed. If the game ever states a real cap, this is the one constant to correct.
 * @type {number}
 */
export const MAX_STEP_ACTIONS = 2_147_483_647;

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
function legSteps({
    key,
    actionHrid,
    itemHrid,
    itemName,
    requiresItemHrid,
    count,
    verb,
    note,
    alchemyType,
    unlimited,
}) {
    if (unlimited) {
        // One Repeat ∞ row: the game's default count is left alone (nothing is typed), and the row runs for
        // as long as its input lasts, then the game moves on. Checked afterwards for being ∞, not for a count.
        const step = {
            key,
            kind: 'craft',
            itemHrid,
            itemName,
            actionHrid,
            count,
            actions: 0,
            label: `${verb} all ${itemName} — Repeat ∞, leave the count (about ${formatWithSeparator(count)} actions)`,
            unlimited: true,
        };
        if (requiresItemHrid) step.requiresItemHrid = requiresItemHrid;
        if (alchemyType) step.alchemyType = alchemyType;
        return [step];
    }
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
            // The walk checks the count the server kept against the count typed
            verifyCount: true,
        };
        if (requiresItemHrid) step.requiresItemHrid = requiresItemHrid;
        if (alchemyType) step.alchemyType = alchemyType;
        return step;
    });
}

/**
 * Whether a leg of this batch is queued as one Repeat ∞ row rather than a counted one. The one place the
 * row shape is chosen: Max sizes its alchemy legs to all the stock held, and an ∞ alchemy row is limited by
 * its materials (the game moves on when they run out); the hours path stays counted, and so does any
 * forage leg, which has no material limit.
 * @param {Object} batch - The batch
 * @param {'forage'|'decompose'|'coinify'} leg - The leg
 * @returns {boolean} True for an ∞ row
 */
export function legIsUnlimited(batch, leg) {
    return Boolean(batch?.max) && (leg === 'decompose' || leg === 'coinify');
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
                alchemyType: 'decompose',
                unlimited: legIsUnlimited(batch, 'decompose'),
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
                alchemyType: 'coinify',
                unlimited: legIsUnlimited(batch, 'coinify'),
            })
        );
    }

    return steps;
}

/**
 * How many queue rows a batch takes — one per walk step. The choice of counted rows (one per leg, split only
 * past {@link MAX_STEP_ACTIONS}) lives in {@link buildQueueSteps}; this counts what it builds, so a change
 * of row shape (for example Repeat ∞ rows) is one place.
 * @param {Object|null} loop - From `calculateStarfruitLoop`
 * @param {Object|null} batch - Counts to queue
 * @returns {number} Rows the walk would add
 */
export function queueRowsNeeded(loop, batch) {
    return buildQueueSteps(loop, batch).length;
}

/**
 * The queue rows still free, read off the game's "Queued Actions (used/total)" header.
 *
 * The limit is not in the data the script holds, only in that header, so it is read from the page; an
 * unreadable header (not drawn, another language) answers null and the caller says the limit is unknown
 * rather than assuming room.
 *
 * @param {Document|null} [doc] - Defaults to the page
 * @returns {{used: number, total: number, free: number}|null} Null when the header cannot be read
 */
export function readQueueSlots(doc = typeof document === 'undefined' ? null : document) {
    if (!doc) return null;
    for (const element of doc.querySelectorAll('div, span, h1, h2, h3, h4, h5, h6')) {
        if (element.children.length > 0) continue;
        const match = /^\s*Queued Actions\s*\((\d+)\s*\/\s*(\d+)\)\s*$/i.exec(element.textContent || '');
        if (!match) continue;
        const used = Number(match[1]);
        const total = Number(match[2]);
        if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
            return { used, total, free: Math.max(0, total - used) };
        }
    }
    return null;
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
    return craftingPlanWalk.start(steps, 'ironcow-queue');
}

export default {
    buildQueueSteps,
    startQueueWalk,
    queueRowsNeeded,
    readQueueSlots,
    DECOMPOSE_ACTION,
    COINIFY_ACTION,
    MAX_STEP_ACTIONS,
};
