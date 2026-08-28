/** @vitest-environment happy-dom */
/**
 * Inventory Category Totals — freshness after inventory changes.
 *
 * The category-total label is drawn by a badge-manager PROVIDER, which only
 * runs for an item container the manager has not already marked "processed
 * with badges present". Two sibling features (Inventory Sort, Inventory
 * Badge Prices) each listen for `items_updated` and call
 * `inventoryBadgeManager.invalidateCache()` to clear that tracking — but this
 * module used to do neither, so with both of those OFF (a perfectly ordinary
 * combination: nothing requires them) a category total computed once at
 * startup never moved again. A stack growing, shrinking, or gaining/losing
 * items left every container's badges untouched, so the provider was never
 * re-invoked and the label kept showing the first number it ever saw.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const dm = vi.hoisted(() => {
    const listeners = new Map();
    return {
        on: (event, fn) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
        },
        off: (event, fn) => listeners.get(event)?.delete(fn),
        emit: (event, data) => {
            for (const fn of listeners.get(event) || []) fn(data);
        },
        listeners,
    };
});

const badgeManagerMock = vi.hoisted(() => ({
    currentInventoryElem: null,
    providerFn: null,
    /** What `calculatePricesForAllItems` would write, keyed by item hrid */
    prices: new Map(),
    registerProvider: vi.fn((_name, renderFn) => {
        badgeManagerMock.providerFn = renderFn;
    }),
    unregisterProvider: vi.fn(),
    clearProcessedTracking: vi.fn(),
    invalidateCache: vi.fn(),
    // The real one writes `dataset.askValue` on every item container from live
    // prices and inventory counts, then calls each registered provider. Nothing
    // else in the app writes those attributes, which is the whole point of the
    // test below: a totals pass that is not preceded by one of these re-adds
    // the numbers that are already there.
    renderAllBadges: vi.fn(async () => {
        const items = badgeManagerMock.currentInventoryElem?.querySelectorAll('[class*="Item_itemContainer"]') || [];
        for (const item of items) {
            item.dataset.askValue = String(badgeManagerMock.prices.get(item.dataset.hrid) ?? 0);
            badgeManagerMock.providerFn?.(item);
        }
    }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'invCategoryTotals',
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dm }));
vi.mock('./inventory-badge-manager.js', () => ({ default: badgeManagerMock }));
vi.mock('./inventory-sort.js', () => ({ default: { currentMode: 'none' } }));
vi.mock('../../utils/formatters.js', () => ({ formatKMB: (n) => String(n) }));
vi.mock('../../utils/dom.js', () => ({ addStyles: vi.fn(), removeStyles: vi.fn() }));

const { default: inventoryCategoryTotals } = await import('./inventory-category-totals.js');

beforeEach(() => {
    dm.listeners.clear();
    badgeManagerMock.currentInventoryElem = null;
    badgeManagerMock.registerProvider.mockClear();
    badgeManagerMock.unregisterProvider.mockClear();
    badgeManagerMock.clearProcessedTracking.mockClear();
    badgeManagerMock.invalidateCache.mockClear();
    badgeManagerMock.renderAllBadges.mockClear();
    badgeManagerMock.providerFn = null;
    badgeManagerMock.prices.clear();
    document.body.innerHTML = '';
    inventoryCategoryTotals.isInitialized = false;
    inventoryCategoryTotals.pendingUpdate = false;
    inventoryCategoryTotals.itemsUpdatedHandler = null;
    inventoryCategoryTotals.itemsUpdatedDebounceTimer = null;
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('freshness against items_updated', () => {
    test('initialize subscribes to items_updated', () => {
        inventoryCategoryTotals.initialize();
        expect(dm.listeners.get('items_updated')?.size).toBe(1);
    });

    test('an inventory change invalidates the badge manager cache so every provider re-runs', () => {
        inventoryCategoryTotals.initialize();

        dm.emit('items_updated', {});
        // Debounced, same 300ms window inventorySort/inventoryBadgePrices use
        vi.advanceTimersByTime(300);

        expect(badgeManagerMock.invalidateCache).toHaveBeenCalledTimes(1);
    });

    test('rapid repeated updates only invalidate once, after the debounce settles', () => {
        inventoryCategoryTotals.initialize();

        dm.emit('items_updated', {});
        vi.advanceTimersByTime(100);
        dm.emit('items_updated', {});
        vi.advanceTimersByTime(100);
        dm.emit('items_updated', {});
        vi.advanceTimersByTime(300);

        expect(badgeManagerMock.invalidateCache).toHaveBeenCalledTimes(1);
    });

    test('the label actually moves: the change is re-priced, not just re-added', async () => {
        // Invalidating the cache and re-summing cannot move a total on their
        // own. `updateAllCategoryTotals` sums `dataset.askValue` off each item
        // container, and only `renderAllBadges()` -> `calculatePricesForAllItems()`
        // ever writes those. With Sort and Badge Prices off nothing else calls
        // it, so a handler that invalidates and re-sums writes the same number
        // back and the total stays stale — the reported bug, intact.
        const inventory = document.createElement('div');
        const category = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'Inventory_label';
        label.textContent = 'Loots';
        const item = document.createElement('div');
        item.className = 'Item_itemContainer';
        item.dataset.hrid = '/items/cheese';
        item.dataset.askValue = '1000';
        category.append(label, item);
        inventory.appendChild(category);
        document.body.appendChild(inventory);
        badgeManagerMock.currentInventoryElem = inventory;

        inventoryCategoryTotals.initialize();
        inventoryCategoryTotals.updateAllCategoryTotals();
        expect(label.textContent).toContain('1000');

        // The player sells most of the stack: same DOM, different holdings
        badgeManagerMock.prices.set('/items/cheese', 250);
        dm.emit('items_updated', {});
        vi.advanceTimersByTime(300);
        await vi.runAllTimersAsync();

        expect(label.textContent).toContain('250');
        expect(label.textContent).not.toContain('1000');
    });

    test('disable() unsubscribes, so a later inventory change does nothing', () => {
        inventoryCategoryTotals.initialize();
        inventoryCategoryTotals.disable();

        dm.emit('items_updated', {});
        vi.advanceTimersByTime(300);

        expect(badgeManagerMock.invalidateCache).not.toHaveBeenCalled();
        expect(dm.listeners.get('items_updated')?.size ?? 0).toBe(0);
    });
});
