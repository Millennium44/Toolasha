/**
 * Alchemy Item Sort
 *
 * A "Game | Profit/hr | XP/hr" toggle in the Alchemize Item picker, kept per
 * alchemy tab (Coinify, Decompose, Transmute, Unrefine) the way
 * `alchemy-item-pins.js` keeps its pins per tab — what is worth coinifying is
 * rarely what is worth decomposing, so a shared toggle would apply one tab's
 * answer to all four. Off by default: the picker keeps the game's own order
 * until a tab is switched away from it.
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
 * Pins keeps ordering the picker on its own regardless of this toggle —
 * nothing here overrides it. Profit/hr and XP/hr both compute the *whole*
 * order — pinned items first, in pin order, read from `alchemyItemPins`
 * itself — so pins' own reorder pass (still hooked to the same
 * `ItemSelector_menu` event) finds its own desired order already in place and
 * writes nothing.
 *
 * ## Restoring Game order
 *
 * The game gives the tiles no order of its own to read back later — once
 * Profit/hr or XP/hr has moved them, the DOM order *is* whatever this module
 * wrote. So every tile is stamped, the first time it is seen each render,
 * with its position at that moment (`stampGameOrder`) — before this module's
 * own dispatch runs for that render. A fresh render (the Item Filter redraws
 * every tile as a new element) gets a fresh stamp; a tile that survives a
 * mode switch keeps the stamp it already has, so switching back to Game
 * cannot bake a Profit/hr- or XP/hr-sorted position in as "the game's order".
 * Switching to Game also strips every label — nothing about switching away
 * used to undo either half of what it did.
 *
 * A tile added while the tiles are out of the game's order (an item picked
 * up, or a filter widened, while Profit/hr is showing) cannot take its DOM
 * index as its stamp — that index is a position in *this* module's order.
 * React places a new node directly before the node that follows it in its
 * own order, so a newcomer is stamped just ahead of its next sibling instead.
 *
 * Game order still puts pinned tiles first, in pin order, exactly as
 * `alchemy-item-pins.js`'s own pass would. Both modules watch the same menu
 * and each reacts to the other's writes, so the order Game wants must be the
 * order Pins wants — a Game order that put a pinned tile back at its stamp
 * would have Pins move it to the front, Game move it back, and so on for as
 * long as the menu is open, inside one microtask checkpoint.
 *
 * ## Profit and XP sources
 *
 * The profit figure is `alchemy-profit-calculator.js`'s own `profitPerHour` —
 * the same figure `alchemy-best-items.js` shows, through the same calculator
 * — rather than a second opinion computed here. Best Items sweeps
 * `itemDetailMap` at enhancement level 0 for its table
 * (`alchemy-rankings.js`'s `rankAlchemyType`); this instead prices each tile
 * actually on screen at *that tile's own* enhancement level, because the
 * picker can show several copies of one item at different enhancement levels
 * and Decompose/Unrefine price those differently (Coinify and Transmute
 * price the base item only — see `CALCULATOR_METHOD`).
 *
 * The XP figure is the calculator's own `actionsPerHour` for that same tile
 * times `alchemy-rankings.js`'s `calcXpPerAction` — the shared helper Best
 * Items' XP column and the live action panel both already use, which folds
 * in wisdom, the failure-action 10% XP and Unrefine's shared multiplier.
 * Nothing here re-derives XP; both figures come off the one calculator call
 * per tile, cached together.
 *
 * Prices are cached per open menu per tab and cleared when the market
 * refreshes or the menu closes, so typing in the Item Filter — which redraws
 * the tiles on every keystroke — never re-runs the calculator.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { calcXpPerAction } from './alchemy-rankings.js';
import { findAlchemizeMenu, activeAlchemyAction, menuTiles, tileItemHrid } from './alchemy-item-selector.js';
import alchemyItemPins from './alchemy-item-pins.js';
import { orderTiles, sameOrder } from '../../utils/item-picker-pins.js';
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
/** Where each tile's pre-move position is stamped, in `tile.dataset` */
const GAME_ORDER_ATTR = 'mwiGameOrder';

/** The modes a tab can be in; anything else read back from storage is treated as Game */
const MODES = ['game', 'profit', 'xp'];

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
        /** `{ [action]: 'game' | 'profit' | 'xp' }` */
        this.order = {};
        this.unregister = null;
        this.styleEl = null;
        this.menuObserver = null;
        this.watchedMenu = null;
        this.applying = false;
        this.pricesHandler = null;
        /** Which action's tiles `this.priceCache` prices, so a tab switch starts fresh */
        this.openAction = null;
        /** `tileKey -> profitData|null`, the calculator's raw answer for the action currently open — profit and XP are both read off it, never re-derived */
        this.priceCache = new Map();
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
        this.pricesHandler = () => this.priceCache.clear();
        dataManager.on('market_item_values_updated', this.pricesHandler);
        this.apply();
    }

    disable() {
        noteTeardown(this);
        try {
            this.unregister?.();
            this.unregister = null;
            // An open menu left in Profit/hr or XP/hr order would stay that way,
            // unlabeled, until the game next redrew it
            this.restoreOpenMenu();
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
            this.priceCache.clear();
            this.openAction = null;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Alchemy Item Sort] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /** Put the open menu, if any, back in Game order — for teardown */
    restoreOpenMenu() {
        const menu = this.watchedMenu;
        const action = activeAlchemyAction();
        if (!menu?.isConnected || !action) return;

        const { grid, tiles } = menuTiles(menu);
        if (grid && tiles.length) this.applyGameOrder(grid, tiles, action);
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
        // A menu closing is never seen here — the watcher is on the menu that
        // went away — so a new menu is the first sign the last one's prices
        // (the character's levels, teas and equipment at that time) are over
        this.priceCache.clear();
        this.watchedMenu = menu;
        this.menuObserver = new MutationObserver(() => this.apply());
        this.menuObserver.observe(menu, { childList: true, subtree: true });
    }

    /** The menu closed: drop the watcher and the prices computed for it */
    detachMenu() {
        this.menuObserver?.disconnect();
        this.menuObserver = null;
        this.watchedMenu = null;
        this.priceCache.clear();
        this.openAction = null;
    }

    /** Put the toggle in the open menu, and order its tiles for the tab's chosen mode */
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

        // Stamp before this pass's own dispatch touches anything, so a tile's
        // stamp is always its pre-move position — see the module doc on why a
        // tile pins already moved by the time this runs is fine.
        this.stampGameOrder(tiles);

        // A different tab than the one the cache was built for: its prices
        // answer a different question, so they cannot be reused
        if (action !== this.openAction) {
            this.priceCache.clear();
            this.openAction = action;
        }

        const mode = this.modeFor(action);
        if (mode === 'profit' || mode === 'xp') {
            this.reorderRanked(grid, tiles, action, mode);
            return;
        }
        this.applyGameOrder(grid, tiles, action);
    }

    /**
     * A tab's order choice, with anything unrecognized read as Game.
     * @param {string} action - An alchemy tab
     * @returns {'game'|'profit'|'xp'} The mode
     */
    modeFor(action) {
        const mode = this.order?.[action];
        return MODES.includes(mode) ? mode : 'game';
    }

    /**
     * Stamp every tile that has not already been stamped with its place in
     * the game's order, before this pass moves anything. A tile carried over
     * from a previous pass — including one this module itself moved — keeps
     * the stamp it already has. When no tile has one (a fresh menu, or the
     * Item Filter redrawing every tile) the grid is as the game drew it, so
     * each takes its index. Otherwise a tile without one was added to a grid
     * whose order may be this module's, so it is stamped between the stamp of
     * the tile after it and the next stamp below that — see the module doc.
     * @param {HTMLElement[]} tiles - The menu's current tiles, in DOM order
     */
    stampGameOrder(tiles) {
        const stamps = [];
        for (const tile of tiles) {
            if (tile.dataset[GAME_ORDER_ATTR] !== undefined) stamps.push(this.gameOrderOf(tile));
        }
        if (!stamps.length) {
            tiles.forEach((tile, index) => {
                tile.dataset[GAME_ORDER_ATTR] = String(index);
            });
            return;
        }
        if (stamps.length === tiles.length) return;

        stamps.sort((a, b) => a - b);
        let next = null;
        for (let i = tiles.length - 1; i >= 0; i--) {
            const tile = tiles[i];
            if (tile.dataset[GAME_ORDER_ATTR] === undefined) {
                const stamp = next === null ? stamps[stamps.length - 1] + 1 : (stampBelow(stamps, next) + next) / 2;
                tile.dataset[GAME_ORDER_ATTR] = String(stamp);
                insertSorted(stamps, stamp);
            }
            next = this.gameOrderOf(tile);
        }
    }

    /**
     * A tile's stamped pre-move position, for sorting Game order back in.
     * @param {HTMLElement} tile - An item tile
     * @returns {number} The stamped index, or the largest safe integer for one never stamped
     */
    gameOrderOf(tile) {
        const raw = Number(tile.dataset[GAME_ORDER_ATTR]);
        return Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
    }

    /**
     * Restore the game's own order: every tile back to its stamped pre-move
     * position, then pinned tiles to the front the way `alchemy-item-pins.js`
     * orders them (see the module doc on why the two must agree). Also strips
     * any Profit/hr or XP/hr label — Game order carries no ranking to label.
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     */
    applyGameOrder(grid, tiles, action) {
        this.clearLabels(tiles);

        const byStamp = [...tiles].sort((a, b) => this.gameOrderOf(a) - this.gameOrderOf(b));
        this.moveTiles(grid, tiles, orderTiles(byStamp, alchemyItemPins.pinnedFor(action), tileItemHrid));
    }

    /**
     * Strip every Profit/hr label — used for Game order, which carries no
     * ranking to label.
     * @param {HTMLElement[]} tiles - The menu's current tiles
     */
    clearLabels(tiles) {
        for (const tile of tiles) {
            tile.querySelector(`.${RATE_CLASS}`)?.remove();
            tile.classList.remove(TILE_CLASS);
        }
    }

    /**
     * Move the grid's tiles into the given order, doing nothing when they are
     * already in it — reordering the DOM is itself a mutation, and this
     * module's own watcher would otherwise react to its own writes forever.
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {HTMLElement[]} desired - The tiles, in the order they should end up
     */
    moveTiles(grid, tiles, desired) {
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
                ['xp', 'XP/hr'],
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
            btn.classList.toggle(ACTIVE_CLASS, btn.dataset.mwiSortMode === this.modeFor(action));
        }
    }

    /**
     * Switch a tab's order choice.
     * @param {string} mode - 'game', 'profit', or 'xp'
     */
    setMode(mode) {
        const action = activeAlchemyAction();
        if (!action || !MODES.includes(mode) || this.modeFor(action) === mode) return;

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
     * Split tiles into the "Remove" cell, pinned tiles (in pin order), and
     * everything else — the shape Profit/hr and XP/hr both build from.
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     * @returns {{fixed: HTMLElement[], front: HTMLElement[], rest: HTMLElement[]}}
     */
    pinBuckets(tiles, action) {
        const pinnedRank = new Map(alchemyItemPins.pinnedFor(action).map((hrid, index) => [hrid, index]));

        const fixed = []; // the "Remove" cell, standing for no item
        const front = [];
        const rest = [];
        for (const tile of tiles) {
            const hrid = tileItemHrid(tile);
            if (!hrid) fixed.push(tile);
            else if (pinnedRank.has(hrid)) front.push(tile);
            else rest.push(tile);
        }
        front.sort((a, b) => pinnedRank.get(tileItemHrid(a)) - pinnedRank.get(tileItemHrid(b)));

        return { fixed, front, rest };
    }

    /**
     * This tile's calculator answer for the given action — never a second
     * opinion computed here. Profit and XP are both read off the same answer.
     * @param {string} action - 'coinify' | 'decompose' | 'transmute' | 'unrefine'
     * @param {HTMLElement} tile - An item tile
     * @returns {Object|null} The calculator's raw answer for this tile, or null when it could not be priced
     */
    computePriceData(action, tile) {
        const itemHrid = tileItemHrid(tile);
        if (!itemHrid) return null;

        try {
            if (action === 'transmute') {
                return alchemyProfitCalculator.calculateTransmuteProfit(itemHrid) || null;
            }
            const method = CALCULATOR_METHOD[action];
            if (!method) return null;
            return alchemyProfitCalculator[method](itemHrid, tileEnhancementLevel(tile)) || null;
        } catch (error) {
            console.error(`[AlchemyItemSort] Pricing ${itemHrid} for ${action} failed:`, error);
            return null;
        }
    }

    /**
     * Profit/hr out of a calculator answer, unmodified.
     * @param {Object|null} priceData - From `computePriceData`
     * @returns {number|null} Profit per hour, or null
     */
    profitValueFrom(priceData) {
        const value = priceData?.profitPerHour;
        return Number.isFinite(value) ? value : null;
    }

    /**
     * XP/hr out of a calculator answer: `alchemy-rankings.js`'s
     * `calcXpPerAction` (wisdom, the failure-action 10% blend, Unrefine's
     * shared multiplier) times the calculator's own `actionsPerHour` for this
     * tile — the same two figures Best Items' XP ranking and the live panel
     * multiply, read off the one calculator call already cached for profit.
     * @param {string} action - 'coinify' | 'decompose' | 'transmute' | 'unrefine'
     * @param {string} itemHrid - The tile's item
     * @param {Object|null} priceData - From `computePriceData`
     * @returns {number|null} XP per hour, or null
     */
    xpValueFor(action, itemHrid, priceData) {
        if (!priceData) return null;
        const actionsPerHour = Number(priceData.actionsPerHour);
        if (!Number.isFinite(actionsPerHour)) return null;

        const successRate = Number.isFinite(priceData.successRate) ? priceData.successRate : 1;
        // XP reads a level-less item at 0, as rankAlchemyType and the action panel do
        const itemLevel = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid]?.itemLevel || 0;
        const value = calcXpPerAction(action, itemLevel, successRate) * actionsPerHour;
        return Number.isFinite(value) ? value : null;
    }

    /**
     * A tile's ranking value for the given mode, off the cached calculator
     * answer — never re-fetched here.
     * @param {string} action - The open alchemy tab
     * @param {string} mode - 'profit' | 'xp'
     * @param {HTMLElement} tile - An item tile
     * @returns {number|null} The ranking value, or null when the tile could not be priced
     */
    rankValue(action, mode, tile) {
        const hrid = tileItemHrid(tile);
        if (!hrid) return null;
        const priceData = this.priceCache.get(this.tileKey(tile));
        return mode === 'xp' ? this.xpValueFor(action, hrid, priceData) : this.profitValueFrom(priceData);
    }

    /**
     * Price whatever tiles are not already cached, yielding back to the
     * browser and resuming later if that takes a while — filling the cache is
     * the only slow part, so the reorder itself never has to wait.
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     * @param {string} mode - 'profit' | 'xp'
     */
    reorderRanked(grid, tiles, action, mode) {
        const start = nowMs();
        for (const tile of tiles) {
            const key = this.tileKey(tile);
            if (!this.priceCache.has(key)) this.priceCache.set(key, this.computePriceData(action, tile));

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
        this.writeRanked(grid, tiles, action, mode);
    }

    /**
     * Reorder the grid: pinned first (in pin order), then priced tiles
     * best-first for the chosen mode, then unpriced tiles last in whatever
     * order the game gave them.
     * @param {HTMLElement} grid - The tile grid
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} action - The open alchemy tab
     * @param {string} mode - 'profit' | 'xp'
     */
    writeRanked(grid, tiles, action, mode) {
        const { fixed, front, rest } = this.pinBuckets(tiles, action);

        // Read once per pass: the sort compares each tile many times, and
        // every read walks the tile for its sprite and enhancement badge
        const values = new Map(tiles.map((tile) => [tile, this.rankValue(action, mode, tile)]));
        const byGame = (a, b) => this.gameOrderOf(a) - this.gameOrderOf(b);

        const priced = [];
        const unpriced = [];
        for (const tile of rest) {
            (Number.isFinite(values.get(tile)) ? priced : unpriced).push(tile);
        }
        // Ties and unpriced tiles keep the game's order, not whatever order the last mode left behind
        priced.sort((a, b) => values.get(b) - values.get(a) || byGame(a, b));
        unpriced.sort(byGame);

        this.paintValues(tiles, mode, values);

        this.moveTiles(grid, tiles, [...fixed, ...front, ...priced, ...unpriced]);
    }

    /**
     * The blue used for every other XP figure this fork draws — read live so
     * a settings change picks it up on the next reorder rather than needing a
     * menu close/reopen.
     * @returns {string} A CSS color
     */
    xpColor() {
        return config.getSettingValue('color_info', '#60a5fa');
    }

    /**
     * A small profit/hr or XP/hr label on each priced tile — only drawn in
     * Profit/hr or XP/hr order, since Game order carries no ranking to label.
     * @param {HTMLElement[]} tiles - The menu's current tiles
     * @param {string} mode - 'profit' | 'xp'
     * @param {Map<HTMLElement, number|null>} values - Each tile's ranking value, from `rankValue`
     */
    paintValues(tiles, mode, values) {
        for (const tile of tiles) {
            const value = values.get(tile);
            let rate = tile.querySelector(`.${RATE_CLASS}`);

            if (!Number.isFinite(value)) {
                rate?.remove();
                tile.classList.remove(TILE_CLASS);
                continue;
            }

            tile.classList.add(TILE_CLASS);
            if (!rate) {
                rate = document.createElement('div');
                rate.className = RATE_CLASS;
                tile.appendChild(rate);
            }
            const text =
                mode === 'xp'
                    ? `${formatKMB(Math.round(value))} xp/h`
                    : `${value >= 0 ? '' : '-'}${formatKMB(Math.abs(Math.round(value)))}/h`;
            if (rate.textContent !== text) rate.textContent = text;
            rate.style.color = mode === 'xp' ? this.xpColor() : value >= 0 ? '#4ade80' : '#f87171';
        }
    }
}

/**
 * The largest stamp below a given one, or one less than it when there is none.
 * @param {number[]} sorted - Stamps, ascending
 * @param {number} limit - The stamp to stay below
 * @returns {number} The stamp to place a newcomer after
 */
function stampBelow(sorted, limit) {
    let below = limit - 1;
    for (const stamp of sorted) {
        if (stamp >= limit) break;
        below = stamp;
    }
    return below;
}

/**
 * Insert a value into an ascending array, keeping it ascending.
 * @param {number[]} sorted - Ascending values, modified in place
 * @param {number} value - The value to insert
 */
function insertSorted(sorted, value) {
    let index = 0;
    while (index < sorted.length && sorted[index] < value) index += 1;
    sorted.splice(index, 0, value);
}

/**
 * @returns {number} A monotonic-ish clock reading for budgeting the reorder loop
 */
function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

const alchemyItemSort = new AlchemyItemSort();
export default alchemyItemSort;
