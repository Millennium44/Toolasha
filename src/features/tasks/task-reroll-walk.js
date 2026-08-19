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
 *  - `tasks_rerollWalkMaxRerolls` — how many rerolls a single task is worth,
 *    counted against the rerolls the server says have already been spent on it,
 *    so a task that arrived half-rerolled is not given a fresh budget;
 *  - `tasks_rerollWalkTrashAtLimit` — what to do with a task that has used up
 *    its budget: offer the trash can, or move past it.
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
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { cardTaskKey } from './task-card-state.js';
import { questForTaskCard } from './task-card-quest.js';
import { findRerollOptions } from './task-reroll-options.js';

const CHIP_ID = 'mwi-task-reroll-walk-chip';
const BUTTON_CLASS = 'mwi-task-reroll-walk-btn';
const PROTECTED_KEY_PREFIX = 'taskProtectedHrids';

/** How long the walk waits for the game to redraw a card after a UI-only click */
const UI_SETTLE_MS = 120;
/** How long it waits for a reroll or discard to come back from the server */
const SERVER_SETTLE_MS = 2500;

/** @returns {string} The protected-task list's key for the current character */
function protectedStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${PROTECTED_KEY_PREFIX}_${charId}`;
}

/**
 * The reroll option a walk should press, out of what the chooser is offering.
 *
 * Free first, because it costs nothing; then cowbells, which is what a player
 * setting out to reroll a whole board is normally spending; coins last. The
 * label always names the choice before it is pressed, so a walk that is about
 * to spend coins says so.
 *
 * @param {Array<{kind: string, available: boolean}>} options - What the chooser offers
 * @returns {Object|null} The option to press, or null when none is available
 */
export function preferredRerollOption(options) {
    const usable = (options || []).filter((option) => option.available);
    for (const kind of ['free', 'cowbell', 'coin']) {
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
 * @param {number|null} params.rerollsSpent - Rerolls the server says have been spent, or null when unreadable
 * @param {number} params.maxRerolls - The configured budget per task
 * @param {boolean} params.trashAtLimit - Discard a task that has used its budget?
 * @returns {{action: string, reason: string}} 'reroll', 'trash' or 'skip', and why
 */
export function verdictForCard({ completed, isProtected, rerollsSpent, maxRerolls, trashAtLimit }) {
    if (completed) return { action: 'skip', reason: 'ready to claim' };
    if (isProtected) return { action: 'skip', reason: 'protected' };
    // A card whose quest cannot be read cannot be judged either, and guessing is
    // how a walk rerolls something the player was keeping
    if (rerollsSpent === null || rerollsSpent === undefined) return { action: 'skip', reason: 'unreadable' };
    if (rerollsSpent < maxRerolls) return { action: 'reroll', reason: `${rerollsSpent}/${maxRerolls}` };
    return trashAtLimit ? { action: 'trash', reason: 'limit reached' } : { action: 'skip', reason: 'limit reached' };
}

class TaskRerollWalk {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        this.protectedHrids = new Set();
        /** idle | ready | waiting | done | stopped */
        this.state = 'idle';
        this.step = null;
        this.message = '';
        this.index = 0;
        this.tally = { kept: 0, rerolled: 0, trashed: 0 };
    }

    /** Set the walk up; it draws nothing until the player presses its control. */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('tasks_rerollWalk')) return;
        this.isInitialized = true;

        await this._loadProtectedHrids();

        const unregisterPanel = domObserver.onClass('TaskRerollWalk-Panel', 'TasksPanel_taskSlotCount', (panel) => {
            this._injectButton(panel);
        });
        this.unregisterHandlers.push(unregisterPanel);

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
     * Add the walk's control to the task panel header.
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
            'Reroll walk: step down the board one click at a time. Protected tasks are left alone; each ' +
            'press does exactly one thing and then tells you what the next press would do.';
        button.style.cssText = 'cursor:pointer; font-size:16px; margin-left:6px; opacity:0.7; transition:opacity 0.1s;';
        button.addEventListener('mouseover', () => {
            button.style.opacity = '1';
        });
        button.addEventListener('mouseout', () => {
            button.style.opacity = '0.7';
        });
        button.addEventListener('click', () => this.start());

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
        const maxRerolls = Number(config.getSettingValue('tasks_rerollWalkMaxRerolls', 3)) || 0;
        const trashAtLimit = Boolean(config.getSetting('tasks_rerollWalkTrashAtLimit'));
        const cards = this._cards();

        while (this.index < cards.length) {
            const card = cards[this.index];
            const slot = this.index + 1;
            const quest = questForTaskCard(card);
            const hrid = quest?.actionHrid || quest?.monsterHrid || '';
            const rerollsSpent = quest ? (quest.coinRerollCount || 0) + (quest.cowbellRerollCount || 0) : null;

            const verdict = verdictForCard({
                completed: this._isCompleted(card),
                isProtected: Boolean(hrid && this.protectedHrids.has(hrid)),
                rerollsSpent,
                maxRerolls,
                trashAtLimit,
            });

            const chooser = findRerollOptions(card);
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
                const option = preferredRerollOption(chooser);
                if (!option) {
                    this.message = `No reroll on offer for #${slot} — walk stopped.`;
                    return null;
                }
                const label = `Reroll #${slot} (${verdict.reason}) — ${this._costLabel(option)}`;
                return this._step('pay', card, slot, label, option.button);
            }
            if (!this._rerollButton(card)) {
                this.message = `Slot ${slot} has no reroll button — walk stopped.`;
                return null;
            }
            return this._step('open', card, slot, `Reroll #${slot} (${verdict.reason}) — open the menu`);
        }

        return null;
    }

    /**
     * What one reroll option costs, in words.
     * @param {{kind: string, cost: number|null}} option - A reroll option
     * @returns {string}
     * @private
     */
    _costLabel(option) {
        if (option.kind === 'free') return 'free';
        const cost = option.cost === null || option.cost === undefined ? null : option.cost;
        if (option.kind === 'cowbell') return `${cost === null ? '?' : cost}\u{1F514}`;
        return `${cost === null ? '?' : formatKMB(cost)}\u{1F4B0}`;
    }

    /**
     * Record a planned press, with everything needed to prove the board has not
     * moved under it.
     * @param {string} kind - What the press does
     * @param {HTMLElement} card - The card it acts on
     * @param {number} slot - The card's 1-based position
     * @param {string} label - What the chip says
     * @param {HTMLElement} [button] - The exact button, when the plan picked one
     * @returns {Object} The step
     * @private
     */
    _step(kind, card, slot, label, button = null) {
        return { kind, card, slot, label, button, signature: cardTaskKey(card) };
    }

    // --------------------------------------------------------------- the walk

    /** Start a walk at the top of the board. */
    start() {
        this.index = 0;
        this.tally = { kept: 0, rerolled: 0, trashed: 0 };
        this.message = '';
        this.timerRegistry.clearAll();

        if (!this._cards().length) {
            this.state = 'stopped';
            this.message = 'No tasks on the board.';
            this._render();
            return;
        }

        this._replan();
    }

    /** Stop, leaving the board exactly as it is. */
    stop() {
        this.state = 'idle';
        this.step = null;
        this.timerRegistry.clearAll();
        this._removeChip();
    }

    /**
     * Re-read the board and work out the next press.
     * @private
     */
    _replan() {
        this.step = this._plan();
        if (this.step) {
            this.state = 'ready';
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
     * Perform the one game click the chip is currently offering.
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
            const option = preferredRerollOption(findRerollOptions(card));
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

    // ------------------------------------------------------------------- chip

    /**
     * What the chip says right now.
     * @returns {string}
     */
    chipLabel() {
        if (this.state === 'ready' && this.step) return `▶ ${this.step.label}`;
        if (this.state === 'waiting') return '⏳ Waiting for the game…';
        if (this.state === 'stopped') return `⚠ ${this.message}`;
        const { kept, rerolled, trashed } = this.tally;
        return `✓ Done — ${kept} kept, ${rerolled} rerolled, ${trashed} trashed`;
    }

    /** @private */
    _render() {
        if (this.state === 'idle') {
            this._removeChip();
            return;
        }

        let chip = document.getElementById(CHIP_ID);
        if (!chip) {
            chip = document.createElement('div');
            chip.id = CHIP_ID;
            chip.style.cssText = [
                'position:fixed',
                'bottom:18px',
                'right:18px',
                `z-index:${config.Z_FLOATING_PANEL || 9999}`,
                'display:flex',
                'align-items:center',
                'gap:8px',
                'background:rgba(20,20,24,0.95)',
                'border:1px solid rgba(255,255,255,0.18)',
                'border-radius:4px',
                'padding:6px 10px',
                'font-size:12px',
            ].join(';');

            const advance = document.createElement('button');
            advance.className = 'mwi-task-reroll-walk-advance';
            advance.style.cssText = 'background:none;border:none;color:inherit;cursor:pointer;font-size:12px;padding:0';
            advance.addEventListener('click', () => this.advance());

            const dismiss = document.createElement('button');
            dismiss.className = 'mwi-task-reroll-walk-stop';
            dismiss.textContent = '✕';
            dismiss.title = 'Stop here — the board is left exactly as it is.';
            dismiss.style.cssText = 'background:none;border:none;color:#999;cursor:pointer;font-size:12px;padding:0';
            dismiss.addEventListener('click', () => this.stop());

            chip.append(advance, dismiss);
            document.body.appendChild(chip);
        }

        const advance = chip.querySelector('.mwi-task-reroll-walk-advance');
        advance.textContent = this.chipLabel();
        advance.disabled = this.state !== 'ready';
        advance.style.color = this.state === 'ready' ? config.COLOR_ACCENT || '#8ecfff' : '#999';
        advance.title =
            this.state === 'ready' ? 'One press, one game action. Nothing else happens until you press again.' : '';
    }

    /** @private */
    _removeChip() {
        document.getElementById(CHIP_ID)?.remove();
    }

    /** Take the walk's control and chip off the page and stop listening. */
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
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.state = 'idle';
        this.step = null;
        this.index = 0;
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
        taskRerollWalk.disable();
    },
    /** The walk itself, for tests and for anything that wants to drive it */
    walk: taskRerollWalk,
};
