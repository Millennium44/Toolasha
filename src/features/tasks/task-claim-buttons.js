/**
 * Which buttons on the task board are a Claim Reward.
 *
 * The exact English label is trusted as it always was. Where it is not there (a translated client) the
 * label says nothing, and the game's green `Button_buy` variant is not a claim on its own: the reroll
 * chooser's Pay buttons wear it too, and pressing one spends coins or cowbells. So a translated claim has to
 * be proved by cues that do not depend on a language, all at once, and anything uncertain is not a claim:
 *
 *  - the card is a task card, and shows no reroll chooser and no discard confirmation;
 *  - it carries exactly one `Button_buy` button;
 *  - its quest (read off the React fiber, as the auto-reroll feature reads it) has reached its goal and is
 *    neither claimed nor discarded.
 */

import { GAME } from '../../utils/selectors.js';
import { taskCardOf, isCardInConfirmState } from './task-card-state.js';
import { findRerollOptions } from './task-reroll-options.js';

/** The game's English label, matched exactly so English behaves as it always has */
const CLAIM_LABEL = 'Claim Reward';

const STATUS_CLAIMED = '/quest_status/claimed';
const STATUS_DISCARDED = '/quest_status/discarded';

/**
 * The quest each given element belongs to, read off the React tree in one walk.
 *
 * One traversal for all of them, because a walk covers the whole page and the board redraws often.
 * @param {Element[]} targets - Elements whose owning `characterQuest` is wanted
 * @returns {Map<Element, Object>} Element to quest; absent when the tree or the quest cannot be read
 */
function questsOf(targets) {
    const found = new Map();
    const wanted = new Set(targets);
    const rootEl = typeof document === 'undefined' ? null : document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber || !wanted.size) return found;

    // Iterative, so a deep tree cannot overflow the stack
    const stack = [rootFiber];
    while (stack.length && found.size < wanted.size) {
        const fiber = stack.pop();
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
        if (!wanted.has(fiber.stateNode)) continue;
        for (let up = fiber.return; up; up = up.return) {
            const quest = up.memoizedProps?.characterQuest;
            if (quest) {
                found.set(fiber.stateNode, quest);
                break;
            }
        }
    }
    return found;
}

/**
 * Has this quest reached its goal and not yet been claimed or discarded?
 * @param {Object|undefined} quest - A `characterQuest`
 * @returns {boolean} False when unreadable
 */
function questIsComplete(quest) {
    if (!quest || quest.status === STATUS_CLAIMED || quest.status === STATUS_DISCARDED) return false;
    const goal = Number(quest.goalCount);
    return goal > 0 && Number(quest.currentCount) >= goal;
}

/**
 * The enabled Claim Reward buttons under a node.
 *
 * @param {ParentNode|null|undefined} root - The task list, a card, or any node holding cards
 * @returns {HTMLElement[]} The claim buttons, in document order
 */
export function claimButtonsIn(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const enabled = [...root.querySelectorAll(GAME.TASK_CLAIM_BUTTON)].filter((button) => !button.disabled);

    // The non-English candidates: a lone green button on a card that is not asking a question
    const candidates = new Map();
    for (const button of enabled) {
        if ((button.textContent || '').trim() === CLAIM_LABEL) continue;
        const card = taskCardOf(button);
        if (!card || candidates.has(card)) continue;
        const greens = card.querySelectorAll(GAME.TASK_CLAIM_BUTTON);
        if (greens.length !== 1 || greens[0] !== button) continue;
        if (!(button.textContent || '').trim()) continue;
        if (isCardInConfirmState(card) || findRerollOptions(card).length) continue;
        if ([...card.querySelectorAll('button')].some((b) => /discard/i.test(b.textContent || ''))) continue;
        candidates.set(card, button);
    }
    const quests = candidates.size ? questsOf([...candidates.values()]) : new Map();

    return enabled.filter((button) => {
        if ((button.textContent || '').trim() === CLAIM_LABEL) return true;
        const card = taskCardOf(button);
        return Boolean(card && candidates.get(card) === button && questIsComplete(quests.get(button)));
    });
}
