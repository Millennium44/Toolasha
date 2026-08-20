/** @vitest-environment happy-dom */

/**
 * Listing Refresh Navigator — the My Listings "Refresh" button and the cycling session it starts.
 *
 * The session is the contract listing-next-navigator.js reads, so the shape of
 * getSessionProgress() matters as much as the navigation itself. The other thing worth pinning
 * down: nothing here advances without a click.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), enabled: true }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => mocks.enabled } }));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: mocks.navigate,
    navigateToMyListings: vi.fn(),
}));

const { default: refreshNavigator } = await import('./listing-refresh-navigator.js');
refreshNavigator.initialize();

/**
 * @param {Array<{hrid: string, level?: number, id: string}>} rows - Listing rows to draw
 */
function drawMyListings(rows) {
    document.body.innerHTML = `
        <div class="MarketplacePanel_listingCount__abc">
            <button>Upgrade Capacity</button>
        </div>
        <table class="MarketplacePanel_myListingsTable__xyz"><tbody></tbody></table>
    `;
    const tbody = document.querySelector('tbody');
    for (const row of rows) {
        const tr = document.createElement('tr');
        tr.dataset.itemHrid = row.hrid;
        tr.dataset.enhancementLevel = String(row.level ?? 0);
        tr.dataset.listingId = row.id;
        tbody.appendChild(tr);
    }
    // The observer that normally re-injects the button after a redraw fires asynchronously.
    refreshNavigator._watch();
}

/** @returns {HTMLButtonElement|undefined} The injected Refresh button */
function refreshButton() {
    return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Refresh');
}

beforeEach(() => {
    mocks.navigate.mockClear();
    mocks.enabled = true;
    drawMyListings([
        { hrid: '/items/plank', id: 'a' },
        { hrid: '/items/sword', level: 5, id: 'b' },
    ]);
});

afterEach(() => {
    refreshNavigator.cleanup();
    document.body.innerHTML = '';
});

describe('the Refresh button', () => {
    test('is injected after Upgrade Capacity', () => {
        const btn = refreshButton();
        expect(btn).toBeTruthy();
        expect(btn.previousElementSibling.textContent).toBe('Upgrade Capacity');
    });

    test('does nothing until clicked', () => {
        expect(mocks.navigate).not.toHaveBeenCalled();
        expect(refreshNavigator.getSessionProgress()).toBeNull();
    });

    test('opens the first listing and starts a session on click', () => {
        refreshButton().click();

        expect(mocks.navigate).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).toHaveBeenCalledWith('/items/plank', 0);
        expect(refreshNavigator.getSessionProgress()).toEqual({
            current: { itemHrid: '/items/plank', enhancementLevel: 0, listingId: 'a' },
            index: 0,
            total: 2,
            isLast: false,
        });
    });

    test('rows without an item hrid are left out of the session', () => {
        drawMyListings([{ hrid: '/items/plank', id: 'a' }]);
        document.querySelector('tbody').appendChild(document.createElement('tr'));
        refreshButton().click();

        expect(refreshNavigator.getSessionProgress().total).toBe(1);
    });

    test('a second cycle resumes at the listing after the one it stopped on', () => {
        refreshButton().click();
        refreshNavigator.advanceSession();

        // Session left sitting on the second listing; restarting wraps back to the first.
        refreshButton().click();
        expect(refreshNavigator.getSessionProgress().index).toBe(0);
    });
});

describe('advanceSession', () => {
    test('moves one listing per call and navigates there', () => {
        refreshButton().click();
        mocks.navigate.mockClear();

        expect(refreshNavigator.advanceSession()).toBe(true);
        expect(mocks.navigate).toHaveBeenCalledTimes(1);
        expect(mocks.navigate).toHaveBeenCalledWith('/items/sword', 5);

        const progress = refreshNavigator.getSessionProgress();
        expect(progress.index).toBe(1);
        expect(progress.isLast).toBe(true);
    });

    test('refuses to run past the last listing', () => {
        refreshButton().click();
        refreshNavigator.advanceSession();
        mocks.navigate.mockClear();

        expect(refreshNavigator.advanceSession()).toBe(false);
        expect(mocks.navigate).not.toHaveBeenCalled();
    });

    test('is a no-op with no session', () => {
        expect(refreshNavigator.advanceSession()).toBe(false);
    });
});

describe('endSession', () => {
    test('clears the progress the next navigator reads', () => {
        refreshButton().click();
        refreshNavigator.endSession();
        expect(refreshNavigator.getSessionProgress()).toBeNull();
    });
});
