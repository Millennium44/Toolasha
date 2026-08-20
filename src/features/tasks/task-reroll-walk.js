/**
 * Guided task reroll walk.
 *
 * Working a full task board down to something worth doing is a lot of clicking:
 * open a card's chooser, pay, look at what arrived, decide, pay again, and on
 * to the next card. This walks that for you — but it walks it, it does not run
 * it.
 *
 * **One user click is one game action, always.** Pressing the walk's button
 * performs exactly one click on exactly one of the game's own buttons and then
 * stops and tells you what the next press would do. Nothing is chained, nothing
 * is queued, nothing fires on a timer or off a websocket message: opening a
 * card's chooser is one press, paying for the reroll is the next, closing the
 * chooser is another. The only work this module does between presses is reading
 * the board and writing a label.
 *
 * The rules come from what the player has already configured elsewhere:
 *
 *  - the reroll-protection list (the shield popup) — a protected task is left
 *    exactly where it is, and the walk moves past it;
 *  - that same popup's "Block rerolls at &lt;coins&gt; &lt;cowbells&gt;"
 *    thresholds — the walk stops rerolling a task the moment its *next* reroll
 *    would cost that much or more. There is no second reroll budget to keep in
 *    step with it: a walk that gave up after three rerolls while the shield
 *    popup was still happy to pay, or the reverse, was two rules for one
 *    decision and the player had to hold both;
 *  - `tasks_rerollWalkCurrency` — which of the two currencies to spend, when
 *    both are still under their threshold;
 *  - `tasks_rerollWalkTrashAtLimit` — what to do with a task whose reroll
 *    options are both blocked: offer the trash can, or move past it.
 *
 * ## What the next reroll costs
 *
 * The game doubles a task's reroll price each time it is used, per currency and
 * per task: 10K → 20K → 40K → 80K → 160K → 320K coins, and 1 → 2 → 4 → 8 → 16 →
 * 32 cowbells, each capped at the last step. That formula is what prices a card
 * whose chooser is shut. When the chooser is open its own Pay buttons are the
 * source of truth instead — they are what the click will actually spend, and a
 * build that changes the progression changes them first.
 *
 * The two prices are then compared in the one unit that makes them comparable:
 * coins. A cowbell is valued the way the task profit display values it (through
 * the Bag of 10 Cowbells on the market), so "2🔔" and "20K🪙" can be put side by
 * side and the cheaper one picked — and the label says which and why, because a
 * walk quietly spending cowbells is a walk you find out about later.
 *
 * Before every click the board is re-read and compared against what was
 * planned. If the card in that slot is not the card the label is about — the
 * game re-ordered the board, a task completed, a reroll landed differently than
 * expected — the walk stops and says so rather than clicking something the
 * player did not agree to.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { GAME } from '../../utils/selectors.js';
import { formatKMB } from '../../utils/formatters.js';
import { clickThroughReact } from '../../utils/react-click.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import {
    createFloatingWidget,
    widgetCheckboxRow,
    widgetDivider,
    widgetNote,
    widgetReadOnlyRow,
    widgetSelectRow,
} from '../../utils/floating-widget.js';
import { cardTaskKey } from './task-card-state.js';
import { questForTaskCard } from './task-card-quest.js';
import { getCowbellValue } from './task-profit-calculator.js';
import { findRerollOptions } from './task-reroll-options.js';

const CHIP_ID = 'mwi-task-reroll-walk-chip';
const BUTTON_CLASS = 'mwi-task-reroll-walk-btn';
const PROTECTED_KEY_PREFIX = 'taskProtectedHrids';
const PANEL_POSITION_KEY = 'taskRerollWalkPanelPosition';

/** The board's "You have N unread tasks" notice, whose one button reads them */
const UNREAD_NOTICE = '[class*="TasksPanel_unreadTasks"]';

/** How many Read presses to offer before walking on past a notice that will not clear */
const READ_PRESS_LIMIT = 3;

/** How long the walk waits for the game to redraw a card after a UI-only click */
const UI_SETTLE_MS = 120;
/** How long it waits for a reroll or discard to come back from the server */
const SERVER_SETTLE_MS = 2500;

/** The game's reroll price ladder: the first coin reroll, doubling, and its ceiling */
const COIN_REROLL_BASE = 10000;
const COIN_REROLL_CAP = 320000;
/** The same ladder in cowbells, which starts at one */
const COWBELL_REROLL_CAP = 32;

/** The shield popup's defaults, so a character who never opened it is not blocked early */
const DEFAULT_COIN_THRESHOLD = 320000;
const DEFAULT_COWBELL_THRESHOLD = 32;

/** @returns {string} The protected-task list's key for the current character */
function protectedStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${PROTECTED_KEY_PREFIX}_${charId}`;
}

/**
 * @param {number} coins - An amount of coins
 * @returns {string} The amount with its icon
 */
function coinLabel(coins) {
    return `${formatKMB(coins)}\u{1FA99}`;
}

/**
 * @param {number} cowbells - An amount of cowbells
 * @returns {string} The amount with its icon
 */
function cowbellLabel(cowbells) {
    return `${cowbells}\u{1F514}`;
}

/**
 * What the task's next reroll costs in each currency, by the game's own ladder.
 *
 * Each currency doubles independently and caps: paying coins five times does
 * not make the first cowbell reroll any dearer.
 *
 * @param {Object|null} quest - The card's characterQuest
 * @returns {{coin: number, cowbell: number}|null} Costs, or null when unreadable
 */
export function nextRerollCosts(quest) {
    if (!quest) return null;
    const coinCount = Number(quest.coinRerollCount) || 0;
    const cowbellCount = Number(quest.cowbellRerollCount) || 0;
    return {
        coin: Math.min(COIN_REROLL_BASE * Math.pow(2, coinCount), COIN_REROLL_CAP),
        cowbell: Math.min(Math.pow(2, cowbellCount), COWBELL_REROLL_CAP),
    };
}

/**
 * What the open chooser says the next reroll costs, which beats the formula.
 *
 * @param {Array<Object>} options - From `findRerollOptions`
 * @returns {{coin: number|null, cowbell: number|null, free: boolean}}
 */
export function costsFromChooser(options) {
    const costs = { coin: null, cowbell: null, free: false };
    for (const option of options || []) {
        if (!option.available) continue;
        if (option.kind === 'free') {
            costs.free = true;
        } else if (option.cost !== null && option.cost !== undefined) {
            costs[option.kind] = option.cost;
        }
    }
    return costs;
}

/**
 * Which reroll to buy, and why — or that both are blocked.
 *
 * "Blocked" is exactly what the shield popup means by it: a cost at or above
 * the threshold that popup was set to. The comparison between the two live
 * options is done in coins, because that is the only unit both are quotable in;
 * a free reroll skips all of it, being cheaper than everything.
 *
 * @param {Object} params - Prices, limits and taste
 * @param {number|null} params.coin - Next coin reroll's cost
 * @param {number|null} params.cowbell - Next cowbell reroll's cost
 * @param {boolean} [params.free] - Is a free reroll on offer right now?
 * @param {number} params.coinThreshold - Block coins at this cost
 * @param {number} params.cowbellThreshold - Block cowbells at this cost
 * @param {number} params.cowbellValue - What one cowbell is worth in coins
 * @param {string} [params.preference] - 'auto', 'cowbell' or 'coin'
 * @returns {{currency: string|null, cost: number|null, costLabel: string, why: string}}
 */
export function chooseReroll({ coin, cowbell, free, coinThreshold, cowbellThreshold, cowbellValue, preference }) {
    if (free) return { currency: 'free', cost: 0, costLabel: 'free', why: '' };

    const coinOk = coin !== null && coin !== undefined && coin < coinThreshold;
    const cowbellOk = cowbell !== null && cowbell !== undefined && cowbell < cowbellThreshold;

    if (!coinOk && !cowbellOk) {
        return { currency: null, cost: null, costLabel: '', why: 'both reroll options blocked' };
    }

    const takeCoin = (why) => ({ currency: 'coin', cost: coin, costLabel: coinLabel(coin), why });
    const takeCowbell = (why) => ({ currency: 'cowbell', cost: cowbell, costLabel: cowbellLabel(cowbell), why });

    if (!coinOk) return takeCowbell('coins blocked');
    if (!cowbellOk) return takeCoin('cowbells blocked');
    if (preference === 'cowbell') return takeCowbell('preferred');
    if (preference === 'coin') return takeCoin('preferred');

    // Both are live and neither is blocked, so it comes down to what they cost
    const cowbellCoins = cowbell * (Number(cowbellValue) || 0);
    if (cowbellCoins <= coin) {
        return takeCowbell(`≈${formatKMB(cowbellCoins)}, cheaper than ${coinLabel(coin)}`);
    }
    return takeCoin(`cheaper than ${cowbellLabel(cowbell)} ≈${formatKMB(cowbellCoins)}`);
}

/**
 * The reroll option a walk should press, out of what the chooser is offering.
 *
 * Free first, because it costs nothing. After that the currency the plan priced
 * is pressed, so the button clicked is the button the label named; with no
 * currency named it falls back to cowbells before coins, which is what a player
 * setting out to reroll a whole board is normally spending.
 *
 * @param {Array<{kind: string, available: boolean}>} options - What the chooser offers
 * @param {string|null} [currency] - The currency the plan chose
 * @returns {Object|null} The option to press, or null when none is available
 */
export function preferredRerollOption(options, currency = null) {
    const usable = (options || []).filter((option) => option.available);
    const free = usable.find((option) => option.kind === 'free');
    if (free) return free;
    if (currency && currency !== 'free') {
        return usable.find((option) => option.kind === currency) || null;
    }
    for (const kind of ['cowbell', 'coin']) {
        const match = usable.find((option) => option.kind === kind);
        if (match) return match;
    }
    return null;
}

/**
 * What the walk should do about one card.
 *
 * @param {Object} params - The card's situation
 * @param {boolean} params.completed - Is it waiting to be claimed?
 * @param {boolean} params.isProtected - Is it on the protected list?
 * @param {Object|null} params.choice - From `chooseReroll`, or null when unreadable
 * @param {boolean} params.trashAtLimit - Discard a task whose options are both blocked?
 * @returns {{action: string, reason: string}} 'reroll', 'trash' or 'skip', and why
 */
export function verdictForCard({ completed, isProtected, choice, trashAtLimit }) {
    if (completed) return { action: 'skip', reason: 'ready to claim' };
    if (isProtected) return { action: 'skip', reason: 'protected' };
    // A card whose price cannot be read cannot be judged either, and guessing is
    // how a walk rerolls something the player was keeping
    if (!choice) return { action: 'skip', reason: 'unreadable' };
    if (!choice.currency) {
        return trashAtLimit
            ? { action: 'trash', reason: choice.why || 'blocked' }
            : { action: 'skip', reason: choice.why || 'blocked' };
    }
    return { action: 'reroll', reason: choice.costLabel + (choice.why ? ` (${choice.why})` : '') };
}

/** How many short waits a chooser may stay unpressable before the walk gives up on it */
const PENDING_RETRY_LIMIT = 12;

class TaskRerollWalk {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.protectedHrids = new Set();
        /** idle | ready | waiting | done | stopped */
        this.state = 'idle';
        /** Set by a plan that found the chooser drawn but unpressable; cleared each plan */
        this.pending = false;
        this.pendingRetries = 0;
        /** Read presses made on the unread-tasks notice this walk */
        this.readPresses = 0;
        /** Whether any card press has been made — after that, Read is never offered */
        this.walkBegun = false;
        this.step = null;
        this.message = '';
        this.index = 0;
        this.tally = { kept: 0, rerolled: 0, trashed: 0 };
        this.coinThreshold = DEFAULT_COIN_THRESHOLD;
        this.cowbellThreshold = DEFAULT_COWBELL_THRESHOLD;
        this.widget = null;
        this.panelPosition = null;
        /** The ✕ puts the widget away until the header 🎲 asks for it back */
        this.hidden = false;
        this.boardWatcher = null;
    }

    /** Set the walk up; its widget appears with the task board. */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('tasks_rerollWalk')) return;
        this.isInitialized = true;

        await this._loadProtectedHrids();
        await this._loadThresholds();
        try {
            this.panelPosition = await storage.get(PANEL_POSITION_KEY, 'settings', null);
        } catch (error) {
            console.error('[TaskRerollWalk] Loading the widget position failed:', error);
        }

        const unregisterPanel = domObserver.onClass('TaskRerollWalk-Panel', 'TasksPanel_taskSlotCount', (panel) => {
            this._injectButton(panel);
        });
        this.unregisterHandlers.push(unregisterPanel);

        // The widget belongs to the Tasks page: it appears with the board and
        // goes when the board does, rather than following the player around the
        // game offering to reroll something that is not on screen.
        this.boardWatcher = createMutationWatcher(
            document.body,
            (mutations) => {
                // Our own widget's writes must not feed back into this watcher:
                // a render that set a label fired the observer, which rendered,
                // which set the label… and the Tasks page froze solid
                const own = this.widget?.element;
                if (own && mutations.every((m) => own.contains(m.target))) return;
                this._syncWidget();
            },
            { childList: true, subtree: true }
        );
        this.unregisterHandlers.push(() => this.boardWatcher?.());
        this._syncWidget();

        // The only listener the walk has, and it does not click anything: it
        // reads the board again once the game has answered for the click the
        // player made, so the next label describes the task that actually
        // arrived rather than the one that was there before.
        const questHandler = () => {
            if (this.state === 'waiting') this._replanSoon(UI_SETTLE_MS);
        };
        webSocketHook.on('quests_updated', questHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questHandler));
    }

    /** @private */
    async _loadProtectedHrids() {
        try {
            const saved = await storage.getJSON(protectedStorageKey(), 'settings', []);
            this.protectedHrids = new Set(saved);
        } catch (error) {
            console.error('[TaskRerollWalk] Failed to load the protected task list:', error);
        }
    }

    /**
     * Read the shield popup's block thresholds — the same keys it writes, per
     * character with the legacy global as a fallback, so the two features
     * cannot drift apart.
     * @private
     */
    async _loadThresholds() {
        try {
            const charId = dataManager.getCurrentCharacterId() || 'default';
            this.coinThreshold =
                Number(
                    (await storage.get(`taskCapCoinThreshold_${charId}`, 'settings', null)) ??
                        (await storage.get('taskCapCoinThreshold', 'settings', DEFAULT_COIN_THRESHOLD))
                ) || DEFAULT_COIN_THRESHOLD;
            this.cowbellThreshold =
                Number(
                    (await storage.get(`taskCapCowbellThreshold_${charId}`, 'settings', null)) ??
                        (await storage.get('taskCapCowbellThreshold', 'settings', DEFAULT_COWBELL_THRESHOLD))
                ) || DEFAULT_COWBELL_THRESHOLD;
        } catch (error) {
            console.error('[TaskRerollWalk] Failed to read the block-reroll thresholds:', error);
        }
    }

    /**
     * Add the walk's control to the task panel header.
     *
     * It shows and hides the widget rather than starting anything: the widget's
     * own button is what starts a walk, and a header icon that begins spending
     * cowbells is not a header icon anyone wants to brush past.
     *
     * @param {HTMLElement} panel - The TasksPanel_taskSlotCount element
     * @private
     */
    _injectButton(panel) {
        const parent = panel?.parentElement;
        if (!parent || parent.querySelector(`.${BUTTON_CLASS}`)) return;

        const button = document.createElement('span');
        button.className = BUTTON_CLASS;
        button.textContent = '\u{1F3B2}';
        button.title =
            'Reroll walk: show or hide the walk panel. The walk steps down the board one click at a time, ' +
            'leaves protected tasks alone, and stops rerolling a task once the shield popup would block the ' +
            'next reroll.';
        button.style.cssText = 'cursor:pointer; font-size:16px; margin-left:6px; opacity:0.7; transition:opacity 0.1s;';
        button.addEventListener('mouseover', () => {
            button.style.opacity = '1';
        });
        button.addEventListener('mouseout', () => {
            button.style.opacity = '0.7';
        });
        button.addEventListener('click', () => this.toggleWidget());

        parent.appendChild(button);
    }

    // ---------------------------------------------------------------- reading

    /**
     * The board's cards, in the order it draws them.
     * @returns {Array<HTMLElement>}
     * @private
     */
    _cards() {
        const list = document.querySelector(GAME.TASK_LIST);
        if (!list) return [];
        return Array.from(list.querySelectorAll(GAME.TASK_CARD));
    }

    /**
     * The Read button on the board's "You have N unread tasks" notice, when the
     * notice is showing. Found by the notice's own class, not its wording.
     * @returns {HTMLElement|null}
     * @private
     */
    _readButton() {
        const list = document.querySelector(GAME.TASK_LIST);
        return list?.querySelector(`${UNREAD_NOTICE} button`) || null;
    }

    /**
     * The card's own Reroll button — the one that opens the chooser.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _rerollButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /^reroll$/i.test((b.textContent || '').trim())) || null;
    }

    /**
     * The trash can: the game's only button on a resting card with no words on it.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _trashButton(card) {
        const buttons = [...card.querySelectorAll('button')];
        return (
            buttons.find((b) => !(b.textContent || '').trim() && !b.closest('[class^="mwi-"], [class*=" mwi-"]')) ||
            null
        );
    }

    /**
     * The Confirm Discard button, however this build words it.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _discardButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /discard/i.test(b.textContent || '')) || null;
    }

    /**
     * The chooser's Back button.
     * @param {HTMLElement} card - A task card
     * @returns {HTMLElement|null}
     * @private
     */
    _backButton(card) {
        return [...card.querySelectorAll('button')].find((b) => /^back$/i.test((b.textContent || '').trim())) || null;
    }

    /**
     * Is this card waiting to be claimed rather than done with?
     * @param {HTMLElement} card - A task card
     * @returns {boolean}
     * @private
     */
    _isCompleted(card) {
        return [...card.querySelectorAll('button')].some((b) => /claim/i.test(b.textContent || ''));
    }

    // --------------------------------------------------------------- planning

    /**
     * What the next reroll on this card costs: the chooser's own Pay buttons
     * when it is open, the game's price ladder when it is not.
     *
     * @param {Object|null} quest - The card's quest
     * @param {Array<Object>} chooser - From `findRerollOptions`
     * @returns {{coin: number|null, cowbell: number|null, free: boolean}|null}
     * @private
     */
    _costsFor(quest, chooser) {
        const live = costsFromChooser(chooser);
        const ladder = nextRerollCosts(quest);
        if (!ladder && !chooser.length) return null;
        return {
            coin: live.coin ?? ladder?.coin ?? null,
            cowbell: live.cowbell ?? ladder?.cowbell ?? null,
            free: live.free,
        };
    }

    /**
     * What one cowbell is worth in coins, priced the way the task profit display
     * prices it. Wrapped so a market with nothing in it cannot throw the plan.
     * @returns {number}
     * @private
     */
    _cowbellValue() {
        try {
            return Number(getCowbellValue()) || 0;
        } catch (error) {
            console.error('[TaskRerollWalk] Pricing a cowbell failed:', error);
            return 0;
        }
    }

    /**
     * The next thing a press would do, skipping past every card that needs
     * nothing.
     *
     * Skipping is bookkeeping, not a game action, so several cards can be
     * passed over inside one plan — no click happens for any of them.
     *
     * @returns {Object|null} The step, or null when the board is walked (or the walk gave up)
     * @private
     */
    _plan() {
        // Unread tasks first: the board can be carrying a "You have N unread
        // tasks" notice whose Read press reveals them, and rerolling around
        // hidden tasks walks an incomplete board. Offered only before any card
        // press — after that the card indexes must stay put — and re-offered a
        // bounded few times when a press did not clear it, since the notice
        // still standing is the only proof the click reached the game.
        if (!this.walkBegun && this.readPresses < READ_PRESS_LIMIT) {
            const readButton = this._readButton();
            if (readButton) {
                return {
                    kind: 'read',
                    card: readButton.closest(UNREAD_NOTICE) || readButton,
                    slot: 0,
                    label: 'Read unread tasks',
                    button: null,
                    signature: '',
                };
            }
        }

        const trashAtLimit = Boolean(config.getSetting('tasks_rerollWalkTrashAtLimit'));
        const preference = String(config.getSettingValue('tasks_rerollWalkCurrency', 'auto') || 'auto');
        const cowbellValue = this._cowbellValue();
        const cards = this._cards();

        while (this.index < cards.length) {
            const card = cards[this.index];
            const slot = this.index + 1;
            const quest = questForTaskCard(card);
            const hrid = quest?.actionHrid || quest?.monsterHrid || '';

            const chooser = findRerollOptions(card);
            const costs = this._costsFor(quest, chooser);
            const choice = costs
                ? chooseReroll({
                      ...costs,
                      coinThreshold: this.coinThreshold,
                      cowbellThreshold: this.cowbellThreshold,
                      cowbellValue,
                      preference,
                  })
                : null;

            const verdict = verdictForCard({
                completed: this._isCompleted(card),
                isProtected: Boolean(hrid && this.protectedHrids.has(hrid)),
                choice,
                trashAtLimit,
            });

            const discardOpen = this._discardButton(card);

            if (verdict.action === 'skip') {
                // A card being left behind with its menu still open is tidied
                // first — one press, and it is the same press a person makes
                const back = chooser.length || discardOpen ? this._backButton(card) : null;
                if (back) return this._step('back', card, slot, `Close the menu on #${slot}`);
                this.tally.kept += 1;
                this.index += 1;
                continue;
            }

            if (verdict.action === 'trash') {
                if (discardOpen) return this._step('confirmDiscard', card, slot, `Confirm discard #${slot}`);
                if (chooser.length) {
                    const back = this._backButton(card);
                    if (back) return this._step('back', card, slot, `Close the menu on #${slot}`);
                }
                if (!this._trashButton(card)) {
                    this.message = `Slot ${slot} has no discard button — walk stopped.`;
                    return null;
                }
                return this._step('trash', card, slot, `Trash #${slot} (${verdict.reason})`);
            }

            // A reroll: open the chooser, then pay. Two presses, on purpose.
            if (chooser.length) {
                const option = preferredRerollOption(chooser, choice.currency);
                if (!option) {
                    // Options drawn but none pressable is what the chooser looks
                    // like while the game is still answering the last payment —
                    // the buttons come back a moment later. A wait, then; a stop
                    // only once it has stayed that way too long to be that
                    if (this.pendingRetries < PENDING_RETRY_LIMIT) {
                        this.pendingRetries += 1;
                        this.pending = true;
                        return null;
                    }
                    this.message = `No reroll on offer for #${slot} — walk stopped.`;
                    return null;
                }
                this.pendingRetries = 0;
                return this._step('pay', card, slot, `Reroll #${slot} — ${verdict.reason}`, option.button, {
                    currency: choice.currency,
                });
            }
            if (!this._rerollButton(card)) {
                this.message = `Slot ${slot} has no reroll button — walk stopped.`;
                return null;
            }
            return this._step('open', card, slot, `Reroll #${slot} — ${verdict.reason}, open the menu`, null, {
                currency: choice.currency,
            });
        }

        return null;
    }

    /**
     * Record a planned press, with everything needed to prove the board has not
     * moved under it.
     * @param {string} kind - What the press does
     * @param {HTMLElement} card - The card it acts on
     * @param {number} slot - The card's 1-based position
     * @param {string} label - What the widget says
     * @param {HTMLElement} [button] - The exact button, when the plan picked one
     * @param {Object} [extra] - Anything else the press needs, such as the currency
     * @returns {Object} The step
     * @private
     */
    _step(kind, card, slot, label, button = null, extra = {}) {
        return { kind, card, slot, label, button, signature: cardTaskKey(card), ...extra };
    }

    // --------------------------------------------------------------- the walk

    /** Start a walk at the top of the board. */
    start() {
        this.index = 0;
        this.pendingRetries = 0;
        this.pending = false;
        this.readPresses = 0;
        this.walkBegun = false;
        this.tally = { kept: 0, rerolled: 0, trashed: 0 };
        this.message = '';
        this.hidden = false;
        this.timerRegistry.clearAll();
        // Fire and forget: the thresholds were read at start-up, and this only
        // catches an edit made in the shield popup since. It writes two numbers
        // and clicks nothing.
        this._loadThresholds();

        if (!this._cards().length && !this._readButton()) {
            this.state = 'stopped';
            this.message = 'No tasks on the board.';
            this._render();
            return;
        }

        this._replan();
    }

    /** Stop, leaving the board exactly as it is, and put the widget away. */
    stop() {
        this.state = 'idle';
        this.step = null;
        this.hidden = true;
        this.timerRegistry.clearAll();
        this._removeWidget();
    }

    /** The header 🎲: show the widget again, or put it away. */
    toggleWidget() {
        this.hidden = !this.hidden;
        if (this.hidden) this._removeWidget();
        else this._render();
    }

    /**
     * Re-read the board and work out the next press.
     * @private
     */
    _replan() {
        this.pending = false;
        this.step = this._plan();
        if (this.step) {
            this.state = 'ready';
        } else if (this.pending) {
            // The board is mid-answer; look again shortly rather than ending
            this.state = 'waiting';
            this._replanSoon(UI_SETTLE_MS);
        } else {
            this.state = this.message ? 'stopped' : 'done';
        }
        this._render();
    }

    /**
     * Re-plan once the game has finished redrawing.
     * @param {number} delay - How long to leave it
     * @private
     */
    _replanSoon(delay) {
        this.timerRegistry.clearAll();
        const timeout = setTimeout(() => this._replan(), delay);
        this.timerRegistry.registerTimeout(timeout);
    }

    /**
     * Perform the one game click the widget is currently offering.
     *
     * Exactly one click leaves this method, on exactly the button the label
     * named, and only after the board has been checked against the plan. There
     * is no path through it that clicks twice, and nothing it schedules clicks
     * at all — the timer it sets only re-reads the board and rewrites the label.
     *
     * @returns {boolean} Whether the click was made
     */
    advance() {
        if (this.state !== 'ready' || !this.step) return false;

        const planned = this.step;

        // The Read press acts on the unread notice, not a task card, so the
        // slot and signature checks below do not apply to it — the button being
        // findable right now is the whole proof the notice is still there.
        if (planned.kind === 'read') {
            const readButton = this._readButton();
            if (!readButton) {
                // Read elsewhere already — nothing to press, walk on
                this._replan();
                return false;
            }
            clickThroughReact(readButton, { reactFirst: true });
            this.readPresses += 1;
            this.state = 'waiting';
            this._render();
            this._replanSoon(SERVER_SETTLE_MS);
            return true;
        }

        const cards = this._cards();

        if (cards[planned.slot - 1] !== planned.card || !document.contains(planned.card)) {
            return this._abort(`Slot ${planned.slot} is not the card it was — walk stopped.`);
        }
        if (cardTaskKey(planned.card) !== planned.signature) {
            return this._abort(`The task in slot ${planned.slot} changed — walk stopped.`);
        }

        const button = this._buttonFor(planned);
        if (!button || !planned.card.contains(button)) {
            return this._abort(`The button for slot ${planned.slot} is gone — walk stopped.`);
        }

        clickThroughReact(button, { reactFirst: true });
        this.walkBegun = true;

        if (planned.kind === 'pay') this.tally.rerolled += 1;
        if (planned.kind === 'confirmDiscard') this.tally.trashed += 1;

        // A press the server has to answer for waits for its answer; a press
        // that only opened or closed a menu is React state and is back within a
        // frame. Either way what comes back is a label, not another click.
        const serverBound = planned.kind === 'pay' || planned.kind === 'confirmDiscard';
        this.state = 'waiting';
        this._render();
        this._replanSoon(serverBound ? SERVER_SETTLE_MS : UI_SETTLE_MS);
        return true;
    }

    /**
     * Re-derive the button a planned press acts on, from the card as it is now.
     * @param {Object} planned - The step
     * @returns {HTMLElement|null}
     * @private
     */
    _buttonFor(planned) {
        const card = planned.card;
        if (planned.kind === 'open') return this._rerollButton(card);
        if (planned.kind === 'back') return this._backButton(card);
        if (planned.kind === 'trash') return this._trashButton(card);
        if (planned.kind === 'confirmDiscard') return this._discardButton(card);
        if (planned.kind === 'pay') {
            const option = preferredRerollOption(findRerollOptions(card), planned.currency);
            // The chooser must still be offering exactly what the label priced
            if (!option || (planned.button && option.button !== planned.button)) return null;
            return option.button;
        }
        return null;
    }

    /**
     * Stop the walk without clicking anything.
     * @param {string} message - Why
     * @returns {boolean} Always false
     * @private
     */
    _abort(message) {
        this.state = 'stopped';
        this.message = message;
        this.step = null;
        this._render();
        return false;
    }

    // ----------------------------------------------------------------- widget

    /**
     * What the widget's main button says right now.
     * @returns {string}
     */
    chipLabel() {
        if (this.state === 'ready' && this.step) return `▶ ${this.step.label}`;
        if (this.state === 'waiting') return '⏳ Waiting for the game…';
        if (this.state === 'stopped') return `⚠ ${this.message}`;
        if (this.state === 'idle') return '▶ Reroll walk';
        const { kept, rerolled, trashed } = this.tally;
        return `✓ Done — ${kept} kept, ${rerolled} rerolled, ${trashed} trashed`;
    }

    /**
     * Show the widget while the board is on screen, and take it away when the
     * player leaves the Tasks page.
     * @private
     */
    _syncWidget() {
        if (!document.querySelector(GAME.TASK_LIST)) {
            this.widget?.remove();
            this.widget = null;
            return;
        }
        this._render();
    }

    /**
     * Build the widget if it is wanted and not already up.
     * @returns {Object|null} The widget, or null when it is hidden
     * @private
     */
    _ensureWidget() {
        if (this.hidden) {
            this._removeWidget();
            return null;
        }
        if (this.widget && document.body.contains(this.widget.element)) return this.widget;

        const widget = createFloatingWidget({
            id: CHIP_ID,
            top: '110px',
            right: '24px',
            accent: config.COLOR_ACCENT || '#8ecfff',
            positionKey: PANEL_POSITION_KEY,
            position: this.panelPosition,
            mainClass: 'mwi-task-reroll-walk-advance',
            closeClass: 'mwi-task-reroll-walk-stop',
        });
        widget.main.addEventListener('click', () => this._onMainClick());
        widget.close.title = 'Hide the walk. A run in progress stops here, and the board is left exactly as it is.';
        widget.close.addEventListener('click', () => this.stop());
        // After the shell's own toggle, so the drawer is rebuilt with whatever
        // the shield popup's thresholds say the moment it is opened
        widget.gear.addEventListener('click', () => this._renderSettings());

        document.body.appendChild(widget.element);
        this.widget = widget;
        this._renderSettings();
        return widget;
    }

    /** @private */
    _onMainClick() {
        if (this.state === 'ready') {
            this.advance();
            return;
        }
        if (this.state === 'waiting') return;
        this.start();
    }

    /**
     * The walk's own settings, plus the two numbers it obeys but does not own.
     * @private
     */
    _renderSettings() {
        const widget = this.widget;
        if (!widget || !widget.settingsOpen) return;

        widget.settings.replaceChildren();
        widget.settings.append(
            widgetDivider(),
            widgetNote('The walk rerolls a task until the shield popup would block the next reroll.'),
            widgetReadOnlyRow({
                label: 'Block rerolls at',
                value: `${coinLabel(this.coinThreshold)} / ${cowbellLabel(this.cowbellThreshold)}`,
                hint: 'Edited in the 🛡 task-protection popup, not here.',
                title: 'A reroll costing this much or more is blocked, exactly as the shield popup blocks it.',
            }),
            widgetSelectRow({
                key: 'tasks_rerollWalkCurrency',
                fallback: 'auto',
                label: 'Pay with',
                options: [
                    { value: 'auto', label: 'cheapest' },
                    { value: 'cowbell', label: 'cowbells' },
                    { value: 'coin', label: 'coins' },
                ],
                title:
                    'Cheapest compares the two prices in coins, valuing a cowbell through the Bag of 10 Cowbells. ' +
                    'A free reroll is always taken first.',
                onChange: () => {
                    if (this.state === 'ready') this._replan();
                },
            }),
            widgetCheckboxRow({
                key: 'tasks_rerollWalkTrashAtLimit',
                label: 'Discard a task once both reroll options are blocked',
                title: 'Offer the red trash can rather than leaving the task on the board. Off: the walk moves past it.',
                onChange: () => {
                    if (this.state === 'ready') this._replan();
                },
            })
        );
    }

    /** @private */
    _render() {
        const widget = this._ensureWidget();
        if (!widget) return;

        // Idempotent on purpose: a DOM write here is a mutation, and this is
        // called from a mutation watcher
        const label = this.chipLabel();
        if (widget.main.textContent !== label) widget.main.textContent = label;
        const disabled = this.state === 'waiting';
        if (widget.main.disabled !== disabled) widget.main.disabled = disabled;
        const color =
            this.state === 'waiting' ? '#999' : this.state === 'stopped' ? '#ffb74d' : config.COLOR_ACCENT || '#8ecfff';
        if (widget.main.style.color !== color) widget.main.style.color = color;
        const title =
            this.state === 'ready'
                ? 'One press, one game action. Nothing else happens until you press again.'
                : this.state === 'idle'
                  ? 'Start at the top of the board. Every press does one thing, then says what the next would do.'
                  : 'Press to walk the board again from the top.';
        if (widget.main.title !== title) widget.main.title = title;
    }

    /** @private */
    _removeWidget() {
        this.widget?.remove();
        this.widget = null;
        document.getElementById(CHIP_ID)?.remove();
    }

    /** Take the walk's control and widget off the page and stop listening. */
    cleanup() {
        this.stop();
        this.timerRegistry.clearAll();
        for (const unregister of this.unregisterHandlers) {
            try {
                unregister();
            } catch (error) {
                console.error('[TaskRerollWalk] Cleanup failed:', error);
            }
        }
        this.unregisterHandlers = [];
        this.boardWatcher = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.state = 'idle';
        this.step = null;
        this.index = 0;
        this.hidden = false;
        this.isInitialized = false;
    }

    /** Same as cleanup; the feature registry calls one or the other. */
    disable() {
        this.cleanup();
    }
}

const taskRerollWalk = new TaskRerollWalk();

export default {
    name: 'Task Reroll Walk',
    initialize: async () => {
        await taskRerollWalk.initialize();
    },
    cleanup: () => {
        taskRerollWalk.disable();
    },
    disable: () => {
        try {
            taskRerollWalk.disable();
        } catch (error) {
            console.error('[Task Reroll Walk] Disable failed part-way:', error);
        } finally {
            taskRerollWalk.isInitialized = false;
        }
    },
    /** The walk itself, for tests and for anything that wants to drive it */
    walk: taskRerollWalk,
};
