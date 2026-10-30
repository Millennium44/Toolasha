/**
 * Scroll Planner
 * Plan how many of each Labyrinth scroll to open, then be walked through opening them one at a
 * time: the scroll's action menu is opened, its quantity is filled in, and the game's own Open
 * button is highlighted. The player still presses Open — this module never presses it, never
 * sends an open request, and never touches any other spend or use button.
 *
 * - The "Plan scrolls" button lives in the scroll's item action menu, so it works from any
 *   inventory view.
 * - The last plan used is stored account-wide; "Load last plan" brings it to any character.
 * - An in-progress run is stored per character and survives a reload.
 * - Items are identified by their icon sprite first and the English name only as a fallback, so a
 *   translated client works.
 */

import config from '../../../core/config.js';
import dataManager from '../../../core/data-manager.js';
import domObserver from '../../../core/dom-observer.js';
import { createCleanupRegistry } from '../../../utils/cleanup-registry.js';
import { getIconHref, getItemHridFromIconHref, getItemHridFromName } from '../../../utils/game-lookups.js';
import { itemHridFromIcon } from '../../../utils/item-icon.js';
import { setReactInputValue } from '../../../utils/react-input.js';
import { setScrollRunActive } from './scroll-planner-state.js';
import {
    buildRun,
    getCurrentStep,
    getOwnedCount,
    getRemainingQuantity,
    getScrollHrids,
    normalizePlan,
    normalizeSteps,
    observeInventory,
} from './scroll-planner-logic.js';
import { clearRun, loadLastPlan, loadRun, saveLastPlan, saveRun } from './scroll-planner-storage.js';

const OBSERVER_NAME = 'ScrollPlanner_menu';
const BUTTON_CLASS = 'toolasha-scroll-planner-btn';
const BAR_CLASS = 'toolasha-scroll-planner-bar';
const MODAL_CLASS = 'toolasha-scroll-planner-modal';
/** Set on the game's Open button while it is highlighted, so teardown can find and restore it */
const HIGHLIGHT_ATTR = 'data-toolasha-scroll-highlight';
const HIGHLIGHT_OUTLINE = '2px solid #fbbf24';
const RUN_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PREFILL_CHECK_DELAY_MS = 150;
/**
 * When to try opening the current scroll's menu, from the moment a step begins. One attempt is not
 * enough: right after Start the menu the modal was opened from is still closing, or another dialog
 * covers the tile, and the click lands on nothing. Each attempt first looks for the scroll's menu:
 * open after our click means done (a step is opened at most once); open before any click (the menu
 * Start was pressed from) is filled in but watched, since it may be the one closing; not open means
 * click the tile.
 */
const AUTO_OPEN_DELAYS_MS = [150, 500, 1000];

const CSS_FONT = 'font-family: inherit; font-size: 13px;';

const TEXT = {
    planButton: 'Plan scrolls',
    modalTitle: 'Scroll Planner',
    modalHelp: 'Choose how many of each scroll to open. Start walks you through them one at a time.',
    allButton: 'All',
    clear: 'Clear',
    loadLast: 'Load last plan',
    loadLastEmpty: 'No previous plan saved yet.',
    loadedLast: 'Loaded your last plan.',
    start: 'Start',
    close: 'Close',
    nothingPlanned: 'Enter a quantity for at least one scroll.',
    nothingOwned: 'You do not own any of the planned scrolls.',
    noScrollData: 'Game data is not loaded yet. Try again in a moment.',
    inventoryNotLoaded: 'Your inventory is not loaded yet. Try again in a moment.',
    barOpenMenuHint: 'Click the scroll in your inventory, then press the highlighted Open button.',
    barMenuReadyHint: 'Quantity is filled in. Press the highlighted Open button.',
    showScroll: 'Show scroll',
    skip: 'Skip',
    stop: 'Stop',
    doneTitle: 'All planned scrolls opened.',
};

class ScrollPlanner {
    constructor() {
        this.registry = createCleanupRegistry();
        this.unregisterMenu = null;
        this.onItemsUpdated = null;
        this.modal = null;
        this.bar = null;
        this.draft = {};
        this.run = null; // { startedAt, steps, shortfalls }
        this.characterId = null;
        this.autoOpenedHrid = null;
        this.prefillFailedHrid = null;
        this.filledMenu = null;
        this.autoOpenToken = 0;
        // Bumped by every cleanup, so work resumed after an await can tell it was torn down
        this.generation = 0;
    }

    /**
     * Initialize the feature
     */
    async initialize() {
        if (!config.getSetting('scrollPlanner')) {
            return;
        }

        this.characterId = dataManager.getCurrentCharacterId() || null;
        this.registry = createCleanupRegistry();

        this.unregisterMenu = domObserver.onClass(OBSERVER_NAME, 'Item_actionMenu', (menu) => {
            this.handleActionMenu(menu);
        });

        this.onItemsUpdated = () => this.handleInventoryChange();
        dataManager.on('items_updated', this.onItemsUpdated);

        await this.resumeSavedRun();
    }

    /**
     * Tear everything down: observer, listener, timers, bar, modal, injected buttons, highlight.
     */
    cleanup() {
        this.generation += 1;
        if (this.unregisterMenu) {
            this.unregisterMenu();
            this.unregisterMenu = null;
        }
        if (this.onItemsUpdated) {
            dataManager.off('items_updated', this.onItemsUpdated);
            this.onItemsUpdated = null;
        }
        this.registry.cleanupAll();
        this.modal?.remove();
        this.bar?.remove();
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((button) => button.remove());
        this.clearHighlights();
        this.modal = null;
        this.bar = null;
        this.run = null;
        this.characterId = null;
        this.autoOpenedHrid = null;
        this.prefillFailedHrid = null;
        this.filledMenu = null;
        this.draft = {};
        setScrollRunActive(false);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /**
     * Whether work started under `generation` for `characterId` may still act.
     * @param {number} generation
     * @param {string|null} characterId
     * @returns {boolean}
     */
    isCurrent(generation, characterId) {
        return (
            generation === this.generation &&
            characterId === this.characterId &&
            characterId === (dataManager.getCurrentCharacterId() || null)
        );
    }

    schedule(callback, delay) {
        this.registry.scheduleTimeout(callback, delay, 'scroll-planner');
    }

    getItemDetailMap() {
        return dataManager.getInitClientData()?.itemDetailMap || null;
    }

    getScrollHrids() {
        return getScrollHrids(this.getItemDetailMap());
    }

    /**
     * @returns {Array|null} The character's items, or null while they are not loaded
     */
    getItems() {
        return Array.isArray(dataManager.characterItems) ? dataManager.characterItems : null;
    }

    getScrollName(itemHrid) {
        return dataManager.getItemDetails(itemHrid)?.name || itemHrid;
    }

    /**
     * @param {HTMLElement} menu - Item action menu
     * @returns {string|null} Scroll HRID the menu belongs to, or null
     */
    resolveScrollHrid(menu) {
        const itemName = menu.querySelector('[class*="Item_name"]')?.textContent?.trim();
        // The icon's sprite first: the name is translated on a non-English client
        const itemHrid =
            getItemHridFromIconHref(getIconHref(menu, 'items_sprite')) ||
            (itemName ? getItemHridFromName(itemName) : null);
        if (!itemHrid) {
            return null;
        }
        return this.getScrollHrids().includes(itemHrid) ? itemHrid : null;
    }

    /**
     * The game's Open button in a scroll menu: the one labeled Open on an English client, else the
     * menu's first own button (Open is the first action of an openable item's menu).
     * @param {HTMLElement} menu
     * @returns {HTMLButtonElement|null}
     */
    findOpenButton(menu) {
        const buttons = [...menu.querySelectorAll(':scope > button')].filter(
            (button) => !button.classList.contains(BUTTON_CLASS)
        );
        return buttons.find((button) => /^open\b/i.test(button.textContent.trim())) || buttons[0] || null;
    }

    clearHighlights() {
        document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((button) => {
            button.style.outline = '';
            button.style.outlineOffset = '';
            button.removeAttribute(HIGHLIGHT_ATTR);
        });
    }

    // ---------------------------------------------------------------------
    // Item action menu
    // ---------------------------------------------------------------------

    handleActionMenu(menu) {
        const itemHrid = this.resolveScrollHrid(menu);
        if (!itemHrid) {
            return;
        }
        this.injectPlanButton(menu);
        this.applyStepToMenu(menu, itemHrid);
    }

    injectPlanButton(menu) {
        if (menu.querySelector(`.${BUTTON_CLASS}`)) {
            return;
        }
        const reference = menu.querySelector(':scope > button');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `${reference?.className || ''} ${BUTTON_CLASS}`.trim();
        button.textContent = TEXT.planButton;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.openModal();
        });
        menu.appendChild(button);
    }

    /**
     * If the menu belongs to the current step, fill in its quantity and highlight Open.
     * Never presses Open.
     */
    applyStepToMenu(menu, itemHrid) {
        const items = this.getItems();
        if (!this.run || !items) {
            return;
        }
        const current = getCurrentStep(this.run.steps, items);
        if (!current || current.step.itemHrid !== itemHrid) {
            return;
        }

        const quantity = getRemainingQuantity(current.step, items);
        const input = menu.querySelector('[class*="Item_amountInputContainer"] input[type="number"]');
        const openButton = this.findOpenButton(menu);

        if (input) {
            setReactInputValue(input, String(quantity), { focus: false, dispatchChange: true });
        }
        if (openButton) {
            openButton.style.outline = HIGHLIGHT_OUTLINE;
            openButton.style.outlineOffset = '2px';
            openButton.setAttribute(HIGHLIGHT_ATTR, '1');
        }
        this.filledMenu = menu;

        // The game's Open label carries the quantity ("Open 3"); if it does not, the fill did not
        // take and the player has to type it themselves. Digits only, so a translated label or a
        // thousands separator does not matter.
        const generation = this.generation;
        this.schedule(() => {
            if (generation !== this.generation) {
                return;
            }
            const filled = Boolean(input) && input.value === String(quantity);
            const labelDigits = openButton?.textContent.replace(/\D/g, '') || '';
            const labelMatches = labelDigits === String(quantity);
            this.prefillFailedHrid = filled && labelMatches ? null : itemHrid;
            this.renderBar();
        }, PREFILL_CHECK_DELAY_MS);
        this.prefillFailedHrid = null;
        this.renderBar();
    }

    // ---------------------------------------------------------------------
    // Run lifecycle
    // ---------------------------------------------------------------------

    async resumeSavedRun() {
        const generation = this.generation;
        const characterId = this.characterId;
        if (!characterId || !this.getItems()) {
            return;
        }
        const saved = await loadRun(characterId);
        if (!this.isCurrent(generation, characterId)) {
            return;
        }
        const items = this.getItems();
        if (!items || !Array.isArray(saved?.steps) || saved.steps.length === 0) {
            return;
        }
        // Read in the current shape (an older record has targetCount only), then fold in what
        // changed while the page was closed: scrolls opened count, scrolls gained do not
        const normalized = normalizeSteps(saved.steps, items);
        const steps = normalized ? observeInventory(normalized, items).steps : null;
        const stale = !(Date.now() - saved.startedAt < RUN_MAX_AGE_MS);
        if (stale || !steps || !getCurrentStep(steps, items)) {
            await clearRun(characterId);
            return;
        }
        this.run = {
            startedAt: saved.startedAt,
            steps,
            shortfalls: Array.isArray(saved.shortfalls) ? saved.shortfalls : [],
        };
        setScrollRunActive(true);
        this.renderBar();
        this.autoOpenCurrentScroll();
    }

    /**
     * @param {Object} rawPlan - Draft itemHrid -> quantity
     * @returns {Promise<{error: string|null}>}
     */
    async startRun(rawPlan) {
        const generation = this.generation;
        const characterId = this.characterId;
        const scrollHrids = this.getScrollHrids();
        if (scrollHrids.length === 0) {
            return { error: TEXT.noScrollData };
        }
        if (!this.getItems() || !characterId) {
            return { error: TEXT.inventoryNotLoaded };
        }
        const plan = normalizePlan(rawPlan, scrollHrids);
        if (Object.keys(plan).length === 0) {
            return { error: TEXT.nothingPlanned };
        }

        await saveLastPlan(plan);
        if (!this.isCurrent(generation, characterId)) {
            return { error: null };
        }
        const items = this.getItems();
        if (!items) {
            return { error: TEXT.inventoryNotLoaded };
        }

        const { steps, shortfalls } = buildRun(plan, scrollHrids, items);
        if (steps.length === 0) {
            return { error: TEXT.nothingOwned };
        }

        this.clearHighlights();
        const run = { startedAt: Date.now(), steps, shortfalls };
        this.run = run;
        this.autoOpenedHrid = null;
        this.prefillFailedHrid = null;
        setScrollRunActive(true);
        this.closeModal();
        this.renderBar();
        this.autoOpenCurrentScroll();

        await this.persistRun(characterId, run);
        return { error: null };
    }

    async stopRun() {
        const characterId = this.characterId;
        this.endRun();
        this.bar?.remove();
        this.bar = null;
        await clearRun(characterId);
    }

    async skipCurrentStep() {
        const items = this.getItems();
        if (!this.run || !items) {
            return;
        }
        const generation = this.generation;
        const characterId = this.characterId;
        const current = getCurrentStep(this.run.steps, items);
        if (current) {
            current.step.skipped = true;
            this.clearHighlights();
        }
        const run = this.run;
        this.handleInventoryChange();
        // A finished run has already cleared its record; only a run still going is saved
        if (current && this.run === run && this.isCurrent(generation, characterId)) {
            await this.persistRun(characterId, run);
        }
    }

    /**
     * Save a run, and take the record back out if the run was stopped or finished while the write
     * was in flight — otherwise the late write would resurrect it on the next load. A teardown
     * (character switch, setting off) is not a stop: that run stays saved so it can resume, and a
     * run started since owns the record itself.
     * @param {string} characterId - Captured before the first await
     * @param {Object} run
     */
    async persistRun(characterId, run) {
        const generation = this.generation;
        await saveRun(characterId, run);
        if (generation === this.generation && this.run === null) {
            await clearRun(characterId);
        }
    }

    handleInventoryChange() {
        const items = this.getItems();
        // Not loaded (or mid-switch) is not "every scroll opened": leave the run alone
        if (!this.run || !items) {
            return;
        }
        // Count what was opened before deciding anything; a gain never adds to the plan
        const observed = observeInventory(this.run.steps, items);
        this.run.steps = observed.steps;
        const current = getCurrentStep(this.run.steps, items);
        if (!current) {
            this.finishRun();
            return;
        }
        if (observed.changed) {
            this.persistRun(this.characterId, this.run);
        }
        if (this.autoOpenedHrid !== current.step.itemHrid) {
            this.clearHighlights();
            this.autoOpenCurrentScroll();
        }
        this.renderBar();
    }

    /** Drop the in-memory run and everything that follows it */
    endRun() {
        this.run = null;
        this.autoOpenedHrid = null;
        this.prefillFailedHrid = null;
        this.filledMenu = null;
        this.clearHighlights();
        setScrollRunActive(false);
    }

    async finishRun() {
        const characterId = this.characterId;
        const skipped = this.run.steps.filter((step) => step.skipped).map((step) => step.itemHrid);
        this.endRun();
        this.renderBar({ finished: true, skipped });
        await clearRun(characterId);
    }

    // ---------------------------------------------------------------------
    // Opening the scroll's action menu
    // ---------------------------------------------------------------------

    /**
     * The visible, unenhanced inventory tile of an item, matched by its icon sprite.
     * @param {string} itemHrid
     * @returns {HTMLElement|null} The clickable part of the tile
     */
    findInventoryTile(itemHrid) {
        const itemDetailMap = this.getItemDetailMap();
        const tiles = document.querySelectorAll('[class*="Inventory_items"] [class*="Item_itemContainer"]');
        for (const tile of tiles) {
            if (itemHridFromIcon(tile, itemDetailMap) !== itemHrid) {
                continue;
            }
            if (tile.getClientRects().length === 0) {
                continue;
            }
            return tile.querySelector('[class*="Item_item"]') || tile;
        }
        return null;
    }

    /**
     * Click the current scroll's inventory tile so the game opens its action menu. Done once per
     * step; the bar's "Show scroll" button repeats it on demand. Opening the menu spends nothing.
     */
    autoOpenCurrentScroll(force = false) {
        const items = this.getItems();
        if (!this.run || !items) {
            return;
        }
        const current = getCurrentStep(this.run.steps, items);
        if (!current) {
            return;
        }
        const itemHrid = current.step.itemHrid;
        if (!force && this.autoOpenedHrid === itemHrid) {
            return;
        }
        this.autoOpenedHrid = itemHrid;
        // A newer call (next step, Show scroll) supersedes this one's remaining attempts
        this.autoOpenToken += 1;
        const token = this.autoOpenToken;
        const generation = this.generation;
        const attempt = (index, clicked) => {
            if (generation !== this.generation || token !== this.autoOpenToken) {
                return;
            }
            const items = this.getItems();
            const step = this.run && items ? getCurrentStep(this.run.steps, items) : null;
            if (step?.step.itemHrid !== itemHrid) {
                return;
            }
            const openMenu = this.findOpenMenu(itemHrid);
            if (openMenu && clicked) {
                return;
            }
            if (openMenu) {
                // Open before we clicked: fill it in, and look again in case it is closing
                if (this.filledMenu !== openMenu) {
                    this.applyStepToMenu(openMenu, itemHrid);
                }
            } else {
                this.findInventoryTile(itemHrid)?.dispatchEvent(
                    new MouseEvent('click', { bubbles: true, cancelable: true })
                );
            }
            if (index + 1 < AUTO_OPEN_DELAYS_MS.length) {
                const wait = AUTO_OPEN_DELAYS_MS[index + 1] - AUTO_OPEN_DELAYS_MS[index];
                this.schedule(() => attempt(index + 1, clicked || !openMenu), wait);
            }
        };
        this.schedule(() => attempt(0, false), AUTO_OPEN_DELAYS_MS[0]);
    }

    /**
     * The item action menu open now for this scroll, if any.
     * @param {string} itemHrid
     * @returns {HTMLElement|null}
     */
    findOpenMenu(itemHrid) {
        for (const menu of document.querySelectorAll('[class*="Item_actionMenu"]')) {
            if (menu.isConnected && this.resolveScrollHrid(menu) === itemHrid) {
                return menu;
            }
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // Progress bar
    // ---------------------------------------------------------------------

    ensureBar() {
        if (this.bar && document.body.contains(this.bar)) {
            return this.bar;
        }
        this.bar = document.createElement('div');
        this.bar.className = BAR_CLASS;
        this.bar.style.cssText = `
            position: fixed;
            bottom: 16px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 10001;
            background: #2a2a2a;
            border: 1px solid #fbbf24;
            border-radius: 8px;
            padding: 10px 14px;
            color: #fff;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            max-width: 92vw;
            ${CSS_FONT}
        `;
        document.body.appendChild(this.bar);
        return this.bar;
    }

    makeButton(label, onClick, primary = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = `
            padding: 4px 10px;
            border-radius: 4px;
            border: 1px solid ${primary ? '#fbbf24' : '#666'};
            background: ${primary ? '#fbbf24' : '#3a3a3a'};
            color: ${primary ? '#000' : '#fff'};
            cursor: pointer;
            ${CSS_FONT}
        `;
        button.addEventListener('click', onClick);
        return button;
    }

    makeLine(text, color = '#fff', bold = false) {
        const line = document.createElement('div');
        line.textContent = text;
        line.style.cssText = `color: ${color}; ${bold ? 'font-weight: 600;' : ''}`;
        return line;
    }

    renderBar(result = null) {
        if (!this.run && !result) {
            return;
        }

        if (result?.finished) {
            const bar = this.ensureBar();
            bar.replaceChildren();
            bar.appendChild(this.makeLine(TEXT.doneTitle, '#4ade80', true));
            if (result.skipped.length > 0) {
                const names = result.skipped.map((hrid) => this.getScrollName(hrid)).join(', ');
                bar.appendChild(this.makeLine(`Skipped: ${names}`, '#aaa'));
            }
            const actions = document.createElement('div');
            actions.style.cssText = 'margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end;';
            actions.appendChild(
                this.makeButton(
                    TEXT.close,
                    () => {
                        this.bar?.remove();
                        this.bar = null;
                    },
                    true
                )
            );
            bar.appendChild(actions);
            return;
        }

        const items = this.getItems();
        if (!items) {
            return;
        }
        const current = getCurrentStep(this.run.steps, items);
        if (!current) {
            return;
        }
        const bar = this.ensureBar();
        bar.replaceChildren();
        const { step, index } = current;
        const quantity = getRemainingQuantity(step, items);

        bar.appendChild(
            this.makeLine(
                `Scroll ${index + 1} of ${this.run.steps.length}: ${this.getScrollName(step.itemHrid)} ×${quantity}`,
                '#fbbf24',
                true
            )
        );

        if (this.prefillFailedHrid === step.itemHrid) {
            bar.appendChild(
                this.makeLine(
                    `Could not fill in the quantity. Set it to ${quantity} yourself, then press Open.`,
                    '#f87171'
                )
            );
        } else if (this.filledMenu?.isConnected) {
            bar.appendChild(this.makeLine(TEXT.barMenuReadyHint, '#ddd'));
        } else {
            bar.appendChild(this.makeLine(TEXT.barOpenMenuHint, '#ddd'));
        }

        const shortfalls = this.run.shortfalls || [];
        if (shortfalls.length > 0) {
            const list = shortfalls
                .map((entry) => `${this.getScrollName(entry.itemHrid)} (${entry.planned} → ${entry.owned})`)
                .join(', ');
            bar.appendChild(this.makeLine(`Not enough owned (planned → owned): ${list}`, '#f59e0b'));
        }

        const actions = document.createElement('div');
        actions.style.cssText = 'margin-top: 8px; display: flex; gap: 8px; justify-content: flex-end;';
        actions.appendChild(this.makeButton(TEXT.showScroll, () => this.autoOpenCurrentScroll(true)));
        actions.appendChild(this.makeButton(TEXT.skip, () => this.skipCurrentStep()));
        actions.appendChild(this.makeButton(TEXT.stop, () => this.stopRun()));
        bar.appendChild(actions);
    }

    // ---------------------------------------------------------------------
    // Plan modal
    // ---------------------------------------------------------------------

    openModal() {
        this.modal?.remove();
        this.modal = document.createElement('div');
        this.modal.className = MODAL_CLASS;
        this.modal.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;
        this.modal.addEventListener('click', (event) => {
            if (event.target === this.modal) {
                this.closeModal();
            }
        });
        document.body.appendChild(this.modal);
        this.renderModal('');
    }

    closeModal() {
        this.modal?.remove();
        this.modal = null;
    }

    renderModal(message, messageColor = '#f87171') {
        if (!this.modal) {
            return;
        }
        this.modal.replaceChildren();

        const content = document.createElement('div');
        content.style.cssText = `
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            min-width: min(360px, 90vw);
            max-width: 95vw;
            max-height: 90%;
            overflow: auto;
            color: #fff;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            ${CSS_FONT}
        `;

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';
        const title = document.createElement('h3');
        title.textContent = TEXT.modalTitle;
        title.style.cssText = 'margin: 0; color: #fff;';
        header.appendChild(title);
        header.appendChild(this.makeButton('✕', () => this.closeModal()));
        content.appendChild(header);

        const help = this.makeLine(TEXT.modalHelp, '#aaa');
        help.style.cssText += 'margin: 8px 0 12px;';
        content.appendChild(help);

        const scrollHrids = this.getScrollHrids();
        const items = this.getItems();
        // Not loaded is told apart from owning none: no rows of zeros for data that has not arrived
        if (scrollHrids.length === 0 || !items) {
            content.appendChild(
                this.makeLine(scrollHrids.length === 0 ? TEXT.noScrollData : TEXT.inventoryNotLoaded, '#f87171')
            );
            this.modal.appendChild(content);
            return;
        }

        const totalLine = this.makeLine('', '#ddd');
        const updateTotal = () => {
            const total = Object.values(this.draft).reduce((sum, value) => sum + value, 0);
            totalLine.textContent = `Total: ${total}`;
        };

        for (const itemHrid of scrollHrids) {
            content.appendChild(this.buildRow(itemHrid, getOwnedCount(items, itemHrid), updateTotal));
        }

        totalLine.style.cssText += 'margin-top: 10px;';
        updateTotal();
        content.appendChild(totalLine);

        const status = this.makeLine(message, messageColor);
        status.style.cssText += 'margin-top: 6px; min-height: 18px;';
        content.appendChild(status);

        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;';
        footer.appendChild(
            this.makeButton(TEXT.clear, () => {
                this.draft = {};
                this.renderModal('');
            })
        );
        footer.appendChild(this.makeButton(TEXT.loadLast, () => this.loadLastIntoDraft()));
        footer.appendChild(
            this.makeButton(
                TEXT.start,
                async () => {
                    const result = await this.startRun(this.draft);
                    if (result.error) {
                        this.renderModal(result.error);
                    }
                },
                true
            )
        );
        content.appendChild(footer);

        this.modal.appendChild(content);
    }

    buildRow(itemHrid, owned, updateTotal) {
        const row = document.createElement('div');
        row.className = 'toolasha-scroll-planner-row';
        row.dataset.itemHrid = itemHrid;
        row.style.cssText = `display: flex; align-items: center; gap: 8px; padding: 3px 0; opacity: ${owned > 0 ? 1 : 0.55};`;

        const name = document.createElement('span');
        name.textContent = this.getScrollName(itemHrid);
        name.style.cssText = 'flex: 1; min-width: 120px;';
        row.appendChild(name);

        const ownedLabel = document.createElement('span');
        ownedLabel.textContent = `Owned: ${owned}`;
        ownedLabel.style.cssText = 'color: #aaa; min-width: 80px; text-align: right;';
        row.appendChild(ownedLabel);

        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = this.draft[itemHrid] > 0 ? String(this.draft[itemHrid]) : '';
        input.style.cssText =
            'width: 64px; padding: 2px 4px; background: #1f1f1f; color: #fff; border: 1px solid #555; border-radius: 4px;';
        input.addEventListener('input', () => {
            const value = Math.floor(Number(input.value));
            if (Number.isFinite(value) && value > 0) {
                this.draft[itemHrid] = value;
            } else {
                delete this.draft[itemHrid];
            }
            input.style.borderColor = value > owned ? '#f87171' : '#555';
            input.title = value > owned ? `Only ${owned} owned` : '';
            updateTotal();
        });
        input.dispatchEvent(new Event('input'));
        row.appendChild(input);

        row.appendChild(
            this.makeButton(TEXT.allButton, () => {
                if (owned > 0) {
                    this.draft[itemHrid] = owned;
                    input.value = String(owned);
                    input.dispatchEvent(new Event('input'));
                }
            })
        );

        return row;
    }

    async loadLastIntoDraft() {
        const generation = this.generation;
        const characterId = this.characterId;
        const raw = await loadLastPlan();
        if (!this.isCurrent(generation, characterId) || !this.modal) {
            return;
        }
        const last = normalizePlan(raw, this.getScrollHrids());
        if (Object.keys(last).length === 0) {
            this.renderModal(TEXT.loadLastEmpty);
            return;
        }
        this.draft = last;
        this.renderModal(TEXT.loadedLast, '#4ade80');
    }
}

const scrollPlanner = new ScrollPlanner();

export default {
    name: 'Scroll Planner',
    initialize: () => scrollPlanner.initialize(),
    cleanup: () => scrollPlanner.cleanup(),
};

export { ScrollPlanner };
