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
    /free\s*reroll/, // the MooPass free reroll
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
