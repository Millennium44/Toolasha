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
import { BADGE_MODE_SETTING, totalValueKey } from './inventory-badge-mode.js';
import { formatKMB } from '../../utils/formatters.js';
import * as dom from '../../utils/dom.js';
import { getIconHref } from '../../utils/game-lookups.js';

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

/** Sprite ids (the part after `#` in a tile's icon href) of the items the Currencies category holds. */
const CURRENCY_ICON_IDS = new Set([
    'coin',
    'gold_coin',
    'cowbell',
    'task_token',
    'chimerical_token',
    'sinister_token',
    'enchanted_token',
    'pirate_token',
]);

const ITEMS_UPDATED_DEBOUNCE_MS = 300;

class InventoryCategoryTotals {
    constructor() {
        this.isInitialized = false;
        this.pendingUpdate = false;
        this.pendingUpdateTimer = null;
        this.itemsUpdatedHandler = null;
        this.itemsUpdatedDebounceTimer = null;
        this.unwatchBadgeMode = null;
        this.tabClickHandler = null;
        this.tabSwitchDebounceTimer = null;
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
            this.itemsUpdatedDebounceTimer = setTimeout(() => this.repriceAndSchedule(), ITEMS_UPDATED_DEBOUNCE_MS);
        };
        dataManager.on('items_updated', this.itemsUpdatedHandler);

        // A native inventory tab switch shows a panel that was never totalled, and the only tab
        // listener otherwise lives in Inventory Sort, which may be off. Same structural test it
        // uses (role="tab" inside the inventory, not a class name or label), capture phase because
        // the game stops propagation. With Sort on this runs alongside its own pass; both only
        // re-price and re-sum, so the overlap is harmless (the badge manager's cooldown
        // and the pendingUpdate flag coalesce them).
        this.tabClickHandler = (event) => {
            const tab = event.target?.closest?.('[role="tab"]');
            if (!tab || !inventoryBadgeManager.currentInventoryElem?.contains(tab)) return;
            clearTimeout(this.tabSwitchDebounceTimer);
            this.tabSwitchDebounceTimer = setTimeout(() => this.repriceAndSchedule(), ITEMS_UPDATED_DEBOUNCE_MS);
        };
        document.addEventListener('click', this.tabClickHandler, true);

        // The badge mode decides which side an unsorted total is priced on
        // ('alwaysBid' sums bids where every other mode sums asks), so changing
        // it changes this label. Re-summing is enough — both sides' values are
        // already on every container — but something has to ask for it:
        // Inventory Sort's own listener only fires while that feature is on,
        // and with it off the label kept the side it was drawn with.
        this.unwatchBadgeMode = config.onSettingChange(BADGE_MODE_SETTING, () => this.scheduleUpdate());
    }

    /**
     * Re-price every tile, then total. The render writes the values the totals sum.
     */
    repriceAndSchedule() {
        inventoryBadgeManager.invalidateCache();
        Promise.resolve(inventoryBadgeManager.renderAllBadges?.()).catch((error) =>
            console.error('[Inventory Category Totals] Re-pricing after an inventory change failed:', error)
        );
        // Still scheduled directly: a render that bails on its cooldown
        // or on a closed inventory must not leave the label unwritten.
        this.scheduleUpdate();
    }

    disable() {
        try {
            clearTimeout(this.pendingUpdateTimer);
            this.pendingUpdateTimer = null;
            this.pendingUpdate = false;

            if (!this.isInitialized) {
                return;
            }

            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = null;
            if (this.itemsUpdatedHandler) {
                dataManager.off('items_updated', this.itemsUpdatedHandler);
                this.itemsUpdatedHandler = null;
            }

            clearTimeout(this.tabSwitchDebounceTimer);
            this.tabSwitchDebounceTimer = null;
            if (this.tabClickHandler) {
                document.removeEventListener('click', this.tabClickHandler, true);
                this.tabClickHandler = null;
            }

            if (this.unwatchBadgeMode) {
                this.unwatchBadgeMode();
                this.unwatchBadgeMode = null;
            }

            inventoryBadgeManager.unregisterProvider('inventory-category-totals');
            document.querySelectorAll(`.mwi-category-total`).forEach((el) => el.remove());
            dom.removeStyles(CSS_ID);

            this.isInitialized = false;
        } catch (error) {
            console.error('[Inventory Category Totals] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    scheduleUpdate() {
        if (!this.isInitialized || this.pendingUpdate) {
            return;
        }
        this.pendingUpdate = true;
        this.pendingUpdateTimer = setTimeout(() => {
            this.pendingUpdateTimer = null;
            this.pendingUpdate = false;
            if (!this.isInitialized) return;
            this.updateAllCategoryTotals();
        }, 0);
    }

    updateAllCategoryTotals() {
        const inventoryElem = inventoryBadgeManager.currentInventoryElem;
        if (!inventoryElem) {
            return;
        }

        // Derive pricing mode from inventory sort controls (same source as badges).
        // Totals are shown whether or not badges are, so a mode that draws no
        // badge still falls back to the sorted side, or to Ask when unsorted
        const mode = inventorySort.currentMode;
        const valueKey = totalValueKey(mode);

        // Category containers are the Inventory_itemGrid elements (one Inventory_label plus that
        // category's tiles as flat siblings). Since the 2026-09 native inventory tabs,
        // inventoryElem's only direct child is the TabsComponent wrapper, so its children are not
        // categories: the grids live inside the selected tab panel. A hidden panel keeps stale
        // tiles, which must not be counted (the same search inventory-sort uses).
        const categoryDivs = Array.from(inventoryElem.querySelectorAll('[class*="Inventory_itemGrid"]')).filter(
            (grid) => !grid.closest('[class*="TabPanel_hidden"]')
        );

        // A single-category native tab (Resources, say) draws its grid with no Inventory_label at
        // all (see inventory-sort.js shouldSortCategory), so its total is hosted on the selected
        // tab instead. Totals on any other tab are stale and go.
        const selectedTab = inventoryElem.querySelector('[role="tab"][aria-selected="true"]');
        inventoryElem.querySelectorAll(`[role="tab"] [${SPAN_ATTR}]`).forEach((span) => {
            if (span.closest('[role="tab"]') !== selectedTab) span.remove();
        });

        for (const categoryDiv of categoryDivs) {
            let labelEl = categoryDiv.querySelector('[class*="Inventory_label"]');
            if (!labelEl) {
                labelEl = selectedTab;
            }
            if (!labelEl) {
                continue;
            }

            if (this.isCurrenciesGrid(categoryDiv, labelEl)) {
                if (labelEl === selectedTab) this.injectOrUpdateLabel(labelEl, 0);
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
     * Whether a category grid is the Currencies category, which gets no total.
     * Identified by its tiles' icons first (every tile is a currency sprite), since the label is
     * translated for a non-English client; the English label is the fallback.
     * @param {HTMLElement} categoryDiv - The Inventory_itemGrid
     * @param {HTMLElement} labelEl - Its Inventory_label
     * @returns {boolean}
     */
    isCurrenciesGrid(categoryDiv, labelEl) {
        const tiles = categoryDiv.querySelectorAll('[class*="Item_itemContainer"]');
        if (tiles.length > 0) {
            const allCurrencies = Array.from(tiles).every((tile) => {
                // Item icons often carry the sprite id on `xlink:href` alone
                const href = getIconHref(tile, 'items_sprite') ?? '';
                const iconId = href.match(/#(.+)$/)?.[1];
                return iconId && CURRENCY_ICON_IDS.has(iconId);
            });
            if (allCurrencies) {
                return true;
            }
        }

        // A tab hosting the total has no text label to read
        if (labelEl.matches('[role="tab"]')) {
            return false;
        }

        const existingSpan = labelEl.querySelector(`[${SPAN_ATTR}]`);
        const labelText = existingSpan
            ? labelEl.textContent.replace(existingSpan.textContent, '').trim()
            : labelEl.textContent.trim();
        return labelText.toLowerCase() === 'currencies';
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
