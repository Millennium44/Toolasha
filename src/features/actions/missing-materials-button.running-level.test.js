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
    getShopCoinOnlyCost: () => 0,
    getActionHridFromName: () => null,
    getActionHridFromFiber: () => null,
}));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerShopCoinCost: () => 0,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ guildMemberSkills: () => null, missingMaterialsButton: () => null }));
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
/**
 * The Enhance tab's two item tiles as the game draws them (test server, 2026-10-04): the input
 * copy in the selector, with a level badge only above +0, and the Outputs copy one level up,
 * whose name carries no level and whose badge is the input's plus one
 * @param {string} itemName - "Name" or "Name +N"
 * @returns {string} HTML
 */
const enhancingItems = (itemName) => {
    const level = Number((itemName.match(/\+(\d+)$/) || [0, 0])[1]);
    const name = itemName.replace(/\s*\+\d+$/, '');
    return (
        '<div class="SkillActionDetail_primaryItemSelectorContainer__nrvNW"><div class="Item_itemContainer__x7kH1">' +
        '<div class="Item_item__2De2O Item_clickable__3viV6 Item_large__1aJaU">' +
        (level > 0 ? `<div class="Item_enhancementLevel__19g-e">+${level}</div>` : '') +
        '</div></div></div>' +
        '<div class="SkillActionDetail_enhancingOutput__VPHbY"><div class="SkillActionDetail_item__2vEAz">' +
        '<div class="Item_itemContainer__x7kH1"><div class="Item_item__2De2O Item_inline__3eeJo">' +
        `<div class="Item_name__2C42x">${name}</div><div class="Item_enhancementLevel__19g-e">+${level + 1}</div>` +
        '</div></div></div></div>'
    );
};

async function planStartLevel(shown = 'Brie Sword') {
    state.startLevels = [];
    document.body.innerHTML =
        '<div class="SkillActionDetail_enhancingComponent__17bOx" data-mwi-item-hrid="/items/brie_sword">' +
        '<div><span>Target Level</span><input type="number" value="10"></div>' +
        enhancingItems(shown) +
        '</div>';
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

    test('the panel shows the running copy: its level', async () => {
        state.actions = running('/items/brie_sword', 7);
        expect(await planStartLevel('Brie Sword +7')).toBe(7);
    });

    test('a +7 copy running while another +0 copy of the same item is shown plans from +0', async () => {
        state.actions = running('/items/brie_sword', 7);
        expect(await planStartLevel('Brie Sword')).toBe(0);
    });
});
