/**
 * Tests for the House Cost Calculator
 *
 * Two suites with two fixtures, because they were once two calculators — the
 * totals half (build-to-level, battle houses) and the breakdown half
 * (per-level materials, formerly `features/house/house-cost-calculator.js`).
 * They now share one pricing chain: ask, then bid, then vendor sell price.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, prices: {}, inventory: [] }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getHouseRoomLevel: () => 3,
        getInventory: () => state.inventory,
    },
}));

vi.mock('../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: vi.fn() },
}));

// The pricing chain reads through getItemPrice, mode by mode. `prices` maps
// itemHrid -> {ask, bid}; a missing side or item answers null, like the real one.
vi.mock('./market-data.js', () => ({
    getItemPrice: (itemHrid, { mode } = {}) => state.prices[itemHrid]?.[mode] ?? null,
}));

const {
    calculateHouseBuildCost,
    calculateBattleHousesCost,
    calculateLevelCost,
    calculateCumulativeCost,
    getInventoryCount,
    getItemName,
    getRoomName,
} = await import('./house-cost-calculator.js');

const houseRoomDetailMap = {
    '/house_rooms/dojo': {
        name: 'Dojo',
        upgradeCostsMap: {
            1: [{ itemHrid: '/items/coin', count: 100 }],
            2: [{ itemHrid: '/items/plank', count: 10 }],
            3: [{ itemHrid: '/items/plank', count: 20 }],
        },
    },
    '/house_rooms/library': {
        name: 'Library',
        upgradeCostsMap: {
            1: [{ itemHrid: '/items/plank', count: 5 }],
        },
    },
};

describe('calculateHouseBuildCost', () => {
    beforeEach(() => {
        state.gameData = { houseRoomDetailMap };
        state.prices = { '/items/plank': { ask: 12, bid: 8 } };
    });

    test('returns 0 without game data', () => {
        state.gameData = null;
        expect(calculateHouseBuildCost('/house_rooms/dojo', 3)).toBe(0);
    });

    test('returns 0 for an unknown house room', () => {
        expect(calculateHouseBuildCost('/house_rooms/nonexistent', 3)).toBe(0);
    });

    test('sums costs across all levels up to currentLevel, coins at face value', () => {
        // level1: 100 coins = 100
        // level2: 10 plank * ask 12 = 120
        // level3: 20 plank * 12 = 240
        const cost = calculateHouseBuildCost('/house_rooms/dojo', 3);
        expect(cost).toBe(100 + 120 + 240);
    });

    test('prices materials at the ask, which is what buying them costs', () => {
        // Not the midpoint. The advisor and the equipment savings row already
        // quoted the ask, so the same room was worth two different figures
        // depending on which panel was asked
        state.prices = { '/items/plank': { ask: 12, bid: 8 } };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 12);
    });

    test('only counts levels up to and including currentLevel', () => {
        const cost = calculateHouseBuildCost('/house_rooms/dojo', 1);
        expect(cost).toBe(100);
    });

    test('uses the one side the book has when there is no ask', () => {
        // A material nobody is selling is still a material the room needs;
        // leaving it out would understate the room by exactly that material
        state.prices = { '/items/plank': { bid: 9 } };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 9);
    });

    test('an ask with no bid behind it is still the ask', () => {
        state.prices = { '/items/plank': { ask: 15 } };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 15);
    });

    test('skips items with no price data at all', () => {
        state.prices = {};
        const cost = calculateHouseBuildCost('/house_rooms/library', 1);
        expect(cost).toBe(0);
    });

    test('falls back to the vendor sell price when the market has no answer', () => {
        // The breakdown half always did this; the totals half used to say 0.
        // Same question, so the same floor
        state.prices = {};
        state.gameData = {
            houseRoomDetailMap,
            itemDetailMap: { '/items/plank': { name: 'Plank', sellPrice: 3 } },
        };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 3);
    });
});

describe('calculateBattleHousesCost', () => {
    beforeEach(() => {
        state.gameData = { houseRoomDetailMap };
        state.prices = { '/items/plank': { ask: 10, bid: 10 } };
    });

    test('only includes recognized battle houses, sorted by cost descending', () => {
        const characterHouseRooms = {
            '/house_rooms/dojo': { level: 2 },
            '/house_rooms/library': { level: 1 },
            '/house_rooms/kitchen': { level: 5 }, // not a battle house
        };
        const result = calculateBattleHousesCost(characterHouseRooms);

        expect(result.breakdown.map((b) => b.name)).toEqual(['Dojo', 'Library']);
        expect(result.breakdown[0].cost).toBeGreaterThanOrEqual(result.breakdown[1].cost);
        expect(result.totalCost).toBe(result.breakdown.reduce((s, b) => s + b.cost, 0));
    });

    test('skips rooms at level 0', () => {
        const result = calculateBattleHousesCost({ '/house_rooms/dojo': { level: 0 } });
        expect(result.breakdown).toEqual([]);
        expect(result.totalCost).toBe(0);
    });

    test('returns zeroed result when game data is unavailable', () => {
        state.gameData = null;
        const result = calculateBattleHousesCost({ '/house_rooms/dojo': { level: 3 } });
        expect(result).toEqual({ totalCost: 0, breakdown: [] });
    });
});

describe('level cost breakdowns', () => {
    beforeEach(() => {
        state.prices = { '/items/plank': { ask: 10 } };
        state.inventory = [];
        state.gameData = {
            houseRoomDetailMap: {
                '/house_rooms/brewery': {
                    name: 'Brewery',
                    upgradeCostsMap: {
                        4: [
                            { itemHrid: '/items/coin', count: 1000 },
                            { itemHrid: '/items/plank', count: 20 },
                        ],
                        5: [
                            { itemHrid: '/items/coin', count: 2000 },
                            { itemHrid: '/items/plank', count: 40 },
                        ],
                    },
                },
            },
            itemDetailMap: {
                '/items/plank': { name: 'Plank', sellPrice: 5 },
            },
        };
    });

    test('calculateLevelCost separates coins from priced materials', async () => {
        const cost = await calculateLevelCost('/house_rooms/brewery', 4);

        expect(cost.coins).toBe(1000);
        expect(cost.materials).toEqual([{ itemHrid: '/items/plank', count: 20, marketPrice: 10, totalValue: 200 }]);
        expect(cost.totalValue).toBe(1200);
    });

    test('a missing market price falls back to the vendor sell price', async () => {
        state.prices = {};
        const cost = await calculateLevelCost('/house_rooms/brewery', 4);

        expect(cost.materials[0].marketPrice).toBe(5);
        expect(cost.materials[0].totalValue).toBe(100);
    });

    test('a bid is preferred over the vendor price when there is no ask', async () => {
        // The old breakdown calculator jumped straight from ask to vendor; a
        // standing buy order is a live market signal and beats the vendor floor
        state.prices = { '/items/plank': { bid: 8 } };
        const cost = await calculateLevelCost('/house_rooms/brewery', 4);

        expect(cost.materials[0].marketPrice).toBe(8);
    });

    test('calculateLevelCost throws for an unknown room', async () => {
        await expect(calculateLevelCost('/house_rooms/nope', 4)).rejects.toThrow('House room not found');
    });

    test('calculateLevelCost throws for a level with no defined cost', async () => {
        await expect(calculateLevelCost('/house_rooms/brewery', 9)).rejects.toThrow('No upgrade costs for level 9');
    });

    test('calculateCumulativeCost sums coins and merges material quantities across levels', async () => {
        const cost = await calculateCumulativeCost('/house_rooms/brewery', 3, 5);

        expect(cost.coins).toBe(3000);
        expect(cost.materials).toEqual([{ itemHrid: '/items/plank', count: 60, marketPrice: 10, totalValue: 600 }]);
        expect(cost.totalValue).toBe(3600);
    });

    test('calculateCumulativeCost rejects a target at or below the current level', async () => {
        await expect(calculateCumulativeCost('/house_rooms/brewery', 5, 5)).rejects.toThrow(
            'Target level must be greater than current level'
        );
    });

    test('calculateCumulativeCost rejects a target above the level cap', async () => {
        await expect(calculateCumulativeCost('/house_rooms/brewery', 3, 9)).rejects.toThrow('Maximum house level is 8');
    });

    test('getInventoryCount only counts unenhanced items sitting in the inventory', () => {
        state.inventory = [
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/inventory', count: 20, enhancementLevel: 0 },
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/head', count: 5, enhancementLevel: 0 },
        ];

        expect(getInventoryCount('/items/plank')).toBe(20);
    });

    test('getInventoryCount ignores an enhanced stack', () => {
        state.inventory = [
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/inventory', count: 20, enhancementLevel: 3 },
        ];

        expect(getInventoryCount('/items/plank')).toBe(0);
    });

    test('getInventoryCount is zero for an item not held', () => {
        expect(getInventoryCount('/items/nothing')).toBe(0);
    });

    test('getItemName special-cases coin and falls back for unknown items', () => {
        expect(getItemName('/items/coin')).toBe('Gold');
        expect(getItemName('/items/plank')).toBe('Plank');
        expect(getItemName('/items/nope')).toBe('Unknown Item');
    });

    test('getRoomName falls back for an unknown room', () => {
        expect(getRoomName('/house_rooms/brewery')).toBe('Brewery');
        expect(getRoomName('/house_rooms/nope')).toBe('Unknown Room');
    });
});
