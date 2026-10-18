/** @vitest-environment happy-dom
 *
 * A bill of materials that is not an action's — a house level's, or the pieces
 * a cross-slot gear swap buys — opened as the same marketplace tabs the
 * action-panel button builds.
 *
 * What is worth asserting is the mapping: totals against what the inventory
 * holds (unenhanced copies only, unless the line names a level), nothing
 * reserved for the queue, a line the game does not know still named from its
 * hrid.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    items: {},
    unclaimed: {},
    enhancementMaterials: [],
    enhancementCalls: [],
    wholeAttempts: 7,
    settingsEnabled: false,
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
    // Off unless a test asks for the Tester shop hand-off
    testerShop: false,
    // The action queue, the production-input part of it, and dataManager listeners
    currentActions: [],
    queuedInputs: new Map(),
    dataListeners: [],
    ignoreQueue: false,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: (hrid) => state.items[hrid] || null,
        getCurrentActions: () => state.currentActions,
        getCurrentCharacterId: () => 'char1',
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
    calculateMaterialRequirements: () => state.actionMaterials,
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
    findQuantityInput: () => null,
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
const ledger = vi.hoisted(() => ({ claims: {}, reserved: [], released: [] }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    onReservationsChanged: () => () => {},
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
const { materialsFromList, openBillOwner, openMaterialsList, openMissingMaterials } = missingMaterials;

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

    test('a copy equipped or listed on the market does not count as stock', () => {
        // Before this fix, `materialsFromList` summed every inventory row by
        // itemHrid and level alone, so an equipped shield read exactly like a
        // spare one in the bag — "have" 2, nothing missing from a bill for 2.
        // A recipe cannot spend a piece of gear that is worn, so only the bag
        // copy may count.
        state.items = { '/items/manticore_shield': { name: 'Manticore Shield', isTradable: true } };
        state.inventory = [
            {
                itemHrid: '/items/manticore_shield',
                enhancementLevel: 0,
                count: 1,
                itemLocationHrid: '/item_locations/inventory',
            },
            {
                itemHrid: '/items/manticore_shield',
                enhancementLevel: 0,
                count: 1,
                itemLocationHrid: '/item_locations/main_hand',
            },
        ];

        const [line] = materialsFromList([{ itemHrid: '/items/manticore_shield', count: 2 }]);

        expect(line.have).toBe(1);
        expect(line.missing).toBe(1);
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

    test('a line that names an enhancement level is counted at that level alone', () => {
        state.items = { '/items/manticore_shield': { name: 'Manticore Shield', isTradable: true } };
        state.inventory = [
            { itemHrid: '/items/manticore_shield', enhancementLevel: 0, count: 3 },
            { itemHrid: '/items/manticore_shield', enhancementLevel: 7, count: 1 },
        ];
        // A buy order for the unenhanced item is not progress towards a +7
        state.unclaimed = { '/items/manticore_shield': 5 };

        const [line] = materialsFromList([{ itemHrid: '/items/manticore_shield', count: 1, enhancementLevel: 7 }]);

        expect(line.enhancementLevel).toBe(7);
        expect(line.have).toBe(1);
        expect(line.missing).toBe(0);
        state.unclaimed = {};
    });

    test('a line without one is the object it has always been', () => {
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 10 }];

        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 30 }]);

        expect('enhancementLevel' in line).toBe(false);
        expect(line.have).toBe(10);
    });

    test('empty or zero lines are dropped, and an empty bill opens nothing', async () => {
        expect(materialsFromList([{ itemHrid: '/items/x', count: 0 }, { count: 3 }, null])).toEqual([]);
        expect(await openMaterialsList([])).toBe(false);
    });
});

describe('enhancement missing-material reservation handoff', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        state.settingsEnabled = true;
        state.enhancementCalls = [];
        state.enhancementMaterials = [
            {
                itemHrid: '/items/protection_scroll',
                itemName: 'Protection Scroll',
                required: 1,
                have: 1,
                queued: 0,
                available: 0,
                missing: 1,
                reserved: 1,
                reservedNote: '1 short — reserved by "Goal: Cheese sword"',
                isTradeable: true,
                isUpgradeItem: false,
            },
        ];
        ledger.claims = { 'goal:cheese-sword': { '/items/protection_scroll|0': 1 } };
        buildMarketplaceDom();
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="SkillActionDetail_enhancingComponent__17bOx" data-mwi-item-hrid="/items/sword">' +
                '<div><span>Target Level</span><input type="number" value="5"></div>' +
                '</div>'
        );
    });

    afterEach(() => {
        missingMaterials.cleanup?.();
        vi.useRealTimers();
        state.settingsEnabled = false;
        ledger.claims = {};
    });

    test('renders the external-claim shortfall, recalculates fresh on click, claims its bill, and keeps its own claim out of the live shortfall', async () => {
        missingMaterials.initialize();
        await vi.advanceTimersByTimeAsync(600);

        const button = document.querySelector('#mwi-missing-mats-button');
        expect(button).not.toBeNull();
        expect(button.disabled).toBe(false);
        expect(state.enhancementCalls.at(-1)).toHaveLength(8);
        expect(state.enhancementCalls.at(-1)[7]).toBe(1);
        expect(state.enhancementCalls.at(-1)[6]).toBe('missingMats');

        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(200);
        await Promise.resolve();

        const tab = document.querySelector('[data-item-hrid="/items/protection_scroll"]');
        expect(tab?.getAttribute('data-missing-quantity')).toBe('1');
        expect(ledger.reserved.at(-1)).toMatchObject({ ownerId: 'missingMats' });
        expect(ledger.claims.missingMats['/items/protection_scroll|0']).toBe(1);
        expect(state.enhancementCalls.at(-1)[6]).toBe('missingMats');

        // The calculator returns an updated value based on external claims only;
        // the own bill claim must not increase this material's missing count.
        state.enhancementMaterials = [
            {
                ...state.enhancementMaterials[0],
                available: 1,
                missing: 0,
                reserved: undefined,
                reservedNote: undefined,
            },
        ];
        const update = state.wsOn.mock.calls.find(([type]) => type === '*')?.[1];
        expect(update).toBeTypeOf('function');
        const priorCalls = state.enhancementCalls.length;
        update({ type: 'items_updated' });
        expect(state.enhancementCalls.length).toBe(priorCalls + 1);
        expect(ledger.claims.missingMats['/items/protection_scroll|0']).toBe(1);
        expect(tab.getAttribute('data-missing-quantity')).toBe('0');
        expect(state.enhancementCalls.at(-1)[6]).toBe('missingMats');
    });

    describe('the attempts and copies adjustments', () => {
        const field = (name) => document.querySelector(`#mwi-missing-mats-controls [data-mwi-adjust="${name}"]`);
        const type = async (input, value) => {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(10);
        };

        test('untouched, the fields are prefilled and the bill is the one the button always built', async () => {
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);

            expect(field('attempts').value).toBe('1');
            expect(field('copies').value).toBe('1');
            // Repeat reads 1 with no Repeat control on the panel: the game's count, one copy
            const call = state.enhancementCalls.at(-1);
            expect(call[5]).toBe(1);
            expect(call[7]).toBe(1);
        });

        test('typing attempts and copies recomputes the bill and the click buys for it', async () => {
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);

            await type(field('attempts'), '12');
            await type(field('copies'), '3');
            const call = state.enhancementCalls.at(-1);
            expect(call[5]).toBe(12);
            expect(call[7]).toBe(3);
            const button = document.querySelector('#mwi-missing-mats-button');
            expect(button.title).toContain('12 attempts × 3 copies');

            state.enhancementCalls = [];
            button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
            expect(state.enhancementCalls.at(-1)[5]).toBe(12);
            expect(state.enhancementCalls.at(-1)[7]).toBe(3);
        });

        test('values are clamped to 1-9999 and key events stay out of the game', async () => {
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);

            await type(field('attempts'), '99999');
            expect(state.enhancementCalls.at(-1)[5]).toBe(9999);
            await type(field('copies'), '0');
            expect(state.enhancementCalls.at(-1)[7]).toBe(1);

            const seen = vi.fn();
            document.body.addEventListener('keydown', seen);
            field('attempts').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
            expect(seen).not.toHaveBeenCalled();
        });

        test('a computed value that moves without a key change is still not treated as manual', async () => {
            const panel = document.querySelector('.SkillActionDetail_enhancingComponent__17bOx');
            panel.insertAdjacentHTML('afterbegin', '<div><span>Repeat</span><input type="text" value="∞"></div>');
            state.wholeAttempts = 7;
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);
            expect(field('attempts').value).toBe('7');

            // Gear or tea changes the expectation; the panel redraws with the same key
            state.wholeAttempts = 9;
            missingMaterials.cleanup();
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);
            expect(field('attempts').value).toBe('9');

            await type(field('attempts'), '9');
            expect(state.enhancementCalls.at(-1)[5]).toBe(null); // still automatic
            field('attempts').dispatchEvent(new Event('change', { bubbles: true }));
            expect(field('attempts').value).toBe('9');

            // An automatic figure past 9999 is not shrunk by an edit
            await type(field('attempts'), '20000');
            expect(state.enhancementCalls.at(-1)[5]).toBe(9999);
            state.wholeAttempts = 20000;
            missingMaterials.cleanup();
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);
            await type(field('attempts'), '20000');
            expect(state.enhancementCalls.at(-1)[5]).toBe(null);
        });

        test('a different item resets both fields', async () => {
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);
            await type(field('attempts'), '12');
            await type(field('copies'), '3');

            document.querySelector('.SkillActionDetail_enhancingComponent__17bOx').dataset.mwiItemHrid = '/items/axe';
            missingMaterials.cleanup();
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);

            expect(field('attempts').value).toBe('1');
            expect(field('copies').value).toBe('1');
            expect(state.enhancementCalls.at(-1)[5]).toBe(1);
            expect(state.enhancementCalls.at(-1)[7]).toBe(1);
        });
    });

    describe('the Return tab', () => {
        function installGame(game) {
            const root = document.createElement('div');
            root.id = 'root';
            root._reactRootContainer = { current: { stateNode: game } };
            document.body.appendChild(root);
        }

        async function openAndReturn() {
            missingMaterials.initialize();
            await vi.advanceTimersByTimeAsync(600);
            document
                .querySelector('#mwi-missing-mats-button')
                .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await vi.advanceTimersByTimeAsync(200);
            await Promise.resolve();
            const tab = Array.from(document.querySelectorAll('[data-mwi-custom-tab]')).find((el) =>
                el.textContent.includes('Return')
            );
            expect(tab).toBeTruthy();
            tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await vi.advanceTimersByTimeAsync(200);
        }

        test('returns to Enhancing with the starting stack selected', async () => {
            const game = { handleEnhanceItem: vi.fn(), handleGoToAction: vi.fn() };
            installGame(game);
            state.inventory = [
                {
                    itemLocationHrid: '/item_locations/inventory',
                    itemHrid: '/items/sword',
                    enhancementLevel: 0,
                    count: 1,
                    hash: '1::/item_locations/inventory::/items/sword::0',
                },
            ];
            await openAndReturn();
            expect(game.handleEnhanceItem).toHaveBeenCalledWith('1::/item_locations/inventory::/items/sword::0');
            expect(game.handleGoToAction).not.toHaveBeenCalled();
        });

        test('with no such stack it opens the Enhancing action instead', async () => {
            const game = { handleEnhanceItem: vi.fn(), handleGoToAction: vi.fn() };
            installGame(game);
            state.inventory = [];
            await openAndReturn();
            expect(game.handleEnhanceItem).not.toHaveBeenCalled();
            expect(game.handleGoToAction).toHaveBeenCalledWith('/actions/enhancing/enhance');
        });
    });
});

describe('the button says what it will buy', () => {
    const line = (itemHrid, itemName, required, missing, extra = {}) => ({
        itemHrid,
        itemName,
        required,
        have: required - missing,
        queued: 0,
        available: required - missing,
        missing,
        isTradeable: true,
        isUpgradeItem: false,
        ...extra,
    });

    beforeEach(() => {
        vi.useFakeTimers();
        state.settingsEnabled = true;
        state.enhancementCalls = [];
        buildMarketplaceDom();
        document.body.insertAdjacentHTML(
            'beforeend',
            '<div class="SkillActionDetail_enhancingComponent__17bOx" data-mwi-item-hrid="/items/sword">' +
                '<div><span>Target Level</span><input type="number" value="5"></div>' +
                '<div><span>Repeat</span><input type="text" value="∞"></div>' +
                '</div>'
        );
    });

    afterEach(() => {
        missingMaterials.cleanup?.();
        vi.useRealTimers();
        state.settingsEnabled = false;
    });

    test('counts and lists the missing lines, leaves out coin and covered lines, and notes the infinite repeat', async () => {
        state.enhancementMaterials = [
            line('/items/sinister_essence', 'Sinister Essence', 8, 8),
            line('/items/sorcerer_essence', 'Sorcerer Essence', 2000, 2000),
            line('/items/gobo_essence', 'Gobo Essence', 2000, 0),
            line('/items/coin', 'Coin', 1345, 1345, { isTradeable: false }),
        ];
        missingMaterials.initialize();
        await vi.advanceTimersByTimeAsync(600);

        const button = document.querySelector('#mwi-missing-mats-button');
        expect(button.textContent).toBe('Missing Mats Marketplace · 2 items');
        expect(button.title).toContain('Sinister Essence ×8, Sorcerer Essence ×2,000');
        expect(button.title).not.toContain('Gobo');
        expect(button.title).not.toContain('Coin');
        expect(button.title).toContain('expected attempts');
    });

    test('nothing missing shows no count', async () => {
        state.enhancementMaterials = [line('/items/gobo_essence', 'Gobo Essence', 2000, 0)];
        missingMaterials.initialize();
        await vi.advanceTimersByTimeAsync(600);

        const button = document.querySelector('#mwi-missing-mats-button');
        expect(button.textContent).toBe('Missing Mats Marketplace');
        expect(button.title).toBe('');
    });
});

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
    const myListingsBadge = document.createElement('span');
    myListingsBadge.className = 'TabsComponent_badge';
    myListings.appendChild(myListingsBadge);
    const marketListings = document.createElement('button');
    marketListings.setAttribute('role', 'tab');
    marketListings.textContent = 'Market Listings';
    const marketListingsBadge = document.createElement('span');
    marketListingsBadge.className = 'TabsComponent_badge';
    marketListings.appendChild(marketListingsBadge);
    container.append(myListings, marketListings);
    document.body.appendChild(container);
    Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });
    Object.defineProperty(container, 'getBoundingClientRect', {
        value: () => ({ width: 100 }),
        configurable: true,
    });

    return { container, myListings, marketListings };
}

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

    test('a bill line’s enhancement level is the listing its tab opens', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = {
            '/items/sundering_crossbow': { name: 'Sundering Crossbow', isTradable: true },
            '/items/manticore_shield': { name: 'Manticore Shield', isTradable: true },
        };
        state.inventory = [];

        await openMaterialsList([
            { itemHrid: '/items/sundering_crossbow', count: 1, enhancementLevel: 7 },
            { itemHrid: '/items/manticore_shield', count: 1, enhancementLevel: 7 },
        ]);

        const tabs = container.querySelectorAll('[data-item-hrid]');
        expect(tabs.length).toBe(2);
        tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/manticore_shield', 7);
    });

    test('a line with no level still opens the unenhanced listing', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [];

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 300 }]);
        container
            .querySelector('[data-item-hrid]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/cedar_lumber', 0);
    });

    test('an upgrade item wanted at a level is counted, named and opened at that level', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = {
            '/items/shard': { name: 'Shard', isTradable: true },
            '/items/furious_spear': { name: 'Furious Spear', isTradable: true },
        };
        // A +10 in the bag is not stock against a +12, and the +0 order book is
        // not where a +12 is bought
        state.inventory = [{ itemHrid: '/items/furious_spear', enhancementLevel: 10, count: 1 }];
        state.actionMaterials = [
            { itemHrid: '/items/shard', itemName: 'Shard', missing: 267, required: 267, isTradeable: true },
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 0,
                required: 1,
                have: 1,
                queued: 0,
                available: 1,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1, { upgradeItemLevel: 12 });

        const spearTab = container.querySelector('[data-item-hrid="/items/furious_spear"]');
        // The +10 stopped counting, so the line is short again
        expect(spearTab.getAttribute('data-missing-quantity')).toBe('1');
        spearTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/furious_spear', 12);
    });

    test('a copy already at the level is stock, and the consumables are untouched by it', async () => {
        const { container } = buildMarketplaceDom();
        state.items = {
            '/items/shard': { name: 'Shard', isTradable: true },
            '/items/furious_spear': { name: 'Furious Spear', isTradable: true },
        };
        state.inventory = [{ itemHrid: '/items/furious_spear', enhancementLevel: 12, count: 1 }];
        state.actionMaterials = [
            { itemHrid: '/items/shard', itemName: 'Shard', missing: 267, required: 267, isTradeable: true },
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 1,
                required: 1,
                have: 0,
                queued: 0,
                available: 0,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1, { upgradeItemLevel: 12 });

        expect(
            container.querySelector('[data-item-hrid="/items/furious_spear"]').getAttribute('data-missing-quantity')
        ).toBe('0');
        // The shards are +0 consumables whatever level the output is wanted at
        expect(container.querySelector('[data-item-hrid="/items/shard"]').getAttribute('data-missing-quantity')).toBe(
            '267'
        );
    });

    test('a caller that names no level gets the bill it always got', async () => {
        const { container } = buildMarketplaceDom();
        const handleGoToMarketplace = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToMarketplace }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.items = { '/items/furious_spear': { name: 'Furious Spear', isTradable: true } };
        state.inventory = [];
        state.actionMaterials = [
            {
                itemHrid: '/items/furious_spear',
                itemName: 'Furious Spear',
                missing: 3,
                required: 4,
                have: 1,
                queued: 0,
                available: 1,
                isTradeable: true,
                isUpgradeItem: true,
            },
        ];

        await openMissingMaterials('/actions/refine', 1);

        const tab = container.querySelector('[data-item-hrid="/items/furious_spear"]');
        expect(tab.getAttribute('data-missing-quantity')).toBe('3');
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(handleGoToMarketplace).toHaveBeenCalledWith('/items/furious_spear', 0);
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

/**
 * The Tester shop hand-off pins the same lines into the shop's own strip. Its
 * armings are the same kind the marketplace tabs set — persistent, recomputed
 * on every buy box — so they need the same scope, or they go on filling every
 * later buy box for any item.
 */
describe('the Tester shop strip', () => {
    /** A shop navbar button and a visible strip holding the Tester tab */
    function buildShopDom() {
        document.body.innerHTML = '';

        const nav = document.createElement('div');
        nav.className = 'NavigationBar_nav__3uuUl';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-label', 'navigationBar.shop');
        nav.appendChild(svg);
        document.body.appendChild(nav);

        const container = document.createElement('div');
        container.className = 'MuiTabs-flexContainer';
        container.setAttribute('role', 'tablist');
        const tester = document.createElement('button');
        tester.setAttribute('role', 'tab');
        tester.textContent = 'Tester';
        container.appendChild(tester);
        // The Shop's tab strip sits inside its panel (measured on the test server)
        const shopPanel = document.createElement('div');
        shopPanel.className = 'ShopPanel_shopPanel__1Wl3r';
        shopPanel.appendChild(container);
        document.body.appendChild(shopPanel);
        Object.defineProperty(container, 'offsetParent', { get: () => document.body, configurable: true });

        return { container, tester };
    }

    beforeEach(() => {
        state.autofill.setPendingCalculation.mockClear();
        state.testerShop = true;
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
        ];
    });

    test('clicking a pinned line arms the quantity for that line’s item, not for any buy box', async () => {
        const { container } = buildShopDom();

        await openMissingMaterials('/actions/crafting/plank', 5);

        const tab = container.querySelector('[data-item-hrid="/items/plank"]');
        expect(tab).not.toBeNull();
        tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(state.autofill.setPendingCalculation).toHaveBeenCalledWith(expect.any(Function), {
            itemHrid: '/items/plank',
        });
    });
});

describe('the open bill and the reservation ledger', () => {
    beforeEach(() => {
        ledger.claims = {};
        ledger.reserved = [];
        ledger.released = [];
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 }];
        state.unclaimed = {};
        state.actionMaterials = [];
    });

    test('a bill with no owner is the bill it has always been, claims or no claims', () => {
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }]);

        expect(line.have).toBe(120);
        expect(line.available).toBe(120);
        expect(line.missing).toBe(0);
        expect(line.reserved).toBeUndefined();
        expect(line.reservedNote).toBeUndefined();
    });

    test('another owner\u2019s claim is not this bill\u2019s to spend, and the tab says whose it is', () => {
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.available).toBe(20);
        expect(line.missing).toBe(80);
        expect(line.reservedNote).toBe('80 short — reserved by "Goal: Cheese sword"');
    });

    test('a bill is never charged its own claim', () => {
        ledger.claims = { missingMats: { '/items/cedar_lumber|0': 100 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.available).toBe(120);
        expect(line.missing).toBe(0);
    });

    test('an ordinary shortfall carries no note', () => {
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 5 }];
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 3 } };
        const [line] = materialsFromList([{ itemHrid: '/items/cedar_lumber', count: 100 }], 'missingMats');

        expect(line.missing).toBe(98);
        expect(line.reservedNote).toBeUndefined();
    });

    test('the tabs on screen claim their required totals, and leaving gives them back', async () => {
        const { container } = buildMarketplaceDom();
        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 40, required: 40, isTradeable: true },
        ];

        await openMissingMaterials('/actions/crafting/plank', 5);
        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'missingMats',
            lines: [{ itemHrid: '/items/plank', count: 40, enhancementLevel: 0 }],
        });

        container
            .querySelector('[data-mwi-clear-all-tab="true"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(ledger.released).toContain('missingMats');
    });

    test('a bill opened under a caller’s own owner is never re-claimed as the tabs’ own, not even on a live update', async () => {
        buildMarketplaceDom();

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }], {
            ownerId: 'craftingPlan:/items/chair',
        });
        expect(ledger.reserved).toEqual([]);

        // The live-update path recomputes the bill on every inventory message;
        // a second claim there would be this trip competing with itself
        const [, handler] = state.wsOn.mock.calls.at(-1);
        handler({ type: 'items_updated' });

        expect(ledger.reserved.map((entry) => entry.ownerId)).not.toContain('missingMats');
    });

    test('the open bill names the caller whose claim it is, and stops naming it when the trip ends', async () => {
        const { container } = buildMarketplaceDom();
        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }], {
            ownerId: 'craftingPlan:/items/chair',
        });
        // What lets a crafting plan keep its claim while the player shops: the
        // click that opened this bill navigated away from the plan's own panel
        expect(openBillOwner()).toBe('craftingPlan:/items/chair');

        container
            .querySelector('[data-mwi-clear-all-tab="true"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(openBillOwner()).toBeNull();
    });

    test('a bill the tabs claimed themselves names no caller', async () => {
        buildMarketplaceDom();
        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }]);
        expect(openBillOwner()).toBeNull();
    });
});

/**
 * The live-update path redraws the badge of every pinned tab on each inventory
 * message. It used to redraw it with a second, private copy of
 * `updateTabBadge` that had drifted from the exported one the tabs are built
 * with: the copy dropped the "reserved by …" line, so the note explaining why
 * visible stock is not this bill's to spend vanished on the first message to
 * arrive; and it cleared `tab.title`, wiping the Tester-shop tab's own hint.
 */
describe('a live inventory update redraws a tab without losing what it says', () => {
    /** The marketplace strip, with a badge span on the tab material tabs clone. */
    function marketplaceDomWithBadge() {
        const dom = buildMarketplaceDom();
        dom.myListings.innerHTML = '<span class="TabsComponent_badge__x">My Listings</span>';
        return dom;
    }

    /** Redraw every pinned tab, the way an inventory websocket message does. */
    function fireInventoryUpdate() {
        const [, handler] = state.wsOn.mock.calls.at(-1);
        handler({ type: 'items_updated' });
    }

    beforeEach(() => {
        ledger.claims = {};
        ledger.reserved = [];
        ledger.released = [];
        state.items = { '/items/cedar_lumber': { name: 'Cedar Lumber', isTradable: true } };
        state.inventory = [{ itemHrid: '/items/cedar_lumber', enhancementLevel: 0, count: 120 }];
        state.unclaimed = {};
        state.actionMaterials = [];
    });

    test('a tab short only because another plan claimed the stock keeps saying so', async () => {
        const { container } = marketplaceDomWithBadge();
        // 120 held against 100 needed, all but 20 of it claimed elsewhere: the line is short
        // for a reason the player can otherwise see no trace of
        ledger.claims = { 'goal:a': { '/items/cedar_lumber|0': 100 } };

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 100 }]);
        const tab = container.querySelector('[data-item-hrid="/items/cedar_lumber"]');
        expect(tab.innerHTML).toContain('reserved by');

        fireInventoryUpdate();

        expect(tab.innerHTML).toContain('reserved by');
    });

    test('a tab redrawn keeps the tooltip it was given', async () => {
        const { container } = marketplaceDomWithBadge();

        await openMaterialsList([{ itemHrid: '/items/cedar_lumber', count: 300 }]);
        const tab = container.querySelector('[data-item-hrid="/items/cedar_lumber"]');
        // The Tester-shop strip sets exactly this on a line the shop does not stock
        tab.title = 'Not sold in the Tester shop — opens the marketplace';

        fireInventoryUpdate();

        expect(tab.title).toBe('Not sold in the Tester shop — opens the marketplace');
    });
});

/**
 * The Alchemy panel's Missing Mats button: the selected item, bulk multiplier
 * times per Repeat, costed by the same bill builder as every other bill.
 */
describe('the Alchemy panel button', () => {
    const MILK = '/items/holy_milk';
    const STACK_HASH = `char1::/item_locations/inventory::${MILK}::0`;

    /** The alchemy component as the game draws it: tab strip, Costs, Repeat. */
    function mountAlchemyPanel({ itemId = 'holy_milk', enhancement = '', repeat = '10', tab = 'Decompose' } = {}) {
        document.body.insertAdjacentHTML(
            'beforeend',
            `<div class="AlchemyPanel_tabsComponentContainer__x">${['Coinify', 'Decompose', 'Transmute', 'Unrefine']
                .map((t) => `<button role="tab" aria-selected="${t === tab}">${t}</button>`)
                .join('')}</div>` +
                '<div class="SkillActionDetail_alchemyComponent__x">' +
                '<div class="SkillActionDetail_info__x">' +
                '<div class="SkillActionDetail_alchemyCosts__x"><div class="SkillActionDetail_itemRequirements__x">' +
                (itemId
                    ? `<div class="Item_itemContainer__x"><svg><use href="/sprites#${itemId}"></use></svg>` +
                      (enhancement ? `<div class="Item_enhancementLevel__x">${enhancement}</div>` : '') +
                      '</div>'
                    : '') +
                '</div></div>' +
                `<div class="SkillActionDetail_maxActionCountInput__x"><input value="${repeat}"></div>` +
                '</div></div>'
        );
        return document.querySelector('[class*="SkillActionDetail_alchemyComponent"]');
    }

    const button = () => document.getElementById('mwi-alchemy-missing-mats-button');

    beforeEach(() => {
        vi.useFakeTimers();
        state.settingsEnabled = true;
        state.ignoreQueue = false;
        state.currentActions = [];
        state.queuedInputs = new Map();
        state.dataListeners = [];
        state.unclaimed = {};
        ledger.claims = {};
        ledger.reserved = [];
        ledger.released = [];
        state.items = {
            [MILK]: { name: 'Holy Milk', isTradable: true, alchemyDetail: { bulkMultiplier: 2 } },
            '/items/star_cape_refined': { name: 'Star Cape', isTradable: false, alchemyDetail: {} },
        };
        state.inventory = [
            { itemHrid: MILK, enhancementLevel: 0, count: 5, itemLocationHrid: '/item_locations/inventory' },
        ];
        buildMarketplaceDom();
    });

    afterEach(() => {
        missingMaterials.cleanup();
        vi.useRealTimers();
        state.settingsEnabled = false;
        state.currentActions = [];
        state.queuedInputs = new Map();
    });

    test('sizes the bill from Repeat × the bulk multiplier, less what the bag holds', () => {
        mountAlchemyPanel();
        missingMaterials.initialize();

        // 10 actions × 2 per action = 20, 5 held
        expect(button().textContent).toBe('Missing Mats Marketplace · 1 item');
        expect(button().title).toContain('Holy Milk ×15');
        expect(button().disabled).toBe(false);
        // Placed beneath the Costs block
        expect(document.querySelector('[class*="SkillActionDetail_alchemyCosts"]').nextElementSibling).toBe(button());
        // The production button's id is left to the production panels
        expect(document.getElementById('mwi-missing-mats-button')).toBeNull();
    });

    test('the finite queue eats stock first — production inputs and queued alchemy on the same +0 item', () => {
        state.inventory[0].count = 25;
        state.queuedInputs = new Map([[MILK, 4]]);
        state.currentActions = [
            // 3 left × 2 = 6 queued
            {
                actionHrid: '/actions/alchemy/decompose',
                hasMaxCount: true,
                maxCount: 5,
                currentCount: 2,
                primaryItemHash: STACK_HASH,
            },
            // Not counted: infinite, enhanced, another item, not alchemy
            { actionHrid: '/actions/alchemy/decompose', hasMaxCount: false, primaryItemHash: STACK_HASH },
            {
                actionHrid: '/actions/alchemy/coinify',
                hasMaxCount: true,
                maxCount: 9,
                currentCount: 0,
                primaryItemHash: `char1::/item_locations/inventory::${MILK}::3`,
            },
            {
                actionHrid: '/actions/alchemy/coinify',
                hasMaxCount: true,
                maxCount: 9,
                currentCount: 0,
                primaryItemHash: 'char1::/item_locations/inventory::/items/egg::0',
            },
            {
                actionHrid: '/actions/cooking/cake',
                hasMaxCount: true,
                maxCount: 9,
                currentCount: 0,
                primaryItemHash: STACK_HASH,
            },
        ];
        mountAlchemyPanel();
        missingMaterials.initialize();

        // 25 held − 10 queued = 15 available against 20
        expect(button().title).toContain('Holy Milk ×5');
    });

    test('ignoring the queue counts the whole bag', () => {
        state.inventory[0].count = 25;
        state.ignoreQueue = true;
        state.queuedInputs = new Map([[MILK, 4]]);
        state.currentActions = [
            {
                actionHrid: '/actions/alchemy/decompose',
                hasMaxCount: true,
                maxCount: 5,
                currentCount: 2,
                primaryItemHash: STACK_HASH,
            },
        ];
        mountAlchemyPanel();
        missingMaterials.initialize();

        expect(button().textContent).toBe('Missing Mats Marketplace');
    });

    test('an infinite Repeat leaves the button disabled, asking for a quantity', () => {
        mountAlchemyPanel({ repeat: '∞' });
        missingMaterials.initialize();

        expect(button().disabled).toBe(true);
        expect(button().title).toBe('Enter a quantity to check missing materials');
    });

    test('no button with no item selected, an enhanced selection, or the setting off', () => {
        mountAlchemyPanel({ itemId: '' });
        missingMaterials.initialize();
        expect(button()).toBeNull();
        missingMaterials.cleanup();

        buildMarketplaceDom();
        mountAlchemyPanel({ enhancement: '+3' });
        missingMaterials.initialize();
        expect(button()).toBeNull();
        missingMaterials.cleanup();

        buildMarketplaceDom();
        state.settingsEnabled = false;
        mountAlchemyPanel();
        missingMaterials.initialize();
        expect(button()).toBeNull();
    });

    test('an untradable input (a refined cape to unrefine) has nothing to buy', () => {
        mountAlchemyPanel({ itemId: 'star_cape_refined', tab: 'Unrefine' });
        missingMaterials.initialize();

        expect(button().textContent).toBe('Missing Mats Marketplace');
        expect(button().title).toBe('');
    });

    test('a new item, a new count and a bag change redraw it; another feature writing into the panel does not', async () => {
        const panel = mountAlchemyPanel();
        missingMaterials.initialize();
        const first = button();

        // Another Alchemy feature's node: the bill is unchanged, so the button is left alone
        panel
            .querySelector('[class*="SkillActionDetail_info"]')
            .insertAdjacentHTML('beforeend', '<div class="mwi-alchemy-gold-summary">Gold</div>');
        await vi.advanceTimersByTimeAsync(200);
        expect(button()).toBe(first);

        panel.querySelector('input').value = '3';
        panel.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
        await vi.advanceTimersByTimeAsync(200);
        expect(button().title).toContain('Holy Milk ×1');

        state.inventory[0].count = 0;
        state.dataListeners.find((l) => l.event === 'items_updated').handler();
        await vi.advanceTimersByTimeAsync(200);
        expect(button().title).toContain('Holy Milk ×6');

        state.items['/items/egg'] = { name: 'Egg', isTradable: true, alchemyDetail: { bulkMultiplier: 1 } };
        panel.querySelector('use').setAttribute('href', '/sprites#egg');
        await vi.advanceTimersByTimeAsync(200);
        expect(button().title).toContain('Egg ×3');
    });

    test('opens a tab for the item, claims the bill, and the Return tab names the item and count', async () => {
        const { container } = buildMarketplaceDom();
        mountAlchemyPanel();
        missingMaterials.initialize();

        button().click();
        await vi.advanceTimersByTimeAsync(1000);

        const tab = container.querySelector(`[data-item-hrid="${MILK}"]`);
        expect(tab).toBeTruthy();
        expect(ledger.reserved.at(-1)).toEqual({
            ownerId: 'missingMats',
            lines: [{ itemHrid: MILK, count: 20, enhancementLevel: 0 }],
        });
        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        expect(returnTab.textContent).toContain('Holy Milk (×10)');
    });

    test('Return reopens Alchemy on the +0 stack through the game handler and restores the count', async () => {
        const { container } = buildMarketplaceDom();
        const handleAlchemizeItem = vi.fn();
        const handleGoToAction = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToAction, handleAlchemizeItem }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        mountAlchemyPanel();
        missingMaterials.initialize();

        button().click();
        await vi.advanceTimersByTimeAsync(1000);
        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        returnTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(300);

        expect(handleAlchemizeItem).toHaveBeenCalledWith(STACK_HASH);
        expect(handleGoToAction).not.toHaveBeenCalled();
    });

    describe('Return selects the stored alchemy tab', () => {
        async function returnWith({ withTransmuteTab }) {
            const { container } = buildMarketplaceDom();
            const order = [];
            const root = document.createElement('div');
            root.id = 'root';
            root._reactRootContainer = {
                current: {
                    stateNode: { handleGoToAction: vi.fn(), handleAlchemizeItem: vi.fn(() => order.push('alchemize')) },
                    child: null,
                    sibling: null,
                },
            };
            document.body.appendChild(root);
            mountAlchemyPanel({ tab: 'Transmute' });
            missingMaterials.initialize();
            button().click();
            await vi.advanceTimersByTimeAsync(1000);

            // The game lands on another tab; the Transmute tab is there (or not) to be clicked
            const strip = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
            strip.innerHTML = ['Coinify', 'Decompose', 'Transmute', 'Unrefine']
                .map((t) => `<button role="tab" aria-selected="${t === 'Coinify'}">${t}</button>`)
                .join('');
            let transmute = strip.querySelectorAll('[role="tab"]')[2];
            if (withTransmuteTab) {
                transmute.addEventListener('click', () => order.push('tab'));
            } else {
                strip.innerHTML = '<button role="tab" aria-selected="true">Coinify</button>';
                transmute = null;
            }
            globalThis.__repeatWrites = () => order.push('repeat');
            const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
                (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
            );
            returnTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            await vi.advanceTimersByTimeAsync(3000);
            delete globalThis.__repeatWrites;
            return order;
        }

        test('the Transmute tab is clicked before Repeat is restored', async () => {
            const order = await returnWith({ withTransmuteTab: true });
            expect(order.indexOf('tab')).toBeGreaterThan(order.indexOf('alchemize'));
            expect(order.indexOf('repeat')).toBeGreaterThan(order.indexOf('tab'));
        });

        test('a tab that never appears does not throw, and Repeat is still restored', async () => {
            const order = await returnWith({ withTransmuteTab: false });
            expect(order).toContain('alchemize');
            expect(order).not.toContain('tab');
            expect(order).toContain('repeat');
        });
    });

    test('with no stack left, Return opens the alchemy action by its tab', async () => {
        const { container } = buildMarketplaceDom();
        const handleAlchemizeItem = vi.fn();
        const handleGoToAction = vi.fn();
        const root = document.createElement('div');
        root.id = 'root';
        root._reactRootContainer = {
            current: { stateNode: { handleGoToAction, handleAlchemizeItem }, child: null, sibling: null },
        };
        document.body.appendChild(root);
        state.inventory = [];
        mountAlchemyPanel({ tab: 'Transmute' });
        missingMaterials.initialize();

        button().click();
        await vi.advanceTimersByTimeAsync(1000);
        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        returnTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(300);

        expect(handleAlchemizeItem).not.toHaveBeenCalled();
        expect(handleGoToAction).toHaveBeenCalledWith('/actions/alchemy/transmute');
    });

    test('a catalyst picked in the profit what-if joins the bill, sized by its success rate', async () => {
        const whatIf = await import('../alchemy/alchemy-catalyst-whatif.js');
        state.items['/items/prime_catalyst'] = { name: 'Prime Catalyst', isTradable: true };
        state.inventory.push({
            itemHrid: '/items/prime_catalyst',
            enhancementLevel: 0,
            count: 2,
            itemLocationHrid: '/item_locations/inventory',
        });
        mountAlchemyPanel();
        missingMaterials.initialize();
        expect(button().title).not.toContain('Prime Catalyst');

        whatIf.setCatalystWhatIf('prime');
        whatIf.publishCatalystWhatIfResult({
            itemHrid: MILK,
            actionType: 'decompose',
            catalystHrid: '/items/prime_catalyst',
            successRate: 0.75,
        });
        await vi.advanceTimersByTimeAsync(200);

        // 10 actions × 0.75 = 7.5 → 8 needed, 2 held
        expect(button().textContent).toBe('Missing Mats Marketplace · 2 items');
        expect(button().title).toContain('Prime Catalyst ×6');
        expect(button().title).toContain('Catalyst count is an estimate');

        // Back to Equipped: the catalyst leaves the bill
        whatIf.setCatalystWhatIf(null);
        await vi.advanceTimersByTimeAsync(200);
        expect(button().title).not.toContain('Prime Catalyst');
        whatIf.resetCatalystWhatIf();
    });

    test('a catalyst that is also the selected item is billed once, from one stack', async () => {
        const whatIf = await import('../alchemy/alchemy-catalyst-whatif.js');
        const CAT = '/items/prime_catalyst';
        state.items[CAT] = { name: 'Prime Catalyst', isTradable: true, alchemyDetail: { bulkMultiplier: 1 } };
        state.inventory = [
            { itemHrid: CAT, enhancementLevel: 0, count: 10, itemLocationHrid: '/item_locations/inventory' },
        ];
        mountAlchemyPanel({ itemId: 'prime_catalyst' });
        missingMaterials.initialize();
        whatIf.setCatalystWhatIf('prime');
        whatIf.publishCatalystWhatIfResult({
            itemHrid: CAT,
            actionType: 'decompose',
            catalystHrid: CAT,
            successRate: 0.75,
        });
        await vi.advanceTimersByTimeAsync(200);

        // 10 to alchemize + 8 spent as the catalyst = 18 from one stack of 10
        expect(button().textContent).toBe('Missing Mats Marketplace · 1 item');
        expect(button().title).toContain('Prime Catalyst ×8');
        whatIf.resetCatalystWhatIf();
    });

    describe('queued alchemy catalysts', () => {
        const CAT = '/items/prime_catalyst';
        const queuedWith = (over = {}) => ({
            actionHrid: '/actions/alchemy/coinify',
            hasMaxCount: true,
            maxCount: 5,
            currentCount: 1,
            primaryItemHash: `char1::/item_locations/inventory::/items/egg::0`,
            secondaryItemHash: `char1::/item_locations/inventory::${CAT}::0`,
            ...over,
        });
        const publish = async () => {
            const whatIf = await import('../alchemy/alchemy-catalyst-whatif.js');
            state.items[CAT] = { name: 'Prime Catalyst', isTradable: true };
            state.inventory.push({
                itemHrid: CAT,
                enhancementLevel: 0,
                count: 10,
                itemLocationHrid: '/item_locations/inventory',
            });
            mountAlchemyPanel();
            missingMaterials.initialize();
            whatIf.setCatalystWhatIf('prime');
            whatIf.publishCatalystWhatIfResult({
                itemHrid: MILK,
                actionType: 'decompose',
                catalystHrid: CAT,
                successRate: 0.75,
            });
            await vi.advanceTimersByTimeAsync(200);
            return whatIf;
        };

        test('catalysts committed to finite queued alchemy are not available', async () => {
            // 4 actions left use 4 of the 10; 8 are needed, so 2 short
            state.currentActions = [queuedWith()];
            const whatIf = await publish();
            expect(button().title).toContain('Prime Catalyst ×2');
            whatIf.resetCatalystWhatIf();
        });

        test('ignoring the queue, and infinite entries, leave the stack free', async () => {
            state.currentActions = [queuedWith({ hasMaxCount: false })];
            const whatIf = await publish();
            expect(button().title).not.toContain('Prime Catalyst');
            state.ignoreQueue = true;
            state.currentActions = [queuedWith()];
            whatIf.setCatalystWhatIf('prime');
            await vi.advanceTimersByTimeAsync(200);
            expect(button().title).not.toContain('Prime Catalyst');
            whatIf.resetCatalystWhatIf();
        });
    });

    test('a what-if result for another item or tab is not this bill’s', async () => {
        const whatIf = await import('../alchemy/alchemy-catalyst-whatif.js');
        state.items['/items/prime_catalyst'] = { name: 'Prime Catalyst', isTradable: true };
        whatIf.setCatalystWhatIf('prime');
        whatIf.publishCatalystWhatIfResult({
            itemHrid: '/items/egg',
            actionType: 'decompose',
            catalystHrid: '/items/prime_catalyst',
            successRate: 0.75,
        });
        mountAlchemyPanel();
        missingMaterials.initialize();
        expect(button().title).not.toContain('Prime Catalyst');
        missingMaterials.cleanup();

        buildMarketplaceDom();
        whatIf.publishCatalystWhatIfResult({
            itemHrid: MILK,
            actionType: 'transmute',
            catalystHrid: '/items/prime_catalyst',
            successRate: 0.75,
        });
        mountAlchemyPanel();
        missingMaterials.initialize();
        expect(button().title).not.toContain('Prime Catalyst');
        whatIf.resetCatalystWhatIf();
    });

    test('the opened bill keeps the catalyst it was opened with', async () => {
        const whatIf = await import('../alchemy/alchemy-catalyst-whatif.js');
        state.items['/items/prime_catalyst'] = { name: 'Prime Catalyst', isTradable: true };
        const { container } = buildMarketplaceDom();
        whatIf.setCatalystWhatIf('prime');
        whatIf.publishCatalystWhatIfResult({
            itemHrid: MILK,
            actionType: 'decompose',
            catalystHrid: '/items/prime_catalyst',
            successRate: 0.5,
        });
        mountAlchemyPanel();
        missingMaterials.initialize();

        button().click();
        await vi.advanceTimersByTimeAsync(1000);

        expect(container.querySelector('[data-item-hrid="/items/prime_catalyst"]')).toBeTruthy();
        expect(ledger.reserved.at(-1).lines).toEqual([
            { itemHrid: MILK, count: 20, enhancementLevel: 0 },
            { itemHrid: '/items/prime_catalyst', count: 5, enhancementLevel: 0 },
        ]);
        whatIf.resetCatalystWhatIf();
    });

    test('cleanup removes the button and every listener it added', () => {
        mountAlchemyPanel();
        missingMaterials.initialize();
        expect(button()).not.toBeNull();
        expect(state.dataListeners.length).toBe(2);

        missingMaterials.cleanup();

        expect(button()).toBeNull();
        expect(state.dataListeners).toEqual([]);
    });

    test('a production bill opened afterwards drops the alchemy context', async () => {
        const { container } = buildMarketplaceDom();
        mountAlchemyPanel();
        missingMaterials.initialize();
        button().click();
        await vi.advanceTimersByTimeAsync(1000);

        state.actionMaterials = [
            { itemHrid: '/items/plank', itemName: 'Plank', missing: 4, required: 4, isTradeable: true },
        ];
        const opening = openMissingMaterials('/actions/crafting/plank', 2);
        await vi.advanceTimersByTimeAsync(1000);
        await opening;

        const returnTab = Array.from(container.querySelectorAll('[data-mwi-custom-tab="true"]')).find(
            (el) => !el.hasAttribute('data-item-hrid') && !el.hasAttribute('data-mwi-clear-all-tab')
        );
        expect(returnTab.textContent).not.toContain('Holy Milk');
    });
});
