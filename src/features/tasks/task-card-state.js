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
 * after a reroll (the player has to click Back to get the trash can again), so
 * the card sits mid-flow with the
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

/**
 * The task a card is currently showing, as a string.
 *
 * Name plus goal count, because the chooser leaves both in place: pressing a
 * reroll option swaps the card's task while its action row is still the
 * chooser, so this is the only thing on a mid-flow card that says the task has
 * changed. The progress *made* is left out on purpose — a card whose count
 * ticks up is still the same task and must not be redrawn for it.
 *
 * Toolasha's own injected zone index (`Z9`) is stripped, since it is added
 * after the first draw and would otherwise read as a change on the second pass.
 *
 * @param {Element|null|undefined} node - A task card, or any node inside one
 * @returns {string} The key, or '' when the node is not a card with a task on it
 */
export function cardTaskKey(node) {
    const card = taskCardOf(node) || node;
    if (!card || typeof card.querySelector !== 'function') return '';

    const nameNode = card.querySelector(GAME.TASK_NAME);
    if (!nameNode) return '';
    const injected = nameNode.querySelector?.('span.script_taskMapIndex');
    const rawName = nameNode.textContent || '';
    const name = (injected ? rawName.replace(injected.textContent, '') : rawName).trim();

    let goal = '';
    for (const div of card.querySelectorAll('div')) {
        const text = (div.textContent || '').trim();
        if (!text.startsWith('Progress:')) continue;
        const match = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (match) goal = match[2];
        break;
    }

    return `${name}|${goal}`;
}

/**
 * What each consumer last drew on each card, so a mid-flow card whose task has
 * changed can be told from one that is merely waiting on a click.
 */
const drawnTaskKeys = new WeakMap();

/**
 * @param {Element} card - A task card
 * @returns {Map<string, string>} That card's per-consumer keys
 */
function drawnKeysFor(card) {
    let keys = drawnTaskKeys.get(card);
    if (!keys) {
        keys = new Map();
        drawnTaskKeys.set(card, keys);
    }
    return keys;
}

/**
 * Should this pass leave the card alone because it is mid-flow?
 *
 * The plain rule — never touch a card that is asking the player a question —
 * has one hole in it, and it is the commonest thing a player does on this
 * board. Paying for a reroll does not close the chooser: the card keeps the
 * chooser open and puts the *new* task above it, so every pass that follows
 * skips a card whose rows now describe a task that no longer exists. The
 * player sees the old estimate, the old profit and the old spend sitting under
 * a task they have just replaced, and nothing fixes it until they press Back.
 *
 * So the skip holds while the card is showing the same task this consumer
 * already drew, and gives way the moment the task underneath changes. Redrawing
 * then disturbs nothing the player is mid-click on: what changed is the card's
 * content, not its action row, and the rows being replaced are Toolasha's own.
 *
 * @param {Element|null|undefined} node - A task card, or any node inside one
 * @param {string} consumer - Which feature is asking (its own rows are its own business)
 * @returns {boolean} True to skip the card this pass
 */
export function shouldSkipConfirmingCard(node, consumer) {
    const card = taskCardOf(node) || node;
    if (!isCardInConfirmState(card)) return false;

    const seen = drawnKeysFor(card).get(consumer);
    if (seen === undefined) return true;

    const key = cardTaskKey(card);
    // No readable task (the card is not drawn yet, or the build renamed the
    // name node) is not evidence of a change
    if (!key || key === seen) return true;

    return false;
}

/**
 * Record the task a consumer has just drawn for a card.
 *
 * Called on every pass that draws, not only the mid-flow ones: the key that
 * matters is the one from the last completed draw, whenever that was.
 *
 * @param {Element|null|undefined} node - A task card, or any node inside one
 * @param {string} consumer - Which feature drew
 */
export function noteCardTaskDrawn(node, consumer) {
    const card = taskCardOf(node) || node;
    if (!card || typeof card.querySelector !== 'function') return;
    const key = cardTaskKey(card);
    if (key) drawnKeysFor(card).set(consumer, key);
}
