/**
 * The Max button counts only what a craft can spend: +0 copies in the bag.
 *
 * The character item list carries equipped gear alongside the inventory, and an enhanced copy of
 * an item is never drawn as a production input or as the +0 upgrade. Counting either filled Max
 * with crafts the game refuses to queue.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

const game = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => null,
        getItemDetails: () => null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
        getEquipment: () => new Map(),
        getPersonalBuffFlatBoost: () => 0,
        isTaskAction: () => false,
        isBuffBeingSimulated: () => false,
        getCommunityBuffLevel: () => 0,
        characterData: {},
        on: () => () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
    },
}));

vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => new Set() },
}));

const quickInputButtons = (await import('./quick-input-buttons.js')).default;

const CHEESE_SWORD = '/items/cheese_sword';
const VERDANT_CHEESE = '/items/verdant_cheese';
const CHARM = '/items/foraging_charm';
const CHARM_MATS = '/items/charm_mats';

function row(itemHrid, count, enhancementLevel = 0, itemLocationHrid = '/item_locations/inventory') {
    return { itemHrid, count, enhancementLevel, itemLocationHrid };
}

const VERDANT_SWORD = {
    hrid: '/actions/cheesesmithing/verdant_sword',
    type: '/action_types/cheesesmithing',
    inputItems: [{ itemHrid: VERDANT_CHEESE, count: 10 }],
    upgradeItemHrid: CHEESE_SWORD,
};

const ADVANCED_CHARM = {
    hrid: '/actions/crafting/advanced_foraging_charm',
    type: '/action_types/crafting',
    inputItems: [
        { itemHrid: CHARM, count: 1 },
        { itemHrid: CHARM_MATS, count: 5 },
    ],
    upgradeItemHrid: CHARM,
};

describe('Max for production', () => {
    beforeEach(() => {
        game.inventory = [];
    });

    test('an equipped upgrade item is not in the bag', () => {
        game.inventory = [row(VERDANT_CHEESE, 1000), row(CHEESE_SWORD, 1, 0, '/item_locations/main_hand')];
        expect(quickInputButtons.calculateMaxValue(null, VERDANT_SWORD, { itemDetailMap: {} })).toBe(0);
    });

    test('enhanced or equipped copies of an input buy no crafts', () => {
        game.inventory = [
            row(CHARM, 2, 0),
            row(CHARM, 4, 3),
            row(CHARM, 1, 0, '/item_locations/charm'),
            row(CHARM_MATS, 1000),
        ];
        // Two +0 charms in the bag, two per craft (one input, one upgrade)
        expect(quickInputButtons.calculateMaxValue(null, ADVANCED_CHARM, { itemDetailMap: {} })).toBe(1);
    });
});
