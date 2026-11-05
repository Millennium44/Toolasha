/**
 * Guided crafting walk.
 *
 * The crafting plan already says what to make and in what order; what it cannot
 * do from a list is put you in front of each step. This walks the plan: it opens
 * the game on one step's action, types that step's count into the game's own
 * count box, and then stops. Adapted from MWITools semiAutoTrain,
 * CC-BY-NC-SA-4.0, see third-party/mwitools/.
 *
 * **One user click is one game action, always.** The walk never presses a game
 * button. It navigates and it pre-fills; the press that queues the action is
 * always the player's, on the game's own control, and the walk only advances
 * once the server has answered that press with an `actions_updated` naming the
 * action the step asked for. Nothing is chained, nothing fires on a timer.
 *
 * A step the plan says to buy rather than craft opens the marketplace on that
 * item instead, and waits for the item to actually arrive in the inventory
 * before moving on — the purchase, like the queue press, is the player's.
 *
 * A step may also name an item that has to be *selected* before its count means
 * anything — an alchemy action is one action for every item in the game, and the
 * item is chosen in a slot the game gives no handler for. Such a step navigates
 * to the action and then waits, without pre-filling, until the panel itself says
 * the named item is in the slot: a count typed against the wrong item is a count
 * the player did not ask for, and the press that follows it is theirs.
 *
 * The walk lives in memory only: a reload ends it, a character switch ends it,
 * and Stop ends it. Nothing about it is written anywhere.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { getInventoryCount } from '../../utils/house-cost-calculator.js';
import { navigateToAction, navigateToAlchemyItem } from '../../utils/item-navigation.js';
import { selectAlchemyTab } from '../../utils/alchemy-navigation.js';
import { readAlchemyTabType } from '../alchemy/alchemy-tabs.js';
import { isMobileMode } from '../../utils/mobile.js';
import { makeDraggable } from '../../utils/floating-panel.js';
import { clampPanelToViewport, clearPosition, restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { registerFloatingPanel, unregisterFloatingPanel } from '../../utils/panel-z-index.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { findActionInput, resolveDetailPanel } from '../../utils/action-panel-helper.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';
import { markToolashaSurface } from '../../utils/surface-marker.js';
import { GAME_COLORS, GAME_FRAME, styleGameButton } from '../../utils/game-look.js';
import { normalizePlannedSurplus } from './crafting-plan-surplus.js';

const STRIP_ID = 'mwi-crafting-walk-strip';

/** Where the bar's position is remembered (the shared panel-geometry record, as for every movable panel) */
const STRIP_GEOMETRY_KEY = 'craftingWalkStrip';
/** The smallest the bar may be pushed to by the clamp */
const STRIP_MIN = { width: 120, height: 24 };
const CURRENT_CLASS = 'mwi-crafting-walk-current';

/** Attribute the plan display tags its rows with, so a step can point at its own row */
export const WALK_KEY_ATTRIBUTE = 'data-mwi-walk-key';

/** How long to leave the game to draw the action panel before looking for its count box */
const NAV_SETTLE_MS = 100;
/** How many of those waits to spend before giving up on pre-filling a step */
const NAV_RETRY_LIMIT = 15;

/**
 * How often to look again for a step whose item the player still has to select.
 *
 * Slower than {@link NAV_SETTLE_MS} and not spent against the navigation
 * retries, because this is not waiting on the game to draw — it is waiting on a
 * person to put an item in a slot. The idle timeout below is what ends it.
 */
const ITEM_WAIT_POLL_MS = 500;

/**
 * How the alchemy item is held in the slot. The game's item-menu handler sets its override for one tick only, and
 * the game re-picks the slot itself when a row starts running or the tab changes, so the slot is read back and the
 * handler re-asserted a bounded number of times rather than trusted once.
 */
const ALCHEMY_SETTLE_MS = 600;
const ALCHEMY_RETRY_MS = 700;
const ALCHEMY_WATCH_MS = 1000;
/** Re-assertions in a row before the walk leaves the choice to the player, and in total for one step */
const ALCHEMY_ATTEMPTS_PER_RUN = 6;
const ALCHEMY_ATTEMPTS_TOTAL = 30;
/** Writes to one count box before the walk stops fighting a box that will not keep the figure */
const COUNT_WRITES_PER_BOX = 5;
/**
 * How long after a step starts (or after its item arrives in the bag) the walk may navigate or click a tab to put the
 * item right. After that the player is in charge of the panel: a mismatch is reported, never undone.
 */
const ALCHEMY_ASSERT_WINDOW_MS = 10_000;

/**
 * How long a step may sit untouched before the walk ends itself.
 *
 * The walk waits on a press, not on a craft: the press that queues an hour of
 * cheesesmithing arrives in seconds. A step still waiting a quarter of an hour
 * later is a player who walked away, and a walk that outlives their attention
 * is a strip on screen pointing at a plan they have stopped following.
 */
const IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * The one step a plan node contributes, or null when it contributes none.
 *
 * The rejections are the plan's, not the walk's: coins are not bought on the
 * marketplace, a leg the plan sized at nothing is nothing to do, and a craft leg
 * with no action behind it cannot be opened. Exported because anything that
 * reasons about the same steps — the merge across several plans above all — must
 * agree with the walk about which nodes are steps and what each one is called,
 * and a second copy of this predicate is a second answer waiting to diverge.
 *
 * @param {Object} node - A `CraftingPlanNode`
 * @returns {{key: string, kind: 'craft'|'buy', itemHrid: string, itemName: string,
 *   actionHrid: string|null, count: number, actions: number, outputCount: number}|null} The step, or null
 */
export function walkStepFor(node) {
    if (!node) return null;
    if (node.itemHrid === '/items/coin') return null;
    const count = Math.ceil(node.stepCount ?? node.quantity);
    if (!(count > 0)) return null;
    const isCraft = node.strategy === 'craft';
    if (isCraft && !node.actionHrid) return null;
    if (isCraft && !(node.actionsNeeded > 0)) return null;

    return {
        key: isCraft ? `craft:${node.actionHrid}` : `buy:${node.itemHrid}`,
        kind: isCraft ? 'craft' : 'buy',
        itemHrid: node.itemHrid,
        itemName: node.itemName,
        actionHrid: isCraft ? node.actionHrid : null,
        count,
        actions: isCraft ? node.actionsNeeded || 0 : 0,
        outputCount: isCraft ? node.outputCount || 1 : 1,
    };
}

/**
 * Flatten a computed plan into the steps a walk performs, leaves first.
 *
 * Nodes are collected in post-order and repeated action rows are merged. A
 * stable dependency ordering then accounts for material and planned-surplus
 * prerequisites found on later occurrences of a merged action.
 *
 * Coins are not a step (they are not bought on the marketplace), and neither is
 * a leg the plan sized at nothing.
 *
 * @param {Object} plan - Root `CraftingPlanNode` from `computeBestCraftingPlan`
 * @param {Object} [options]
 * @param {boolean} [options.surplusNormalized=false] - Whether planned output has already been reconciled
 * @param {Array<Object>} [options.inventory] - Effective unenhanced bag inventory available to the walk
 * @returns {Array<{key: string, kind: 'craft'|'buy', itemHrid: string, itemName: string,
 *   actionHrid: string|null, count: number, actions: number, outputCount: number}>} Steps in dependency order
 */
export function buildWalkSteps(plan, { surplusNormalized = false, inventory = [] } = {}) {
    const steps = [];
    const byKey = new Map();
    const executionPlan = surplusNormalized ? plan : normalizePlannedSurplus(plan, { inventory });
    const craftDemandByKey = new Map();

    (function collectCraftDemand(node) {
        if (!node) return;
        if (node.strategy === 'craft' && node.actionHrid) {
            const count = Math.ceil(node.stepCount ?? node.quantity);
            if (count > 0) {
                const key = `craft:${node.actionHrid}`;
                craftDemandByKey.set(key, (craftDemandByKey.get(key) || 0) + count);
            }
        }
        for (const child of node.children || []) collectCraftDemand(child);
    })(executionPlan);

    const emit = (node) => {
        const step = walkStepFor(node);
        if (!step) return;

        const existing = byKey.get(step.key);
        if (existing) {
            existing.count += step.count;
            // Each node was normalized in traversal order, so its action count
            // already reflects surplus consumed by prior branches.
            existing.actions += step.actions;
            return;
        }

        byKey.set(step.key, step);
        steps.push(step);
    };

    (function walk(node) {
        if (!node) return;
        for (const child of node.children || []) walk(child);
        emit(node);
    })(executionPlan);

    const walkIndex = new Map(steps.map((step, index) => [step.key, index]));
    const before = new Map(steps.map((step) => [step.key, new Set()]));
    const after = new Map(steps.map((step) => [step.key, new Set()]));
    const addDependency = (producer, consumer) => {
        if (!producer || !consumer || producer === consumer || !before.has(producer) || !before.has(consumer)) return;
        before.get(consumer).add(producer);
        after.get(producer).add(consumer);
    };

    (function collectDependencies(node, consumerKey) {
        if (!node) return;
        const key = walkStepFor(node)?.key || null;
        for (const dependency of node.plannedDependencies || []) addDependency(dependency, consumerKey);
        for (const child of node.children || []) collectDependencies(child, key || consumerKey);
        addDependency(key, consumerKey);
    })(executionPlan, null);

    const remainingBefore = new Map([...before].map(([key, dependencies]) => [key, dependencies.size]));
    const ready = [...before.keys()].filter((key) => remainingBefore.get(key) === 0);
    const ordered = [];
    while (ready.length > 0) {
        ready.sort((left, right) => walkIndex.get(left) - walkIndex.get(right));
        const key = ready.shift();
        ordered.push(byKey.get(key));
        for (const consumer of after.get(key)) {
            const remaining = remainingBefore.get(consumer) - 1;
            remainingBefore.set(consumer, remaining);
            if (remaining === 0) ready.push(consumer);
        }
    }

    // Surplus reconciliation can reduce a later repeated node to zero actions.
    // Its demand still belongs in the step label, even though its actions have
    // already been covered by an earlier craft (or by owned inventory).
    const orderedSteps = ordered.length === steps.length ? ordered : steps;
    for (const step of orderedSteps) {
        if (step.kind === 'craft') step.count = craftDemandByKey.get(step.key) || step.count;
    }

    return orderedSteps;
}

/**
 * The item an action panel currently has selected, for the actions that are
 * chosen by item rather than being an action apiece.
 *
 * Read off the requirement row's sprite, which is the only place the game states
 * it — there is no handler and no field to ask.
 *
 * @param {HTMLElement} panel - An action detail panel
 * @returns {string|null} Item hrid, or null when nothing is selected
 */
function selectedItemHrid(panel) {
    const use = panel.querySelector(
        '[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"] svg use'
    );
    // Many item icons carry only the namespaced attribute
    const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
    const id = href.split('#')[1];
    return id ? `/items/${id}` : null;
}

/** Human wording for one step, e.g. `craft 40 Rough Leather`. */
function stepLabel(step) {
    const verb = step.kind === 'craft' ? 'craft' : 'buy';
    const base = step.label || `${verb} ${formatWithSeparator(step.count)} ${step.itemName}`;
    const warn = step.warn ? ` ⚠ ${step.warn}` : '';
    // A step that has been queued has nothing left to press: it says so, and keeps any warning in view
    if (step.done) return `${step.kind === 'craft' ? 'Queued' : 'Done'} ✓ ${base}${warn}`;
    // The count box, said truthfully for the steps that type one: "filled" only when the box was read back showing it
    const countNote =
        step.verifyCount && step.actions > 0
            ? step.countFilled
                ? ` — count ${formatWithSeparator(step.actions)} filled`
                : step.playerEdited
                  ? ` — count box left as you set it (the plan asks for ${formatWithSeparator(step.actions)})`
                  : ` — type ${formatWithSeparator(step.actions)} in the count box`
            : '';
    if (!step.alchemyType) return `${base}${countNote}${warn}`;
    // Said plainly, because the script never presses a game button: the player's press queues the row.
    // "In the slot" only when the slot was read showing the item.
    let pressNote;
    if (step.itemSelected) {
        pressNote = `${step.itemName} is in the slot; the Start press is yours`;
    } else if (step.itemAbsent) {
        pressNote =
            `${step.itemName} is not in your bag yet, so the game cannot offer it. It is chosen for you as soon as ` +
            'it arrives; Skip to leave this for later';
    } else {
        pressNote = `choose ${step.itemName} in the slot, then press Start`;
    }
    const slot = step.slotNote ? ` (${step.slotNote})` : '';
    return `${base}${countNote} — ${pressNote}${slot}${warn}`;
}

/** The starter name Crafting Plan's own surfaces (the plan's Walk button, the task board's walk) use */
export const CRAFTING_PLAN_STARTER = 'crafting-plan';

class CraftingPlanWalk {
    constructor() {
        this.isInitialized = false;
        /** Who started the running walk (see {@link CraftingPlanWalk#start}), null when none */
        this.starter = null;
        /** Crafting Plan was turned off while another surface's walk was running; finish the teardown when it ends */
        this._disablePending = false;
        this.unregisterHandlers = [];
        this.timerRegistry = createTimerRegistry();
        /** @type {Array<Object>} */
        this.steps = [];
        this.index = 0;
        this.active = false;
        /** What the inventory must reach before a buy step is satisfied */
        this.buyTarget = 0;
        /**
         * Action ids already queued for the current step's action when the step
         * began. `endCharacterActions` carries existing actions alongside new
         * ones, so a step whose action the player had queued already — or is
         * performing right now — would otherwise advance on the next queue
         * event of any kind, with nothing pressed.
         * @type {Set<*>}
         */
        this.queuedBefore = new Set();
        /** Why the walk ended, shown in the strip until it is dismissed */
        this.message = '';
        /** @type {((step: Object) => void)|null} The seam hook itself */
        this._stepHook = null;
        /**
         * Whether {@link _stepHook} was installed for the walk that is about to
         * start, rather than left behind by the last one. Assigning the hook
         * raises it; {@link start} lowers it, having kept the hook only if it
         * was raised; {@link stop} clears both.
         */
        this._stepHookFresh = false;
    }

    /**
     * The reservation seam.
     *
     * Called once per step, with that step, immediately before the walk
     * navigates anywhere for it — early enough that a caller can reserve the
     * step's materials against the inventory ledger before the player is put in
     * front of the button that spends them. Set it to a function immediately
     * before {@link start}; it is never called twice for the same visit to a
     * step, and a throw from it is logged and does not stop the walk.
     *
     * Owned by ONE walk. The walk is a singleton three surfaces share and the
     * third of them — the ironcow queue walk — installs no hook at all, so a
     * hook that outlived its own walk would fire for somebody else's steps and
     * re-reserve a finished plan's materials against a bag it has no claim on
     * — restamping a claim the ledger's TTL was about to expire, and sizing it
     * against an inventory another walk is spending. So {@link stop} drops it
     * and {@link start} keeps only a hook installed since the last stop.
     * @type {((step: Object) => void)|null}
     */
    get onStepAboutToRun() {
        return this._stepHook;
    }

    set onStepAboutToRun(fn) {
        this._stepHook = typeof fn === 'function' ? fn : null;
        this._stepHookFresh = true;
    }

    /** Subscribe to the two messages the walk advances on, and to the switch that ends it. */
    initialize() {
        // A re-enable while an Iron Cow walk was keeping the listeners alive: they stay
        this._disablePending = false;
        if (this.isInitialized) return;
        // Two surfaces drive this one walk: the action panel's plan and the task
        // board's merged walk. Either setting on is a reason to be listening.
        if (!config.getSetting('craftingPlan_guidedWalk') && !config.getSetting('tasks_mergedCraftingWalk')) return;
        this._listen();
    }

    /**
     * Subscribe, whoever asked for the walk.
     *
     * Split from {@link initialize} because the settings gate above governs the
     * crafting plan's own two surfaces, and a walk started by a third — a panel
     * behind a setting of its own — must still advance and must still end on a
     * character switch. A walk that is running and not listening is a strip that
     * never moves.
     * @private
     */
    _listen() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const onActions = (data) => this._onActionsUpdated(data);
        webSocketHook.on('actions_updated', onActions);
        this.unregisterHandlers.push(() => webSocketHook.off('actions_updated', onActions));

        const onItems = () => this._onItemsUpdated();
        dataManager.on('items_updated', onItems);
        this.unregisterHandlers.push(() => dataManager.off?.('items_updated', onItems));

        // The plan, the counts and the inventory the walk is stepping through all
        // belong to the character that started it; none of them survive a switch.
        const onSwitch = () => this.stop('Character switched — the walk ended.');
        dataManager.on('character_switching', onSwitch);
        this.unregisterHandlers.push(() => dataManager.off?.('character_switching', onSwitch));
    }

    /**
     * Begin walking a set of steps.
     * @param {Array<Object>} steps - From {@link buildWalkSteps}
     * @param {Object} [options]
     * @param {string} [options.finalNote] - Said at the end of the walk (for example rows waiting behind one that never ends)
     * @param {string} [starter] - Who started it. Crafting Plan's own surfaces take the default; the Iron Cow
     *   queue walk passes its own name, so turning Crafting Plan off does not end its walk
     * @returns {boolean} Whether a walk started
     */
    start(steps, starter = CRAFTING_PLAN_STARTER, { finalNote = '' } = {}) {
        if (!Array.isArray(steps) || steps.length === 0) return false;
        // Someone wants this walk running: a deferred disable no longer applies
        this._disablePending = false;
        this._listen();
        // Captured across the reset below, and only when this walk's own caller
        // installed it: `stop()` drops the hook, and a caller that installs one
        // does so immediately before starting
        const hook = this._stepHookFresh ? this._stepHook : null;
        this.stop('');
        this._stepHook = hook;
        this._stepHookFresh = false;
        this.starter = starter;
        this.steps = steps;
        this.finalNote = finalNote;
        this.index = 0;
        this.active = true;
        this.message = '';
        this._runStep();
        return true;
    }

    /**
     * What the strip says when the last step is over: "complete" only for a full success. Steps that were skipped are
     * named and said not to be queued; a count warning and any note the caller asked for stay in view.
     * @param {string} warn - The last step's count warning, if any
     * @returns {string}
     * @private
     */
    _endMessage(warn) {
        const names = [
            ...new Set(this.steps.filter((step) => step.skipped).map((step) => step.shortName || step.itemName)),
        ];
        const lead =
            names.length === 0
                ? 'Walk complete.'
                : `Walk finished: ${names.join(' and ')} ${names.length === 1 ? 'was' : 'were'} skipped, so ` +
                  `${names.length === 1 ? 'it is' : 'they are'} not queued.`;
        const queued = this.steps[this.steps.length - 1]?.done ? 'Queued ✓ ' : '';
        return `${queued}${lead}${warn ? ` ⚠ ${warn}` : ''}${this.finalNote ? ` ${this.finalNote}` : ''}`;
    }

    /** Leave this step undone and move to the next. */
    skip() {
        if (!this.active) return;
        const step = this.currentStep();
        // Left undone on purpose: said at the end, because it is not queued
        if (step && !step.done) step.skipped = true;
        this._advance();
    }

    /**
     * End the walk, leaving the game exactly where it is.
     * @param {string} [message] - Why, shown in the strip; empty removes the strip
     */
    stop(message = '') {
        this.active = false;
        this.starter = null;
        this.steps = [];
        this.index = 0;
        this.buyTarget = 0;
        this.queuedBefore = new Set();
        this._alchemyTickNow = null;
        this._fillCleanup?.();
        this._fillCleanup = null;
        this.finalNote = '';
        this.message = message;
        // The hook belonged to the walk that just ended; see its own comment
        this._stepHook = null;
        this._stepHookFresh = false;
        this.timerRegistry.clearAll();
        this._clearHighlight();
        if (message) this._render();
        else this._removeStrip();
        // A disable that was held back for another surface's walk completes when that walk ends
        if (this._disablePending) this._teardown();
    }

    /** The step the walk is currently standing on, or null. @returns {Object|null} */
    currentStep() {
        return this.active ? this.steps[this.index] || null : null;
    }

    /**
     * Open the game on the current step and pre-fill it. Presses nothing.
     * @private
     */
    _runStep() {
        const step = this.steps[this.index];
        if (!step) {
            this.stop('Walk complete.');
            return;
        }

        // A step starts unfinished and unwarned, whatever a previous walk of the same object left behind
        step.done = false;
        step.warn = '';

        // The seam: everything that must happen before the player is put in
        // front of this step's button happens here, once, ahead of the
        // navigation — a materials reservation above all.
        try {
            this.onStepAboutToRun?.(step);
        } catch (error) {
            console.error('[CraftingPlanWalk] The step hook failed:', error);
        }

        if (step.kind === 'buy') {
            // Measured before navigating: the target is what the player holds now
            // plus what this step buys, so a partial fill does not advance early
            this.buyTarget = getInventoryCount(step.itemHrid) + step.count;
            this.queuedBefore = new Set();
            navigateToMarketplace(step.itemHrid);
        } else {
            // Snapshotted before the player can press anything: only an action
            // id this step did not start with is their press on this step
            this.queuedBefore = this._queuedIdsFor(step.actionHrid, step.requiresItemHrid);
            let opened = false;
            if (step.requiresItemHrid && step.alchemyType) {
                // Alchemy is one action for every item: the game's own item-menu handler opens it with the item
                // already in the slot (when it is in the bag), and the tab is then chosen by position. Both are
                // navigation; the press that queues the row stays the player's.
                step.itemSelected = false;
                step.itemAbsent = getInventoryCount(step.requiresItemHrid) <= 0;
                step.slotNote = '';
                step.warn = '';
                // An item that is not in the bag cannot be offered by the game: only the action is opened, and
                // the item is chosen as soon as it arrives
                if (!step.itemAbsent) {
                    opened = navigateToAlchemyItem(step.requiresItemHrid, step.alchemyType).opened;
                    if (opened) this._selectTab(step);
                }
                this._watchAlchemyItem(step, opened);
            }
            if (!opened && !navigateToAction(step.actionHrid)) {
                this.stop('The game could not be opened on the next step.');
                return;
            }
            this._prefillSoon(step);
        }

        this._armIdleTimeout();
        this._render();
    }

    /** Choose the step's alchemy tab by position, for as long as the step is the current one. @private */
    _selectTab(step) {
        selectAlchemyTab(step.alchemyType, this.timerRegistry.scheduleTimeout, () => {
            return this.active && this.steps[this.index] === step;
        });
    }

    /**
     * Keep the right item in the alchemy slot for as long as the step waits.
     *
     * The slot is read back (`href` and `xlink:href`), and the step says "in the slot" only when it was read
     * showing the item. The handler is re-asserted, bounded, when the slot or the tab is not right, and again if it
     * changes while the step waits (the game re-picks the slot when a row starts running). An item that is not in
     * the bag cannot be offered, so nothing is asserted until it arrives, and then it is chosen at once.
     * Navigation only: nothing is pressed.
     *
     * @param {Object} step
     * @param {boolean} openedAlready - The first assertion was made by `_runStep`
     * @private
     */
    _watchAlchemyItem(step, openedAlready) {
        let runAttempts = openedAlready ? 1 : 0;
        let totalAttempts = openedAlready ? 1 : 0;
        // The short window in which the walk may put the item right: right after the step starts, and again right
        // after the item arrives in the bag. Outside it the player is in charge of the panel.
        let assertUntil = Date.now() + ALCHEMY_ASSERT_WINDOW_MS;
        const current = () => this.active && this.steps[this.index] === step && !step.done;

        /** One look at the slot and the tab; may put the item right, only inside the window. @returns {boolean} ready */
        const look = () => {
            const held = getInventoryCount(step.requiresItemHrid) > 0;
            const tab = readAlchemyTabType();
            const shown = selectedItemHrid(document);
            const ready = shown === step.requiresItemHrid && (tab === null || tab === step.alchemyType);
            const before = `${step.itemSelected}|${step.itemAbsent}|${step.slotNote}`;
            if (ready) {
                step.itemSelected = true;
                step.itemAbsent = false;
                step.slotNote = '';
                runAttempts = 0;
            } else {
                step.itemSelected = false;
                step.itemAbsent = !held;
                const mayAssert =
                    held &&
                    Date.now() <= assertUntil &&
                    runAttempts < ALCHEMY_ATTEMPTS_PER_RUN &&
                    totalAttempts < ALCHEMY_ATTEMPTS_TOTAL;
                if (mayAssert) {
                    runAttempts++;
                    totalAttempts++;
                    navigateToAlchemyItem(step.requiresItemHrid, step.alchemyType);
                    this._selectTab(step);
                    step.slotNote = '';
                } else if (held) {
                    // The player is in charge now: say what the panel shows, and leave it alone
                    const wrongTab = tab !== null && tab !== step.alchemyType;
                    const otherItem = shown && shown !== step.requiresItemHrid;
                    const otherName = otherItem ? dataManager.getItemDetails?.(shown)?.name || 'another item' : '';
                    step.slotNote = wrongTab
                        ? `the ${tab} tab is open, not ${step.alchemyType}`
                        : otherItem
                          ? `the slot shows ${otherName}`
                          : shown
                            ? ''
                            : 'the alchemy panel is not showing this item';
                }
            }
            if (before !== `${step.itemSelected}|${step.itemAbsent}|${step.slotNote}`) this._render();
            return ready;
        };

        // One chain of timers per step. An items_updated only looks now: it adds no timer and refills no budget.
        const tick = () => {
            if (!current()) return;
            const ready = look();
            this.timerRegistry.scheduleTimeout(tick, ready ? ALCHEMY_WATCH_MS : ALCHEMY_RETRY_MS);
        };
        this._alchemyTickNow = () => {
            if (!current() || step.itemSelected) return;
            // The item has just arrived in the bag: a fresh short window to choose it, nothing more is refilled
            if (step.itemAbsent && getInventoryCount(step.requiresItemHrid) > 0) {
                assertUntil = Date.now() + ALCHEMY_ASSERT_WINDOW_MS;
            }
            look();
        };
        this.timerRegistry.scheduleTimeout(tick, ALCHEMY_SETTLE_MS);
    }

    /**
     * Type the step's action count into the game's own count box, once the panel
     * the game navigated to is confirmed to be the step's own.
     *
     * Re-verified rather than assumed: navigation is asynchronous and the player
     * may have moved on themselves, and a count typed into somebody else's panel
     * is a count the player did not ask for.
     * @param {Object} step
     * @private
     */
    _prefillSoon(step) {
        if (!(step.actions > 0)) return;
        const figure = String(step.actions);
        let retries = 0;
        let lastInput = null;
        let writes = 0;
        // The value in the box when last looked at (after our write): any other change is not ours
        let observed = null;
        step.countFilled = false;
        step.playerEdited = false;

        // The player typing in the count box is theirs: a trusted input event there ends our filling for
        // good. (Our own writes are synthetic, so they never count as the player's.)
        const onInput = (event) => {
            if (event.isTrusted && event.target?.closest?.('[class*="maxActionCountInput"]')) step.playerEdited = true;
        };
        document.addEventListener('input', onInput, true);
        this._fillCleanup = () => document.removeEventListener('input', onInput, true);

        const setFilled = (value) => {
            if (step.countFilled === value) return;
            step.countFilled = value;
            this._render();
        };

        const tryFill = () => {
            if (!this.active || this.steps[this.index] !== step || step.done) return;

            let input = null;
            if (step.alchemyType) {
                // Alchemy is one panel for every tab and item, so it is the step's own when the tab and the
                // item in the slot are, not by an action hrid the panel does not carry
                const panel =
                    document.querySelector(GAME.SKILL_ACTION_DETAIL_ALCHEMY) ||
                    document.querySelector(GAME.SKILL_ACTION_DETAIL);
                const tab = readAlchemyTabType();
                const ready =
                    panel &&
                    selectedItemHrid(document) === step.requiresItemHrid &&
                    (tab === null || tab === step.alchemyType);
                input = ready ? findActionInput(panel) : null;
            } else {
                const panel = document.querySelector(GAME.SKILL_ACTION_DETAIL);
                if (panel && resolveDetailPanel(panel)?.actionHrid === step.actionHrid) {
                    input = findActionInput(panel);
                }
            }

            // The same box showing something the walk did not write — the game's ∞ toggle, a quick button, typing
            // without an input event — is the player's choice: filling stops for this step
            if (input && input === lastInput && observed !== null && input.value !== observed) {
                step.playerEdited = true;
            }
            if (input && step.playerEdited) {
                setFilled(input.value === figure);
                return;
            }
            if (input && !step.playerEdited) {
                // Written through React's own setter, and again whenever the box is a new element (the form
                // remounted) or no longer shows the figure; then read back: "filled" is only said if it shows it
                if (input !== lastInput) writes = 0;
                if ((input !== lastInput || input.value !== figure) && writes < COUNT_WRITES_PER_BOX) {
                    writes++;
                    setReactInputValue(input, step.actions, { focus: false });
                }
                lastInput = input;
                observed = input.value;
                setFilled(input.value === figure);
            } else if (!input) {
                lastInput = null;
                setFilled(false);
            }

            // Keep watching for as long as the step waits, so a remount that clears the box is filled again;
            // the first look gives up after a bounded wait for a panel that never comes
            if (input || step.requiresItemHrid || ++retries < NAV_RETRY_LIMIT) {
                const wait = step.countFilled
                    ? ALCHEMY_WATCH_MS
                    : step.requiresItemHrid
                      ? ITEM_WAIT_POLL_MS
                      : NAV_SETTLE_MS;
                this.timerRegistry.scheduleTimeout(tryFill, wait);
            }
        };

        this.timerRegistry.scheduleTimeout(tryFill, NAV_SETTLE_MS);
    }

    /**
     * The ids of the actions already queued for one action hrid.
     * @param {string} actionHrid
     * @param {string|null} [requiresItemHrid] - For an action that is chosen by item
     * @returns {Set<*>}
     * @private
     */
    _queuedIdsFor(actionHrid, requiresItemHrid = null) {
        const rows = dataManager.getCurrentActions?.() || [];
        return new Set(
            rows
                .filter(
                    (row) =>
                        row?.actionHrid === actionHrid &&
                        (!requiresItemHrid || row.primaryItemHash?.includes(requiresItemHrid))
                )
                .map((row) => row.id)
        );
    }

    /**
     * A craft step is done when the server says an action the step named has
     * been ADDED to the queue. Any other `actions_updated` — a completion
     * elsewhere, somebody else's queue edit — names other actions and moves
     * nothing.
     *
     * Added, not merely present: `endCharacterActions` carries existing actions
     * alongside new ones, so a step whose action was already in the queue when
     * the step began (the player queued some of it themselves, or is running it
     * right now) matched on the first queue event of any kind and skipped
     * itself, unpressed and uncrafted. Only an id the step did not start with
     * is the player's press.
     *
     * @param {Object} data - The `actions_updated` payload
     * @private
     */
    _onActionsUpdated(data) {
        const step = this.currentStep();
        if (!step || step.kind !== 'craft' || step.done) return;
        const rows = data?.endCharacterActions;
        if (!Array.isArray(rows)) return;
        const isThisStep = (row) =>
            row?.actionHrid === step.actionHrid &&
            !this.queuedBefore.has(row.id) &&
            // One alchemy action covers every item in the game, so the action
            // alone does not say this step was the one pressed.
            (!step.requiresItemHrid || row.primaryItemHash?.includes(step.requiresItemHrid));
        const added = rows.find(isThisStep);
        if (!added) {
            // A row for this action but another item is not this step's press; say what happened
            const other = rows.find(
                (row) =>
                    row?.actionHrid === step.actionHrid &&
                    !this.queuedBefore.has(row.id) &&
                    step.requiresItemHrid &&
                    row.primaryItemHash
            );
            if (other) {
                const hrid = String(other.primaryItemHash).split('::')[2];
                const name = (hrid && dataManager.getItemDetails?.(hrid)?.name) || 'another item';
                step.warn = `${name} was queued instead of ${step.itemName}; it does not count for this step`;
                this._render();
            }
            return;
        }
        // A step that asks for it is checked against what the server kept: a server cap would otherwise
        // leave the queue quietly short of what was typed
        if (step.unlimited) {
            // A Repeat ∞ step is checked for what it is: no count on the row
            if (added.hasMaxCount) {
                step.warn =
                    `It was queued with a count of ${formatWithSeparator(Number(added.maxCount))} instead of ` +
                    'Repeat ∞, so it will stop short. Walk it again to queue the rest';
            }
        } else if (step.verifyCount) {
            const stored = added.hasMaxCount ? Number(added.maxCount) : null;
            if (stored !== step.count) {
                const kept = stored === null ? 'with no count' : `${formatWithSeparator(stored)}`;
                step.warn =
                    `The game queued ${kept} instead of the ${formatWithSeparator(step.count)} typed, so the ` +
                    'queue is short. Walk it again to queue the rest';
            }
        }
        this._finishStep(step);
    }

    /**
     * A step has been queued (or bought). The walk does NOT move on: the next step opens, selects and fills only
     * when the player presses Next, so one press of theirs is one thing the game does. The last step ends the
     * walk in a Done state. Any count warning stays on the finished step rather than being lost.
     * @param {Object} step
     * @private
     */
    _finishStep(step) {
        step.done = true;
        this.timerRegistry.clearAll();
        this._alchemyTickNow = null;
        this._fillCleanup?.();
        this._fillCleanup = null;
        this._clearHighlight();
        if (this.index >= this.steps.length - 1) {
            this.stop(this._endMessage(step.warn));
            return;
        }
        this._armIdleTimeout();
        this._render();
    }

    /**
     * The player's press on Next: open the following step. Ignored unless the current step is finished, so a
     * double press cannot skip one (the second press finds an unfinished step).
     */
    next() {
        if (!this.active) return;
        if (!this.currentStep()?.done) return;
        this._advance();
    }

    /**
     * A buy step is done when the item is actually held. Reading the count back
     * rather than trusting the purchase means a cancelled or partial buy leaves
     * the walk where it was.
     * @private
     */
    _onItemsUpdated() {
        const step = this.currentStep();
        if (step?.alchemyType && step.itemAbsent) this._alchemyTickNow?.();
        if (!step || step.kind !== 'buy' || step.done) return;
        if (getInventoryCount(step.itemHrid) < this.buyTarget) return;
        this._finishStep(step);
    }

    /** @private */
    _advance() {
        this.timerRegistry.clearAll();
        this._fillCleanup?.();
        this._fillCleanup = null;
        this.index += 1;
        if (this.index >= this.steps.length) {
            this.stop(this._endMessage(''));
            return;
        }
        this._runStep();
    }

    /**
     * End a walk nobody is watching any more.
     * @private
     */
    _armIdleTimeout() {
        this.timerRegistry.scheduleTimeout(
            () => this.stop('The walk ended after a long wait on one step.'),
            IDLE_TIMEOUT_MS
        );
    }

    // === Strip ===

    /**
     * The strip is fixed to the page rather than seated in the plan section: the
     * walk's whole job is to navigate away from the panel that plan was drawn
     * on, and a strip living inside it would go with the first step.
     * @private
     */
    _strip() {
        let strip = document.getElementById(STRIP_ID);
        if (strip) return strip;

        strip = document.createElement('div');
        strip.id = STRIP_ID;
        const mobile = this._mobile();
        // Fixed, and placed by script (never by a centering transform) so it can be dragged and clamped. Full
        // width and not draggable on a phone; the label wraps rather than hiding the figure it asks for.
        strip.style.cssText = `
            position: fixed; z-index: 150; display: flex; align-items: center; gap: 10px;
            ${mobile ? 'left: 8px; right: 8px;' : 'max-width: min(760px, calc(100vw - 24px));'}
            padding: 6px 12px; box-sizing: border-box;
            border: ${GAME_FRAME.border}; border-radius: 14px;
            background: ${GAME_FRAME.background}; color: ${GAME_COLORS.text};
            font-size: 0.85em; box-shadow: ${GAME_FRAME.boxShadow};
        `;

        if (!mobile) {
            // A clear handle, not hover-only: a grip glyph with a label for assistive tech
            const handle = document.createElement('span');
            handle.dataset.role = 'handle';
            handle.textContent = '⠿';
            handle.title = 'Drag to move. Double-click to put it back.';
            handle.setAttribute('aria-label', 'Move the walk bar');
            handle.style.cssText =
                'cursor: grab; user-select: none; padding: 2px 6px; margin: -2px 0 -2px -6px; font-size: 1.3em;' +
                'line-height: 1; color: ' +
                GAME_COLORS.text +
                '; opacity: 0.85; flex-shrink: 0;';
            strip.appendChild(handle);
        }

        const label = document.createElement('span');
        label.dataset.role = 'label';
        label.style.cssText = 'min-width: 0; overflow-wrap: anywhere; white-space: normal; line-height: 1.25;';
        strip.appendChild(label);

        const next = this._stripButton('Next', () => this.next());
        next.dataset.role = 'next';
        next.hidden = true;
        strip.appendChild(next);

        const skip = this._stripButton('Skip', () => this.skip());
        skip.dataset.role = 'skip';
        strip.appendChild(skip);

        const stop = this._stripButton('Stop', () => this.stop(''));
        stop.dataset.role = 'stop';
        strip.appendChild(stop);

        markToolashaSurface(strip, 'panel');
        document.body.appendChild(strip);
        this._placeStrip(strip, mobile);
        return strip;
    }

    /** Phone-sized and touch-driven? Never throws: an unreadable setting means a desktop. @private */
    _mobile() {
        try {
            return Boolean(isMobileMode());
        } catch {
            return false;
        }
    }

    /**
     * Put the bar where the player is already looking and make it movable.
     *
     * Default: top centre, just under the game's header. A saved position (the shared panel-geometry record)
     * replaces it; a resize or a smaller window pulls it back on screen; a double-click on the handle puts it back
     * to the default and forgets the saved spot. On a phone it is full width, not draggable, and sits at the bottom
     * above the phone's own bar, clear of the header and the queue controls under it. The z-order is the shared
     * floating-panel one.
     * @param {HTMLElement} strip
     * @param {boolean} mobile
     * @private
     */
    _placeStrip(strip, mobile) {
        const cleanups = [];
        registerFloatingPanel(strip);
        cleanups.push(() => unregisterFloatingPanel(strip));

        const header = document.querySelector('[class*="Header_header"]');
        const defaultTop = Math.round((header?.getBoundingClientRect().bottom || 48) + 8);
        const applyDefault = () => {
            if (mobile) {
                strip.style.top = 'auto';
                strip.style.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 64px)';
                return;
            }
            const width = strip.getBoundingClientRect().width || 0;
            strip.style.right = 'auto';
            strip.style.bottom = 'auto';
            strip.style.top = `${defaultTop}px`;
            strip.style.left = `${Math.max(8, Math.round((window.innerWidth - width) / 2))}px`;
        };
        applyDefault();
        if (mobile) {
            this._stripCleanup = () => cleanups.forEach((fn) => fn());
            return;
        }

        const handle = strip.querySelector('[data-role="handle"]');
        const keepOnScreen = () => clampPanelToViewport(strip, STRIP_MIN);
        window.addEventListener('resize', keepOnScreen);
        cleanups.push(() => window.removeEventListener('resize', keepOnScreen));

        // The saved spot, if any, replaces the default once storage answers (unless the player has already moved it)
        Promise.resolve()
            .then(() => restoreGeometry(strip, STRIP_GEOMETRY_KEY, STRIP_MIN))
            .catch((error) => console.error('[CraftingPlanWalk] Restoring the bar position failed:', error));

        const detach = makeDraggable(strip, handle, ({ left, top }) => {
            Promise.resolve()
                .then(() => saveGeometry(STRIP_GEOMETRY_KEY, { left: parseFloat(left), top: parseFloat(top) }))
                .catch((error) => console.error('[CraftingPlanWalk] Saving the bar position failed:', error));
        });
        cleanups.push(detach);

        const reset = () => {
            applyDefault();
            Promise.resolve()
                .then(() => clearPosition(STRIP_GEOMETRY_KEY))
                .catch((error) => console.error('[CraftingPlanWalk] Forgetting the bar position failed:', error));
        };
        handle.addEventListener('dblclick', reset);
        cleanups.push(() => handle.removeEventListener('dblclick', reset));

        this._stripCleanup = () => cleanups.forEach((fn) => fn());
    }

    /** @private */
    _stripButton(text, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        styleGameButton(button, 'quiet', true);
        button.style.flexShrink = '0';
        button.addEventListener('click', onClick);
        return button;
    }

    /** @private */
    _removeStrip() {
        // Listeners (drag, resize, z-order) go with the bar
        this._stripCleanup?.();
        this._stripCleanup = null;
        document.getElementById(STRIP_ID)?.remove();
    }

    /** @private */
    _render() {
        if (typeof document === 'undefined') return;

        if (!this.active) {
            if (!this.message) {
                this._removeStrip();
                return;
            }
            const strip = this._strip();
            strip.querySelector('[data-role="label"]').textContent = this.message;
            strip.querySelector('[data-role="skip"]').hidden = true;
            strip.querySelector('[data-role="next"]').hidden = true;
            strip.querySelector('[data-role="stop"]').textContent = 'Dismiss';
            return;
        }

        const step = this.steps[this.index];
        const strip = this._strip();
        strip.querySelector('[data-role="label"]').textContent =
            `Step ${this.index + 1} of ${this.steps.length}: ${stepLabel(step)}`;
        strip.querySelector('[data-role="skip"]').hidden = false;
        strip.querySelector('[data-role="next"]').hidden = !step.done;
        strip.querySelector('[data-role="stop"]').textContent = 'Stop';
        this._highlight(step.key);
        if (!this._mobile()) clampPanelToViewport(strip, STRIP_MIN);
    }

    /**
     * Mark the current step's row in whichever plan tree is on the page. The tree
     * belongs to the panel the plan was drawn on, so once the walk navigates away
     * there is nothing to mark — which is correct, not a miss.
     * @param {string} key
     * @private
     */
    _highlight(key) {
        this._clearHighlight();
        for (const row of document.querySelectorAll(`[${WALK_KEY_ATTRIBUTE}="${key}"]`)) {
            row.classList.add(CURRENT_CLASS);
            row.style.color = '#ffe27a';
        }
    }

    /** @private */
    _clearHighlight() {
        if (typeof document === 'undefined') return;
        for (const row of document.querySelectorAll(`.${CURRENT_CLASS}`)) {
            row.classList.remove(CURRENT_CLASS);
            row.style.color = '';
        }
    }

    /**
     * Stop listening and take the strip off the page.
     *
     * The walk is shared by Crafting Plan, the task board's merged walk and the Iron Cow queue walk, but only
     * Crafting Plan's setting reaches this. A walk another surface started is not Crafting Plan's to end: it keeps
     * running (and listening) until it finishes, and the teardown then completes.
     * @param {string} [owner] - Who is disabling; with a walk running that this owner did not start, nothing is torn down
     */
    disable(owner = null) {
        if (owner && this.active && this.starter && this.starter !== owner) {
            this._disablePending = true;
            return;
        }
        this.stop('');
        this._teardown();
    }

    /** Drop the listeners; the walk itself is already ended or deliberately left alone. @private */
    _teardown() {
        this._disablePending = false;
        for (const unregister of this.unregisterHandlers) {
            try {
                unregister();
            } catch (error) {
                console.error('[CraftingPlanWalk] Cleanup failed:', error);
            }
        }
        this.unregisterHandlers = [];
        this.isInitialized = false;
    }
}

const craftingPlanWalk = new CraftingPlanWalk();

export default craftingPlanWalk;
