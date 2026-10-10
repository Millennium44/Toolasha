/**
 * Enhance-to-sell Profit/h column
 *
 * Adds a "Profit/h" column to the sell (ask) side of the marketplace order book while an
 * enhanced listing (+1 and up) is open. Each row answers: if I enhanced the base item to this
 * level myself and sold it at this row's ask, what would I earn per hour of enhancing?
 *
 * - Revenue: the row's ask after market tax.
 * - Cost and time: the optimal enhancement path from +0 to the level, from the same calculator
 *   the enhancement tooltip uses (base item, materials × expected attempts, protection at the
 *   cheapest strategy, Philosopher's Mirror when it is cheaper), with this character's enhancing
 *   parameters.
 *
 * The path only depends on the item and level, so it is computed once per (item, level) and held
 * until market prices or the enhancing parameters change. Each row adds only its own revenue.
 *
 * Injection follows the order-book pattern of estimated-listing-age.js: the item comes from the
 * current-item sprite, the level from the enhancement badge, and the rows are matched to the
 * order book's asks by position.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { calculateEnhancementPath } from '../enhancement/tooltip-enhancement.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';

export const ENHANCE_PROFIT_SETTING = 'market_enhanceProfitPerHour';

const HEADER_CLASS = 'mwi-enh-profit-header';
const CELL_CLASS = 'mwi-enh-profit-cell';
const STAMP_ATTR = 'data-mwi-enh-profit';

/** Order-book messages arrive one per level when an item opens; draw once after the run. */
const REPAINT_DEBOUNCE_MS = 50;

/** Held path quotes: a safety net beside the price/params invalidation. */
const QUOTE_TTL_MS = 5 * 60 * 1000;

const DASH = '—';

/**
 * Profit per hour of enhancing an item to a level and selling it at a given ask.
 * @param {Object} params
 * @param {number} params.askPrice - The row's ask, before tax
 * @param {number} params.cost - Expected cost of reaching the level from +0, base item included
 * @param {number} params.hours - Expected enhancing hours to reach the level
 * @param {Function} [params.afterTax] - Tax rule, calculatePriceAfterTax by default
 * @returns {{revenue: number, profit: number, profitPerHour: number}|null} null when the inputs
 *   cannot produce a rate
 */
export function computeProfitPerHour({ askPrice, cost, hours, afterTax = calculatePriceAfterTax }) {
    if (!(askPrice > 0) || !Number.isFinite(cost) || !(cost > 0) || !(hours > 0)) return null;
    const revenue = afterTax(askPrice);
    const profit = revenue - cost;
    return { revenue, profit, profitPerHour: profit / hours };
}

/**
 * The cost and time of taking an item from +0 to a level, or why it cannot be quoted.
 * @param {string} itemHrid - Item being enhanced
 * @param {number} level - Target level
 * @param {Object} params - Enhancing parameters (getEnhancingParams())
 * @param {Function} [pathFn] - Path calculator, calculateEnhancementPath by default
 * @returns {{ok: true, cost: number, hours: number, attempts: number, protections: number,
 *   mirrors: number}|{ok: false, reason: string}} The quote
 */
export function buildLevelQuote(itemHrid, level, params, pathFn = calculateEnhancementPath) {
    if (!params) return { ok: false, reason: 'Enhancing stats are not known yet' };
    if (level > 20) return { ok: false, reason: `The enhancement calculator stops at +20` };

    let path = null;
    try {
        path = pathFn(itemHrid, level, params);
    } catch (error) {
        console.error('[EnhanceProfitColumn] Path calculation failed:', error);
        return { ok: false, reason: 'The enhancement path could not be calculated' };
    }

    const strategy = path?.optimalStrategy;
    if (!strategy) return { ok: false, reason: 'No enhancement path for this item and level' };
    if (path.pricesPartial) {
        return { ok: false, reason: 'The base item or an enhancing material has no market price' };
    }

    const cost = strategy.totalCost;
    const hours = (strategy.totalTime || 0) / 3600;
    if (!Number.isFinite(cost) || !(cost > 0)) return { ok: false, reason: 'The enhancing cost could not be priced' };
    if (!(hours > 0)) return { ok: false, reason: 'The enhancing time is unknown' };

    return {
        ok: true,
        cost,
        hours,
        attempts: strategy.expectedAttempts || 0,
        protections: strategy.protectionCount || 0,
        mirrors: strategy.mirrorCount || 0,
    };
}

/**
 * The tooltip for one row.
 * @param {Object} quote - A successful {@link buildLevelQuote}
 * @param {Object} result - {@link computeProfitPerHour}
 * @returns {string} Multi-line breakdown
 */
function describeRow(quote, result) {
    const lines = [
        `Revenue after tax: ${formatWithSeparator(Math.round(result.revenue))}`,
        `Expected cost from +0: ${formatWithSeparator(Math.round(quote.cost))}`,
        `Profit per item: ${formatWithSeparator(Math.round(result.profit))}`,
        `Expected time: ${quote.hours.toFixed(2)} h`,
        `Expected attempts: ${formatWithSeparator(Math.round(quote.attempts))}`,
        `Expected protections: ${formatWithSeparator(Math.round(quote.protections))}`,
    ];
    if (quote.mirrors > 0) lines.push(`Philosopher's Mirrors: ${quote.mirrors}`);
    lines.push('Your enhancing stats; optimal protection strategy');
    return lines.join('\n');
}

class EnhanceProfitColumn {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        /** itemHrid -> marketItemOrderBooks payload (latest only per item) */
        this.orderBooks = new Map();
        /** `${itemHrid}|${level}` -> { quote, signature, at } */
        this.quoteCache = new Map();
        this._repaintTimer = null;
        this._containerObserver = null;
        this._observedContainer = null;
    }

    /** Whether the column should be shown at all for this character. */
    shouldShow() {
        if (!config.getSetting(ENHANCE_PROFIT_SETTING)) return false;
        if (config.getSetting('ironCow_enabled')) return false;
        return !isIronCowCharacter();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(ENHANCE_PROFIT_SETTING)) return;
        this.isInitialized = true;

        const bookHandler = (data) => {
            const books = data?.marketItemOrderBooks;
            if (!books?.itemHrid) return;
            this.orderBooks.set(books.itemHrid, books);
            this.scheduleRepaint();
        };
        dataManager.on('market_item_order_books_updated', bookHandler);

        const priceHandler = () => {
            this.quoteCache.clear();
            this.scheduleRepaint();
        };
        marketAPI.on(priceHandler);

        const unregisterObserver = domObserver.onClass(
            'EnhanceProfitColumn',
            'MarketplacePanel_orderBooksContainer',
            (container) => this.processContainer(container)
        );

        this.cleanupRegistry.registerCleanup(() => {
            dataManager.off('market_item_order_books_updated', bookHandler);
            marketAPI.off(priceHandler);
            unregisterObserver();
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
            this._disconnectContainer();
        });

        this.repaint();
    }

    scheduleRepaint() {
        if (this._repaintTimer) return;
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null;
            this.repaint();
        }, REPAINT_DEBOUNCE_MS);
    }

    repaint() {
        document.querySelectorAll(GAME.MARKETPLACE_ORDER_BOOKS).forEach((c) => this.processContainer(c));
    }

    /**
     * Watch the order book for React redrawing its rows (a level switch, a refreshed book), so
     * the column follows without waiting for a websocket message.
     * @param {HTMLElement} container - Order book container
     */
    _watchContainer(container) {
        if (this._observedContainer === container) return;
        this._disconnectContainer();
        if (typeof MutationObserver === 'undefined') return;
        this._containerObserver = new MutationObserver(() => this.scheduleRepaint());
        this._containerObserver.observe(container, { childList: true, subtree: true });
        this._observedContainer = container;
    }

    _disconnectContainer() {
        this._containerObserver?.disconnect();
        this._containerObserver = null;
        this._observedContainer = null;
    }

    /**
     * @returns {string|null} Item open in the order book, from its icon sprite
     */
    getCurrentItemHrid() {
        const current = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const use = current?.querySelector('use');
        const href = use?.href?.baseVal || use?.getAttribute?.('href') || use?.getAttribute?.('xlink:href');
        return href && href.includes('#') ? '/items/' + href.split('#')[1] : null;
    }

    /**
     * @returns {number} Enhancement level of the open listing (0 when none)
     */
    getCurrentEnhancementLevel() {
        const current = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const badge = current?.querySelector('[class*="Item_enhancementLevel"]');
        const match = badge?.textContent.match(/\+(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    /**
     * What a cached quote depends on besides the item and level.
     * @param {Object} params - Enhancing parameters
     * @returns {string} Signature
     */
    paramsSignature(params) {
        return JSON.stringify([
            dataManager.getCurrentCharacterId?.() ?? null,
            params?.enhancingLevel,
            params?.houseLevel,
            params?.toolBonus,
            params?.speedBonus,
            params?.guzzlingBonus,
            params?.blessedTeaBonus,
            params?.teas,
            config.getSetting('enhanceSim_baseItemCraftingCost'),
        ]);
    }

    /**
     * The cost and time quote for one (item, level), computed once and held.
     * @param {string} itemHrid - Item
     * @param {number} level - Level
     * @returns {Object} {@link buildLevelQuote} result
     */
    getQuote(itemHrid, level) {
        const params = getEnhancingParams();
        const signature = this.paramsSignature(params);
        const key = `${itemHrid}|${level}`;
        const held = this.quoteCache.get(key);
        if (held && held.signature === signature && Date.now() - held.at < QUOTE_TTL_MS) {
            return held.quote;
        }
        const quote = buildLevelQuote(itemHrid, level, params);
        this.quoteCache.set(key, { quote, signature, at: Date.now() });
        return quote;
    }

    /**
     * Remove the column from one table.
     * @param {Element} table - Order book table
     */
    removeFrom(table) {
        table.querySelectorAll(`.${HEADER_CLASS}, .${CELL_CLASS}`).forEach((el) => el.remove());
        table.removeAttribute(STAMP_ATTR);
    }

    /**
     * Draw (or take down) the column in one order-book container.
     * @param {HTMLElement} container - Order book container
     */
    processContainer(container) {
        if (!container?.isConnected) return;
        const tables = container.querySelectorAll('table');
        const sellTable = Array.from(tables).find((table) => this.isSellTable(table, container));

        const itemHrid = this.shouldShow() ? this.getCurrentItemHrid() : null;
        const level = itemHrid ? this.getCurrentEnhancementLevel() : 0;
        const book = itemHrid ? this.orderBooks.get(itemHrid)?.orderBooks?.[level] : null;
        const itemDetails = itemHrid ? dataManager.getItemDetails?.(itemHrid) : null;
        const enhanceable = Boolean(itemDetails?.enhancementCosts?.length);

        if (!this.shouldShow()) {
            tables.forEach((table) => this.removeFrom(table));
            this._disconnectContainer();
            return;
        }
        this._watchContainer(container);

        // Only the ask side, and only for an enhanced listing of an enhanceable item
        tables.forEach((table) => {
            if (table !== sellTable) this.removeFrom(table);
        });
        if (!sellTable) return;
        if (!itemHrid || level < 1 || !enhanceable || !book) {
            this.removeFrom(sellTable);
            return;
        }

        this.drawColumn(sellTable, itemHrid, level, book.asks || []);
    }

    /**
     * @param {Element} table - A table in the container
     * @param {Element} container - The order book container
     * @returns {boolean} Whether it is the sell (ask) table
     */
    isSellTable(table, container) {
        const tableContainer = table.closest('[class*="orderBookTableContainer"]');
        if (tableContainer) return tableContainer === container.children[0];
        return container.querySelector('table') === table;
    }

    /**
     * Put the column into the sell table, unless it is already there for this item, level and
     * set of rows.
     * @param {Element} table - The sell table
     * @param {string} itemHrid - Item
     * @param {number} level - Level
     * @param {Array<{price: number}>} asks - The book's asks at this level, best first
     */
    drawColumn(table, itemHrid, level, asks) {
        const theadRow = table.querySelector('thead tr');
        const tbody = table.querySelector('tbody');
        if (!theadRow || !tbody) return;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        const quote = this.getQuote(itemHrid, level);
        const askSignature = asks.map((ask) => ask?.price).join(',');
        const stamp = `${itemHrid}|${level}|${askSignature}|${quote.ok ? quote.cost + ':' + quote.hours : quote.reason}`;
        const complete =
            table.getAttribute(STAMP_ATTR) === stamp &&
            theadRow.querySelectorAll(`.${HEADER_CLASS}`).length === 1 &&
            rows.every((row) => row.querySelectorAll(`.${CELL_CLASS}`).length === 1);
        if (complete) return;

        this.removeFrom(table);
        table.setAttribute(STAMP_ATTR, stamp);

        // Column position: right after the price column, as the game draws it
        const firstDataRow = rows.find((row) => !this.isSeparator(row) && row.children.length > 1);
        const priceCell = firstDataRow?.querySelector('[class*="price"]')?.closest('td');
        const priceIndex = priceCell ? Array.prototype.indexOf.call(firstDataRow.children, priceCell) : -1;

        const header = document.createElement('th');
        header.className = HEADER_CLASS;
        header.textContent = 'Profit/h';
        header.title =
            'Profit per hour of enhancing the base item to this level yourself and selling it at this ' +
            "row's ask (after tax), using your enhancing stats and the cheapest protection strategy";
        header.style.whiteSpace = 'nowrap';
        insertAt(theadRow, header, priceIndex >= 0 ? priceIndex + 1 : -1);

        let index = 0;
        for (const row of rows) {
            const cell = document.createElement('td');
            cell.className = CELL_CLASS;
            cell.style.whiteSpace = 'nowrap';
            cell.style.fontSize = '0.9em';

            if (this.isSeparator(row)) {
                insertAt(row, cell, priceIndex >= 0 ? priceIndex + 1 : -1);
                continue;
            }

            const ask = index < asks.length ? asks[index] : null;
            index++;
            if (ask) this.fillCell(cell, quote, ask.price);
            insertAt(row, cell, priceIndex >= 0 ? priceIndex + 1 : -1);
        }
    }

    /**
     * @param {Element} row - A body row
     * @returns {boolean} Whether it is the game's "outside tradable range" grouping row
     */
    isSeparator(row) {
        return row.matches('[class*="MarketplacePanel_outsideRangeSeparator"]');
    }

    /**
     * Write one row's figure.
     * @param {HTMLElement} cell - The cell
     * @param {Object} quote - The level's quote
     * @param {number} askPrice - The row's ask
     */
    fillCell(cell, quote, askPrice) {
        if (!quote.ok) {
            cell.textContent = DASH;
            cell.title = quote.reason;
            cell.style.color = '#888';
            return;
        }
        const result = computeProfitPerHour({ askPrice, cost: quote.cost, hours: quote.hours });
        if (!result) {
            cell.textContent = DASH;
            cell.title = 'This row has no usable price';
            cell.style.color = '#888';
            return;
        }
        cell.textContent = formatKMB(result.profitPerHour, 2);
        cell.title = describeRow(quote, result);
        cell.style.color = result.profitPerHour >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
    }

    clearDisplays() {
        document.querySelectorAll(`.${HEADER_CLASS}, .${CELL_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`[${STAMP_ATTR}]`).forEach((el) => el.removeAttribute(STAMP_ATTR));
    }

    disable() {
        this.cleanupRegistry.cleanupAll();
        this.clearDisplays();
        this.orderBooks.clear();
        this.quoteCache.clear();
        this.isInitialized = false;
    }

    cleanup() {
        this.disable();
    }
}

/**
 * Insert a child at an index, or append it when the index is unknown or past the end.
 * @param {Element} parent - Parent element
 * @param {Element} child - Element to insert
 * @param {number} index - Target index, -1 to append
 */
function insertAt(parent, child, index) {
    const reference = index >= 0 ? parent.children[index] || null : null;
    parent.insertBefore(child, reference);
}

const enhanceProfitColumn = new EnhanceProfitColumn();

// Follow the checkbox at once: off removes the column immediately
config.onSettingChange(ENHANCE_PROFIT_SETTING, (enabled) => {
    if (enabled) {
        enhanceProfitColumn.initialize();
    } else {
        enhanceProfitColumn.disable();
    }
});

export default enhanceProfitColumn;
