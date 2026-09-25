/**
 * Which stacks a queued production row can spend.
 *
 * Production consumes only +0 copies of an input, and the upgrade slot draws the one stack the
 * queued action selected in `primaryItemHash` — the game's own action counter reads exactly that
 * stack. Summing every enhancement level into the limit promised crafts the queue cannot run.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ actionDetails: {}, itemDetails: {} }));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const CHEESE_SWORD = '/items/cheese_sword';
const VERDANT_CHEESE = '/items/verdant_cheese';
const CHARM = '/items/foraging_charm';
const CHARM_MATS = '/items/charm_mats';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

const VERDANT_SWORD = {
    hrid: '/actions/cheesesmithing/verdant_sword',
    type: '/action_types/cheesesmithing',
    inputItems: [{ itemHrid: VERDANT_CHEESE, count: 10 }],
    upgradeItemHrid: CHEESE_SWORD,
    outputItems: [{ itemHrid: '/items/verdant_sword', count: 1 }],
};

// Every advanced+ charm lists its lower tier as both an input and the upgrade item
const ADVANCED_CHARM = {
    hrid: '/actions/crafting/advanced_foraging_charm',
    type: '/action_types/crafting',
    inputItems: [
        { itemHrid: CHARM, count: 1 },
        { itemHrid: CHARM_MATS, count: 5 },
    ],
    upgradeItemHrid: CHARM,
    outputItems: [{ itemHrid: '/items/advanced_foraging_charm', count: 1 }],
};

describe('queued production rows spend the stacks the game spends', () => {
    beforeEach(() => {
        game.actionDetails = { [VERDANT_SWORD.hrid]: VERDANT_SWORD, [ADVANCED_CHARM.hrid]: ADVANCED_CHARM };
        game.itemDetails = {};
    });

    test('the upgrade limit is the selected +0 stack, not every level of the item', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([
            stack(VERDANT_CHEESE, 1000),
            stack(CHEESE_SWORD, 2, 0),
            stack(CHEESE_SWORD, 1, 5),
        ]);
        const row = { actionHrid: VERDANT_SWORD.hrid, primaryItemHash: hashFor(CHEESE_SWORD, 0) };
        const limit = actionTimeDisplay.calculateMaterialLimit(VERDANT_SWORD, lookup, 0, row);
        expect(limit.maxActions).toBe(2);
        expect(limit.limitType).toBe(`upgrade:${CHEESE_SWORD}`);
    });

    test('a selected enhanced upgrade stack limits by that stack, and the ledger spends it', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([
            stack(VERDANT_CHEESE, 1000),
            stack(CHEESE_SWORD, 4, 0),
            stack(CHEESE_SWORD, 1, 5),
        ]);
        const row = { actionHrid: VERDANT_SWORD.hrid, primaryItemHash: hashFor(CHEESE_SWORD, 5) };
        expect(actionTimeDisplay.calculateMaterialLimit(VERDANT_SWORD, lookup, 0, row).maxActions).toBe(1);

        actionTimeDisplay.deductQueueActionMaterials(lookup, VERDANT_SWORD, row, { count: 1, isTrulyInfinite: false });
        expect(lookup.byEnhancedKey[`${CHEESE_SWORD}::5`]).toBe(0);
        expect(lookup.byEnhancedKey[`${CHEESE_SWORD}::0`]).toBe(4);
    });

    test('enhanced copies of an input item buy no crafts', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([
            stack(CHARM, 1, 0),
            stack(CHARM, 3, 4),
            stack(CHARM_MATS, 1000),
        ]);
        const row = { actionHrid: ADVANCED_CHARM.hrid, primaryItemHash: hashFor(CHARM, 0) };
        // One +0 charm against two per craft (one input, one upgrade): nothing can be made
        expect(actionTimeDisplay.calculateMaterialLimit(ADVANCED_CHARM, lookup, 0, row).maxActions).toBe(0);
    });
});
