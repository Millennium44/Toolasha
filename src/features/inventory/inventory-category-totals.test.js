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
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    clearProcessedTracking: vi.fn(),
    invalidateCache: vi.fn(),
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

    test('disable() unsubscribes, so a later inventory change does nothing', () => {
        inventoryCategoryTotals.initialize();
        inventoryCategoryTotals.disable();

        dm.emit('items_updated', {});
        vi.advanceTimersByTime(300);

        expect(badgeManagerMock.invalidateCache).not.toHaveBeenCalled();
        expect(dm.listeners.get('items_updated')?.size ?? 0).toBe(0);
    });
});
