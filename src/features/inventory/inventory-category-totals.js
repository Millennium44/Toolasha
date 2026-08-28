/**
 * Inventory Category Totals
 *
 * Appends the total market value of all item stacks in each inventory category
 * to the category label (e.g. "Equipment  3.2M", "Food  480K").
 *
 * Registers as a badge provider at priority 200 so it runs after the badge manager
 * has already populated dataset.askValue / dataset.bidValue on every item element.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import inventoryBadgeManager from './inventory-badge-manager.js';
import inventorySort from './inventory-sort.js';
import { formatKMB } from '../../utils/formatters.js';
import * as dom from '../../utils/dom.js';

const CSS_ID = 'mwi-inv-category-totals';
const SPAN_ATTR = 'data-mwi-category-total';

const CSS = `
.mwi-category-total {
    margin-left: 8px;
    font-size: 10pt;
    font-weight: bold;
    opacity: 0.8;
}
`;

const ITEMS_UPDATED_DEBOUNCE_MS = 300;

class InventoryCategoryTotals {
    constructor() {
        this.isInitialized = false;
        this.pendingUpdate = false;
        this.itemsUpdatedHandler = null;
        this.itemsUpdatedDebounceTimer = null;
    }

    initialize() {
        if (!config.getSetting('invCategoryTotals')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        dom.addStyles(CSS, CSS_ID);

        inventoryBadgeManager.registerProvider('inventory-category-totals', () => this.scheduleUpdate(), 200);

        // Trigger an immediate render pass so totals appear without needing a manual refresh
        inventoryBadgeManager.clearProcessedTracking();

        // Keep totals live when nothing else drives the badge manager's cache.
        // InventorySort and Inventory Badge Prices both invalidate the badge
        // manager's `processedItems` tracking on `items_updated`, and every
        // provider (this one included) benefits from that as a side effect —
        // but with both of those off, an item container that already has a
        // total-contributing badge is never revisited, so a stack that grows,
        // shrinks, or gets enhanced never moves the label it belongs to until
        // something unrelated (an item click, a settings toggle) happens to
        // clear the tracking. This module owns its own freshness instead of
        // borrowing a sibling feature's.
        //
        // Invalidating is not enough on its own, and re-summing on its own is
        // worth nothing: a category total is the sum of each item container's
        // `dataset[...Value]`, and those attributes are written only by
        // `renderAllBadges()` -> `calculatePricesForAllItems()`. Invalidating
        // makes the *next* render recompute them — but with Sort and Badge
        // Prices off there is no next render (only an item click's popper
        // triggers one), so `scheduleUpdate()` would re-add the same stale
        // numbers and write the identical label back. The render has to be
        // driven from here; its own pass calls this module's provider, which
        // schedules the totals off the freshly written attributes.
        this.itemsUpdatedHandler = () => {
            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = setTimeout(() => {
                inventoryBadgeManager.invalidateCache();
                Promise.resolve(inventoryBadgeManager.renderAllBadges?.()).catch((error) =>
                    console.error('[Inventory Category Totals] Re-pricing after an inventory change failed:', error)
                );
                // Still scheduled directly: a render that bails on its cooldown
                // or on a closed inventory must not leave the label unwritten.
                this.scheduleUpdate();
            }, ITEMS_UPDATED_DEBOUNCE_MS);
        };
        dataManager.on('items_updated', this.itemsUpdatedHandler);
    }

    disable() {
        try {
            if (!this.isInitialized) {
                return;
            }

            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = null;
            if (this.itemsUpdatedHandler) {
                dataManager.off('items_updated', this.itemsUpdatedHandler);
                this.itemsUpdatedHandler = null;
            }

            inventoryBadgeManager.unregisterProvider('inventory-category-totals');
            document.querySelectorAll(`.mwi-category-total`).forEach((el) => el.remove());
            dom.removeStyles(CSS_ID);

            this.isInitialized = false;
            this.pendingUpdate = false;
        } catch (error) {
            console.error('[Inventory Category Totals] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    scheduleUpdate() {
        if (this.pendingUpdate) {
            return;
        }
        this.pendingUpdate = true;
        setTimeout(() => {
            this.pendingUpdate = false;
            this.updateAllCategoryTotals();
        }, 0);
    }

    updateAllCategoryTotals() {
        const inventoryElem = inventoryBadgeManager.currentInventoryElem;
        if (!inventoryElem) {
            return;
        }

        // Derive pricing mode from inventory sort controls (same source as badges)
        let valueKey;
        if (inventorySort.currentMode === 'none') {
            const badgesOnNone = config.getSettingValue('invSort_badgesOnNone', 'None');
            valueKey = badgesOnNone !== 'None' ? badgesOnNone.toLowerCase() + 'Value' : 'askValue';
        } else {
            valueKey = inventorySort.currentMode + 'Value';
        }

        for (const categoryDiv of inventoryElem.children) {
            const labelEl = categoryDiv.querySelector('[class*="Inventory_label"]');
            if (!labelEl) {
                continue;
            }

            // Get label text without any injected span
            const existingSpan = labelEl.querySelector(`[${SPAN_ATTR}]`);
            const labelText = existingSpan
                ? labelEl.textContent.replace(existingSpan.textContent, '').trim()
                : labelEl.textContent.trim();

            if (labelText.toLowerCase() === 'currencies') {
                continue;
            }

            const itemContainers = categoryDiv.querySelectorAll('[class*="Item_itemContainer"]');
            let total = 0;
            for (const itemEl of itemContainers) {
                const val = parseFloat(itemEl.dataset[valueKey]);
                if (val > 0) {
                    total += val;
                }
            }

            this.injectOrUpdateLabel(labelEl, total);
        }
    }

    /**
     * @param {HTMLElement} labelEl
     * @param {number} total
     */
    injectOrUpdateLabel(labelEl, total) {
        let span = labelEl.querySelector(`[${SPAN_ATTR}]`);

        if (total <= 0) {
            if (span) {
                span.remove();
            }
            return;
        }

        if (!span) {
            span = document.createElement('span');
            span.className = 'mwi-category-total';
            span.setAttribute(SPAN_ATTR, 'true');
            labelEl.appendChild(span);
        }

        span.textContent = formatKMB(total);
    }
}

const inventoryCategoryTotals = new InventoryCategoryTotals();
export default inventoryCategoryTotals;
