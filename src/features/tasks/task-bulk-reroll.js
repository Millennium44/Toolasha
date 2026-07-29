/**
 * Task Bulk Reroller
 * Adds a "Reroll Tasks" button to the task panel header (next to the Claim
 * Reward collector button). One click runs a pass over every task card:
 * non-protected tasks are rerolled — coins first, then cowbells — until they
 * land on a protected task or hit the per-character reroll limits from the
 * reroll-protection popup; a task at the limit for both categories is deleted.
 * Completed tasks (Claim Reward showing) are never touched. Clicking the
 * button again stops the pass.
 *
 * Limit semantics match cap protection: a category's rerolls are spent while
 * the next reroll's cost is below the configured threshold, so the minimum
 * threshold (10K coins / 1 cowbell) means zero rerolls in that category.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';

const BTN_ID = 'mwi-bulk-reroll-btn';
const MAX_ACTIONS_PER_RUN = 150;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class TaskBulkReroll {
    constructor() {
        this.isInitialized = false;
        this.unregisterObserver = null;
        this.button = null;
        this.running = false;
        this.actionsDone = 0;
        this.lastNote = '';
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('taskBulkReroll')) return;
        this.isInitialized = true;

        this.unregisterObserver = domObserver.onClass('TaskBulkReroll', 'TasksPanel_taskSlotCount', (headerElement) =>
            this._ensureButton(headerElement)
        );
    }

    _ensureButton(headerElement) {
        if (document.getElementById(BTN_ID)) return;

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.className = 'Button_button__1Fe9z Button_small__3fqC7';
        btn.style.cssText = 'margin-left: 8px;';
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
        this._updateButton();
    }

    _updateButton() {
        if (!this.button) return;
        if (this.running) {
            this.button.textContent = `⏹ Stop (${this.actionsDone})`;
            this.button.title = 'Stop the bulk reroll pass';
        } else {
            this.button.textContent = '🎲 Reroll Tasks';
            this.button.title =
                'Reroll every non-protected task (coins first, then cowbells) until it lands on a protected task or hits the per-character reroll limits from the 🛡️ popup; tasks at the limit for both categories are deleted. Completed tasks are never touched.' +
                (this.lastNote ? `\nLast run: ${this.lastNote}` : '');
        }
    }

    _onClick() {
        if (this.running) {
            this.running = false;
            this._updateButton();
            return;
        }
        this._run();
    }

    async _run() {
        this.running = true;
        this.actionsDone = 0;
        this.lastNote = '';
        this._updateButton();
        let deletes = 0;
        let rerolls = 0;
        try {
            const limits = await this._loadLimits();
            const protectedHrids = await this._loadProtectedHrids();
            const cardState = new Map(); // questId → { stalled, noDelete }

            while (this.running && this.actionsDone < MAX_ACTIONS_PER_RUN) {
                const next = this._findNextAction(protectedHrids, limits, cardState);
                if (!next) break;

                const acted = await this._actOnCard(next.card, next.mode);
                if (!acted) {
                    // Button not found — remember so this card can't loop forever
                    const state = cardState.get(next.questId) || {};
                    if (next.mode === 'delete') state.noDelete = true;
                    else state.stalled = true;
                    cardState.set(next.questId, state);
                    continue;
                }

                this.actionsDone++;
                if (next.mode === 'delete') deletes++;
                else rerolls++;
                this._updateButton();

                const updated = await this._waitForQuestsUpdate();
                if (!updated) {
                    // Server never confirmed — don't retry this card blindly
                    const state = cardState.get(next.questId) || {};
                    state.stalled = true;
                    cardState.set(next.questId, state);
                }
                // Let React re-render the task list before the next evaluation
                await sleep(500);
            }
        } catch (error) {
            console.error('[TaskBulkReroll] Run failed:', error);
        }
        this.running = false;
        this.lastNote = `${rerolls} rerolls, ${deletes} deletes`;
        this._updateButton();
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
     * Pick the next card to act on and how.
     * Coin rerolls are spent before cowbell rerolls; a card below neither
     * limit is deleted (at the limit for both categories).
     */
    _findNextAction(protectedHrids, limits, cardState) {
        const cards = document.querySelectorAll('[class*="RandomTask_randomTask"]');
        for (const card of cards) {
            // Completed task — claimable, leave it alone
            if (card.querySelector('button[class*="Button_buy"]')) continue;

            const quest = this._getQuestFromCard(card);
            if (!quest) continue;
            const hrid = quest.actionHrid || quest.monsterHrid || '';
            if (hrid && protectedHrids.has(hrid)) continue;

            const state = cardState.get(quest.id) || {};
            if (state.stalled) continue;

            const nextCoinCost = Math.min(10000 * Math.pow(2, quest.coinRerollCount || 0), 320000);
            const nextCowbellCost = Math.min(Math.pow(2, quest.cowbellRerollCount || 0), 32);
            if (nextCoinCost < limits.coin) return { card, questId: quest.id, mode: 'coin' };
            if (nextCowbellCost < limits.cowbell) return { card, questId: quest.id, mode: 'cowbell' };
            if (!state.noDelete) return { card, questId: quest.id, mode: 'delete' };
        }
        return null;
    }

    /**
     * Perform one action on a card: a coin/cowbell reroll (free reroll
     * preferred when offered) or a delete. Returns false if the needed
     * button couldn't be found.
     */
    async _actOnCard(card, mode) {
        if (mode === 'delete') return this._deleteCard(card);

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
     * Delete a task that is at the limit for both categories. Looks for the
     * game's delete button on the card (expanding the reroll options if
     * needed) and confirms any dialog that appears.
     */
    async _deleteCard(card) {
        const findDelete = () =>
            Array.from(card.querySelectorAll('button')).find((b) => /delete|discard|abandon/i.test(b.textContent));

        let deleteBtn = findDelete();
        if (!deleteBtn) {
            const expandBtn = Array.from(card.querySelectorAll('button')).find(
                (b) => b.textContent.trim().toLowerCase() === 'reroll'
            );
            if (expandBtn) {
                expandBtn.click();
                await sleep(300);
                deleteBtn = findDelete();
            }
        }
        if (!deleteBtn) return false;
        deleteBtn.click();

        // Confirm dialog, if the game asks
        await sleep(300);
        const modal = document.querySelector('[class*="Modal_modalContainer"]');
        if (modal) {
            const confirmBtn = Array.from(modal.querySelectorAll('button')).find((b) =>
                /delete|confirm|yes/i.test(b.textContent)
            );
            confirmBtn?.click();
        }
        return true;
    }

    /** Resolve until the server confirms the task change (or time out) */
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
        this.running = false;
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        if (this.button) {
            this.button.remove();
            this.button = null;
        }
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
