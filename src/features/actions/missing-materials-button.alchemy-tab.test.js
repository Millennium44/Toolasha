/** @vitest-environment happy-dom
 *
 * Missing Mats restores the alchemy tab by position, not by translated label.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ actions: [], startLevels: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getActionDetails: () => null,
        getItemDetails: () => null,
        getCurrentActions: () => state.actions,
        on: () => {},
        off: () => {},
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
    calculateEnhancementWholeAttempts: () => 3,
    calculateQueuedMaterialsForAction: () => new Map(),
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
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    missingMaterialsButton: () => null,
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: -1, bid: -1 }), on: () => {} } }));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: () => ({ price: 0, custom: false, missing: true }),
}));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: () => {} }));

const missingMaterials = await import('./missing-materials-button.js');

afterEach(() => {
    document.body.innerHTML = '';
});

describe('selectAlchemyTab', () => {
    function mount(labels, selected) {
        document.body.innerHTML = `<div class="AlchemyPanel_tabsComponentContainer__x">${labels
            .map((l, i) => `<button role="tab" aria-selected="${i === selected}">${l}</button>`)
            .join('')}</div>`;
        const clicks = [];
        document
            .querySelectorAll('[role="tab"]')
            .forEach((el, i) => el.addEventListener('click', () => clicks.push(i)));
        return clicks;
    }

    test('clicks the transmute tab on a Chinese client', async () => {
        const clicks = mount(['点金', '分解', '转化', '重铸', 'Alchemy History'], 0);
        await missingMaterials.selectAlchemyTab('transmute');
        expect(clicks).toEqual([2]);
    });

    test('does not click an already selected tab', async () => {
        const clicks = mount(['点金', '分解', '转化', '重铸'], 3);
        await missingMaterials.selectAlchemyTab('unrefine');
        expect(clicks).toEqual([]);
    });

    test('an unknown tab type clicks nothing', async () => {
        const clicks = mount(['Coinify', 'Decompose', 'Transmute', 'Unrefine'], 0);
        await missingMaterials.selectAlchemyTab('bogus');
        expect(clicks).toEqual([]);
    });
});
