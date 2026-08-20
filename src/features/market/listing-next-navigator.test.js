/** @vitest-environment happy-dom */

/**
 * Listing Next Navigator — the Next/Back button that replaces the native per-item Refresh while
 * a My Listings cycling session is running.
 *
 * The real listing-refresh-navigator is used rather than a stub, because the pair only works if
 * the session shape both sides agree on is the real one. Only the navigation helpers are mocked.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    backToListings: vi.fn(),
    itemDetailMap: { '/items/plank': {}, '/items/sword': {} },
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ itemDetailMap: mocks.itemDetailMap }) },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: mocks.navigate,
    navigateToMyListings: mocks.backToListings,
}));

const { default: refreshNavigator } = await import('./listing-refresh-navigator.js');
const { default: nextNavigator } = await import('./listing-next-navigator.js');

const LISTINGS = [
    { hrid: '/items/plank', level: 0, id: 'a' },
    { hrid: '/items/sword', level: 5, id: 'b' },
];

/** Draw the My Listings table and start a session on its first row. */
function startSession() {
    document.body.innerHTML = `
        <div class="MarketplacePanel_listingCount__abc"><button>Upgrade Capacity</button></div>
        <table class="MarketplacePanel_myListingsTable__xyz"><tbody></tbody></table>
    `;
    const tbody = document.querySelector('tbody');
    for (const row of LISTINGS) {
        const tr = document.createElement('tr');
        tr.dataset.itemHrid = row.hrid;
        tr.dataset.enhancementLevel = String(row.level);
        tr.dataset.listingId = row.id;
        tbody.appendChild(tr);
    }
    refreshNavigator.initialize();
    Array.from(document.querySelectorAll('button'))
        .find((b) => b.textContent === 'Refresh')
        .click();
}

/**
 * Draw an order-book page for one item, the way the game does.
 * @param {string} spriteId - Icon sprite id, e.g. 'plank' (identity is read from the sprite)
 * @param {number} [enhancementLevel] - Level badge to draw, omitted when 0
 */
function drawOrderBook(spriteId, enhancementLevel = 0) {
    const badge = enhancementLevel ? `<div class="Item_enhancementLevel__x">+${enhancementLevel}</div>` : '';
    document.body.innerHTML = `
        <div class="MarketplacePanel_currentItem__3ercC">
            <svg><use href="/static/media/items_sprite.svg#${spriteId}"></use></svg>
            ${badge}
        </div>
        <div class="MarketplacePanel_marketNavButtonContainer__q">
            <button id="native-refresh">Refresh</button>
        </div>
    `;
}

/** @returns {HTMLButtonElement|null} The injected Next / Back button */
function nextButton() {
    return document.querySelector('#mwi-listing-next-btn');
}

/** @returns {HTMLButtonElement|null} The game's own per-item Refresh button */
function nativeRefresh() {
    return document.querySelector('#native-refresh');
}

beforeEach(() => {
    startSession();
    nextNavigator.initialize();
    // Starting the session navigates to the first listing; the assertions here are about what
    // happens after that.
    mocks.navigate.mockClear();
    mocks.backToListings.mockClear();
});

afterEach(() => {
    nextNavigator.cleanup();
    refreshNavigator.cleanup();
    document.body.innerHTML = '';
});

describe('while the open item is the session’s current listing', () => {
    beforeEach(() => {
        drawOrderBook('plank');
        nextNavigator._update();
    });

    test('a Next button labelled with the position appears', () => {
        expect(nextButton().textContent).toBe('Next (1/2)');
    });

    test('the redundant native Refresh button is hidden', () => {
        expect(nativeRefresh().style.display).toBe('none');
    });

    test('nothing navigates until the button is clicked', () => {
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(mocks.backToListings).not.toHaveBeenCalled();
    });

    test('one click advances exactly one listing', () => {
        nextButton().click();

        expect(mocks.navigate).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).toHaveBeenCalledWith('/items/sword', 5);
        expect(refreshNavigator.getSessionProgress().index).toBe(1);
    });

    test('repeated observer passes never advance on their own', () => {
        nextNavigator._update();
        nextNavigator._update();

        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(refreshNavigator.getSessionProgress().index).toBe(0);
    });
});

describe('on the last listing', () => {
    beforeEach(() => {
        refreshNavigator.advanceSession();
        mocks.navigate.mockClear();
        drawOrderBook('sword', 5);
        nextNavigator._update();
    });

    test('the button offers the way back instead of a next item', () => {
        expect(nextButton().textContent).toBe('Back to My Listings');
    });

    test('clicking it ends the session, restores the native button and returns to the table', () => {
        const native = nativeRefresh();
        nextButton().click();

        expect(mocks.backToListings).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(refreshNavigator.getSessionProgress()).toBeNull();
        expect(native.style.display).toBe('');
        expect(nextButton()).toBeNull();
    });
});

describe('when the page is not the session’s current listing', () => {
    test('a different item leaves the native Refresh button alone', () => {
        drawOrderBook('sword', 5); // session is still on the plank
        nextNavigator._update();

        expect(nextButton()).toBeNull();
        expect(nativeRefresh().style.display).toBe('');
    });

    test('a matching item at a different enhancement level does not count', () => {
        drawOrderBook('plank', 3);
        nextNavigator._update();

        expect(nextButton()).toBeNull();
    });

    test('with no session at all the button is removed again', () => {
        drawOrderBook('plank');
        nextNavigator._update();
        expect(nextButton()).toBeTruthy();

        refreshNavigator.endSession();
        nextNavigator._update();

        expect(nextButton()).toBeNull();
        expect(nativeRefresh().style.display).toBe('');
    });

    test('an unknown sprite is not resolved into an item', () => {
        drawOrderBook('not_a_real_item');
        nextNavigator._update();

        expect(nextButton()).toBeNull();
    });
});
