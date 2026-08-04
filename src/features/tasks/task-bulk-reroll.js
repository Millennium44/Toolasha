/**
 * Task Bulk Reroller
 * Adds a stepper button to the task panel header (next to the Claim Reward
 * collector). The game allows one server action per user click, so each click
 * performs exactly one action on the first task that needs one:
 * - a reroll (coins first, then cowbells) on a non-protected task that hasn't
 *   hit the per-character reroll limits from the reroll-protection popup, or
 * - a discard (Back if the reroll view is open → trash can icon → "Confirm
 *   Discard") once a task is at the limit for both categories.
 * The button label always previews the next action. Tasks that land on a
 * protected target, tasks rating at or above the visible board's median, and
 * completed tasks (Claim Reward showing) are all left alone.
 *
 * Limit semantics match cap protection: a category's rerolls are spent while
 * the next reroll's cost is below the configured threshold, so the minimum
 * threshold (10K coins / 1 cowbell) means zero rerolls in that category, and a
 * card is at cap once EITHER category's limit is hit.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { readVisibleTaskRatings } from './task-profit-display.js';
import { formatKMB } from '../../utils/formatters.js';

const BTN_ID = 'mwi-bulk-reroll-btn';

// Coin progression 10K → 320K, cowbell progression 1 → 32 (both hard-capped)
const MIN_COIN_COST = 10000;
const MAX_COIN_COST = 320000;
const MIN_COWBELL_COST = 1;
const MAX_COWBELL_COST = 32;

/**
 * Is a card at the reroll cap?
 *
 * Same rule cap protection paints its orange edge with: a card is done being
 * rerolled once EITHER category hits its limit, not once both have. A category
 * whose threshold allows zero rerolls is trivially at cap from the start, so it
 * is ignored unless it is the only category configured that way.
 *
 * @param {number} nextCoinCost - Coins the next coin reroll would cost
 * @param {number} nextCowbellCost - Cowbells the next cowbell reroll would cost
 * @param {{coin: number, cowbell: number}} limits - Configured thresholds
 * @returns {boolean}
 */
export function isAtRerollCap(nextCoinCost, nextCowbellCost, limits) {
    const coinAtCap = nextCoinCost >= limits.coin;
    const cowbellAtCap = nextCowbellCost >= limits.cowbell;
    const coinZero = limits.coin <= MIN_COIN_COST;
    const cowbellZero = limits.cowbell <= MIN_COWBELL_COST;
    if (coinZero && !cowbellZero) return cowbellAtCap;
    if (cowbellZero && !coinZero) return coinAtCap;
    return coinAtCap || cowbellAtCap;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class TaskBulkReroll {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.button = null;
        this.busy = false;
        this.noDeleteIds = new Set(); // questIds whose trash/discard buttons weren't found
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('taskBulkReroll')) return;
        this.isInitialized = true;

        const unregisterPanel = domObserver.onClass('TaskBulkReroll', 'TasksPanel_taskSlotCount', (headerElement) => {
            this._ensureButton(headerElement);
            this._refreshLabel();
        });
        this.unregisterHandlers.push(unregisterPanel);

        // Re-evaluate the next action whenever the server confirms task changes
        const questHandler = () => {
            this.noDeleteIds.clear();
            setTimeout(() => this._refreshLabel(), 400);
        };
        webSocketHook.on('quests_updated', questHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('quests_updated', questHandler));
    }

    _ensureButton(headerElement) {
        if (document.getElementById(BTN_ID)) return;

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.className = 'Button_button__1Fe9z Button_small__3fqC7';
        btn.style.cssText = 'margin-left: 8px;';
        btn.textContent = '🎲 Reroll Next';
        btn.title =
            'Each click performs one action on the first task that needs one: reroll a non-protected task (coins first, then cowbells) until it lands on a protected task or hits the per-character reroll limits from the 🛡️ popup, then discard it once a limit is hit. Tasks rating at or above the board median, and completed tasks, are never touched.';
        btn.addEventListener('click', () => this._onClick());

        const claimBtn = headerElement.querySelector('#mwi-claim-proxy-btn');
        const highlightBtn = headerElement.querySelector('[data-mwi-task-highlight]');
        if (claimBtn) {
            claimBtn.after(btn);
        } else if (highlightBtn) {
            highlightBtn.after(btn);
        } else {
            headerElement.appendChild(btn);
        }
        this.button = btn;
    }

    /** Update the button label to preview the next pending action */
    async _refreshLabel() {
        if (!this.button || this.busy) return;
        try {
            const limits = await this._loadLimits();
            const protectedHrids = await this._loadProtectedHrids();
            const pending = this._collectPending(protectedHrids, limits);
            const next = pending[0] || null;
            if (!next) {
                this.button.textContent = '✓ Tasks settled';
            } else if (next.mode === 'delete') {
                this.button.textContent = `🗑 Discard Task (${pending.length})`;
            } else {
                const costLabel = next.mode === 'coin' ? `${formatKMB(next.cost)}💰` : `${next.cost}🔔`;
                this.button.textContent = `🎲 Reroll ${costLabel} (${pending.length})`;
            }
        } catch (error) {
            console.error('[TaskBulkReroll] Failed to refresh label:', error);
        }
    }

    /** One click = one server action on the first pending task */
    async _onClick() {
        if (this.busy) return;
        this.busy = true;
        if (this.button) this.button.textContent = '…';
        try {
            const limits = await this._loadLimits();
            const protectedHrids = await this._loadProtectedHrids();
            const next = this._collectPending(protectedHrids, limits)[0];
            if (next) {
                const acted = await this._actOnCard(next.card, next.mode);
                if (acted) {
                    // Wait for the server to confirm before previewing the next action
                    await this._waitForQuestsUpdate();
                    await sleep(400);
                } else if (next.mode === 'delete') {
                    // Trash/discard buttons not found — skip this card so the
                    // next click moves on instead of retrying forever
                    this.noDeleteIds.add(next.questId);
                    console.warn('[TaskBulkReroll] Discard buttons not found on task card');
                }
            }
        } catch (error) {
            console.error('[TaskBulkReroll] Action failed:', error);
        }
        this.busy = false;
        this._refreshLabel();
    }

    /**
     * Load reroll limits: per-character cap thresholds shared with the
     * reroll-protection popup, falling back to the legacy global values.
     */
    async _loadLimits() {
        const charId = dataManager.getCurrentCharacterId() || 'default';
        const coin =
            (await storage.get(`taskCapCoinThreshold_${charId}`, 'settings', null)) ??
            (await storage.get('taskCapCoinThreshold', 'settings', 320000));
        const cowbell =
            (await storage.get(`taskCapCowbellThreshold_${charId}`, 'settings', null)) ??
            (await storage.get('taskCapCowbellThreshold', 'settings', 32));
        return { coin, cowbell };
    }

    /** Load the per-character protected task list (same storage as the 🛡️ popup) */
    async _loadProtectedHrids() {
        const charId = dataManager.getCurrentCharacterId() || 'default';
        const saved = await storage.getJSON(`taskProtectedHrids_${charId}`, 'settings', []);
        return new Set(saved);
    }

    /**
     * Collect every card that still needs an action, in task-list order.
     *
     * Cards rating at or above the visible board's median are left alone — a
     * bulk reroll that chews through the good tasks along with the bad is worse
     * than not running it. Below that, coin rerolls are spent before cowbell
     * ones, and a card at the cap is discarded.
     *
     * @returns {Array<{card: HTMLElement, questId: number, mode: string, cost: number}>}
     */
    _collectPending(protectedHrids, limits) {
        const pending = [];
        const cards = Array.from(document.querySelectorAll('[class*="RandomTask_randomTask"]'));
        const board = readVisibleTaskRatings(cards);

        for (const card of cards) {
            // Completed task — claimable, leave it alone
            if (card.querySelector('button[class*="Button_buy"]')) continue;

            const quest = this._getQuestFromCard(card);
            if (!quest) continue;
            const hrid = quest.actionHrid || quest.monsterHrid || '';
            if (hrid && protectedHrids.has(hrid)) continue;

            // Good task by the board's own numbers — never reroll or discard it
            const rating = board.entries.get(card);
            if (board.median !== null && rating && rating.value >= board.median) continue;

            const nextCoinCost = Math.min(MIN_COIN_COST * Math.pow(2, quest.coinRerollCount || 0), MAX_COIN_COST);
            const nextCowbellCost = Math.min(Math.pow(2, quest.cowbellRerollCount || 0), MAX_COWBELL_COST);

            if (isAtRerollCap(nextCoinCost, nextCowbellCost, limits)) {
                if (!this.noDeleteIds.has(quest.id)) {
                    pending.push({ card, questId: quest.id, mode: 'delete', cost: 0 });
                }
            } else if (nextCoinCost < limits.coin) {
                pending.push({ card, questId: quest.id, mode: 'coin', cost: nextCoinCost });
            } else {
                pending.push({ card, questId: quest.id, mode: 'cowbell', cost: nextCowbellCost });
            }
        }
        return pending;
    }

    /**
     * Perform one server action on a card: a coin/cowbell reroll (free reroll
     * preferred when offered) or a discard. Expanding menus and confirm
     * dialogs are UI-only clicks — exactly one click reaches the server.
     * Returns false if the needed button couldn't be found.
     */
    async _actOnCard(card, mode) {
        if (mode === 'delete') return this._discardCard(card);

        let payButtons = this._findPayButtons(card);
        if (!payButtons.length) {
            const expandBtn = Array.from(card.querySelectorAll('button')).find(
                (b) => b.textContent.trim().toLowerCase() === 'reroll'
            );
            if (!expandBtn) return false;
            expandBtn.click();
            await sleep(300);
            payButtons = this._findPayButtons(card);
        }
        if (!payButtons.length) return false;

        const freeBtn = payButtons.find((b) => b.textContent.toLowerCase().includes('free'));
        if (freeBtn) {
            freeBtn.click();
            return true;
        }
        const wantCoin = mode === 'coin';
        const target = payButtons.find((b) => this._isCoinCost(b.textContent) === wantCoin);
        if (!target) return false;
        target.click();
        return true;
    }

    /** Pay/Free reroll buttons currently visible on a card */
    _findPayButtons(card) {
        return Array.from(card.querySelectorAll('button')).filter((b) => {
            if (b.disabled) return false;
            const text = b.textContent.trim();
            return text.startsWith('Pay') || text.toLowerCase().includes('free');
        });
    }

    /** Coin costs render as 10K+; cowbell costs are plain small numbers */
    _isCoinCost(btnText) {
        const match = btnText.match(/([\d,]+)\s*(K?)/);
        if (!match) return false;
        const raw = parseInt(match[1].replace(/,/g, ''), 10);
        const cost = match[2] === 'K' ? raw * 1000 : raw;
        return cost >= 1000;
    }

    /**
     * Discard a task at the limit for both categories. The full flow is
     * Back (when the card is on the reroll options view, which hides the
     * trash can) → trash can icon → "Confirm Discard". All three clicks run
     * off the one button press; only the confirmation is the server action.
     */
    async _discardCard(card) {
        // The trash can is an icon-only red (danger) button in the card's
        // default view, next to Reroll/Go which always carry text
        const findTrash = () => {
            const dangerBtn = Array.from(card.querySelectorAll('button[class*="danger" i]')).find(
                (b) => !b.textContent.trim()
            );
            if (dangerBtn) return dangerBtn;
            const iconOnlyBtn = Array.from(card.querySelectorAll('button')).find(
                (b) => !b.textContent.trim() && b.querySelector('svg')
            );
            if (iconOnlyBtn) return iconOnlyBtn;
            const trashTarget =
                card.querySelector('use[href*="trash" i]') || card.querySelector('svg[class*="trash" i]');
            return trashTarget?.closest('button, [role="button"], svg') || trashTarget || null;
        };
        const findConfirm = () =>
            Array.from(card.querySelectorAll('button')).find((b) => /discard/i.test(b.textContent));

        let trashBtn = findTrash();
        if (!trashBtn) {
            // Reroll options view is open (a prior reroll left it expanded) —
            // click Back to return to the card view with the trash can
            const backBtn = Array.from(card.querySelectorAll('button')).find(
                (b) => b.textContent.trim().toLowerCase() === 'back'
            );
            if (backBtn) {
                backBtn.click();
                await sleep(300);
                trashBtn = findTrash();
            }
        }
        if (!trashBtn) return false;
        trashBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        await sleep(300);
        let discardBtn = findConfirm();
        if (!discardBtn) {
            await sleep(400);
            discardBtn = findConfirm();
        }
        if (!discardBtn) return false;
        discardBtn.click();
        return true;
    }

    /** Resolve once the server confirms the task change (or time out) */
    _waitForQuestsUpdate(timeoutMs = 3500) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                webSocketHook.off('quests_updated', handler);
                clearTimeout(timer);
                resolve(result);
            };
            const handler = () => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            webSocketHook.on('quests_updated', handler);
        });
    }

    /**
     * Extract quest data from a task card via React fiber traversal
     * (same approach as task reroll protection).
     */
    _getQuestFromCard(taskCard) {
        const rootEl = document.getElementById('root');
        const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function walk(fiber, target) {
            if (!fiber) return null;
            if (fiber.stateNode === target) return fiber;
            return walk(fiber.child, target) || walk(fiber.sibling, target);
        }

        function findQuestInFiber(startFiber) {
            let f = startFiber?.return;
            while (f) {
                if (f.memoizedProps?.characterQuest) {
                    return f.memoizedProps.characterQuest;
                }
                f = f.return;
            }
            return null;
        }

        const anchors = [
            taskCard.querySelector('button.Button_success__6d6kU'),
            taskCard.querySelector('button'),
            taskCard.querySelector('[class*="RandomTask_name"]'),
            taskCard,
        ];

        for (const anchor of anchors) {
            if (!anchor) continue;
            const fiber = walk(rootFiber, anchor);
            if (fiber) {
                const quest = findQuestInFiber(fiber);
                if (quest) return quest;
            }
        }

        return null;
    }

    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        if (this.button) {
            this.button.remove();
            this.button = null;
        }
        this.busy = false;
        this.noDeleteIds.clear();
        this.isInitialized = false;
    }
}

const taskBulkReroll = new TaskBulkReroll();

export default {
    name: 'Task Bulk Reroller',
    initialize: () => {
        taskBulkReroll.initialize();
    },
    cleanup: () => {
        taskBulkReroll.disable();
    },
    disable: () => {
        taskBulkReroll.disable();
    },
};
