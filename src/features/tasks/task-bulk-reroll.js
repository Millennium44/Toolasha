/**
 * Task Bulk Reroller
 * Adds a stepper button to the task panel header (next to the Claim Reward
 * collector). The game allows one server action per user click, so each click
 * performs exactly one action on the first task that needs one:
 * - a reroll (the MooPass free reroll first, then coins, then cowbells) on a
 *   non-protected task that hasn't hit the per-character reroll limits from the
 *   reroll-protection popup, or
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
import { findRerollOptions, formatBulkRerollLabel, hasMooPass, readFreeRerollOffer } from './task-reroll-options.js';

const BTN_ID = 'mwi-bulk-reroll-btn';

// Coin progression 10K → 320K, cowbell progression 1 → 32 (both hard-capped)
const MIN_COIN_COST = 10000;
const MAX_COIN_COST = 320000;
const MIN_COWBELL_COST = 1;
const MAX_COWBELL_COST = 32;

/**
 * How long a free reroll stays demoted after going nowhere twice.
 *
 * It used to be forever, which is the whole of the bug the third report is
 * about: a MooPass allowance refills, and a latch that never lifts means the
 * one session where two replies were missed is a session — and every session
 * after it, since nothing but disable() cleared it — where the free reroll is
 * never chosen again. Ten minutes is longer than any server hiccup and shorter
 * than a day's allowance.
 */
const FREE_REROLL_STALL_MS = 10 * 60 * 1000;

/** What the header button explains about itself on hover */
const BTN_TITLE =
    'Each click performs one action on the first task that needs one: reroll a non-protected task (the MooPass free reroll first, then coins, then cowbells) until it lands on a protected task or hits the per-character reroll limits from the 🛡️ popup, then discard it once a limit is hit. Tasks rating at or above the board median, and completed tasks, are never touched.';

/**
 * The footnote on a starred cost.
 *
 * A free reroll can only be seen while some card's chooser is open, so a board
 * at rest cannot be priced exactly. Saying so is better than a FREE that turns
 * out to cost 10K.
 */
const MAYBE_FREE_NOTE =
    '\n\n* Your MooPass may make the first reroll free — Toolasha can only see the free option once a task’s Reroll menu is open.';

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

/**
 * What makes one task different from the task that replaced it.
 *
 * A reroll keeps the quest id and changes everything else about it; a free
 * reroll changes the task without moving either reroll counter, so a check that
 * watched only the counters would call every free reroll silent.
 *
 * @param {Object|null|undefined} quest - A character quest
 * @returns {string} A comparable signature
 */
export function questSignature(quest) {
    return [
        quest?.actionHrid || '',
        quest?.monsterHrid || '',
        quest?.goalCount ?? '',
        quest?.coinRerollCount ?? 0,
        quest?.cowbellRerollCount ?? 0,
    ].join('|');
}

export class TaskBulkReroll {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.button = null;
        this.busy = false;
        this.noDeleteIds = new Set(); // questIds whose trash/discard buttons weren't found
        this.noRerollIds = new Set(); // questIds whose chooser offered nothing pressable
        // When free rerolls stop being chosen, and until when. See _actOnCard:
        // preferring a button that does not act is a loop with no way out of it,
        // and demoting it forever is a loop that never lets the pass back in.
        this.freeRerollStalledUntil = 0;
        this.lastClickWasFree = false;
        this.silentFreeClicks = 0;
    }

    /**
     * Is the free reroll currently demoted?
     *
     * An accessor rather than a flag so that setting it books a cooldown: every
     * assignment site wants "stop choosing free for a while", and none of them
     * wants "stop choosing free until the page is reloaded".
     *
     * @returns {boolean}
     */
    get freeRerollStalled() {
        return Date.now() < this.freeRerollStalledUntil;
    }

    set freeRerollStalled(value) {
        this.freeRerollStalledUntil = value ? Date.now() + FREE_REROLL_STALL_MS : 0;
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
            this.noRerollIds.clear();
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
        btn.title = BTN_TITLE;
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

    /**
     * Update the button label to preview the next pending action.
     *
     * The price it quotes is MooPass-aware: a free reroll visible in an open
     * chooser is quoted as FREE, and a board with no chooser open is quoted with
     * a star rather than a promise.
     */
    async _refreshLabel() {
        if (!this.button || this.busy) return;
        try {
            const limits = await this._loadLimits();
            const protectedHrids = await this._loadProtectedHrids();
            const pending = this._collectPending(protectedHrids, limits);
            const next = pending[0] || null;
            const free = readFreeRerollOffer(document);
            const mooPass = hasMooPass();
            this.button.textContent = formatBulkRerollLabel({
                pendingCount: next ? pending.length : 0,
                mode: next?.mode,
                cost: next?.cost,
                free,
                mooPass,
            });
            const starred = this.button.textContent.includes('*');
            this.button.title = starred ? BTN_TITLE + MAYBE_FREE_NOTE : BTN_TITLE;
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
                    // Wait for the server to confirm before previewing the next
                    // action. The confirmation has to be this task's, not any
                    // quests_updated: task progress from whatever the character
                    // is doing produces those constantly, and counting one as
                    // proof would make the free reroll's health check meaningless
                    const confirmed = await this._waitForQuestsUpdate(next.questId, next.signature);
                    if (this.lastClickWasFree) this._noteFreeRerollResult(confirmed);
                    await sleep(400);
                } else if (next.mode === 'delete') {
                    // Trash/discard buttons not found — skip this card so the
                    // next click moves on instead of retrying forever
                    this.noDeleteIds.add(next.questId);
                    console.warn('[TaskBulkReroll] Discard buttons not found on task card');
                } else {
                    // The chooser offered nothing this reroller could press. It
                    // used to return here in silence, which is the click the
                    // player reported as "nothing happens": the label kept
                    // quoting a cost for a card that was never going to move.
                    this.noRerollIds.add(next.questId);
                    console.warn(
                        '[TaskBulkReroll] No usable reroll option on this task card; skipping it. Offered:',
                        findRerollOptions(next.card).map((option) => `${option.text} [${option.kind}]`)
                    );
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
     * @returns {Array<{card: HTMLElement, questId: number, signature: string, mode: string, cost: number}>}
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

            const signature = questSignature(quest);

            if (isAtRerollCap(nextCoinCost, nextCowbellCost, limits)) {
                if (!this.noDeleteIds.has(quest.id)) {
                    pending.push({ card, questId: quest.id, signature, mode: 'delete', cost: 0 });
                }
            } else if (this.noRerollIds.has(quest.id)) {
                continue;
            } else if (nextCoinCost < limits.coin) {
                pending.push({ card, questId: quest.id, signature, mode: 'coin', cost: nextCoinCost });
            } else {
                pending.push({ card, questId: quest.id, signature, mode: 'cowbell', cost: nextCowbellCost });
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
        this.lastClickWasFree = false;
        if (mode === 'delete') return this._discardCard(card);

        let options = findRerollOptions(card);
        if (!options.length) {
            const expandBtn = Array.from(card.querySelectorAll('button')).find(
                (b) => b.textContent.trim().toLowerCase() === 'reroll'
            );
            if (!expandBtn) return false;
            expandBtn.click();
            await sleep(300);
            options = findRerollOptions(card);
        }
        if (!options.length) return false;

        const usable = options.filter((option) => option.available);

        // The free reroll is preferred while it works, and only while it works.
        // A MooPass whose rerolls are spent can leave the button on the card
        // looking exactly as it did — same label, not disabled — and clicking
        // it reaches no server, so every later click chose it again and the
        // bulk reroller never moved off that card. The demotion is a cooldown,
        // not a life sentence: the allowance refills.
        const freeOption = this.freeRerollStalled ? null : usable.find((option) => option.kind === 'free');
        if (freeOption) {
            this.lastClickWasFree = true;
            freeOption.button.click();
            return true;
        }

        const wantKind = mode === 'coin' ? 'coin' : 'cowbell';
        const target = usable.find((option) => option.kind === wantKind);
        if (!target) return false;
        target.button.click();
        return true;
    }

    /**
     * Record how a free reroll went, and stop choosing it if it goes nowhere.
     *
     * Two silent clicks rather than one, because the difference between a
     * MooPass with nothing left on it and a slow server is exactly one missed
     * reply — and treating the slow server as an exhausted pass spends coins
     * the player did not have to spend.
     *
     * @param {boolean} confirmed - Did the server confirm the task changed?
     * @private
     */
    _noteFreeRerollResult(confirmed) {
        if (confirmed) {
            this.silentFreeClicks = 0;
            return;
        }
        this.silentFreeClicks += 1;
        if (this.silentFreeClicks >= 2) {
            this.freeRerollStalled = true;
            console.warn('[TaskBulkReroll] Free reroll is not reaching the server; paying from here on');
        }
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

    /**
     * Resolve once the server confirms THIS task changed (or time out).
     *
     * Any `quests_updated` used to count, and the game sends one every time a
     * task's progress ticks — so a character that was mid-action confirmed
     * every click, including the ones that did nothing, and the free reroll's
     * health check could never notice a click going nowhere. The other way
     * round matters more: a card whose task is genuinely replaced comes back
     * with a different action, goal or reroll count, and that is what is
     * checked for.
     *
     * @param {number} [questId] - The task acted on
     * @param {string} [before] - Its signature before the click
     * @param {number} [timeoutMs=3500] - How long to wait
     * @returns {Promise<boolean>} Did this task change?
     */
    _waitForQuestsUpdate(questId, before, timeoutMs = 3500) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                webSocketHook.off('quests_updated', handler);
                clearTimeout(timer);
                resolve(result);
            };
            const handler = (data) => {
                const quests = data?.endCharacterQuests;
                // Nothing to compare against — an older payload shape, or no
                // task was identified. Any update is taken as confirmation
                // rather than reporting a working reroll as silent.
                if (!Array.isArray(quests) || questId === undefined || before === undefined) {
                    finish(true);
                    return;
                }
                const updated = quests.find((quest) => quest?.id === questId);
                // The task left the board entirely: discarded, or replaced by
                // one the server gave a new id
                if (!updated) {
                    finish(true);
                    return;
                }
                if (questSignature(updated) !== before) finish(true);
            };
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
        this.noRerollIds.clear();
        this.freeRerollStalled = false;
        this.lastClickWasFree = false;
        this.silentFreeClicks = 0;
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
