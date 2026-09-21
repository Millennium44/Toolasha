/**
 * My Listings Drag Order
 *
 * Adds a small drag handle to each row in the native My Listings table and
 * remembers the chosen order per character. This is presentation-only: the
 * marketplace listings themselves remain owned and ordered by the game.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import listingPriceDisplay from './listing-price-display.js';

const TABLE_CLASS = 'MarketplacePanel_myListingsTable';
const STORAGE_KEY_PREFIX = 'marketListingDragOrder';
const STYLE_ID = 'mwi-listing-drag-order-styles';
const SORT_INDICATOR_PATTERN = /[▲▼#]/;

const CSS = `
.mwi-listing-drag-handle {
    appearance: none;
    background: transparent;
    border: 0;
    color: rgba(232, 236, 245, 0.55);
    cursor: grab;
    font: inherit;
    line-height: 1;
    margin: 0 7px 0 -4px;
    padding: 5px 4px;
    touch-action: none;
    vertical-align: middle;
}
.mwi-listing-drag-handle:hover,
.mwi-listing-drag-handle:focus-visible {
    color: rgb(158, 196, 255);
    outline: none;
}
.mwi-listing-drag-handle:active { cursor: grabbing; }
tr.mwi-listing-dragging { opacity: 0.45; }
tr.mwi-listing-drag-over { box-shadow: inset 0 2px rgb(158, 196, 255); }
`;

class ListingDragOrder {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.tbodyObservers = new WeakMap();
        this.savedOrder = [];
        this.storageKey = null;
        this.draggedRow = null;
        this.decorateQueued = new WeakSet();
    }

    async initialize() {
        if (this.isInitialized || !config.getSetting('market_listingDragOrder')) return;

        const characterId = dataManager.getCurrentCharacterId();
        if (!characterId) return;

        this.storageKey = `${STORAGE_KEY_PREFIX}_${characterId}`;
        const ticket = captureOwner(this);
        const stored = await storage.get(this.storageKey, 'settings', []);
        if (!stillOurs(ticket)) return;
        this.savedOrder = this._sanitizeOrder(stored);
        this.isInitialized = true;
        addStyles(CSS, STYLE_ID);

        const unregister = domObserver.onClass('ListingDragOrder', TABLE_CLASS, (tableNode) => {
            this._watchTable(tableNode);
        });
        this.cleanupRegistry.registerCleanup(unregister);
        this.cleanupRegistry.registerCleanup(
            domObserver.onReady('ListingDragOrderCatchUp', () => {
                const table = document.querySelector(`[class*="${TABLE_CLASS}"]`);
                if (table) this._watchTable(table);
            })
        );
    }

    /** @param {*} value @returns {Array<string>} */
    _sanitizeOrder(value) {
        if (!Array.isArray(value)) return [];
        return [...new Set(value.filter((id) => ['string', 'number'].includes(typeof id)).map(String))];
    }

    /** @param {HTMLElement} table */
    _watchTable(table) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        if (!this.tbodyObservers.has(tbody)) {
            const observer = new MutationObserver(() => this._queueDecorate(table));
            observer.observe(tbody, { childList: true, subtree: true });
            this.tbodyObservers.set(tbody, observer);
            this.cleanupRegistry.registerObserver(observer);
        }

        this._decorate(table);
    }

    /** @param {HTMLElement} table */
    _queueDecorate(table) {
        if (this.decorateQueued.has(table)) return;
        this.decorateQueued.add(table);
        queueMicrotask(() => {
            this.decorateQueued.delete(table);
            if (table.isConnected) this._decorate(table);
        });
    }

    /**
     * Give rows stable listing IDs even when the optional price columns are disabled.
     * Reuses the row parser already maintained by listing-price-display.
     * @param {HTMLElement} tbody
     */
    _assignMissingListingIds(tbody) {
        const listings = dataManager.getMarketListings();
        if (!Array.isArray(listings) || listings.length === 0) return;

        const used = new Set(
            Array.from(tbody.querySelectorAll('tr[data-listing-id]'), (row) => String(row.dataset.listingId))
        );

        for (const row of tbody.querySelectorAll('tr:not([data-listing-id])')) {
            const info = listingPriceDisplay.extractRowInfo(row);
            const match = listings.find((listing) => {
                if (listing?.id == null || used.has(String(listing.id))) return false;
                if (
                    listing.itemHrid !== info.itemHrid ||
                    listing.enhancementLevel !== info.enhancementLevel ||
                    listing.isSell !== info.isSell
                ) {
                    return false;
                }
                if (info.price && Math.abs(listing.price - info.price) >= 0.01) return false;
                if (info.filledQuantity === null || info.orderQuantity === null) return true;

                const filledMatches =
                    info.filledSuffixMultiplier > 1
                        ? Math.floor(listing.filledQuantity / info.filledSuffixMultiplier) ===
                          Math.floor(info.filledQuantity / info.filledSuffixMultiplier)
                        : listing.filledQuantity === info.filledQuantity;
                const orderMatches =
                    info.orderSuffixMultiplier > 1
                        ? Math.floor(listing.orderQuantity / info.orderSuffixMultiplier) ===
                          Math.floor(info.orderQuantity / info.orderSuffixMultiplier)
                        : listing.orderQuantity === info.orderQuantity;
                return filledMatches && orderMatches;
            });

            if (!match) continue;
            used.add(String(match.id));
            row.dataset.listingId = String(match.id);
            row.dataset.isSell = String(match.isSell);
        }
    }

    /** @param {HTMLElement} table */
    _decorate(table) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        this._assignMissingListingIds(tbody);
        for (const row of tbody.querySelectorAll('tr[data-listing-id]')) {
            this._addHandle(row, table);
        }
        this._applySavedOrder(table);
    }

    /** @param {HTMLElement} row @param {HTMLElement} table */
    _addHandle(row, table) {
        if (row.querySelector('.mwi-listing-drag-handle')) return;
        const statusCell = row.children[0];
        if (!statusCell) return;

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'mwi-listing-drag-handle';
        handle.textContent = '⠿';
        handle.draggable = true;
        handle.setAttribute('aria-label', 'Drag to reorder this listing');
        handle.title = 'Drag to reorder. With the handle focused, use Up/Down to move the listing.';
        statusCell.prepend(handle);

        handle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        handle.addEventListener('dragstart', (event) => this._startDrag(event, row, table));
        handle.addEventListener('dragend', () => this._finishDrag(table));
        handle.addEventListener('keydown', (event) => this._handleKeydown(event, row, table));
        row.addEventListener('dragover', (event) => this._dragOver(event, row));
        row.addEventListener('dragleave', () => row.classList.remove('mwi-listing-drag-over'));
        row.addEventListener('drop', (event) => {
            event.preventDefault();
            row.classList.remove('mwi-listing-drag-over');
        });
    }

    /** @param {HTMLElement} table @returns {boolean} */
    _hasColumnSort(table) {
        return SORT_INDICATOR_PATTERN.test(table.querySelector('thead')?.textContent || '');
    }

    /** @param {DragEvent} event @param {HTMLElement} row @param {HTMLElement} table */
    _startDrag(event, row, table) {
        const handle = row.querySelector('.mwi-listing-drag-handle');
        if (this._hasColumnSort(table)) {
            event.preventDefault();
            handle.title = 'Clear the active column sort before arranging listings manually.';
            return;
        }
        handle.title = 'Drag to reorder. With the handle focused, use Up/Down to move the listing.';
        this.draggedRow = row;
        row.classList.add('mwi-listing-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', row.dataset.listingId);
        }
    }

    /** @param {DragEvent} event @param {HTMLElement} targetRow */
    _dragOver(event, targetRow) {
        if (!this.draggedRow || targetRow === this.draggedRow) return;
        event.preventDefault();
        const rect = targetRow.getBoundingClientRect();
        const after = event.clientY >= rect.top + rect.height / 2;
        this._moveRow(this.draggedRow, targetRow, after);
        targetRow.classList.add('mwi-listing-drag-over');
    }

    /** @param {HTMLElement} row @param {HTMLElement} targetRow @param {boolean} after */
    _moveRow(row, targetRow, after) {
        const tbody = targetRow.parentElement;
        if (!tbody || row.parentElement !== tbody) return;
        const reference = after ? targetRow.nextSibling : targetRow;
        if (reference !== row) tbody.insertBefore(row, reference);
    }

    /** @param {KeyboardEvent} event @param {HTMLElement} row @param {HTMLElement} table */
    _handleKeydown(event, row, table) {
        if (!['ArrowUp', 'ArrowDown'].includes(event.key) || this._hasColumnSort(table)) return;
        const target = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'ArrowUp') {
            this._moveRow(row, target, false);
        } else {
            this._moveRow(row, target, true);
        }
        this._saveOrder(table);
        row.querySelector('.mwi-listing-drag-handle')?.focus();
    }

    /** @param {HTMLElement} table */
    _finishDrag(table) {
        table.querySelectorAll('.mwi-listing-dragging, .mwi-listing-drag-over').forEach((row) => {
            row.classList.remove('mwi-listing-dragging', 'mwi-listing-drag-over');
        });
        const hadDrag = !!this.draggedRow;
        this.draggedRow = null;
        if (hadDrag) this._saveOrder(table);
    }

    /** @param {HTMLElement} table */
    _applySavedOrder(table) {
        if (this.savedOrder.length < 2 || this._hasColumnSort(table)) {
            delete table.dataset.mwiManualListingOrder;
            return;
        }

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const rank = new Map(this.savedOrder.map((id, index) => [id, index]));
        const desired = rows
            .map((row, index) => ({ row, index, rank: rank.get(String(row.dataset.listingId)) ?? Infinity }))
            .sort((a, b) => a.rank - b.rank || a.index - b.index)
            .map(({ row }) => row);
        if (!desired.every((row, index) => row === rows[index])) {
            for (const row of desired) tbody.appendChild(row);
        }
        table.dataset.mwiManualListingOrder = 'true';
    }

    /** @param {HTMLElement} table */
    async _saveOrder(table) {
        const ids = Array.from(table.querySelectorAll('tbody tr[data-listing-id]'), (row) => row.dataset.listingId);
        if (ids.length < 2) return;

        const visible = new Set(ids);
        this.savedOrder = [...ids, ...this.savedOrder.filter((id) => !visible.has(id))];
        table.dataset.mwiManualListingOrder = 'true';
        try {
            const saved = await storage.set(this.storageKey, this.savedOrder, 'settings');
            if (saved) return;
            console.warn('[ListingDragOrder] The new listing order is active for this page but could not be saved.');
        } catch (error) {
            console.warn(
                '[ListingDragOrder] The new listing order is active for this page but could not be saved.',
                error
            );
        }
    }

    cleanup() {
        noteTeardown(this);
        this.cleanupRegistry.cleanupAll();
        document.querySelectorAll('.mwi-listing-drag-handle').forEach((handle) => handle.remove());
        document.querySelectorAll(`[class*="${TABLE_CLASS}"]`).forEach((table) => {
            delete table.dataset.mwiManualListingOrder;
        });
        removeStyles(STYLE_ID);
        this.tbodyObservers = new WeakMap();
        this.decorateQueued = new WeakSet();
        this.savedOrder = [];
        this.storageKey = null;
        this.draggedRow = null;
        this.isInitialized = false;
    }
}

const listingDragOrder = new ListingDragOrder();
export default listingDragOrder;
