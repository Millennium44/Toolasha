/**
 * Instant Order Gap
 *
 * A Buy Now / Sell Now order fills at the other side's best price, so when the best sell offer and the best
 * buy offer are two or more price steps apart, a listing would have done noticeably better. This adds one
 * line to those dialogs saying how many steps apart the two are and what the gap costs, and stays silent when
 * the two are adjacent (one step, or crossed).
 *
 * Nothing here clicks, fills or blocks anything: the line is text, and the dialog's own buttons are untouched.
 *
 * The step is the game's own price increment (`priceIncrement` in utils/market-values.js, the game's
 * `binGap`), which grows with the price and is five times wider for an enhanced item, so the same coin
 * amount can be one step on one item and ten on another.
 *
 * The book comes from the order-book messages the game sends when a market item opens (cached per item), not
 * from the dialog, so the line is silent when no book for the dialog's item has been seen. The dialog's item is
 * read from its icon sprite; whether it is a Buy Now or Sell Now dialog is read from its title, so the line is
 * English-title only.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { nextPriceUp } from '../../utils/market-values.js';
import { findQuantityInput, modalItemHrid } from '../../utils/marketplace-autofill.js';
import { parseItemCount } from '../../utils/number-parser.js';

const SETTING = 'market_instantOrderGap';
const LINE_CLASS = 'mwi-instant-order-gap';
// A bad book can put the two prices very far apart; there is no point counting every step
const MAX_STEPS = 999;
const SHOW_DELAY_MS = 150;
// Fewer steps than this is "adjacent" and says nothing
const MIN_STEPS_TO_WARN = 2;
// An order book older than this may no longer be the book the dialog fills against
const MAX_BOOK_AGE_MS = 5 * 60 * 1000;

/**
 * @param {number} low - The lower price
 * @param {number} high - The higher price
 * @param {number} [enhancementLevel=0]
 * @returns {number} How many "+" clicks of the game's price control get from low to high, capped at MAX_STEPS
 */
export function countPriceSteps(low, high, enhancementLevel = 0) {
    let steps = 0;
    let price = low;
    while (price < high && steps < MAX_STEPS) {
        price = nextPriceUp(price, enhancementLevel);
        steps += 1;
    }
    return steps;
}

/**
 * @param {{asks?: Array<{price: number}>, bids?: Array<{price: number}>}|undefined} book - One enhancement
 *     level of an item's order book
 * @param {number} enhancementLevel
 * @returns {{ask: number, bid: number, steps: number}|null} The gap between the best offers; null when either
 *     side is empty or the two cross
 */
export function measureGap(book, enhancementLevel) {
    const ask = book?.asks?.[0]?.price;
    const bid = book?.bids?.[0]?.price;
    if (!(ask > 0) || !(bid > 0) || ask <= bid) return null;
    return { ask, bid, steps: countPriceSteps(bid, ask, enhancementLevel) };
}

/**
 * @param {Object|Array|undefined} orderBooks - A market item's `orderBooks`, an array or a map by level
 * @param {number} level - Enhancement level
 * @returns {Object|undefined} That level's book
 */
function bookAtLevel(orderBooks, level) {
    return Array.isArray(orderBooks) ? orderBooks[level] : orderBooks?.[String(level)];
}

/**
 * The enhancement level the dialog is set to. An unenhanceable item's dialog has no such field: level 0.
 * @param {HTMLElement} modal - Modal container element
 * @returns {number}
 */
function modalEnhancementLevel(modal) {
    for (const input of modal.querySelectorAll('input')) {
        let parent = input.parentElement;
        for (let step = 0; step < 4 && parent; step++, parent = parent.parentElement) {
            const text = parent.textContent || '';
            if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                return parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10) || 0;
            }
        }
    }
    return 0;
}

/**
 * Which instant order a dialog is, from its title.
 * @param {HTMLElement} modal - Modal container element
 * @returns {'buy'|'sell'|null} null for anything else (a listing, the shop, another modal)
 */
function instantKind(modal) {
    const title = modal.querySelector('div[class*="MarketplacePanel_header"]')?.textContent || '';
    if (title.includes('Buy Now')) return 'buy';
    if (title.includes('Sell Now')) return 'sell';
    return null;
}

/**
 * The text of the warning line.
 * @param {'buy'|'sell'} kind
 * @param {{steps: number, each: number}} gap
 * @param {number} quantity - Quantity typed in the dialog, 0 when empty
 * @returns {string}
 */
export function gapText(kind, gap, quantity) {
    const each = formatWithSeparator(gap.each);
    const head =
        kind === 'sell'
            ? `Sell Now pays ${gap.steps} price steps below the best sell offer (${each} less per item)`
            : `Buy Now costs ${gap.steps} price steps above the best buy offer (${each} more per item)`;
    return quantity > 1
        ? `${head}, ${formatWithSeparator(gap.each * quantity)} for ${formatWithSeparator(quantity)}`
        : head;
}

class InstantOrderGap {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.processedModals = new WeakSet();
        // itemHrid -> { books: the last `marketItemOrderBooks` message for it, receivedAt }
        this.orderBooks = new Map();
        // Dialogs currently carrying (or able to carry) the line, so a new book can refresh them
        this.openModals = new Set();
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;

        this.isInitialized = true;

        const onBooks = (data) => {
            const books = data?.marketItemOrderBooks;
            if (!books?.itemHrid) return;
            this.orderBooks.set(books.itemHrid, { books, receivedAt: Date.now() });
            for (const modal of [...this.openModals]) this.refresh(modal);
        };
        dataManager.on('market_item_order_books_updated', onBooks);
        this.cleanupRegistry.registerCleanup(() => dataManager.off('market_item_order_books_updated', onBooks));

        const unregister = domObserver.onClass('instant-order-gap', 'Modal_modalContainer', (modal) => {
            this.handleModal(modal);
        });
        this.cleanupRegistry.registerCleanup(unregister);
    }

    /**
     * @param {HTMLElement} modal - Modal container element
     */
    handleModal(modal) {
        if (!this.isInitialized || this.processedModals.has(modal)) return;
        if (!instantKind(modal)) return;
        this.processedModals.add(modal);

        // Typing a quantity or changing the enhancement level moves the figures; the listeners go with the dialog
        const onChange = () => this.refresh(modal);
        this.cleanupRegistry.registerListener(modal, 'input', onChange, true);
        this.cleanupRegistry.registerListener(modal, 'click', () => setTimeout(onChange, 0), true);
        this.openModals.add(modal);

        // Let the dialog finish rendering before reading its state
        this.cleanupRegistry.registerTimeout(setTimeout(() => this.refresh(modal), SHOW_DELAY_MS));
    }

    /**
     * Draw, update or remove the line for one dialog.
     * @param {HTMLElement} modal - Modal container element
     */
    refresh(modal) {
        if (!this.isInitialized) return;
        if (!modal.isConnected) {
            this.openModals.delete(modal);
            return;
        }
        const existing = modal.querySelector(`.${LINE_CLASS}`);

        const kind = instantKind(modal);
        const itemHrid = modalItemHrid(modal);
        const level = modalEnhancementLevel(modal);
        const cached = itemHrid ? this.orderBooks.get(itemHrid) : null;
        const books = cached && Date.now() - cached.receivedAt <= MAX_BOOK_AGE_MS ? cached.books : null;
        const gap =
            kind && books && books.itemHrid === itemHrid
                ? measureGap(bookAtLevel(books.orderBooks, level), level)
                : null;

        if (!gap || gap.steps < MIN_STEPS_TO_WARN) {
            existing?.remove();
            return;
        }

        const quantityInput = findQuantityInput(modal);
        const quantity = parseItemCount(quantityInput?.value, 0);
        const el = existing || document.createElement('div');
        if (!existing) {
            el.className = LINE_CLASS;
            // Zero width with a full-width minimum: the line fills the dialog but adds nothing to the width the
            // dialog sizes itself by, so a long message wraps instead of widening it
            el.style.cssText = `text-align: center; font-size: 13px; margin: 4px 0; color: ${config.COLOR_WARNING}; width: 0; min-width: 100%; box-sizing: border-box; white-space: normal; overflow-wrap: anywhere;`;
            const quantityRow = modal.querySelector('div[class*="MarketplacePanel_quantityInputs"]');
            if (quantityRow) quantityRow.insertAdjacentElement('beforebegin', el);
            else modal.appendChild(el);
        }
        el.textContent = gapText(kind, { steps: gap.steps, each: gap.ask - gap.bid }, quantity);
    }

    disable() {
        document.querySelectorAll(`.${LINE_CLASS}`).forEach((el) => el.remove());
        this.cleanupRegistry.cleanupAll();
        this.processedModals = new WeakSet();
        this.openModals = new Set();
        this.orderBooks = new Map();
        this.isInitialized = false;
    }

    cleanup() {
        this.disable();
    }
}

const instantOrderGap = new InstantOrderGap();

export default instantOrderGap;
