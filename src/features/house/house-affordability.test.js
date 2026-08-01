import { describe, test, expect, vi } from 'vitest';

const roomDetails = {
    '/house_rooms/dojo': { name: 'Dojo' },
    '/house_rooms/gym': { name: 'Gym' },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ houseRoomDetailMap: roomDetails }),
        getCombinedData: () => ({}),
    },
}));

// Cumulative cost to reach a level: 100 per level for the dojo, 1000 for the gym
vi.mock('../../utils/house-cost-calculator.js', () => ({
    calculateHouseBuildCost: (hrid, level) => (hrid === '/house_rooms/dojo' ? 100 : 1000) * level,
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: () => {} }));
vi.mock('../../utils/formatters.js', () => ({ formatLargeNumber: (n) => String(n) }));

const { nextLevelCost, affordableUpgrades } = await import('./house-affordability.js');

describe('nextLevelCost', () => {
    test('is the difference between two cumulative totals, not a cumulative total', () => {
        // The calculator returns the cost of getting to a level from nothing;
        // charging that for one upgrade would overstate it several times over
        expect(nextLevelCost('/house_rooms/dojo', 3)).toBe(100);
    });

    test('a maxed room has nothing left to buy', () => {
        expect(nextLevelCost('/house_rooms/dojo', 8)).toBe(0);
        expect(nextLevelCost('/house_rooms/dojo', 9)).toBe(0);
    });

    test('an unpriceable upgrade counts as nothing rather than negative', () => {
        expect(nextLevelCost('/house_rooms/unknown', 0)).toBeGreaterThanOrEqual(0);
    });
});

describe('affordableUpgrades', () => {
    const rooms = { '/house_rooms/dojo': { level: 3 }, '/house_rooms/gym': { level: 2 } };

    test('counts each upgrade against your coins on its own', () => {
        // Dojo's next level is 100, the gym's is 1000
        expect(affordableUpgrades(rooms, 500)).toMatchObject({ affordable: 1, total: 2 });
        expect(affordableUpgrades(rooms, 5000)).toMatchObject({ affordable: 2, total: 2 });
        expect(affordableUpgrades(rooms, 50)).toMatchObject({ affordable: 0, total: 2 });
    });

    test('names the cheapest upgrade', () => {
        expect(affordableUpgrades(rooms, 0).cheapest).toEqual({ name: 'Dojo', cost: 100 });
    });

    test('maxed rooms are not counted as upgrades you declined', () => {
        const maxed = { '/house_rooms/dojo': { level: 8 }, '/house_rooms/gym': { level: 2 } };
        expect(affordableUpgrades(maxed, 0).total).toBe(1);
    });

    test('a room at level zero still has a next level', () => {
        expect(affordableUpgrades({ '/house_rooms/dojo': { level: 0 } }, 100).affordable).toBe(1);
    });

    test('survives no house data', () => {
        expect(affordableUpgrades(null, 100)).toEqual({ affordable: 0, total: 0, cheapest: null });
    });
});
