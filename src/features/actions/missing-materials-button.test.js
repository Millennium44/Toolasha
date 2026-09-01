/** @vitest-environment happy-dom
 *
 * A bill of materials that is not an action's — a house level's — opened as
 * the same marketplace tabs the action-panel button builds.
 *
 * What is worth asserting is the mapping: totals against what the inventory
 * holds (unenhanced copies only), nothing reserved for the queue, a line the
 * game does not know still named from its hrid.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    items: {},
    unclaimed: {},
    // What `calculateMaterialRequirements` hands back to the click handlers —
    // a test sets this before driving `openMissingMaterials`.
    actionMaterials: [],
    autofill: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        setPendingCalculation: vi.fn(),
        clearQuantity: vi.fn(),
    },
    wsOn: vi.fn(),
    wsOff: vi.fn(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: (hrid) => state.items[hrid] || null,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({
    default: { on: (...args) => state.wsOn(...args), off: (...args) => state.wsOff(...args) },
}));
vi.mock('../../utils/action-panel-helper.js', () => ({
    findActionInput: () => null,
    attachInputListeners: () => {},
    performInitialUpdate: () => {},
    onActionPanelsRefresh: () => () => {},
    onDetailPanel: () => () => {},
    resolveDetailPanel: () => ({
        panel: null,
        nameElement: null,
        actionName: '',
        actionHrid: null,
        actionDetails: null,
    }),
}));
vi.mock('../../utils/material-calculator.js', () => ({
    calculateMaterialRequirements: () => state.actionMaterials,
    calculateEnhancementMaterialRequirements: () => [],
    unclaimedBoughtCount: (itemHrid) => state.unclaimed?.[itemHrid] || 0,
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => state.autofill,
    findQuantityInput: () => null,
}));
// marketplace-tabs.js itself is NOT mocked — its tab creation, dismiss button,
// and clear-all control are exercised for real, the same way lab-sim-ui.test.js
// drives it, so this file is testing the actual DOM the player sees rather than
// a stand-in for it.
vi.mock('./enhancement-display.js', () => ({
    getProtectionItemFromUI: () => null,
    getProtectFromLevelFromUI: () => 0,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => ({ disconnect: () => {} }) }));
vi.mock('../../utils/game-lookups.js', () => ({ getActionHridFromName: () => null }));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: () => {} }));

const { materialsFromList, openMaterialsList, openMissingMaterials } = await import('./missing-materials-button.js');

describe('a bill of materials against the inventory', () => {
    test('each line is what is needed less the unenhanced copies held', () => {
        state.items = {
            '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true },
            '/items/linen_hat': { name: 'Linen Hat', isTradable: true },
        };
        state.inventory = [
            { itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 },
            { itemHrid: '/items/linen_hat', enhancementLevel: 0, count: 4 },
            // An enhanced hat is not a material
            { itemHrid: '/items/linen_hat', enhancementLevel: 3, count: 20 },
        ];

        const materials = materialsFromList([
            { itemHrid: '/items/cedar_lumber', count: 300 },
            { itemHrid: '/items/linen_hat', count: 16 },
        ]);

        expect(materials).toEqual([
            {
                itemHrid: '/items/cedar_lumber',
                itemName: 'Cedar Lumber',
                required: 300,
                have: 120,
                queued: 0,
                available: 120,
                missing: 180,
                isTradeable: true,
                isUpgradeItem: false,
            },
            {
                itemHrid: '/items/linen_hat',
                itemName: 'Linen Hat',
                required: 16,
                have: 4,
                queued: 0,
                available: 4,
                missing: 12,
                isTradeable: true,
                isUpgradeItem: false,
            },
        ]);
    });

    test('items bought but not yet claimed off a buy order count as held', () => {
        state.inventory = [{ itemHrid: '/items/eyessence', count: 1000, enhancementLevel: 0 }];
        state.unclaimed = { '/items/eyessence': 112852 };
        state.items = { '/items/eyessence': { name: 'Eyessence', isTradable: true } };

        const [line] = materialsFromList([{ itemHrid: '/items/eyessence', count: 151275 }]);

        expect(line.have).toBe(113852);
        expect(line.missing).toBe(151275 - 113852);
        state.unclaimed = {};
    });

    test('enough on hand is a line with nothing missing; an unknown item is named from its hrid', () => {
        state.items = { '/items/birch_lumber': { name: 'Birch Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/birch_lumber', count: 500 }];

        const [lumber, mystery] = materialsFromList([
            { itemHrid: '/items/birch_lumber', count: 300 },
            { itemHrid: '/items/odd_thing', count: 2 },
        ]);
        expect(lumber.missing).toBe(0);
        expect(mystery.itemName).toBe('odd thing');
        expect(mystery.isTradeable).toBe(false);
    });

    test('empty or zero lines are dropped, and an empty bill opens nothing', async () => {
        expect(materialsFromList([{ itemHrid: '/items/x', count: 0 }, { count: 3 }, null])).toEqual([]);
        expect(await openMaterialsList([])).toBe(false);
    });
});

/**
 * The "Clear" control on the marketplace tab strip — one click retires every
 * pinned material tab, the Return tab, and the quantity armed for the buy
 * dialog, then lands the player back on the plain Market Listings view.
 *
 * marketplace-tabs.js is deliberately not mocked here (see the note above the
 * mocks): this exercises the real tab elements the player sees, the same way
 * lab-sim-ui.test.js does for the sim's own "clear all" control.
 */
describe('the marketplace clear-all control', () => {
    /** A navbar marketplace button plus a visible tab strip carrying the two
     * native tabs ("My Listings" is the clone template, "Market Listings" is
     * where a clear-all should land the player). happy-dom does no real layout,
     * so `offsetParent`/`getBoundingClientRect` are stubbed the same way
     * marketplace-tabs.test.js stubs them for `visibleTabsContainer`. */
    function buildMarketplaceDom() {
        document.body.innerHTML = '';

        const nav = document.createElement('div');
        nav.className = 'NavigationBar_nav__3uuUl';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-label', 'navigationBar.marketplace');
        nav.appendChild(svg);
        document.body.appendChild(nav);

        const container = document.createElement('div');
        container.className = 'MuiTabs-flexContainer';
        container.setAttribute('role', 'tablist');
        const myListings = document.createElement('button');
        myListings.setAttribute('role', 'tab');
        myListings.textContent = 'My Listings';
        const marketListings = document.createElement('button');
        marketListings.setAttribute('role', 'tab');
        marketListings.textContent = 'Market Listings';
        container.append(myListings, marketListings);
        document.body.appendChild(container);
        Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });
        Object.defineProperty(container, 'getBoundingClientRect', {
            value: () => ({ width: 100 }),
            configurable: true,
        });

        return { container, myListings, marketListings };
    }

    beforeEach(() => {
        state.autofill.setPendingCalculation.mockClear();
        state.autofill.clearQuantity.mockClear();
        state.wsOn.mockClear();
        state.wsOff.mockClear();
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
            { itemHrid: '/items/nail', itemName: 'Nail', missing: 8, required: 8, isTradeable: true },
        ];
    });

    test('is absent before any missing-mats tabs are opened', () => {
        const { container } = buildMarketplaceDom();
        expect(container.querySelector('[data-mwi-clear-all-tab="true"]')).toBeNull();
    });

    test('appears once tabs are opened, and one click removes every custom tab, the armed quantity, and the inventory listener — landing on Market Listings', async () => {
        const { container, marketListings } = buildMarketplaceDom();
        const onMarketListingsClick = vi.fn();
        marketListings.addEventListener('click', onMarketListingsClick);

        await openMissingMaterials('/actions/crafting/plank', 5);

        const materialTabs = container.querySelectorAll('[data-item-hrid]');
        expect(materialTabs.length).toBe(2);
        const clearAll = container.querySelector('[data-mwi-clear-all-tab="true"]');
        expect(clearAll).not.toBeNull();
        // Return tab: a custom tab with no item, distinct from the material tabs and the control
        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        expect(returnTab).toBeTruthy();
        expect(state.wsOn).toHaveBeenCalledWith('*', expect.any(Function));

        clearAll.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(container.querySelectorAll('[data-mwi-custom-tab="true"]').length).toBe(0);
        // Cleared at least once — the click's own teardown, and again (harmlessly)
        // by the delegated "a different native tab was picked" listener once the
        // Market Listings tab click below lands.
        expect(state.autofill.clearQuantity).toHaveBeenCalled();
        expect(state.wsOff).toHaveBeenCalledWith('*', expect.any(Function));
        expect(onMarketListingsClick).toHaveBeenCalledTimes(1);
    });

    test('a single tab can still be dismissed on its own, leaving the rest (including the clear-all control) in place', async () => {
        const { container } = buildMarketplaceDom();

        await openMissingMaterials('/actions/crafting/plank', 5);

        const [firstTab] = container.querySelectorAll('[data-item-hrid]');
        firstTab
            .querySelector('[data-mwi-tab-dismiss="true"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(container.contains(firstTab)).toBe(false);
        expect(container.querySelectorAll('[data-item-hrid]').length).toBe(1);
        expect(container.querySelector('[data-mwi-clear-all-tab="true"]')).not.toBeNull();
    });
});
