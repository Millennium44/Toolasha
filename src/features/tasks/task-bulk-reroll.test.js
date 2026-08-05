/**
 * @vitest-environment happy-dom
 *
 * Tests for the Task Bulk Reroller's stopping rule, and for which button on a
 * card it presses.
 *
 * The stopping rule is the one that decides whether a card gets another reroll
 * or gets discarded — the one place where a divergence from what the shield
 * popup shows costs the player a task they meant to keep. Cap protection paints
 * its orange edge on EITHER category hitting its limit, so bulk reroll has to
 * stop on the same condition.
 *
 * Which button it presses is the other half: it prefers the MooPass free reroll
 * over spending, which is right until the free reroll stops working, at which
 * point preferring it is a loop that never chooses anything else.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

import { isAtRerollCap, questSignature, TaskBulkReroll } from './task-bulk-reroll.js';
import { armConfirmSettleWatch, onConfirmFlowSettled, stopConfirmSettleWatch } from './task-card-state.js';

// Thresholds as the shield popup stores them
const bothOpen = { coin: 320000, cowbell: 32 };

describe('isAtRerollCap', () => {
    test('a fresh card with both categories open is not at cap', () => {
        expect(isAtRerollCap(10000, 1, bothOpen)).toBe(false);
    });

    test('either category hitting its limit stops the card', () => {
        // Coins exhausted, cowbells still cheap — the old rule kept spending
        // cowbells here, which is exactly what protection calls "at cap"
        expect(isAtRerollCap(320000, 1, bothOpen)).toBe(true);
        expect(isAtRerollCap(10000, 32, bothOpen)).toBe(true);
    });

    test('a category allowing zero rerolls is ignored while the other is live', () => {
        const noCoins = { coin: 10000, cowbell: 32 };
        expect(isAtRerollCap(10000, 1, noCoins)).toBe(false);
        expect(isAtRerollCap(10000, 32, noCoins)).toBe(true);

        const noCowbells = { coin: 320000, cowbell: 1 };
        expect(isAtRerollCap(10000, 1, noCowbells)).toBe(false);
        expect(isAtRerollCap(320000, 1, noCowbells)).toBe(true);
    });

    test('both categories at zero means no rerolls at all', () => {
        expect(isAtRerollCap(10000, 1, { coin: 10000, cowbell: 1 })).toBe(true);
    });

    test('matches cap protection on the same inputs', () => {
        // Mirror of task-reroll-protection.js _cardIsAtCap
        const protectionRule = (coinCost, cowbellCost, limits) => {
            const coinAtCap = coinCost >= limits.coin;
            const cowbellAtCap = cowbellCost >= limits.cowbell;
            const coinZero = limits.coin <= 10000;
            const cowbellZero = limits.cowbell <= 1;
            if (coinZero && !cowbellZero) return cowbellAtCap;
            if (cowbellZero && !coinZero) return coinAtCap;
            return coinAtCap || cowbellAtCap;
        };

        const coinCosts = [10000, 20000, 40000, 80000, 160000, 320000];
        const cowbellCosts = [1, 2, 4, 8, 16, 32];
        const limitSets = [
            bothOpen,
            { coin: 10000, cowbell: 32 },
            { coin: 320000, cowbell: 1 },
            { coin: 80000, cowbell: 8 },
            { coin: 10000, cowbell: 1 },
        ];

        for (const limits of limitSets) {
            for (const coinCost of coinCosts) {
                for (const cowbellCost of cowbellCosts) {
                    expect(isAtRerollCap(coinCost, cowbellCost, limits)).toBe(
                        protectionRule(coinCost, cowbellCost, limits)
                    );
                }
            }
        }
    });
});

describe('which reroll button gets pressed', () => {
    /**
     * A card showing its reroll chooser.
     * @param {Array<string|{label: string, disabled?: boolean, className?: string}>} buttons - The chooser's buttons
     * @returns {HTMLElement} The card
     */
    function chooser(buttons) {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';
        for (const entry of buttons) {
            const spec = typeof entry === 'string' ? { label: entry } : entry;
            const button = document.createElement('button');
            button.textContent = spec.label;
            if (spec.disabled) button.disabled = true;
            if (spec.className) button.className = spec.className;
            button.addEventListener('click', () => {
                card.dataset.pressed = spec.label;
            });
            card.appendChild(button);
        }
        return card;
    }

    test('the free reroll is preferred over spending', async () => {
        const reroller = new TaskBulkReroll();
        const card = chooser(['Back', 'Pay 10K', 'Pay 1', 'MooPass Free Reroll (2)']);

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
        expect(card.dataset.pressed).toBe('MooPass Free Reroll (2)');
    });

    test('a free reroll the server ignored is not chosen again', async () => {
        // The reported symptom: the button label never changes, the card never
        // moves on, and every click goes to the same free reroll that did
        // nothing the last time
        const reroller = new TaskBulkReroll();
        reroller.freeRerollStalled = true;
        const card = chooser(['Back', 'Pay 10K', 'Pay 1', 'MooPass Free Reroll (0)']);

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
        expect(card.dataset.pressed).toBe('Pay 10K');
    });

    test('a free reroll is never mistaken for the cowbell option', async () => {
        // "MooPass Free Reroll (2)" carries a small number, and the paid
        // options are told apart by exactly that — a small number is cowbells
        const reroller = new TaskBulkReroll();
        reroller.freeRerollStalled = true;
        const card = chooser(['Back', 'Pay 10K', 'Pay 1', 'Free Reroll (2)']);

        expect(await reroller._actOnCard(card, 'cowbell')).toBe(true);
        expect(card.dataset.pressed).toBe('Pay 1');
    });

    test('a greyed-out free reroll is not pressed', async () => {
        const reroller = new TaskBulkReroll();
        const byClass = chooser(['Back', 'Pay 10K', { label: 'Free Reroll (0)', className: 'Button_disabled__7x' }]);

        expect(await reroller._actOnCard(byClass, 'coin')).toBe(true);
        expect(byClass.dataset.pressed).toBe('Pay 10K');

        const byAttribute = chooser(['Back', 'Pay 10K', { label: 'Free Reroll (0)', disabled: true }]);
        expect(await reroller._actOnCard(byAttribute, 'coin')).toBe(true);
        expect(byAttribute.dataset.pressed).toBe('Pay 10K');
    });

    test('pressing the free reroll is remembered, so a silent one can be noticed', async () => {
        const reroller = new TaskBulkReroll();

        await reroller._actOnCard(chooser(['Back', 'Pay 10K', 'MooPass Free Reroll (2)']), 'coin');
        expect(reroller.lastClickWasFree).toBe(true);

        await reroller._actOnCard(chooser(['Back', 'Pay 10K']), 'coin');
        expect(reroller.lastClickWasFree).toBe(false);
    });

    test('one unanswered free reroll is a slow server, two is a spent pass', () => {
        // Giving up after a single missed reply would spend the player's coins
        // on a MooPass that was working and merely slow
        const reroller = new TaskBulkReroll();

        reroller._noteFreeRerollResult(false);
        expect(reroller.freeRerollStalled).toBe(false);

        reroller._noteFreeRerollResult(false);
        expect(reroller.freeRerollStalled).toBe(true);
    });

    test('a free reroll that does land clears the doubt', () => {
        const reroller = new TaskBulkReroll();

        reroller._noteFreeRerollResult(false);
        reroller._noteFreeRerollResult(true);
        reroller._noteFreeRerollResult(false);

        expect(reroller.freeRerollStalled).toBe(false);
    });
});

describe('the chooser the player actually has', () => {
    /**
     * The card from the user's devtools capture: the chooser is open, "Back"
     * and the MooPass free reroll sit in the row, and the paid options are a
     * currency icon and a number rather than anything beginning with "Pay".
     *
     * @param {Object} [options] - Shape of the chooser
     * @param {boolean} [options.free=true] - Is the free reroll still offered?
     * @returns {HTMLElement} The card
     */
    function screenshotCard({ free = true } = {}) {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';

        const row = document.createElement('div');
        row.className = 'RandomTask_action__4jkl';

        const add = (label, className, icon) => {
            const button = document.createElement('button');
            button.className = className;
            if (icon) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                use.setAttribute('href', `/static/media/misc_sprite.svg#${icon}`);
                svg.appendChild(use);
                button.appendChild(svg);
            }
            button.appendChild(document.createTextNode(label));
            button.addEventListener('click', () => {
                card.dataset.pressed = label;
            });
            row.appendChild(button);
        };

        add('Back', 'Button_button__1Fe9z');
        add('10,000', 'Button_button__1Fe9z', 'coin');
        add('1', 'Button_button__1Fe9z', 'cowbell');
        if (free) add('MooPass Free Reroll', 'Button_button__1Fe9z Button_fullWidth__17pVU');

        card.appendChild(row);
        return card;
    }

    test('the free reroll on the captured card is the one that gets pressed', async () => {
        const reroller = new TaskBulkReroll();
        const card = screenshotCard();

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
        expect(card.dataset.pressed).toBe('MooPass Free Reroll');
    });

    test('the coin option is pressable even though its label never says "Pay"', async () => {
        // The dead end behind the third report. With the free reroll demoted,
        // the old reader had no paid button to fall back on — it returned false
        // and the click did nothing at all, in silence, while the header button
        // went on quoting "Reroll 10.0K💰 (1)" forever
        const reroller = new TaskBulkReroll();
        reroller.freeRerollStalled = true;
        const card = screenshotCard();

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
        expect(card.dataset.pressed).toBe('10,000');
    });

    test('and the cowbell option, told apart by its icon rather than its size', async () => {
        const reroller = new TaskBulkReroll();
        reroller.freeRerollStalled = true;
        const card = screenshotCard();

        expect(await reroller._actOnCard(card, 'cowbell')).toBe(true);
        expect(card.dataset.pressed).toBe('1');
    });

    test('a chooser whose free reroll has already gone still rerolls for coins', async () => {
        const reroller = new TaskBulkReroll();
        const card = screenshotCard({ free: false });

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
        expect(card.dataset.pressed).toBe('10,000');
    });

    test('an already-open chooser is acted on without hunting for a Reroll button', async () => {
        // Nothing on the card says "Reroll" once the chooser is open, and the
        // game leaves it open after every reroll — so a path that needs that
        // button first is a path that stops working after the first reroll
        const reroller = new TaskBulkReroll();
        const card = screenshotCard();
        expect([...card.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Reroll')).toBe(false);

        expect(await reroller._actOnCard(card, 'coin')).toBe(true);
    });
});

describe('the free reroll is demoted, not exiled', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    test('the demotion lifts on its own', () => {
        // A MooPass allowance refills. A latch that only disable() could clear
        // meant one session of missed replies was every session after it too:
        // the free reroll was never chosen again, which is precisely the
        // "it is still not rerolling the free MooPass reroll" being reported
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();

        reroller._noteFreeRerollResult(false);
        reroller._noteFreeRerollResult(false);
        expect(reroller.freeRerollStalled).toBe(true);

        vi.advanceTimersByTime(11 * 60 * 1000);

        expect(reroller.freeRerollStalled).toBe(false);
    });

    test('a free reroll pressed after the demotion lifts is preferred again', async () => {
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        reroller._noteFreeRerollResult(false);
        reroller._noteFreeRerollResult(false);

        vi.advanceTimersByTime(11 * 60 * 1000);

        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';
        for (const label of ['Back', 'Pay 10K', 'MooPass Free Reroll']) {
            const button = document.createElement('button');
            button.textContent = label;
            button.addEventListener('click', () => {
                card.dataset.pressed = label;
            });
            card.appendChild(button);
        }

        await reroller._actOnCard(card, 'coin');
        expect(card.dataset.pressed).toBe('MooPass Free Reroll');
    });
});

describe('a free reroll nobody had seen yet', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * A card at rest, whose Reroll button opens the chooser the way the game
     * draws it: the paid options first, and the full-width MooPass row a beat
     * behind them.
     *
     * @param {Object} [options] - How this card's chooser behaves
     * @param {boolean} [options.free=true] - Does a free reroll ever appear?
     * @param {number} [options.freeAfterMs=0] - How late the free row is
     * @returns {HTMLElement} The card, showing Go / Reroll / trash
     */
    function restingCard({ free = true, freeAfterMs = 0 } = {}) {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';
        const row = document.createElement('div');
        row.className = 'RandomTask_action__4jkl';
        card.appendChild(row);

        const option = (label, icon) => {
            const button = document.createElement('button');
            button.className = 'Button_button__1Fe9z';
            if (icon) {
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
                use.setAttribute('href', `/static/media/misc_sprite.svg#${icon}`);
                svg.appendChild(use);
                button.appendChild(svg);
            }
            button.appendChild(document.createTextNode(label));
            button.addEventListener('click', () => {
                card.dataset.pressed = label;
            });
            return button;
        };

        const go = document.createElement('button');
        go.textContent = 'Go';
        const trash = document.createElement('button');
        const reroll = document.createElement('button');
        reroll.textContent = 'Reroll';
        reroll.addEventListener('click', () => {
            row.replaceChildren(option('Back'), option('10,000', 'coin'), option('1', 'cowbell'));
            if (free) {
                setTimeout(() => row.appendChild(option('MooPass Free Reroll')), freeAfterMs);
            }
        });
        row.append(go, reroll, trash);
        return card;
    }

    /** A reroller that has been shown a working free reroll recently */
    function withKnownFree(available) {
        const reroller = new TaskBulkReroll();
        reroller.lastFreeOffer = { known: true, available, remaining: null };
        reroller.lastFreeOfferAt = Date.now();
        return reroller;
    }

    test('the first click opens the menu and takes the free reroll it finds there', async () => {
        // The whole of the request: a click made while the free reroll's
        // availability was unknown should still end up using it
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        const card = restingCard();

        const acting = reroller._actOnCard(card, 'coin');
        await vi.advanceTimersByTimeAsync(600);

        expect(await acting).toBe(true);
        expect(card.dataset.pressed).toBe('MooPass Free Reroll');
        expect(reroller.lastClickWasFree).toBe(true);
    });

    test('a MooPass row drawn a beat after the paid ones is still the one pressed', async () => {
        // The difference the player saw between the first click and every click
        // after it. A chooser that is already open finished drawing long ago;
        // one this click opened draws its paid options first, and a pass that
        // read the card one fixed beat later found coins and pressed them
        vi.useFakeTimers();
        const reroller = withKnownFree(true);
        const card = restingCard({ freeAfterMs: 350 });

        const acting = reroller._actOnCard(card, 'coin');
        await vi.advanceTimersByTimeAsync(800);

        expect(await acting).toBe(true);
        expect(card.dataset.pressed).toBe('MooPass Free Reroll');
    });

    test('but a chooser that will never draw one does not hold the click up forever', async () => {
        vi.useFakeTimers();
        const reroller = withKnownFree(true);
        const card = restingCard({ free: false });

        const acting = reroller._actOnCard(card, 'coin');
        await vi.advanceTimersByTimeAsync(2000);

        expect(await acting).toBe(true);
        expect(card.dataset.pressed).toBe('10,000');
    });

    test('a pass already seen to be spent is not waited for again', async () => {
        // The answer converges: one chooser that showed no free reroll is
        // enough, and later clicks pay at the old speed
        vi.useFakeTimers();
        const reroller = withKnownFree(false);
        const card = restingCard({ freeAfterMs: 350 });

        const acting = reroller._actOnCard(card, 'coin');
        await vi.advanceTimersByTimeAsync(800);

        expect(await acting).toBe(true);
        expect(card.dataset.pressed).toBe('10,000');
    });

    test('what the chooser said survives the chooser being closed', async () => {
        // The reroller shuts the chooser when it is done, and the chooser is
        // the only place the free reroll can be seen — so the label would go
        // straight back to a starred guess one moment after knowing the answer
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        expect(reroller._readFreeOffer().known).toBe(false);

        reroller.lastFreeOffer = { known: true, available: true, remaining: 2 };
        reroller.lastFreeOfferAt = Date.now();
        expect(reroller._readFreeOffer()).toEqual({ known: true, available: true, remaining: 2 });

        await vi.advanceTimersByTimeAsync(61 * 1000);
        expect(reroller._readFreeOffer().known).toBe(false);
    });
});

describe('the board the reroller leaves behind', () => {
    afterEach(() => {
        stopConfirmSettleWatch();
        document.body.replaceChildren();
        vi.useRealTimers();
    });

    /**
     * A card on the board with its chooser open, whose Back button closes it
     * the way the game's does.
     *
     * @returns {HTMLElement} The card
     */
    function midFlowCard() {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';
        const row = document.createElement('div');
        row.className = 'RandomTask_action__4jkl';
        for (const label of ['Back', '10,000', 'MooPass Free Reroll']) {
            const button = document.createElement('button');
            button.textContent = label;
            row.appendChild(button);
        }
        card.appendChild(row);
        row.firstChild.addEventListener('click', () => {
            row.replaceChildren(
                ...['Go', 'Reroll', ''].map((label) => {
                    const button = document.createElement('button');
                    button.textContent = label;
                    return button;
                })
            );
        });
        document.body.appendChild(card);
        return card;
    }

    test('a chooser left open is a board that never settles', async () => {
        // The reported bug, at its root. Every Toolasha pass refuses to touch a
        // card that is mid-flow, and the redraw they book instead only happens
        // once the board is at rest — which, for a chooser the script opened
        // and nobody ever closes, is never
        vi.useFakeTimers();
        midFlowCard();
        const repaint = vi.fn();
        const unsubscribe = onConfirmFlowSettled(repaint);
        armConfirmSettleWatch();

        await vi.advanceTimersByTimeAsync(60 * 1000);
        unsubscribe();

        expect(repaint).not.toHaveBeenCalled();
    });

    test('so the reroller closes the one it opened, and every decorator runs again', async () => {
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        const card = midFlowCard();
        const repaint = vi.fn();
        const unsubscribe = onConfirmFlowSettled(repaint);

        const settling = reroller._settleCard(card);
        await vi.advanceTimersByTimeAsync(300);
        await settling;
        await vi.advanceTimersByTimeAsync(300);
        unsubscribe();

        expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Go', 'Reroll', '']);
        expect(repaint).toHaveBeenCalled();
    });

    test('and the repaint does not wait on some other feature having skipped a card first', async () => {
        // The settle watch is armed from inside each injector's per-card skip,
        // so a reroll whose quest update never arrived — no pass ran, nothing
        // was skipped — used to leave nothing armed at all
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        const card = midFlowCard();
        card.querySelector('button').click(); // the chooser is already closed
        const repaint = vi.fn();
        const unsubscribe = onConfirmFlowSettled(repaint);

        await reroller._settleCard(card);
        await vi.advanceTimersByTimeAsync(300);
        unsubscribe();

        expect(repaint).toHaveBeenCalled();
    });

    test('a discard confirmation it could not finish is backed out of too', async () => {
        // The other way a card is left asking a question nobody is going to
        // answer: the trash can was pressed and the confirmation never found
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';
        for (const label of ['Cancel', 'Confirm Discard']) {
            const button = document.createElement('button');
            button.textContent = label;
            card.appendChild(button);
        }
        card.querySelector('button').addEventListener('click', () => card.replaceChildren());
        document.body.appendChild(card);

        const settling = reroller._settleCard(card);
        await vi.advanceTimersByTimeAsync(300);
        await settling;

        expect(card.querySelector('button')).toBe(null);
    });

    test('what the chooser was offering is read before it is closed', async () => {
        vi.useFakeTimers();
        const reroller = new TaskBulkReroll();
        const card = midFlowCard();

        const settling = reroller._settleCard(card);
        await vi.advanceTimersByTimeAsync(300);
        await settling;

        expect(reroller.lastFreeOffer).toEqual({ known: true, available: true, remaining: null });
    });
});

describe('what counts as the server confirming a reroll', () => {
    test('a task whose action changed is confirmation; the same task again is not', () => {
        // A free reroll moves neither reroll counter, so a check that watched
        // only the counters would report every working free reroll as silent
        // and demote it after two of them
        const before = questSignature({ actionHrid: '/actions/milking/cow', goalCount: 100 });

        expect(questSignature({ actionHrid: '/actions/milking/cow', goalCount: 100 })).toBe(before);
        expect(questSignature({ actionHrid: '/actions/cheesesmithing/cheese', goalCount: 100 })).not.toBe(before);
        expect(questSignature({ actionHrid: '/actions/milking/cow', goalCount: 250 })).not.toBe(before);
        expect(questSignature({ actionHrid: '/actions/milking/cow', goalCount: 100, coinRerollCount: 1 })).not.toBe(
            before
        );
    });
});
