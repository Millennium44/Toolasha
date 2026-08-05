/**
 * Task card confirm-state detection.
 *
 * The game's task cards are two-step. Pressing Reroll swaps the card's action
 * row for a chooser (Back / Pay … / the MooPass free reroll); pressing the trash
 * can swaps it for a Confirm Discard. Both steps are React state living inside
 * the card, and both are waiting on the player's second click.
 *
 * Everything Toolasha draws on a card — the profit rows, the reroll-spend line,
 * the queued badge, the icons, the auto-reroll outline — is injected into that
 * same card, and several of those injectors run off a timer or a mutation. A
 * pass that lands while the card is mid-flow adds and removes nodes underneath
 * the player's pending click: the injectors read the card's default view, find
 * it changed (the Go button is gone, the progress line moved), and tear their
 * own rows down and rebuild them. The player sees the button register and then
 * revert, and the second click lands on a card that has been rebuilt under it.
 *
 * So the rule is: while a card is asking the player a question, Toolasha does
 * not touch it. The card is left exactly as the game drew it until the flow
 * finishes, at which point the ordinary passes — a quest update, a card
 * re-render — redraw it.
 *
 * Except that there is no such pass. The game leaves the reroll chooser open
 * after a reroll (task-bulk-reroll has always had to click Back to get the
 * trash can again, for exactly that reason), so the card sits mid-flow with the
 * *new* task in it for as long as the player keeps rerolling — and every
 * injector's quest-update pass, which runs 250-400 ms after the reroll, skips
 * it. Nothing re-runs when the chooser finally closes either: the injectors are
 * driven by `RandomTask_randomTask` nodes being added, and closing the chooser
 * adds an action row, not a card. So the skip was permanent, and the card kept
 * the previous task's picture, profit rows and reroll spend until something
 * rebuilt the whole board.
 *
 * Hence the settle watch below: a pass that skips a card arms it, and when no
 * card on the board is mid-flow any more every subscriber gets to run again.
 *
 * Detection is by what the confirm views contain rather than by class name,
 * since the game renames its CSS-module classes on every build.
 */

import { GAME } from '../../utils/selectors.js';

/**
 * Text on a button that only ever appears in one of the game's confirm steps.
 * The default card view carries Go, Reroll, Claim Reward and an icon-only trash
 * can, none of which match.
 */
const CONFIRM_BUTTON_TEXT = [
    /^back$/, // the chooser's escape hatch
    /^pay\b/, // Pay 10K / Pay 1 (cowbell)
    /\bfree\b/, // the MooPass free reroll, however the build words it
    /discard/, // Confirm Discard
];

/**
 * Is this card waiting on the player's second click?
 *
 * @param {Element|null|undefined} card - A task card, or any node inside one
 * @returns {boolean} True while the card shows a reroll chooser or a discard confirmation
 */
export function isCardInConfirmState(card) {
    if (!card || typeof card.querySelectorAll !== 'function') return false;

    // The chooser's own container, when the build still names it recognisably
    if (card.querySelector('[class*="rerollOption" i]')) return true;

    for (const button of card.querySelectorAll('button')) {
        const text = (button.textContent || '').trim().toLowerCase();
        if (!text) continue;
        if (CONFIRM_BUTTON_TEXT.some((pattern) => pattern.test(text))) return true;
    }

    return false;
}

/**
 * The task card an injected or game node belongs to.
 *
 * @param {Element|null|undefined} node - Any node inside a task card
 * @returns {Element|null} The card, or null when the node is not on the board
 */
export function taskCardOf(node) {
    if (!node || typeof node.closest !== 'function') return null;
    return node.closest(GAME.TASK_CARD);
}

/**
 * Is the node's own card mid-flow?
 *
 * The convenience form for the injectors, which are handed a node somewhere
 * inside the card (the task info block, the action row) rather than the card.
 *
 * @param {Element|null|undefined} node - Any node inside a task card
 * @returns {boolean}
 */
export function isConfirmPendingFor(node) {
    return isCardInConfirmState(taskCardOf(node) || node);
}

/**
 * Is any card on the board mid-flow?
 *
 * Asked by the sorter, which moves whole cards: reordering the board while one
 * of its cards is waiting on a click pulls that card out from under the player.
 *
 * @param {ParentNode} [root=document] - Where to look
 * @returns {boolean}
 */
export function boardHasConfirmingCard(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return false;
    for (const card of root.querySelectorAll(GAME.TASK_CARD)) {
        if (isCardInConfirmState(card)) return true;
    }
    return false;
}

/**
 * How often the settle watch asks whether the board is still mid-flow.
 *
 * It only ever runs while a card is showing a chooser the player has not
 * finished with, and stops itself the moment none is, so this is a poll that
 * costs nothing for all but a few seconds of a session.
 */
const SETTLE_POLL_MS = 300;

const settleSubscribers = new Set();
let settleTimer = null;

/**
 * Run something again once no card on the board is mid-flow.
 *
 * For the injectors, whose passes skip a card that is asking the player a
 * question and would otherwise never look at it again. The callback runs on the
 * settling edge — once per flow, not once per card — so it should be the
 * feature's ordinary whole-board pass.
 *
 * @param {Function} callback - The pass to re-run
 * @returns {Function} Unsubscribe
 */
export function onConfirmFlowSettled(callback) {
    settleSubscribers.add(callback);
    return () => {
        settleSubscribers.delete(callback);
        if (settleSubscribers.size === 0) stopConfirmSettleWatch();
    };
}

/**
 * Note that a pass has just skipped a card, so it gets to run again later.
 *
 * Idempotent and cheap: called from inside every injector's per-card skip, on
 * every pass, for as long as the flow is open.
 *
 * @param {ParentNode} [root=document] - Where the board is
 */
export function armConfirmSettleWatch(root = document) {
    if (settleTimer !== null) return;
    if (settleSubscribers.size === 0) return;

    settleTimer = setInterval(() => {
        if (boardHasConfirmingCard(root)) return;

        // Stopped before the callbacks run: a pass that skips some *other*
        // card re-arms the watch from inside its own skip, and clearing the
        // timer afterwards would throw that new arming away
        stopConfirmSettleWatch();

        for (const callback of [...settleSubscribers]) {
            try {
                callback();
            } catch (error) {
                console.error('[TaskCardState] Settle handler failed:', error);
            }
        }
    }, SETTLE_POLL_MS);
}

/**
 * Stop the settle watch. Called when it fires, when the last subscriber leaves,
 * and by tests between cases.
 */
export function stopConfirmSettleWatch() {
    if (settleTimer !== null) {
        clearInterval(settleTimer);
        settleTimer = null;
    }
}
