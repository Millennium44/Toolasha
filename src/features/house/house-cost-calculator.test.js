import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initData: null,
    inventory: [],
    prices: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getHouseRoomLevel: () => 3,
        getInitClientData: () => game.initData,
        getInventory: () => game.inventory,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: vi.fn() },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid) => game.prices[itemHrid] ?? null,
}));

const houseCostCalculator = (await import('./house-cost-calculator.js')).default;

describe('house cost calculator', () => {
    beforeEach(() => {
        game.prices = {};
        game.inventory = [];
        game.initData = {
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
        game.prices = { '/items/plank': 10 };
    });

    test('calculateLevelCost separates coins from priced materials', async () => {
        const cost = await houseCostCalculator.calculateLevelCost('/house_rooms/brewery', 4);

        expect(cost.coins).toBe(1000);
        expect(cost.materials).toEqual([
            { itemHrid: '/items/plank', count: 20, marketPrice: 10, totalValue: 200 },
        ]);
        expect(cost.totalValue).toBe(1200);
    });

    test('a missing market price falls back to the vendor sell price', async () => {
        game.prices = {};
        const cost = await houseCostCalculator.calculateLevelCost('/house_rooms/brewery', 4);

        expect(cost.materials[0].marketPrice).toBe(5);
        expect(cost.materials[0].totalValue).toBe(100);
    });

    test('calculateLevelCost throws for an unknown room', async () => {
        await expect(houseCostCalculator.calculateLevelCost('/house_rooms/nope', 4)).rejects.toThrow(
            'House room not found'
        );
    });

    test('calculateLevelCost throws for a level with no defined cost', async () => {
        await expect(houseCostCalculator.calculateLevelCost('/house_rooms/brewery', 9)).rejects.toThrow(
            'No upgrade costs for level 9'
        );
    });

    test('calculateCumulativeCost sums coins and merges material quantities across levels', async () => {
        const cost = await houseCostCalculator.calculateCumulativeCost('/house_rooms/brewery', 3, 5);

        expect(cost.coins).toBe(3000);
        expect(cost.materials).toEqual([
            { itemHrid: '/items/plank', count: 60, marketPrice: 10, totalValue: 600 },
        ]);
        expect(cost.totalValue).toBe(3600);
    });

    test('calculateCumulativeCost rejects a target at or below the current level', async () => {
        await expect(houseCostCalculator.calculateCumulativeCost('/house_rooms/brewery', 5, 5)).rejects.toThrow(
            'Target level must be greater than current level'
        );
    });

    test('calculateCumulativeCost rejects a target above the level cap', async () => {
        await expect(houseCostCalculator.calculateCumulativeCost('/house_rooms/brewery', 3, 9)).rejects.toThrow(
            'Maximum house level is 8'
        );
    });

    test('getInventoryCount only counts unenhanced items sitting in the inventory', () => {
        game.inventory = [
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/inventory', count: 20, enhancementLevel: 0 },
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/head', count: 5, enhancementLevel: 0 },
        ];

        expect(houseCostCalculator.getInventoryCount('/items/plank')).toBe(20);
    });

    test('getInventoryCount ignores an enhanced stack', () => {
        game.inventory = [
            { itemHrid: '/items/plank', itemLocationHrid: '/item_locations/inventory', count: 20, enhancementLevel: 3 },
        ];

        expect(houseCostCalculator.getInventoryCount('/items/plank')).toBe(0);
    });

    test('getInventoryCount is zero for an item not held', () => {
        expect(houseCostCalculator.getInventoryCount('/items/nothing')).toBe(0);
    });

    test('getItemName special-cases coin and falls back for unknown items', () => {
        expect(houseCostCalculator.getItemName('/items/coin')).toBe('Gold');
        expect(houseCostCalculator.getItemName('/items/plank')).toBe('Plank');
        expect(houseCostCalculator.getItemName('/items/nope')).toBe('Unknown Item');
    });

    test('getRoomName falls back for an unknown room', () => {
        expect(houseCostCalculator.getRoomName('/house_rooms/brewery')).toBe('Brewery');
        expect(houseCostCalculator.getRoomName('/house_rooms/nope')).toBe('Unknown Room');
    });
});
