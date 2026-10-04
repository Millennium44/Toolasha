/** @vitest-environment happy-dom
 *
 * The Missing Mats button plans from the level of the item on the panel. An enhance running on a
 * different item at +7 says nothing about it: the plan for a +0 item on the bench starts at +0.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ actions: [], startLevels: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: () => null,
        getCurrentActions: () => state.actions,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
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
    calculateMaterialRequirements: () => [],
    calculateEnhancementMaterialRequirements: (itemHrid, startLevel) => {
        state.startLevels.push(startLevel);
        return [];
    },
    unclaimedBoughtCount: () => 0,
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        cleanup: () => {},
        setPendingCalculation: () => {},
        clearQuantity: () => {},
    }),
    findQuantityInput: () => null,
}));
vi.mock('./enhancement-display.js', async () => {
    const actual = await vi.importActual('./enhancement-display.js');
    return {
        ...actual,
        getProtectionItemFromUI: () => null,
        getProtectFromLevelFromUI: () => 1,
    };
});
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/game-lookups.js', () => ({
    getActionHridFromName: () => null,
    getActionHridFromFiber: () => null,
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerShopCoinCost: () => 0,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: () => null }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: -1, bid: -1 }), on: () => {} } }));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: () => ({ price: 0, custom: false, missing: true }),
}));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: () => {} }));

const missingMaterials = await import('./missing-materials-button.js');

const running = (itemHrid, level) => [
    {
        id: 1,
        actionHrid: '/actions/enhancing/enhance',
        primaryItemHash: `1234::/item_locations/inventory::${itemHrid}::${level}`,
        isDone: false,
        ordinal: 1,
    },
];

/** Mount an Enhance panel for Brie Sword and return the level the plan started from. */
async function planStartLevel() {
    state.startLevels = [];
    document.body.innerHTML =
        '<div class="SkillActionDetail_enhancingComponent__17bOx" data-mwi-item-hrid="/items/brie_sword">' +
        '<div><span>Target Level</span><input type="number" value="10"></div>' +
        '<div class="SkillActionDetail_item__2vEAz"><div class="Item_name__2C42x">Brie Sword</div></div></div>';
    missingMaterials.initialize();
    await vi.advanceTimersByTimeAsync(700);
    missingMaterials.cleanup();
    return state.startLevels[0];
}

beforeEach(() => {
    vi.useFakeTimers();
    state.actions = [];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the Missing Mats plan start level', () => {
    test('an enhance running on another item at +7 does not move a +0 item off +0', async () => {
        state.actions = running('/items/cheese_sword', 7);
        expect(await planStartLevel()).toBe(0);
    });

    test('an enhance running on the panel item itself gives its level', async () => {
        state.actions = running('/items/brie_sword', 7);
        expect(await planStartLevel()).toBe(7);
    });
});
