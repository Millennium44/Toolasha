/**
 * @vitest-environment happy-dom
 *
 * The board's confirm states, recognised by what they contain.
 *
 * The game renames its CSS-module classes on every build, so a detector that
 * keys off `RandomTask_rerollOptionsContainer__2xY` is one deploy from being a
 * detector of nothing — and a detector of nothing means every injector goes
 * back to rebuilding cards underneath the player's pending click. What does not
 * change is the words on the buttons the player is being asked to choose
 * between, which is what this reads.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import {
    isCardInConfirmState,
    isConfirmPendingFor,
    taskCardOf,
    boardHasConfirmingCard,
    onConfirmFlowSettled,
    armConfirmSettleWatch,
    stopConfirmSettleWatch,
} from './task-card-state.js';

/**
 * A task card with the given buttons in its action row.
 * @param {Array<string>} buttonLabels - Button text, in order
 * @param {Object} [options]
 * @param {string} [options.optionsClass] - Class for a wrapper around the buttons
 * @returns {HTMLElement} The card
 */
function card(buttonLabels, { optionsClass = null } = {}) {
    const element = document.createElement('div');
    element.className = 'RandomTask_randomTask__1abc';

    const content = document.createElement('div');
    content.className = 'RandomTask_content__2def';
    const name = document.createElement('div');
    name.className = 'RandomTask_name__3ghi';
    name.textContent = 'Milking - Cow';
    content.appendChild(name);
    element.appendChild(content);

    const action = document.createElement('div');
    action.className = 'RandomTask_action__4jkl';
    const host = optionsClass ? document.createElement('div') : action;
    if (optionsClass) {
        host.className = optionsClass;
        action.appendChild(host);
    }
    for (const label of buttonLabels) {
        const button = document.createElement('button');
        button.textContent = label;
        host.appendChild(button);
    }
    element.appendChild(action);
    return element;
}

describe('isCardInConfirmState', () => {
    test('the card at rest is not mid-flow', () => {
        // Go, Reroll and an icon-only trash can: nothing is being asked
        const resting = card(['Go', 'Reroll', '']);
        expect(isCardInConfirmState(resting)).toBe(false);
    });

    test('a completed card waiting to be claimed is not mid-flow', () => {
        expect(isCardInConfirmState(card(['Claim Reward']))).toBe(false);
    });

    test('the reroll chooser is mid-flow', () => {
        expect(isCardInConfirmState(card(['Back', 'Pay 10K', 'MooPass Free Reroll']))).toBe(true);
    });

    test('the free reroll alone is enough to recognise the chooser', () => {
        // A player out of coins sees the chooser with the paid options disabled
        expect(isCardInConfirmState(card(['Back', 'MooPass Free Reroll']))).toBe(true);
    });

    test('the free reroll is recognised however the build words it', () => {
        // The label has been "MooPass Free Reroll", "Free Reroll (2)" and plain
        // "Free" across builds; the count on the end moves too
        expect(isCardInConfirmState(card(['Free Reroll (2)']))).toBe(true);
        expect(isCardInConfirmState(card(['Free']))).toBe(true);
    });

    test('the discard confirmation is mid-flow', () => {
        expect(isCardInConfirmState(card(['Confirm Discard']))).toBe(true);
    });

    test('the chooser is recognised by its container even if the words change', () => {
        const renamed = card(['◀', '\u{1F4B0}'], { optionsClass: 'RandomTask_rerollOptionsContainer__9zz' });
        expect(isCardInConfirmState(renamed)).toBe(true);
    });

    test('a "Reroll" button is the way in, not the confirmation itself', () => {
        // Blocking on this would mean never touching a card at all
        expect(isCardInConfirmState(card(['Reroll']))).toBe(false);
    });

    test('nothing is not a card', () => {
        expect(isCardInConfirmState(null)).toBe(false);
        expect(isCardInConfirmState(undefined)).toBe(false);
    });
});

describe('asking from inside the card', () => {
    test('a node in a confirming card reports its card, not itself', () => {
        const confirming = card(['Back', 'Pay 10K']);
        document.body.replaceChildren(confirming);
        const name = confirming.querySelector('[class*="RandomTask_name"]');

        expect(taskCardOf(name)).toBe(confirming);
        expect(isConfirmPendingFor(name)).toBe(true);
    });

    test('a node in a resting card reports nothing pending', () => {
        const resting = card(['Go', 'Reroll']);
        document.body.replaceChildren(resting);
        expect(isConfirmPendingFor(resting.querySelector('[class*="RandomTask_name"]'))).toBe(false);
    });
});

describe('boardHasConfirmingCard', () => {
    test('one card mid-flow speaks for the whole board', () => {
        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__xyz';
        list.append(card(['Go', 'Reroll']), card(['Back', 'Pay 20K']), card(['Go', 'Reroll']));
        document.body.replaceChildren(list);

        expect(boardHasConfirmingCard(list)).toBe(true);
    });

    test('a board at rest is at rest', () => {
        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__xyz';
        list.append(card(['Go', 'Reroll']), card(['Claim Reward']));
        document.body.replaceChildren(list);

        expect(boardHasConfirmingCard(list)).toBe(false);
    });
});

/**
 * The way back.
 *
 * Skipping a mid-flow card used to be permanent. The game leaves the reroll
 * chooser open after a reroll, and nothing an injector listens to fires when it
 * finally closes — the game adds an action row, not a card — so a card that was
 * skipped once was skipped for the rest of the session, wearing the picture and
 * the numbers of the task that had been rerolled away.
 */
describe('the settle watch', () => {
    /** A board with the given cards on it */
    function boardOf(...cards) {
        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__xyz';
        list.append(...cards);
        document.body.replaceChildren(list);
        return list;
    }

    afterEach(() => {
        stopConfirmSettleWatch();
        vi.useRealTimers();
    });

    test('a skipped pass runs again once the chooser closes', () => {
        vi.useFakeTimers();
        const chooser = card(['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        boardOf(chooser);

        const rerun = vi.fn();
        const unsubscribe = onConfirmFlowSettled(rerun);
        armConfirmSettleWatch();

        // Still mid-flow: the player has not finished with the card
        vi.advanceTimersByTime(1000);
        expect(rerun).not.toHaveBeenCalled();

        // Back pressed — the card is at rest again
        chooser.replaceChildren(...card(['Go', 'Reroll', '']).childNodes);
        vi.advanceTimersByTime(300);

        expect(rerun).toHaveBeenCalledTimes(1);

        // And it is one pass per flow, not a poll that never stops
        vi.advanceTimersByTime(3000);
        expect(rerun).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    test('a board that is already at rest settles on the next tick', () => {
        vi.useFakeTimers();
        boardOf(card(['Go', 'Reroll', '']));

        const rerun = vi.fn();
        const unsubscribe = onConfirmFlowSettled(rerun);
        armConfirmSettleWatch();
        vi.advanceTimersByTime(300);

        expect(rerun).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    test('an unsubscribed pass is not run', () => {
        vi.useFakeTimers();
        boardOf(card(['Go', 'Reroll']));

        const rerun = vi.fn();
        onConfirmFlowSettled(rerun)();
        armConfirmSettleWatch();
        vi.advanceTimersByTime(1000);

        expect(rerun).not.toHaveBeenCalled();
    });

    test('one subscriber throwing does not cost the others their pass', () => {
        vi.useFakeTimers();
        boardOf(card(['Go', 'Reroll']));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const thrower = vi.fn(() => {
            throw new Error('no');
        });
        const rerun = vi.fn();
        const stopThrower = onConfirmFlowSettled(thrower);
        const stopRerun = onConfirmFlowSettled(rerun);
        armConfirmSettleWatch();
        vi.advanceTimersByTime(300);

        expect(thrower).toHaveBeenCalled();
        expect(rerun).toHaveBeenCalled();
        stopThrower();
        stopRerun();
        consoleError.mockRestore();
    });

    test('arming with nobody waiting leaves no timer behind', () => {
        vi.useFakeTimers();
        boardOf(card(['Back', 'Pay 10K']));

        armConfirmSettleWatch();

        expect(vi.getTimerCount()).toBe(0);
    });
});
