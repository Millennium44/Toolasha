/** @vitest-environment happy-dom
 * The real Missing Mats → reservation ledger → persisted record path. Only the
 * game data and storage transport are doubled; claims and tombstones are real.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildActionCompleted } from '../../__fixtures__/wire/action-completed.js';
import { buildItemsUpdated } from '../../__fixtures__/wire/items-updated.js';

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

const saved = vi.hoisted(() => new Map());
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => saved.get(key) ?? fallback,
        tryGet: async (key) =>
            saved.has(key) ? { found: true, value: structuredClone(saved.get(key)) } : { found: false, value: null },
        set: async (key, value) => {
            saved.set(key, structuredClone(value));
            return true;
        },
    },
}));

const missingMaterials = await import('./missing-materials-button.js');
const { RESERVATIONS_KEY, RELEASED_KEY, allReservations, reserve, flushReservationWrites, _resetReservations } =
    await import('../../utils/inventory-reservations.js');

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

const SWORD = '/items/cheese_sword';
const MIRROR = '/items/philosophers_mirror';
const BAG = '/item_locations/inventory';
const KEY = `${RESERVATIONS_KEY}_char1`;
const owned = () => ({
    ...buildItemsUpdated().endCharacterItems[0],
    characterID: 'char1',
    itemHrid: SWORD,
    enhancementLevel: 12,
    count: 1,
    hash: `char1::${BAG}::${SWORD}::12`,
});
const open = () =>
    missingMaterials.openMaterialsList([{ itemHrid: MIRROR, count: 1 }], {
        ownedInputs: [{ itemHrid: SWORD, enhancementLevel: 12, sourceLocation: BAG, count: 1 }],
    });
const settle = async (promise) => (await Promise.all([promise, vi.advanceTimersByTimeAsync(300)]))[0];
const finishWrites = async () => {
    // Cleanup starts release without awaiting it. Let it hand its write to the
    // real record before asking the record to flush the queue.
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await Promise.resolve();
    await flushReservationWrites();
};

beforeEach(async () => {
    missingMaterials.cleanup();
    await finishWrites();
    saved.clear();
    _resetReservations();
    vi.useFakeTimers();
    state.settingsEnabled = true;
    state.unclaimed = {};
    state.queuedInputs = new Map();
    state.ignoreQueue = false;
    state.characterId = 'char1';
    state.inventory = [owned()];
    state.items = {
        [SWORD]: { name: 'Cheese Sword', isTradable: true },
        [MIRROR]: { name: "Philosopher's Mirror", isTradable: true },
    };
    state.wsOn.mockClear();
    state.wsOff.mockClear();
    buildMarketplaceDom();
});

afterEach(async () => {
    missingMaterials.cleanup();
    await finishWrites();
    _resetReservations();
    vi.useRealTimers();
});

describe('Mirror shopping with the real reservation ledger', () => {
    test.each(['action completion', 'clear all', 'competing claim'])(
        '%s releases the owned copy in memory and storage',
        async (ending) => {
            expect(await settle(open())).toBe(true);
            expect(allReservations().missingMats.lines).toContainEqual({
                itemHrid: SWORD,
                enhancementLevel: 12,
                count: 1,
            });
            if (ending === 'action completion') {
                state.inventory[0].count = 0;
                state.wsOn.mock.calls.at(-1)[1](buildActionCompleted({ endCharacterItems: state.inventory }));
            } else if (ending === 'clear all') {
                document.querySelector('[data-mwi-clear-all-tab]').click();
            } else {
                await reserve('other-plan', [{ itemHrid: SWORD, enhancementLevel: 12, count: 1 }]);
            }
            await finishWrites();
            expect(document.querySelector('[data-owned-inputs]')).toBeNull();
            expect(allReservations().missingMats).toBeUndefined();
            expect(saved.get(KEY).missingMats).toBeUndefined();
            expect(saved.get(KEY)[RELEASED_KEY].missingMats).toBeGreaterThan(0);
            if (ending === 'competing claim') expect(saved.get(KEY)['other-plan']).toBeTruthy();
        }
    );
});

describe('overlapping owned and purchasable requirements', () => {
    const LOGS = '/items/log';
    const WORN = '/item_locations/main_hand';
    const stock = (count, level = 0, location = BAG, itemHrid = LOGS) => ({
        ...buildItemsUpdated().endCharacterItems[0],
        characterID: state.characterId,
        itemHrid,
        enhancementLevel: level,
        itemLocationHrid: location,
        count,
        hash: `${state.characterId}::${location}::${itemHrid}::${level}`,
    });
    const input = (count = 30, level = 0, sourceLocation = BAG, itemHrid = LOGS) => ({
        itemHrid,
        enhancementLevel: level,
        sourceLocation,
        count,
    });
    const tab = (itemHrid = LOGS) => document.querySelector(`[data-item-hrid="${itemHrid}"]`);
    beforeEach(() => {
        state.items[LOGS] = { name: 'Log', isTradable: true };
        state.inventory = [stock(90)];
    });

    test.each([null, 'craft:other'])(
        'allocates bag stock once with reservation owner %s and refreshes the buy amount',
        async (ownerId) => {
            if (ownerId) await reserve(ownerId, [{ itemHrid: LOGS, count: 130 }]);
            expect(
                await settle(
                    missingMaterials.openMaterialsList([{ itemHrid: LOGS, count: 100 }], {
                        ownerId,
                        ownedInputs: [input()],
                    })
                )
            ).toBe(true);
            expect(tab().getAttribute('data-missing-quantity')).toBe('40');
            expect(allReservations()[ownerId || 'missingMats'].lines).toEqual([
                { itemHrid: LOGS, enhancementLevel: 0, count: 130 },
            ]);
            await finishWrites();
            expect(saved.get(KEY)[ownerId || 'missingMats'].lines[0].count).toBe(130);

            tab().click();
            const [quantity] = state.autofill.setPendingCalculation.mock.calls.at(-1);
            expect(quantity()).toBe(40);
            state.inventory[0].count = 130;
            state.wsOn.mock.calls.at(-1)[1](buildItemsUpdated({ endCharacterItems: state.inventory }));
            expect(tab().getAttribute('data-missing-quantity')).toBe('0');
            expect(quantity()).toBe(0);
            expect(allReservations()[ownerId || 'missingMats'].lines[0].count).toBe(130);
        }
    );

    test.each([0, 7])('sums three owned inputs at +%s without spending another level', async (level) => {
        state.inventory = [stock(90, level, BAG, SWORD), stock(500, level + 1, BAG, SWORD)];
        await settle(
            missingMaterials.openMaterialsList([{ itemHrid: SWORD, enhancementLevel: level, count: 100 }], {
                ownedInputs: [input(10, level, BAG, SWORD), input(10, level, BAG, SWORD), input(10, level, BAG, SWORD)],
            })
        );
        expect(tab(SWORD).getAttribute('data-missing-quantity')).toBe('40');
        expect(allReservations().missingMats.lines).toEqual([{ itemHrid: SWORD, enhancementLevel: level, count: 130 }]);
    });

    test.each([
        ['unclaimed purchases', 20, 0, 0, 20],
        ['queued inputs', 0, 5, 0, 45],
        ['other reservations', 0, 0, 10, 50],
    ])('applies %s alongside the owned inputs', async (_name, unclaimed, queued, reserved, missing) => {
        state.unclaimed[LOGS] = unclaimed;
        state.queuedInputs.set(LOGS, queued);
        if (reserved) await reserve('other-plan', [{ itemHrid: LOGS, count: reserved }]);
        await settle(
            missingMaterials.openMaterialsList([{ itemHrid: LOGS, count: 100, queued }], {
                ownedInputs: [input()],
            })
        );
        expect(tab().getAttribute('data-missing-quantity')).toBe(String(missing));
    });

    test.each([
        [7, BAG],
        [0, WORN],
    ])('does not subtract an owned +%s input in %s from the +0 bag', async (level, location) => {
        state.inventory = [stock(90, 0, BAG, SWORD), stock(30, level, location, SWORD)];
        await settle(
            missingMaterials.openMaterialsList([{ itemHrid: SWORD, count: 100 }], {
                ownedInputs: [input(30, level, location, SWORD)],
            })
        );
        expect(tab(SWORD).getAttribute('data-missing-quantity')).toBe('10');
    });

    test('unclaimed purchases cannot replace an unavailable physical owned input', async () => {
        state.inventory = [stock(20)];
        state.unclaimed[LOGS] = 100;
        await expect(
            settle(
                missingMaterials.openMaterialsList([{ itemHrid: LOGS, count: 100 }], {
                    ownedInputs: [input()],
                })
            )
        ).rejects.toMatchObject({ code: 'OWNED_INPUT_UNAVAILABLE' });
        expect(tab()).toBeNull();
        expect(allReservations().missingMats).toBeUndefined();
    });
});

describe('all open shopping lists belong to their originating character', () => {
    test.each([null, 'craft:other'])(
        'clears a plain bill owned by %s before the character changes',
        async (ownerId) => {
            if (ownerId) await reserve(ownerId, [{ itemHrid: MIRROR, count: 1 }]);
            const openPlain = () => missingMaterials.openMaterialsList([{ itemHrid: MIRROR, count: 1 }], { ownerId });
            await settle(openPlain());
            await settle(openPlain());
            expect(state.dataListeners.filter(({ event }) => event === 'character_switching')).toHaveLength(1);
            for (const { handler } of [...state.dataListeners].filter(({ event }) => event === 'character_switching')) {
                handler();
            }
            await finishWrites();
            expect(document.querySelector('[data-mwi-tab-owner="missing-materials"]')).toBeNull();
            expect(allReservations().missingMats).toBeUndefined();
            if (ownerId) expect(allReservations()[ownerId].lines).toHaveLength(1);
            else {
                expect(saved.get(KEY).missingMats).toBeUndefined();
                expect(saved.get(KEY)[RELEASED_KEY].missingMats).toBeGreaterThan(0);
            }
            expect(state.dataListeners.filter(({ event }) => event === 'character_switching')).toHaveLength(0);
            expect(state.wsOff).toHaveBeenCalledWith('*', state.wsOn.mock.calls.at(-1)[1]);
            expect(state.autofill.clearQuantity).toHaveBeenCalled();
            state.characterId = 'char2';
            expect(saved.get(`${RESERVATIONS_KEY}_char2`)).toBeUndefined();
        }
    );
});
