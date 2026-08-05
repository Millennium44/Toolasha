/**
 * Tests for House Cost Calculator Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, prices: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
    },
}));

vi.mock('../api/marketplace.js', () => ({
    default: {
        getPrice: (itemHrid) => state.prices[itemHrid] ?? null,
    },
}));

const { calculateHouseBuildCost, calculateBattleHousesCost } = await import('./house-cost-calculator.js');

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
        state.prices = { '/items/plank': { ask: null, bid: 9 } };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 9);
    });

    test('an ask with no bid behind it is still the ask', () => {
        state.prices = { '/items/plank': { ask: 15, bid: null } };
        expect(calculateHouseBuildCost('/house_rooms/library', 1)).toBe(5 * 15);
    });

    test('skips items with no price data at all', () => {
        state.prices = {};
        const cost = calculateHouseBuildCost('/house_rooms/library', 1);
        expect(cost).toBe(0);
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
