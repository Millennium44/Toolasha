/**
 * Tests for the Max Produceable calculation
 *
 * "Can produce: N" is the one number on the action panel that is pure
 * arithmetic: inventory divided by the per-action material cost, floored, and
 * taken across every input plus the upgrade slot. The character's bank and teas
 * are mocked; the division is not.
 *
 * Not covered here (pure DOM/observer glue): injectMaxProduceable, updateCount,
 * addBestActionIndicators, the font-fitting and layout-sync helpers.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetails: {},
    inventory: [],
    itemDetailMap: {},
    drinkSlots: [],
}));

const buffs = vi.hoisted(() => ({
    artisanBonus: 0,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => game.drinkSlots,
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onSelector: () => () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_k, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#ff0',
        SCRIPT_COLOR_ALERT: '#fa0',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./action-panel-sort.js', () => ({
    default: {
        updateProfit: () => {},
        updateExpPerHour: () => {},
        isPinned: () => false,
        triggerSort: () => {},
        unregisterPanel: () => {},
    },
}));

vi.mock('./action-filter.js', () => ({
    default: { isFilterHidden: () => false },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: async () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => null }));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => buffs.artisanBonus,
    getDrinkConcentration: () => 0,
}));

const maxProduceable = (await import('./max-produceable.js')).default;

const SWORD = '/actions/cheesesmithing/cheesy_sword';
const CHEESE = '/items/cheese';
const IRON = '/items/iron_bar';
const STONE = '/items/enhancement_stone';

/** Inventory rows, defaulting to the inventory location the index filters on */
function stack(itemHrid, count, itemLocationHrid = '/item_locations/inventory') {
    return { itemHrid, count, itemLocationHrid };
}

beforeEach(() => {
    buffs.artisanBonus = 0;
    game.drinkSlots = [];
    game.itemDetailMap = {};
    game.actionDetails = {
        [SWORD]: {
            type: '/action_types/cheesesmithing',
            inputItems: [
                { itemHrid: CHEESE, count: 10 },
                { itemHrid: IRON, count: 5 },
            ],
        },
    };
    game.inventory = [stack(CHEESE, 120), stack(IRON, 65)];
});

describe('calculateMaxProduceable', () => {
    test('is limited by the scarcest input', () => {
        // cheese 120 / 10 = 12, iron 65 / 5 = 13 → 12
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(12);
    });

    test('floors partial crafts', () => {
        game.inventory = [stack(CHEESE, 129), stack(IRON, 65)];

        // 129 / 10 = 12.9 → 12
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(12);
    });

    test('a missing material means zero crafts, not a skipped ingredient', () => {
        game.inventory = [stack(CHEESE, 120)];

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('ignores stacks held outside the inventory', () => {
        game.inventory = [stack(CHEESE, 120), stack(IRON, 65, '/item_locations/bank')];

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('returns null for an unknown action', () => {
        expect(maxProduceable.calculateMaxProduceable('/actions/nope')).toBeNull();
    });

    test('accepts a prebuilt inventory index instead of re-reading the bank', () => {
        const index = new Map([
            [CHEESE, { itemHrid: CHEESE, count: 500 }],
            [IRON, { itemHrid: IRON, count: 500 }],
        ]);

        // 500 / 10 = 50, 500 / 5 = 100 → 50
        expect(maxProduceable.calculateMaxProduceable(SWORD, index)).toBe(50);
    });
});

describe('calculateMaxProduceable — Artisan Tea', () => {
    test('stretches the materials by the artisan reduction', () => {
        buffs.artisanBonus = 0.1;

        // cheese: 10 × 0.9 = 9 per action → 120 / 9 = 13.33 → 13
        // iron:    5 × 0.9 = 4.5        →  65 / 4.5 = 14.44 → 14
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(13);
    });
});

describe('calculateMaxProduceable — upgrade items', () => {
    test('an upgrade item caps the count and is not discounted by artisan tea', () => {
        game.actionDetails[SWORD].upgradeItemHrid = STONE;
        game.inventory = [stack(CHEESE, 120), stack(IRON, 65), stack(STONE, 4)];
        buffs.artisanBonus = 0.5; // would otherwise allow 24 crafts on cheese

        // 1 stone per craft, un-discounted → 4
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(4);
    });

    test('no upgrade item in the bank means nothing can be made', () => {
        game.actionDetails[SWORD].upgradeItemHrid = STONE;

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('when the upgrade item is also an input it costs one extra, undiscounted', () => {
        // Upgrading a sword: 3 cheese plus the sword being upgraded
        game.actionDetails['/actions/cheesesmithing/upgrade'] = {
            type: '/action_types/cheesesmithing',
            inputItems: [
                { itemHrid: CHEESE, count: 3 },
                { itemHrid: '/items/cheesy_sword', count: 2 },
            ],
            upgradeItemHrid: '/items/cheesy_sword',
        };
        game.inventory = [stack(CHEESE, 100), stack('/items/cheesy_sword', 9)];

        // swords per action = 2 + 1 upgrade = 3 → 9 / 3 = 3
        // cheese 100 / 3 = 33 → limited to 3, and the upgrade slot is not charged twice
        expect(maxProduceable.calculateMaxProduceable('/actions/cheesesmithing/upgrade')).toBe(3);
    });

    test('artisan tea discounts the input half of a shared upgrade item only', () => {
        game.actionDetails['/actions/cheesesmithing/upgrade'] = {
            type: '/action_types/cheesesmithing',
            inputItems: [{ itemHrid: '/items/cheesy_sword', count: 2 }],
            upgradeItemHrid: '/items/cheesy_sword',
        };
        game.inventory = [stack('/items/cheesy_sword', 20)];
        buffs.artisanBonus = 0.5;

        // swords per action = 2 × 0.5 + 1 = 2 → 20 / 2 = 10
        expect(maxProduceable.calculateMaxProduceable('/actions/cheesesmithing/upgrade')).toBe(10);
    });
});
