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
        this.tableResources = new Map();
        this.savedOrder = [];
        this.storageKey = null;
        this.draggedRow = null;
        this.dragState = null;
        this.decorateQueued = new WeakSet();
        this.initPromise = null;
    }

    /** Follow the feature checkbox immediately instead of requiring a reload. */
    setupSettingListener() {
        config.onSettingChange('market_listingDragOrder', async (enabled) => {
            if (enabled) {
                await this.initialize();
            } else {
                this.cleanup();
            }
        });
    }

    async initialize() {
        if (this.isInitialized || !config.getSetting('market_listingDragOrder')) return;
        // isInitialized is only set after the storage read, so a second call
        // in that window (feature registry plus the settings toggle) would
        // otherwise register a second set of observers
        if (this.initPromise) return this.initPromise;

        const pending = this._initialize();
        this.initPromise = pending;
        try {
            await pending;
        } finally {
            if (this.initPromise === pending) this.initPromise = null;
        }
    }

    async _initialize() {
        const characterId = dataManager.getCurrentCharacterId();
        if (!characterId) return;

        this.storageKey = `${STORAGE_KEY_PREFIX}_${characterId}`;
        const ticket = captureOwner(this);
        const stored = await storage.get(this.storageKey, 'settings', []);
        if (!stillOurs(ticket)) return;
        this.savedOrder = this._sanitizeOrder(stored);
        this.isInitialized = true;
        addStyles(CSS, STYLE_ID);

        // The game replaces the whole listings table when the marketplace is
        // closed and reopened. Release per-table observers/listeners on the
        // removal mutation instead of retaining each old subtree until a
        // character switch or feature toggle.
        const detachObserver = new MutationObserver(() => this._pruneDetachedTables());
        detachObserver.observe(document.body, { childList: true, subtree: true });
        this.cleanupRegistry.registerObserver(detachObserver);

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

        const held = this.tableResources.get(table);
        if (held?.tbody !== tbody) {
            if (held) this._disposeTable(table);
            const resources = createCleanupRegistry();
            const observer = new MutationObserver(() => this._queueDecorate(table));
            observer.observe(tbody, { childList: true, subtree: true });
            resources.registerObserver(observer);
            this._registerTableListeners(table, tbody, resources);
            this.tableResources.set(table, { tbody, resources });
        }

        this._decorate(table);
    }

    /** Release observers and handlers owned by tables that left the document. */
    _pruneDetachedTables() {
        this._dropStaleDrag();
        for (const table of this.tableResources.keys()) {
            if (!table.isConnected) this._disposeTable(table);
        }
    }

    /**
     * Forget a drag whose row left the document. Its dragend fires on the
     * detached node and never bubbles to the tbody listener, so without this
     * `draggedRow` stays set and every later decorate skips the saved order.
     */
    _dropStaleDrag() {
        if (!this.draggedRow || this.draggedRow.isConnected) return;
        this.draggedRow.classList.remove('mwi-listing-dragging');
        this.draggedRow = null;
        this.dragState = null;
    }

    /** @param {HTMLElement} table */
    _disposeTable(table) {
        const held = this.tableResources.get(table);
        if (!held) return;
        held.resources.cleanupAll();
        this.tableResources.delete(table);
    }

    /** @param {HTMLElement} table */
    _queueDecorate(table) {
        if (this.decorateQueued.has(table)) return;
        this.decorateQueued.add(table);
        const ticket = captureOwner(this);
        queueMicrotask(() => {
            this.decorateQueued.delete(table);
            if (table.isConnected && this.isInitialized && stillOurs(ticket)) this._decorate(table);
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
            this._addHandle(row);
        }
        this._dropStaleDrag();
        // Moving a row wakes the tbody observer. Reapplying the previously
        // saved order during that gesture would snap the row back before the
        // next dragover/drop event can persist its new position.
        if (!this.draggedRow) this._applySavedOrder(table);
    }

    /**
     * Delegate controls from the stable tbody so React can replace listing
     * rows without leaving a listener closure attached to every old row.
     * @param {HTMLElement} table
     * @param {HTMLElement} tbody
     * @param {ReturnType<typeof createCleanupRegistry>} resources
     */
    _registerTableListeners(table, tbody, resources) {
        const handleFor = (event) => event.target?.closest?.('.mwi-listing-drag-handle');
        const rowFor = (event) => event.target?.closest?.('tr[data-listing-id]');

        resources.registerListener(tbody, 'click', (event) => {
            if (!handleFor(event)) return;
            event.preventDefault();
            event.stopPropagation();
        });
        resources.registerListener(tbody, 'dragstart', (event) => {
            const handle = handleFor(event);
            const row = handle?.closest('tr[data-listing-id]');
            if (row) this._startDrag(event, row, table);
        });
        resources.registerListener(tbody, 'dragend', (event) => {
            if (handleFor(event)) this._finishDrag(table, event);
        });
        resources.registerListener(tbody, 'keydown', (event) => {
            const handle = handleFor(event);
            const row = handle?.closest('tr[data-listing-id]');
            if (row) this._handleKeydown(event, row, table);
        });
        resources.registerListener(tbody, 'dragover', (event) => {
            const row = rowFor(event);
            if (row) this._dragOver(event, row);
        });
        resources.registerListener(tbody, 'dragleave', (event) => {
            rowFor(event)?.classList.remove('mwi-listing-drag-over');
        });
        resources.registerListener(tbody, 'drop', (event) => {
            const row = rowFor(event);
            if (!row) return;
            event.preventDefault();
            row.classList.remove('mwi-listing-drag-over');
            if (this.dragState) this.dragState.dropped = true;
        });
    }

    /** @param {HTMLElement} row */
    _addHandle(row) {
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
        // A previous gesture that never delivered its dragend must not leave
        // its row marked
        this.draggedRow?.classList.remove('mwi-listing-dragging');
        // Remembered so a cancelled drag (Escape, or a release outside the
        // table) can put every row back where it was
        this.dragState = {
            rows: Array.from(row.parentElement?.children || []),
            wasManual: table.dataset.mwiManualListingOrder === 'true',
            dropped: false,
        };
        // Claim the table before the first DOM move. The collectable-first
        // observer runs on that same move and must yield for the whole gesture,
        // including a character's first manual arrangement.
        table.dataset.mwiManualListingOrder = 'true';
        this.draggedRow = row;
        row.classList.add('mwi-listing-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', row.dataset.listingId);
        }
    }

    /** @param {DragEvent} event @param {HTMLElement} targetRow */
    _dragOver(event, targetRow) {
        if (!this.draggedRow) return;
        // Accept the drop over the dragged row too — it is usually the row
        // under the pointer once it has moved, and an unaccepted release there
        // would report the gesture as cancelled
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (targetRow === this.draggedRow) return;
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

    /**
     * @param {HTMLElement} table
     * @param {DragEvent} [event] - the dragend; a `none` drop effect with no
     *   drop seen means the player cancelled (Escape or released elsewhere)
     */
    _finishDrag(table, event) {
        table.querySelectorAll('.mwi-listing-dragging, .mwi-listing-drag-over').forEach((row) => {
            row.classList.remove('mwi-listing-dragging', 'mwi-listing-drag-over');
        });
        const hadDrag = !!this.draggedRow;
        const state = this.dragState;
        this.draggedRow = null;
        this.dragState = null;
        if (!hadDrag) return;

        const cancelled = event?.dataTransfer?.dropEffect === 'none' && !state?.dropped;
        if (cancelled && state) {
            this._restoreRows(table, state);
            return;
        }
        this._saveOrder(table);
    }

    /**
     * Put the rows back in their pre-drag order and release the manual-order
     * claim if the drag was what made it.
     * @param {HTMLElement} table
     * @param {{rows: Array<HTMLElement>, wasManual: boolean}} state
     */
    _restoreRows(table, state) {
        const tbody = table.querySelector('tbody');
        if (tbody) {
            for (const row of state.rows) {
                if (row.parentElement === tbody) tbody.appendChild(row);
            }
        }
        if (!state.wasManual) delete table.dataset.mwiManualListingOrder;
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
        // A saved order whose listings have all filled or been cancelled says
        // nothing about this table, and claiming it would keep collectable-first
        // sorting switched off for good
        if (!rows.some((row) => rank.has(String(row.dataset.listingId)))) {
            delete table.dataset.mwiManualListingOrder;
            return;
        }
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
        // Keep off-screen IDs only while the game still lists them, so filled
        // and cancelled listings do not pile up in storage forever
        const listings = dataManager.getMarketListings();
        const live = Array.isArray(listings) && listings.length ? new Set(listings.map((l) => String(l?.id))) : null;
        this.savedOrder = [...ids, ...this.savedOrder.filter((id) => !visible.has(id) && (!live || live.has(id)))];
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
        for (const table of [...this.tableResources.keys()]) this._disposeTable(table);
        document.querySelectorAll('.mwi-listing-drag-handle').forEach((handle) => handle.remove());
        document.querySelectorAll(`[class*="${TABLE_CLASS}"]`).forEach((table) => {
            delete table.dataset.mwiManualListingOrder;
        });
        removeStyles(STYLE_ID);
        this.tableResources = new Map();
        this.decorateQueued = new WeakSet();
        this.savedOrder = [];
        this.storageKey = null;
        this.draggedRow = null;
        this.dragState = null;
        this.initPromise = null;
        this.isInitialized = false;
    }
}

const listingDragOrder = new ListingDragOrder();
listingDragOrder.setupSettingListener();
export default listingDragOrder;
