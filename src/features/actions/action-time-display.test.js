/**
 * Tests for calculateMaterialLimit's alchemy branch.
 *
 * Alchemy charges a coin fee per action that the game's action data does not
 * carry — actionDetails.coinCost is 0 for every alchemy action — so the limit
 * has to derive it from the item. Getting this wrong does not look wrong: the
 * queue just claims more actions than the character can pay for.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    itemDetails: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getCurrentActions: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, fallback) => fallback },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onSelector: () => () => {} },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

const CHEESE = '/items/cheese';
const COIN = '/items/coin';

/** Inventory rows in the one location the lookup counts */
function stack(itemHrid, count, enhancementLevel = 0) {
    return { itemHrid, count, enhancementLevel, itemLocationHrid: '/item_locations/inventory' };
}

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

beforeEach(() => {
    game.itemDetails = {
        [CHEESE]: {
            itemHrid: CHEESE,
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, transmuteSuccessRate: 0.5 },
        },
    };
});

describe('calculateMaterialLimit — alchemy coin fee', () => {
    test('gold limits a decompose queue even though actionDetails.coinCost is 0', () => {
        // (10 + itemLevel 10) × 5 = 100 coins per action; 550 coins buys 5
        const inventory = [stack(CHEESE, 100), stack(COIN, 550)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 5, limitType: 'gold' });
    });

    test('transmute prices the fee off the sell price, not the item level', () => {
        // max(50, 1000 / 5) = 200 coins per action; 1000 coins buys 5
        const inventory = [stack(CHEESE, 100), stack(COIN, 1000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/transmute', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 5, limitType: 'gold' });
    });

    test('the fee scales with the bulk multiplier', () => {
        game.itemDetails[CHEESE].alchemyDetail.bulkMultiplier = 10;
        // (10 + 10) × 5 × 10 = 1000 per action; 3000 coins buys 3, and 100 cheese at
        // 10 per action would otherwise allow 10
        const inventory = [stack(CHEESE, 100), stack(COIN, 3000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 3, limitType: 'gold' });
    });

    test('the material still wins when it is scarcer than the gold', () => {
        const inventory = [stack(CHEESE, 4), stack(COIN, 10_000_000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 4, limitType: `material:${CHEESE}` });
    });

    test('coinify charges no derived fee, so only the item limits it', () => {
        const inventory = [stack(CHEESE, 7), stack(COIN, 0)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/coinify', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE) }
        );

        expect(limit).toEqual({ maxActions: 7, limitType: `material:${CHEESE}` });
    });

    test('an enhanced stack only counts at its own enhancement level', () => {
        const inventory = [stack(CHEESE, 6, 3), stack(CHEESE, 99, 0), stack(COIN, 10_000_000)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/alchemy/decompose', type: '/action_types/alchemy', coinCost: 0 },
            inventory,
            0,
            { primaryItemHash: hashFor(CHEESE, 3) }
        );

        expect(limit).toEqual({ maxActions: 6, limitType: `material:${CHEESE}` });
    });
});

describe('calculateMaterialLimit — non-alchemy actions', () => {
    test('a real coinCost on a production action is still honoured', () => {
        const inventory = [stack(COIN, 250)];

        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/enhancing/enhance', type: '/action_types/enhancing', coinCost: 100 },
            inventory,
            0,
            null
        );

        expect(limit).toEqual({ maxActions: 2, limitType: 'gold' });
    });

    test('an action with no inputs and no cost is unlimited', () => {
        const limit = actionTimeDisplay.calculateMaterialLimit(
            { hrid: '/actions/milking/cow', type: '/action_types/milking', coinCost: 0 },
            [],
            0,
            null
        );

        expect(limit).toBeNull();
    });
});
