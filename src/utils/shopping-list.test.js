/** @vitest-environment happy-dom
 *
 * That there is one shopping list, and that it says whose list it is.
 *
 * The bug this file exists for is not visible in either bundle on its own: the
 * consumables panel and the goal planner each imported their own copy of this
 * module, so each had its own `tabs` array and its own six-second watcher, and
 * two lists opened close together spent those six seconds tearing down each
 * other's tabs. There is one marketplace tab bar, so the module-level state
 * below has to belong to one module — which is what the test at the bottom
 * pins, because nothing else can see the difference from inside a test run
 * where imports always resolve normally.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const tabsModule = vi.hoisted(() => ({ navigations: [], cleanupObservers: 0, badgeUpdates: [] }));
const game = vi.hoisted(() => ({ inventory: [], unclaimed: {}, wsHandlers: new Set(), quantities: [] }));

vi.mock('../core/websocket.js', () => ({
    default: {
        on: (type, fn) => game.wsHandlers.add(fn),
        off: (type, fn) => game.wsHandlers.delete(fn),
    },
}));
vi.mock('../core/data-manager.js', () => ({
    default: { getInventory: () => game.inventory },
}));
vi.mock('./material-calculator.js', () => ({
    unclaimedBoughtCount: (itemHrid) => game.unclaimed[itemHrid] || 0,
}));

vi.mock('./marketplace-tabs.js', () => ({
    createMaterialTab: (material, _reference, onClick) => {
        const tab = document.createElement('div');
        tab.setAttribute('data-item-hrid', material.itemHrid);
        tab.setAttribute('data-mwi-custom-tab', 'true');
        tab.textContent = `${material.itemName}: ${material.missing}`;
        if (onClick) tab.addEventListener('click', onClick);
        return tab;
    },
    removeMaterialTabs: () => {
        for (const tab of document.querySelectorAll('[data-mwi-custom-tab]')) tab.remove();
    },
    setupMarketplaceCleanupObserver: () => {
        tabsModule.cleanupObservers += 1;
        return () => {
            tabsModule.cleanupObservers -= 1;
        };
    },
    navigateToMarketplace: (itemHrid) => tabsModule.navigations.push(itemHrid),
    visibleTabsContainer: () => document.querySelector('#tab-bar'),
    updateTabBadge: (tab, material) => {
        tab.textContent = `${material.itemName}: ${material.missing}`;
        tabsModule.badgeUpdates.push({ itemHrid: material.itemHrid, missing: material.missing });
    },
}));

vi.mock('./marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        setQuantity: (n) => game.quantities.push(n),
        clearQuantity: () => {},
    }),
}));

const { openShoppingList, clearShoppingList } = await import('./shopping-list.js');

/** A tab bar with the reference tab the list clones from */
function tabBar() {
    const bar = document.createElement('div');
    bar.id = 'tab-bar';
    const listings = document.createElement('div');
    listings.textContent = 'My Listings';
    bar.appendChild(listings);
    document.body.appendChild(bar);
    return bar;
}

const items = [
    { itemHrid: '/items/cheese', name: 'Cheese', count: 40 },
    { itemHrid: '/items/log', name: 'Log', count: 12 },
];

const tabText = () => document.querySelector('#tab-bar')?.textContent ?? '';

beforeEach(() => {
    document.body.innerHTML = '';
    tabsModule.navigations = [];
    tabsModule.cleanupObservers = 0;
    tabsModule.badgeUpdates = [];
    game.inventory = [];
    game.unclaimed = {};
    game.quantities = [];
    vi.useFakeTimers();
});

afterEach(() => {
    clearShoppingList();
    vi.useRealTimers();
});

describe('opening a shopping list', () => {
    test('navigates to the first item and puts a tab up for every item', () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);

        expect(tabsModule.navigations).toEqual(['/items/cheese']);
        expect(document.querySelectorAll('[data-item-hrid]')).toHaveLength(2);
        expect(tabText()).toContain('Cheese: 40');
        expect(tabText()).toContain('Log: 12');
    });

    test('counts the items by default', () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);

        expect(tabText()).toContain('Restock: 2 items');
    });

    test('a caller whose counts are an estimate can say so on the bar itself', () => {
        // The marketplace is where somebody decides how many to actually buy, so
        // "these are expected, not required" has to survive the trip
        tabBar();
        openShoppingList(items, { heading: 'Enhancing: expected materials — enhancing is random' });
        vi.advanceTimersByTime(200);

        expect(tabText()).toContain('expected materials — enhancing is random');
        expect(tabText()).not.toContain('Restock:');
    });

    test('an empty list is not a trip to the marketplace', () => {
        tabBar();
        openShoppingList([]);
        openShoppingList([{ itemHrid: '/items/cheese', name: 'Cheese', count: 0 }]);
        vi.advanceTimersByTime(200);

        expect(tabsModule.navigations).toEqual([]);
        expect(document.querySelectorAll('[data-item-hrid]')).toHaveLength(0);
    });

    test('the tabs go back when React rebuilds the bar under them', () => {
        const bar = tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);

        bar.replaceChildren();
        const listings = document.createElement('div');
        listings.textContent = 'My Listings';
        bar.appendChild(listings);
        vi.advanceTimersByTime(200);

        expect(document.querySelectorAll('[data-item-hrid]')).toHaveLength(2);
    });

    test('the watcher stops on its own rather than running for the session', () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(7000);

        expect(vi.getTimerCount()).toBe(0);
    });

    test('clearing takes the tabs away and releases the observer', () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);
        expect(tabsModule.cleanupObservers).toBe(1);

        clearShoppingList();

        expect(document.querySelectorAll('[data-item-hrid]')).toHaveLength(0);
        expect(tabsModule.cleanupObservers).toBe(0);
    });

    test('a second list replaces the first rather than doubling up beside it', () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);
        openShoppingList([{ itemHrid: '/items/milk', name: 'Milk', count: 5 }]);
        vi.advanceTimersByTime(200);

        const tabs = document.querySelectorAll('[data-item-hrid]');
        expect(tabs).toHaveLength(1);
        expect(tabs[0].getAttribute('data-item-hrid')).toBe('/items/milk');
    });
});

describe('purchases move the badges', () => {
    const fireWs = (data) => {
        for (const fn of game.wsHandlers) fn(data);
    };
    const openAndBuild = () => {
        tabBar();
        openShoppingList(items);
        vi.advanceTimersByTime(200);
    };

    test('what is bought after the open comes off the missing count', () => {
        openAndBuild();
        expect(tabText()).toContain('Cheese: 40');

        game.inventory = [{ itemHrid: '/items/cheese', count: 15, enhancementLevel: 0 }];
        fireWs({ type: 'items_updated' });

        expect(tabText()).toContain('Cheese: 25');
        expect(tabText()).toContain('Log: 12');
    });

    test('units bought but unclaimed on a buy order count too, and never twice', () => {
        openAndBuild();
        game.unclaimed = { '/items/cheese': 40 };
        fireWs({ type: 'market_listings_updated' });
        expect(tabText()).toContain('Cheese: 0');

        // The claim moves them to the inventory and off the listing at once
        game.unclaimed = {};
        game.inventory = [{ itemHrid: '/items/cheese', count: 40, enhancementLevel: 0 }];
        fireWs({ type: 'items_updated' });
        expect(tabText()).toContain('Cheese: 0');
    });

    test('what was already held before the open is the caller’s business, not a purchase', () => {
        game.inventory = [{ itemHrid: '/items/cheese', count: 100, enhancementLevel: 0 }];
        openAndBuild();
        fireWs({ type: 'items_updated' });

        // The 100 sat in the baseline; nothing was bought, nothing moves
        expect(tabText()).toContain('Cheese: 40');
    });

    test('a half-filled line arms the buy box with the half that is left', () => {
        openAndBuild();
        game.inventory = [{ itemHrid: '/items/cheese', count: 15, enhancementLevel: 0 }];
        fireWs({ type: 'items_updated' });
        game.quantities = [];

        document.querySelector('[data-item-hrid="/items/cheese"]').click();
        expect(game.quantities).toEqual([25]);
    });
});

describe('the old import path', () => {
    test('still works, and reaches the same module rather than a second copy', async () => {
        const moved = await import('../features/ui/consumables-shopping-list.js');
        expect(moved.openShoppingList).toBe(openShoppingList);
        expect(moved.clearShoppingList).toBe(clearShoppingList);
    });
});
