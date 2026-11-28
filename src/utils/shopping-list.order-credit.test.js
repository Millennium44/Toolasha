/** @vitest-environment happy-dom
 *
 * #1024: a shopping list opened while buy orders rest nets them off its counts (`onOrder`). What the
 * list then counts as bought must leave those orders' own deliveries out, and must not let a purchase
 * be absorbed by them either.
 *
 * The game is modelled once: one listings array that the real `mergeMarketListings` updates from real
 * wire shapes (the data manager does the same on `market_listings_updated`), which feeds the unclaimed
 * count, the open-order fills and the vanishing of a cancelled or collected row together. Messages are
 * sent in the order the game sends them: the inventory change first, then the listing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mergeMarketListings } from './market-listings.js';
import {
    buildRestingBuy,
    buildBuyFilledLater,
    buildFilledBuyUncollected,
    buildCollectedBuy,
    buildListingsUpdated,
} from '../__fixtures__/wire/market.js';

const SUGAR = '/items/sugar';
const game = vi.hoisted(() => ({ inventory: [], listings: [], wsHandlers: new Set(), quantities: [] }));

vi.mock('../core/websocket.js', () => ({
    default: {
        on: (type, fn) => game.wsHandlers.add(fn),
        off: (type, fn) => game.wsHandlers.delete(fn),
    },
}));
vi.mock('../core/data-manager.js', () => ({
    default: { getInventory: () => game.inventory, getMarketListings: () => [...game.listings] },
}));
// The real rule, over the same listings the data manager would hold
vi.mock('./material-calculator.js', () => ({
    unclaimedBoughtCount: (itemHrid) =>
        game.listings
            .filter((l) => !l.isSell && l.itemHrid === itemHrid && !(l.enhancementLevel > 0))
            .reduce((sum, l) => sum + (l.unclaimedItemCount || 0), 0),
}));
vi.mock('./marketplace-tabs.js', () => ({
    insertTabInOrder: (container, tab) => container.appendChild(tab),
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
    setupMarketplaceCleanupObserver: () => () => {},
    navigateToMarketplace: () => {},
    visibleTabsContainer: () => document.querySelector('#tab-bar'),
    updateTabBadge: (tab, material) => {
        tab.textContent = `${material.itemName}: ${material.missing}`;
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

const tabText = () => document.querySelector('#tab-bar')?.textContent ?? '';

/** A game message in, the way the game and the data manager treat it */
function send(message) {
    if (message.type === 'market_listings_updated') {
        game.listings = mergeMarketListings(game.listings, message.endMarketListings);
    }
    for (const fn of game.wsHandlers) fn(message);
}

/** The inventory changes (items_updated carries the new count of each stack) */
function setStock(count) {
    game.inventory = count > 0 ? [{ itemHrid: SUGAR, enhancementLevel: 0, count }] : [];
    send({ type: 'items_updated', endCharacterItems: game.inventory });
}

function listing(row) {
    send(buildListingsUpdated([row]));
}

/** Open a 5-sugar list (15 wanted, 10 on an order resting at 0/10) */
function openWithRestingOrder(extra = {}) {
    const bar = document.createElement('div');
    bar.id = 'tab-bar';
    const mine = document.createElement('div');
    mine.textContent = 'My Listings';
    bar.appendChild(mine);
    document.body.appendChild(bar);
    openShoppingList([{ itemHrid: SUGAR, name: 'Sugar', count: 5, onOrder: 10, ...extra }]);
    vi.advanceTimersByTime(200);
}

beforeEach(() => {
    document.body.innerHTML = '';
    game.inventory = [];
    game.listings = [];
    game.quantities = [];
    vi.useFakeTimers();
    listing(buildRestingBuy());
});

afterEach(() => {
    clearShoppingList();
    game.wsHandlers.clear();
    vi.useRealTimers();
});

describe('a list opened with buy orders resting', () => {
    test('opens at the count it was handed', () => {
        openWithRestingOrder();
        expect(tabText()).toContain('Sugar: 5');
        expect(game.quantities.at(-1)).toBe(5);
    });

    test('a purchase made while the order is open moves the badge (the #1024 bug)', () => {
        openWithRestingOrder();
        // Bought 5 at once: a new buy that filled at placement, its units unclaimed
        listing(buildFilledBuyUncollected({ id: 900301, orderQuantity: 5, filledQuantity: 5, unclaimedItemCount: 5 }));
        expect(tabText()).toContain('Sugar: 0');
    });

    test('a purchase paid into the inventory moves it the same way', () => {
        openWithRestingOrder();
        setStock(3);
        expect(tabText()).toContain('Sugar: 2');
    });

    test('the credited order filling in part does not count as a purchase', () => {
        openWithRestingOrder();
        listing(buildRestingBuy({ filledQuantity: 4, unclaimedItemCount: 4 }));
        expect(tabText()).toContain('Sugar: 5');
    });

    test('the credited order filling in full, then being collected, leaves the count alone', () => {
        openWithRestingOrder();
        listing(buildBuyFilledLater());
        expect(tabText()).toContain('Sugar: 5');
        setStock(10);
        listing({ ...buildBuyFilledLater(), unclaimedItemCount: 0, unclaimedCoinCount: 0 });
        expect(game.listings.some((l) => l.id === buildRestingBuy().id)).toBe(false);
        expect(tabText()).toContain('Sugar: 5');
    });

    test('a purchase, then the order filling and being collected, stays covered', () => {
        openWithRestingOrder();
        setStock(5);
        expect(tabText()).toContain('Sugar: 0');
        listing(buildBuyFilledLater());
        setStock(15);
        listing({ ...buildBuyFilledLater(), unclaimedItemCount: 0, unclaimedCoinCount: 0 });
        expect(tabText()).toContain('Sugar: 0');
    });

    test('the order cancelled with nothing filled is a shortfall again', () => {
        openWithRestingOrder();
        listing(buildRestingBuy({ status: '/market_listing_status/cancelled', coinsAvailable: 0 }));
        expect(game.listings.some((l) => l.id === buildRestingBuy().id)).toBe(false);
        expect(tabText()).toContain('Sugar: 15');
    });

    test('the order cancelled after a partial fill adds back only what it did not deliver', () => {
        openWithRestingOrder();
        listing(buildRestingBuy({ filledQuantity: 4, unclaimedItemCount: 4 }));
        // Cancel: the 4 land in the inventory first, then the row (filledQuantity kept) is dropped
        setStock(4);
        listing(
            buildRestingBuy({
                status: '/market_listing_status/cancelled',
                filledQuantity: 4,
                coinsAvailable: 0,
                unclaimedItemCount: 0,
                unclaimedCoinCount: 0,
            })
        );
        // 15 wanted, 4 held: 11 still to buy
        expect(tabText()).toContain('Sugar: 11');
    });

    test('an order that filled more than the list wanted still leaves the count at zero, not negative', () => {
        openWithRestingOrder();
        setStock(40);
        expect(tabText()).toContain('Sugar: 0');
    });

    test('two credited orders for one item, and an enhanced order that is not credited', () => {
        // onOrder 10 is the +0 orders only: 4 + 6. The +3 order for 7 is a different stack
        game.listings = [];
        listing(buildRestingBuy({ id: 910001, orderQuantity: 4 }));
        listing(buildRestingBuy({ id: 910002, orderQuantity: 6 }));
        listing(buildRestingBuy({ id: 910003, orderQuantity: 7, enhancementLevel: 3 }));
        openWithRestingOrder();

        // One fills in part, the +3 order fills fully: neither is a purchase of this list's
        listing(buildRestingBuy({ id: 910001, orderQuantity: 4, filledQuantity: 3, unclaimedItemCount: 3 }));
        listing(
            buildRestingBuy({
                id: 910003,
                orderQuantity: 7,
                filledQuantity: 7,
                enhancementLevel: 3,
                status: '/market_listing_status/filled',
                unclaimedItemCount: 7,
            })
        );
        expect(tabText()).toContain('Sugar: 5');

        // The other order is cancelled untouched: its 6 are a shortfall again
        listing(buildRestingBuy({ id: 910002, orderQuantity: 6, status: '/market_listing_status/cancelled' }));
        expect(tabText()).toContain('Sugar: 11');
    });

    test('a duplicate message for the same order changes nothing', () => {
        openWithRestingOrder();
        const message = buildListingsUpdated([buildRestingBuy({ filledQuantity: 4, unclaimedItemCount: 4 })]);
        send(message);
        send(message);
        expect(tabText()).toContain('Sugar: 5');
    });

    test('an order that is already gone when the list opens is added back at the open', () => {
        // The caller netted 10, but the order was cancelled between its figures and the click
        game.listings = [];
        openWithRestingOrder();
        expect(tabText()).toContain('Sugar: 15');
        expect(game.quantities.at(-1)).toBe(15);
    });

    test('units held before the open are not credited to the list', () => {
        game.inventory = [{ itemHrid: SUGAR, enhancementLevel: 0, count: 100 }];
        openWithRestingOrder();
        expect(tabText()).toContain('Sugar: 5');
        listing(buildCollectedBuy({ id: 900399, itemHrid: SUGAR }));
        expect(tabText()).toContain('Sugar: 5');
    });
});

describe('a list with nothing on order', () => {
    test('is the plain baseline count, as before', () => {
        listing(buildCollectedBuy({ id: 900398 }));
        game.listings = [];
        const bar = document.createElement('div');
        bar.id = 'tab-bar';
        const mine = document.createElement('div');
        mine.textContent = 'My Listings';
        bar.appendChild(mine);
        document.body.appendChild(bar);
        openShoppingList([{ itemHrid: SUGAR, name: 'Sugar', count: 5 }]);
        vi.advanceTimersByTime(200);
        setStock(2);
        expect(tabText()).toContain('Sugar: 3');
        // Another order cancelled later is nothing this list credited
        listing(buildRestingBuy({ id: 910050, status: '/market_listing_status/cancelled' }));
        expect(tabText()).toContain('Sugar: 3');
    });
});
