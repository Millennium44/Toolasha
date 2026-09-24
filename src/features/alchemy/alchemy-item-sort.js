/**
 * Alchemy Item Sort
 *
 * A "Game | Profit/hr" toggle in the Alchemize Item picker, kept per alchemy
 * tab (Coinify, Decompose, Transmute, Unrefine) the way `alchemy-item-pins.js`
 * keeps its pins per tab — what is worth coinifying is rarely what is worth
 * decomposing, so a shared toggle would apply one tab's answer to all four.
 * Off by default: the picker keeps the game's own order until a tab is
 * switched to Profit/hr.
 *
 * ## Reordering, not fighting React
 *
 * Follows the shape `alchemy-item-pins.js` and `guild-credit-value.js`'s own
 * picker sort already use for this exact component: move the grid's tile
 * wrappers with `insertBefore`, watch the menu's `childList` for the game's
 * own Item Filter redraw (which replaces the tiles without replacing the
 * menu), and guard every write with `sameOrder` so the watcher does not react
 * to its own writes.
 *
 * Pins keeps ordering the picker on its own when this toggle is off — nothing
 * here runs. When a tab is on Profit/hr, this module computes the *whole*
 * order — pinned items first, in pin order, read from `alchemyItemPins`
 * itself — so pins' own reorder pass (still hooked to the same
 * `ItemSelector_menu` event) finds its own desired order already in place and
 * writes nothing.
 *
 * ## Profit source
 *
 * The number is `alchemy-profit-calculator.js`'s own `profitPerHour` — the
 * same figure `alchemy-best-items.js` shows, through the same calculator —
 * rather than a second opinion computed here. Best Items sweeps
 * `itemDetailMap` at enhancement level 0 for its table
 * (`alchemy-rankings.js`'s `rankAlchemyType`); this instead prices each tile
 * actually on screen at *that tile's own* enhancement level, because the
 * picker can show several copies of one item at different enhancement levels
 * and Decompose/Unrefine price those differently (Coinify and Transmute
 * price the base item only — see `CALCULATOR_METHOD`).
 *
 * Prices are cached per open menu per tab and cleared when the market
 * refreshes or the menu closes, so typing in the Item Filter — which redraws
 * the tiles on every keystroke — never re-runs the calculator.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { findAlchemizeMenu, activeAlchemyAction, menuTiles, tileItemHrid } from './alchemy-item-selector.js';
import alchemyItemPins from './alchemy-item-pins.js';
import { sameOrder } from '../../utils/item-picker-pins.js';
import { tileEnhancementLevel } from '../../utils/item-selector-dom.js';
import { formatKMB } from '../../utils/formatters.js';
import { createCuratedRecord } from '../../utils/persisted-record.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY = 'alchemyItemSortOrder';
const STYLE_ID = 'mwi-alchemy-sort-style';
const TOGGLE_CLASS = 'mwi-alchemy-sort-toggle';
const LABEL_CLASS = 'mwi-alchemy-sort-label';
const BTN_CLASS = 'mwi-alchemy-sort-btn';
const ACTIVE_CLASS = 'mwi-alchemy-sort-btn-active';
const TILE_CLASS = 'mwi-alchemy-sort-tile';
const RATE_CLASS = 'mwi-alchemy-sort-rate';

/** How long a reorder pass may run before yielding back to the browser and resuming */
const YIELD_BUDGET_MS = 8;

/**
 * Which calculator method prices which action, and how it takes an
 * enhancement level — Transmute has none (an item goes through as itself), so
 * it is called with the item alone; the other three take the tile's own
 * enhancement level.
 */
const CALCULATOR_METHOD = {
    coinify: 'calculateCoinifyProfit',
    decompose: 'calculateDecomposeProfit',
    unrefine: 'calculateUnrefineProfit',
};

/**
 * Read the record set for this character's pins is per-character; this
 * toggle is a display preference rather than game data, so it is kept
 * globally — one choice per tab, the same on every character.
 */
const record = createCuratedRecord({
    base: STORAGE_KEY,
    store: 'settings',
    empty: () => ({}),
    scoped: false,
    label: 'AlchemyItemSort',
});

const CSS = `
    .${TOGGLE_CLASS} {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px 6px;
        font-size: 11px;
    }
    .${LABEL_CLASS} { color: #9ca3af; }
    .${BTN_CLASS} {
        border: 1px solid #555;
        background: rgba(255, 255, 255, 0.04);
        color: #cbd5e1;
        border-radius: 3px;
        font-size: 11px;
        line-height: 1.4;
        padding: 1px 7px;
        cursor: pointer;
    }
    .${BTN_CLASS}.${ACTIVE_CLASS} {
        background: #4d97ff;
        border-color: #4d97ff;
        color: #fff;
    }
    .${TILE_CLASS} { position: relative; }
    .${RATE_CLASS} {
        position: absolute;
        left: 0;
        right: 0;
        /* Top edge: the bottom carries the game's item count and other badges, which covered the label */
        top: 1px;
        text-align: center;
        font-size: 9px;
        line-height: 1;
        pointer-events: none;
        text-shadow: 0 0 2px #000, 0 0 2px #000;
    }
`;

class AlchemyItemSort {
    constructor() {
        this.isInitialized = false;
        /** `{ [action]: 'game' | 'profit' }` */
        this.order = {};
        this.unregister = null;
        this.styleEl = null;
        this.menuObserver = null;
        this.watchedMenu = null;
        this.applying = false;
        this.pricesHandler = null;
        /** Which action's tiles `this.profitCache` prices, so a tab switch starts fresh */
        this.openAction = null;
        /** `tileKey -> profitPerHour|null`, for the action currently open */
        this.profitCache = new Map();
        this.resumeTimer = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('alchemyItemSort')) return;
        this.isInitialized = true;

        // Taken before the read, checked after — see alchemy-item-pins.js's
        // own initialize() for why a switch landing mid-read must not double-register
        const ticket = captureOwner(this);
        await this.loadOrder();
        if (!stillOurs(ticket)) return;

        this.styleEl = document.createElement('style');
        this.styleEl.id = STYLE_ID;
        this.styleEl.textContent = CSS;
        document.head.appendChild(this.styleEl);

        this.unregister = domObserver.onClass('AlchemyItemSort', 'ItemSelector_menu', () => this.apply());
        this.pricesHandler = () => this.profitCache.clear();
        dataManager.on('market_item_values_updated', this.pricesHandler);
        this.apply();
    }

    disable() {
        noteTeardown(this);
        try {
            this.unregister?.();
            this.unregister = null;
            this.menuObserver?.disconnect();
            this.menuObserver = null;
            this.watchedMenu = null;
            if (this.resumeTimer) {
                clearTimeout(this.resumeTimer);
                this.resumeTimer = null;
            }
            if (this.pricesHandler) {
                dataManager.off('market_item_values_updated', this.pricesHandler);
                this.pricesHandler = null;
            }
            this.styleEl?.remove();
            this.styleEl = null;
            document.querySelectorAll(`.${TOGGLE_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${RATE_CLASS}`).forEach((el) => el.remove());
            document.querySelectorAll(`.${TILE_CLASS}`).forEach((el) => el.classList.remove(TILE_CLASS));
            this.profitCache.clear();
            this.openAction = null;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Alchemy Item Sort] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Read the stored per-tab order choice back.
     * @returns {Promise<boolean>} Whether storage could be read
     */
    async loadOrder() {
        record.reset();
        const readable = await record.load();
        this.order = record.get() || {};
        return readable;
    }

    /**
     * Write the order choice back, without making anybody wait for it.
     * @returns {Promise<boolean>} Whether the write landed
     */
    saveOrder() {
        record.set({ ...this.order });
        return record.save().catch((error) => {
            console.error('[AlchemyItemSort] Saving the order choice failed:', error);
            return false;
        });
    }

    /** @returns {Promise<*>} The pending write, for tests and shutdown */
    flushOrderWrites() {
        return record.flushed();
    }

    /**
     * Watch the open menu's contents, the same way `alchemy-item-pins.js`
     * does for its own reorder — the Item Filter box redraws the tiles
     * without replacing the menu itself.
     * @param {HTMLElement} menu - The open menu
     */
    watchMenu(menu) {
        if (this.watchedMenu === menu && this.menuObserver) return;

        this.menuObserver?.disconnect();
        this.watchedMenu = menu;
        this.menuObserver = new MutationObserver(() => this.apply());
        this.menuObserver.observe(menu, { childList: true, subtree: true });
    }

    /** The menu closed: drop the watcher and the prices computed for it */
    detachMenu() {
        this.menuObserver?.disconnect();
        this.menuObserver = null;
        this.watchedMenu = null;
        this.profitCache.clear();
        this.openAction = null;
    }

    /** Put the toggle in the open menu, and reorder its tiles if Profit/hr is chosen */
    apply() {
        if (this.applying) return;

        const menu = findAlchemizeMenu();
        if (!menu) {
            this.detachMenu();
            return;
        }
        this.watchMenu(menu);

        const action = activeAlchemyAction();
        if (!action) return;

        const { grid, tiles } = menuTiles(menu);
        this.ensureToggle(menu, grid, action);
        if (!grid || !tiles.length) return;

        // A different tab than the one the cache was built for: its prices
        // answer a different question, so they cannot be reused
        if (action !== this.openAction) {
            this.profitCache.clear();
            this.openAction = action;
        }

        if ((this.order[action] || 'game') !== 'profit') return;
        this.reorderByProfit(menu, grid, tiles, action);
    }

    /**
     * Build (or find) the toggle and make sure it reads the current choice.
     * @param {HTMLElement} menu - The open menu
     * @param {HTMLElement|null} grid - The tile grid, from `menuTiles`
     * @param {string} action - The open alchemy tab
     */
    ensureToggle(menu, grid, action) {
        let bar = menu.querySelector(`.${TOGGLE_CLASS}`);
        if (!bar) {
            bar = document.createElement('div');
            bar.className = TOGGLE_CLASS;

            const label = document.createElement('span');
            label.className = LABEL_CLASS;
            label.textContent = 'Order:';
            bar.appendChild(label);

            for (const [mode, text] of [
                ['game', 'Game'],
                ['profit', 'Profit/hr'],
            ]) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = BTN_CLASS;
                btn.textContent = text;
                btn.dataset.mwiSortMode = mode;
                // Capture phase and stopped both ways: the grid's own click
                // handling selects an item on click, and a toggle that also
                // did that would be unusable
                btn.addEventListener('mousedown', (event) => event.stopPropagation());
                btn.addEventListener(
                    'click',
                    (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        this.setMode(mode);
                    },
                    true
                );
                bar.appendChild(btn);
            }

            // Above the grid, below whatever the game draws first (the Item
            // Filter box) — unless the grid *is* the menu's only child, in
            // which case there is nowhere "above the grid" that is not also
            // above the filter box, so the toggle goes to the very top
            if (grid && grid !== menu && grid.parentElement) {
                grid.parentElement.insertBefore(bar, grid);
            } else {
                menu.insertBefore(bar, menu.firstChild);
            }
        }
        for (const btn of bar.querySelectorAll(`.${BTN_CLASS}`)) {
            btn.classList.toggle(ACTIVE_CLASS, btn.dataset.mwiSortMode === (this.order[action] || 'game'));
        }
    }

    /**
     * Switch a tab's order choice.
     * @param {string} mode - 'game' or 'profit'
     */
    setMode(mode) {
        const action = activeAlchemyAction();
        if (!action || this.order[action] === mode) return;

        this.order = { ...this.order, [action]: mode };
        this.saveOrder();
        this.apply();
    }

    /**
     * Identifies one tile's price, since the picker can show the same item at
     * more than one enhancement level as separate tiles.
     * @param {HTMLElement} tile - An item tile
     * @returns {string} A cache key
     */
    tileKey(tile) {
        return `${tileItemHrid(tile)}@${tileEnhancementLevel(tile)}`;
    }

    /**
     * This item's profit/hr for the given action, through the real
     * calculator — never a second opinion computed here.
     * @param {string} action - 'coinify' | 'decompose' | 'transmute' | 'unrefine'
     * @param {HTMLElement} tile - An item tile
     * @returns {number|null} Profit per hour, or null when it could not be priced
     */
    computeProfit(action, tile) {
        const itemHrid = tileItemHrid(tile);
        if (!itemHrid) return null;

        try {
            let profitData;
            if (action === 'transmute') {
                profitData = alchemyProfitCalculator.calculateTransmuteProfit(itemHrid);
            } else {
                const method = CALCULATOR_METHOD[action];
                if (!method) return null;
                profitData = alchemyProfitCalculator[method](itemHrid, tileEnhancementLevel(tile));
            }
            const value = profitData?.profitPerHour;
            return Number.isFinite(value) ? value : null;
        } catch (error) {
            console.error(`[AlchemyItemSort] Pricing ${itemHrid} for ${action} failed:`, error);
            return null;
        }
    }

    /**
     * Price whatever tiles are not already cached, yielding back to the
     * browser and resuming later if that takes a while — filling the cache is
     * the only slow part, so the reorder itself never has to wait.
     * @param {HTMLElement} menu - The open menu
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     */
    reorderByProfit(menu, grid, tiles, action) {
        const start = nowMs();
        for (const tile of tiles) {
            const key = this.tileKey(tile);
            if (!this.profitCache.has(key)) this.profitCache.set(key, this.computeProfit(action, tile));

            if (nowMs() - start > YIELD_BUDGET_MS) {
                if (!this.resumeTimer) {
                    this.resumeTimer = setTimeout(() => {
                        this.resumeTimer = null;
                        this.apply();
                    }, 0);
                }
                return;
            }
        }
        this.writeOrder(grid, tiles, action);
    }

    /**
     * Reorder the grid: pinned first (in pin order, from `alchemyItemPins`),
     * then priced tiles best-first, then unpriced tiles last in whatever
     * order the game gave them.
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     */
    writeOrder(grid, tiles, action) {
        const pinnedRank = new Map(alchemyItemPins.pinnedFor(action).map((hrid, index) => [hrid, index]));

        const fixed = []; // the "Remove" cell, standing for no item
        const front = [];
        const priced = [];
        const unpriced = [];
        for (const tile of tiles) {
            const hrid = tileItemHrid(tile);
            if (!hrid) {
                fixed.push(tile);
            } else if (pinnedRank.has(hrid)) {
                front.push(tile);
            } else if (Number.isFinite(this.profitCache.get(this.tileKey(tile)))) {
                priced.push(tile);
            } else {
                unpriced.push(tile);
            }
        }
        front.sort((a, b) => pinnedRank.get(tileItemHrid(a)) - pinnedRank.get(tileItemHrid(b)));
        priced.sort((a, b) => this.profitCache.get(this.tileKey(b)) - this.profitCache.get(this.tileKey(a)));

        this.paintRates(tiles);

        const desired = [...fixed, ...front, ...priced, ...unpriced];
        if (sameOrder(tiles, desired)) return;

        this.applying = true;
        try {
            const marker = document.createComment('mwi-alchemy-sort');
            grid.insertBefore(marker, tiles[0]);
            const fragment = document.createDocumentFragment();
            for (const tile of desired) fragment.appendChild(tile);
            grid.insertBefore(fragment, marker);
            marker.remove();
        } finally {
            this.applying = false;
        }
    }

    /**
     * A small profit/hr label on each priced tile — only drawn in Profit/hr
     * order, since the game order carries no ranking to label.
     * @param {HTMLElement[]} tiles - The menu's current tiles
     */
    paintRates(tiles) {
        for (const tile of tiles) {
            const hrid = tileItemHrid(tile);
            const profit = hrid ? this.profitCache.get(this.tileKey(tile)) : null;
            let rate = tile.querySelector(`.${RATE_CLASS}`);

            if (!Number.isFinite(profit)) {
                rate?.remove();
                continue;
            }

            tile.classList.add(TILE_CLASS);
            if (!rate) {
                rate = document.createElement('div');
                rate.className = RATE_CLASS;
                tile.appendChild(rate);
            }
            const text = `${profit >= 0 ? '' : '-'}${formatKMB(Math.abs(Math.round(profit)))}/h`;
            if (rate.textContent !== text) rate.textContent = text;
            rate.style.color = profit >= 0 ? '#4ade80' : '#f87171';
        }
    }
}

/**
 * @returns {number} A monotonic-ish clock reading for budgeting the reorder loop
 */
function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

const alchemyItemSort = new AlchemyItemSort();
export default alchemyItemSort;
