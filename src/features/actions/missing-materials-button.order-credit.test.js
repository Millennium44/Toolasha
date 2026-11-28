/** @vitest-environment happy-dom
 *
 * #1024, the craft-bill path: Buy all's combined bill sends required = wanted - open orders. Counting the
 * units those orders deliver as held stock subtracted them a second time (1,000 wanted, 400 on order: 600
 * missing, then 200 once the order filled). The bill credits the orders it was netted by, per order.
 * Opened through `openCraftBill` (the real caller), recounted by the same websocket message that moves it.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    items: {},
    unclaimed: {},
    listings: [],
    enhancementMaterials: [],
    enhancementCalls: [],
    wholeAttempts: 7,
    settingsEnabled: false,
    // What `calculateMaterialRequirements` hands back to the click handlers —
    // a test sets this before driving `openMissingMaterials`.
    actionMaterials: [],
    calcCalls: [],
    autofill: {
        initialize: vi.fn(),
        cleanup: vi.fn(),
        setPendingCalculation: vi.fn(),
        clearQuantity: vi.fn(),
    },
    wsOn: vi.fn(),
    wsOff: vi.fn(),
    // Off unless a test asks for the Tester shop hand-off
    testerShop: false,
    // The action queue, the production-input part of it, and dataManager listeners
    currentActions: [],
    queuedInputs: new Map(),
    dataListeners: [],
    ignoreQueue: false,
    characterId: 'char1',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getMarketListings: () => state.listings,
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: (hrid) => state.items[hrid] || null,
        getCurrentActions: () => state.currentActions,
        getCurrentCharacterId: () => state.characterId,
        on: (event, handler) => state.dataListeners.push({ event, handler }),
        off: (event, handler) => {
            state.dataListeners = state.dataListeners.filter((l) => !(l.event === event && l.handler === handler));
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) =>
            key === 'actions_missingMaterialsButton_ignoreQueue' ? state.ignoreQueue : state.settingsEnabled,
    },
}));
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
    calculateMaterialRequirements: (...args) => {
        state.calcCalls.push(args);
        return state.actionMaterials;
    },
    calculateEnhancementMaterialRequirements: (...args) => {
        state.enhancementCalls.push(args);
        return state.enhancementMaterials;
    },
    calculateEnhancementWholeAttempts: () => state.wholeAttempts,
    calculateQueuedMaterialsForAction: () => state.queuedInputs,
    unclaimedBoughtCount: (itemHrid) => state.unclaimed?.[itemHrid] || 0,
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => state.autofill,
    findQuantityInput: (modal) => modal?.querySelector?.('input') ?? null,
}));
// marketplace-tabs.js itself is NOT mocked — its tab creation, dismiss button,
// and clear-all control are exercised for real, the same way lab-sim-ui.test.js
// drives it, so this file is testing the actual DOM the player sees rather than
// a stand-in for it.
vi.mock('./enhancement-display.js', () => ({
    getProtectionItemFromUI: () => null,
    getProtectFromLevelFromUI: () => 0,
    getCurrentEnhancementLevel: () => 0,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinOnlyCost: () => 0,
    getActionHridFromName: () => null,
    getActionHridFromFiber: () => null,
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => state.testerShop,
    // Every line of the test bill is sold, so the whole bill takes the shop path
    testerShopCoinCost: () => (state.testerShop ? 100 : 0),
}));
vi.mock('../../utils/react-input.js', () => ({
    setReactInputValue: (...args) => globalThis.__repeatWrites?.(...args),
}));

/**
 * The reservation ledger, doubled at the seam. Its arithmetic belongs to
 * `utils/inventory-reservations.test.js`; what matters here is that the bill
 * nets off other owners and never itself, that the open tabs claim what they
 * are asking for and give it back on the way out, and that a bill built with
 * no owner at all is the bill this file has always asserted.
 */
const ledger = vi.hoisted(() => ({ claims: {}, reserved: [], released: [], listeners: new Set() }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    onReservationsChanged: (listener) => {
        ledger.listeners.add(listener);
        return () => ledger.listeners.delete(listener);
    },
    INVENTORY_LOCATION: '/item_locations/inventory',
    reservedElsewhere: (itemHrid, level, { excludeOwner } = {}) => {
        let total = 0;
        for (const [owner, byKey] of Object.entries(ledger.claims)) {
            if (owner === excludeOwner) continue;
            total += byKey[`${itemHrid}|${level}`] || 0;
        }
        return total;
    },
    effectiveInventory: (itemHrid, level, { excludeOwner, held } = {}) => {
        let total = 0;
        for (const [owner, byKey] of Object.entries(ledger.claims)) {
            if (owner === excludeOwner) continue;
            total += byKey[`${itemHrid}|${level}`] || 0;
        }
        return Math.max(0, held - total);
    },
    shortfallNote: (short) => `${short} short — reserved by "Goal: Cheese sword"`,
    reserve: async (ownerId, lines) => {
        ledger.reserved.push({ ownerId, lines });
        ledger.claims[ownerId] = Object.fromEntries(
            lines.map((line) => [`${line.itemHrid}|${line.enhancementLevel || 0}`, line.count])
        );
        return true;
    },
    release: (ownerId) => {
        ledger.released.push(ownerId);
        delete ledger.claims[ownerId];
        return Promise.resolve(true);
    },
}));

const missingMaterials = await import('./missing-materials-button.js');
const { openCraftBill, openMaterialsList, materialsFromList } = missingMaterials;

const LOGS = '/items/cedar_lumber';

/** The real marketplace tab strip, as in missing-materials-button.test.js */
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
    for (const label of ['My Listings', 'Market Listings']) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = label;
        const badge = document.createElement('span');
        badge.className = 'TabsComponent_badge';
        tab.appendChild(badge);
        container.appendChild(tab);
    }
    document.body.appendChild(container);
    Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });
    Object.defineProperty(container, 'getBoundingClientRect', { value: () => ({ width: 100 }), configurable: true });

    const root = document.createElement('div');
    root.id = 'root';
    root._reactRootContainer = {
        current: { stateNode: { handleGoToMarketplace: vi.fn() }, child: null, sibling: null },
    };
    document.body.appendChild(root);
    return container;
}

/** One resting order the way the data manager holds it */
function order(overrides = {}) {
    return {
        id: 900212,
        isSell: false,
        itemHrid: LOGS,
        enhancementLevel: 0,
        status: '/market_listing_status/active',
        orderQuantity: 400,
        filledQuantity: 0,
        unclaimedItemCount: 0,
        ...overrides,
    };
}

const missingNow = (container) =>
    Number(container.querySelector(`[data-item-hrid="${LOGS}"]`)?.getAttribute('data-missing-quantity'));

/** The game's message, in order: the stock changes, the listing follows, then the tabs recount */
async function fire(change) {
    change();
    const handler = state.wsOn.mock.calls.findLast(([event]) => event === '*')[1];
    handler({ type: 'market_listings_updated' });
    await new Promise((resolve) => setTimeout(resolve, 350));
}

/** The listings the data manager holds, and the unclaimed units the calculator reads off them */
function setListings(rows) {
    state.listings = rows;
    state.unclaimed = {
        [LOGS]: rows
            .filter((l) => !l.isSell && l.itemHrid === LOGS && !(l.enhancementLevel > 0))
            .reduce((n, l) => n + l.unclaimedItemCount, 0),
    };
}

/**
 * The consumables panel's combined bill: 1,000 wanted, 400 on order, so the bill's required total is what
 * is wanted less what is on order (600), which is what the panel hands over as a `direct` line.
 */
const openBill = () => openCraftBill([], [{ itemHrid: LOGS, count: 600, onOrder: 400 }]);

describe('a craft bill opened with buy orders resting (#1024)', () => {
    beforeEach(() => {
        state.items = { [LOGS]: { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [];
        state.settingsEnabled = false;
        state.queuedInputs = new Map();
        setListings([order()]);
    });

    afterEach(() => {
        missingMaterials.cleanup?.();
        state.listings = [];
        state.unclaimed = {};
    });

    test('opens at what is wanted less what is on order', async () => {
        const container = buildMarketplaceDom();
        await openBill();
        expect(missingNow(container)).toBe(600);
    });

    test('the order filling does not come off the bill a second time', async () => {
        const container = buildMarketplaceDom();
        await openBill();

        await fire(() => setListings([order({ filledQuantity: 150, unclaimedItemCount: 150 })]));
        expect(missingNow(container)).toBe(600);

        await fire(() =>
            setListings([
                order({ status: '/market_listing_status/filled', filledQuantity: 400, unclaimedItemCount: 400 }),
            ])
        );
        expect(missingNow(container)).toBe(600);

        // Collected: the units move to the inventory and the row goes
        await fire(() => {
            state.inventory = [{ itemHrid: LOGS, enhancementLevel: 0, count: 400 }];
            setListings([]);
        });
        expect(missingNow(container)).toBe(600);
    });

    test('a purchase made while the order is open still counts', async () => {
        const container = buildMarketplaceDom();
        await openBill();

        await fire(() => {
            state.inventory = [{ itemHrid: LOGS, enhancementLevel: 0, count: 250 }];
        });
        expect(missingNow(container)).toBe(350);

        // Then the order fills and is collected on top of it: still only the 250 bought
        await fire(() => {
            state.inventory = [{ itemHrid: LOGS, enhancementLevel: 0, count: 650 }];
            setListings([]);
        });
        expect(missingNow(container)).toBe(350);
    });

    test('an order cancelled with nothing filled is a shortfall again, and not before', async () => {
        const container = buildMarketplaceDom();
        await openBill();
        await fire(() => setListings([]));
        expect(missingNow(container)).toBe(1000);
    });

    test('an order cancelled after a partial fill adds back only what it did not deliver', async () => {
        const container = buildMarketplaceDom();
        await openBill();
        await fire(() => setListings([order({ filledQuantity: 150, unclaimedItemCount: 150 })]));
        // The 150 land in the inventory in the cancel exchange; the row (filledQuantity kept) is dropped
        await fire(() => {
            state.inventory = [{ itemHrid: LOGS, enhancementLevel: 0, count: 150 }];
            setListings([]);
        });
        expect(missingNow(container)).toBe(850);
    });

    test('two credited orders, one of them an enhanced listing that is not credited', async () => {
        const container = buildMarketplaceDom();
        setListings([
            order({ id: 1, orderQuantity: 100 }),
            order({ id: 2, orderQuantity: 300 }),
            // Not the +0 stack: it was never part of what was on order
            order({ id: 3, orderQuantity: 50, enhancementLevel: 2 }),
        ]);
        await openBill();
        await fire(() =>
            setListings([
                order({ id: 1, orderQuantity: 100, filledQuantity: 100, unclaimedItemCount: 100 }),
                order({ id: 2, orderQuantity: 300 }),
                order({ id: 3, orderQuantity: 50, enhancementLevel: 2, filledQuantity: 50, unclaimedItemCount: 50 }),
            ])
        );
        expect(missingNow(container)).toBe(600);
    });

    test('a duplicate listing row for one order reads the larger fill, never a smaller one', async () => {
        const container = buildMarketplaceDom();
        await openBill();
        state.listings = [
            order({ filledQuantity: 100, unclaimedItemCount: 100 }),
            order({ filledQuantity: 200, unclaimedItemCount: 0 }),
        ];
        state.unclaimed = { [LOGS]: 100 };
        const handler = state.wsOn.mock.calls.findLast(([event]) => event === '*')[1];
        handler({ type: 'market_listings_updated' });
        await new Promise((resolve) => setTimeout(resolve, 350));
        // Held 100 (unclaimed); the larger fill (200) is taken off it: the bill reads the safer, higher shortfall
        expect(missingNow(container)).toBe(600);
    });

    test('a bill line with no onOrder is exactly what it was', async () => {
        const container = buildMarketplaceDom();
        setListings([order({ filledQuantity: 100, unclaimedItemCount: 100 })]);
        await openMaterialsList([{ itemHrid: LOGS, count: 600 }]);
        expect(missingNow(container)).toBe(500);
        expect(materialsFromList([{ itemHrid: LOGS, count: 600 }])[0]).toMatchObject({ required: 600, have: 100 });
    });
});
