/** @vitest-environment happy-dom
 *
 * A bill of materials that is not an action's — a house level's — opened as
 * the same marketplace tabs the action-panel button builds.
 *
 * What is worth asserting is the mapping: totals against what the inventory
 * holds (unenhanced copies only), nothing reserved for the queue, a line the
 * game does not know still named from its hrid.
 */

import { describe, test, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
    inventory: [],
    items: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({ itemDetailMap: state.items }),
        getActionDetails: () => null,
        getItemDetails: (hrid) => state.items[hrid] || null,
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
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
    calculateEnhancementMaterialRequirements: () => [],
}));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        cleanup: () => {},
        setPendingCalculation: () => {},
        clearQuantity: () => {},
    }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    createMaterialTab: () => document.createElement('button'),
    removeMaterialTabs: () => {},
    setupMarketplaceCleanupObserver: () => null,
    navigateToMarketplace: () => {},
    visibleTabsContainer: () => null,
}));
vi.mock('./enhancement-display.js', () => ({
    getProtectionItemFromUI: () => null,
    getProtectFromLevelFromUI: () => 0,
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ calculateEnhancementPath: () => null }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => ({ disconnect: () => {} }) }));
vi.mock('../../utils/game-lookups.js', () => ({ getActionHridFromName: () => null }));
vi.mock('../../utils/react-input.js', () => ({ setReactInputValue: () => {} }));

const { materialsFromList, openMaterialsList } = await import('./missing-materials-button.js');

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
