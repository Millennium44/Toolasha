/**
 * Tests for reading labyrinth supplies and clamping plans to them.
 *
 * All pure: fixture inventories in, counts and shortfall wording out. The
 * reason this logic lives apart from the panel is exactly so it can be checked
 * without a game — the bug it exists to prevent (a plan calling for thirteen
 * shrouds against two owned) is arithmetic, not rendering.
 */

import { describe, test, expect } from 'vitest';

import {
    SUPPLY_HRIDS,
    resolveSupplyHrids,
    readSupplyCounts,
    bestOwnedTier,
    clampToOwned,
    describeSupplyNeed,
    estimateRestockCost,
} from './labyrinth-supplies.js';

const inInventory = (itemHrid, count) => ({
    itemHrid,
    count,
    enhancementLevel: 0,
    itemLocationHrid: '/item_locations/inventory',
});

/** The user's reported floor: plenty of torches, three beacons, two shrouds */
const reportedBag = [
    inInventory('/items/expert_torch', 43),
    inInventory('/items/expert_shroud', 2),
    inInventory('/items/advanced_beacon', 3),
    inInventory('/items/cheese', 900),
];

describe('reading what is in the bag', () => {
    test('sums a kind across its tiers', () => {
        const counts = readSupplyCounts([
            inInventory('/items/basic_torch', 5),
            inInventory('/items/advanced_torch', 7),
            inInventory('/items/expert_torch', 1),
        ]);
        expect(counts.torch).toBe(13);
        expect(counts.byTier.torch['/items/advanced_torch']).toBe(7);
    });

    test('ignores anything that is not sitting in the inventory', () => {
        const counts = readSupplyCounts([
            inInventory('/items/expert_shroud', 2),
            { itemHrid: '/items/expert_shroud', count: 40, itemLocationHrid: '/item_locations/market_listing' },
        ]);
        expect(counts.shroud).toBe(2);
    });

    test('no inventory at all is unknown, which is not the same as owning none', () => {
        const counts = readSupplyCounts(null);
        expect(counts.known).toBe(false);
        expect(counts.shroud).toBe(0);
    });

    test('reads the reported floor as 43 torches, 2 shrouds, 3 beacons', () => {
        const counts = readSupplyCounts(reportedBag);
        expect(counts).toMatchObject({ torch: 43, shroud: 2, beacon: 3, known: true });
    });

    test('names the best tier held, not the first one listed', () => {
        const counts = readSupplyCounts([
            inInventory('/items/basic_beacon', 9),
            inInventory('/items/advanced_beacon', 1),
        ]);
        expect(bestOwnedTier(counts, 'beacon')).toBe('/items/advanced_beacon');
        expect(bestOwnedTier(counts, 'shroud')).toBeNull();
    });
});

describe('finding the supply items in the game data', () => {
    test('prefers what the live item map calls them', () => {
        const hrids = resolveSupplyHrids({
            '/items/basic_torch': {},
            '/items/expert_torch': {},
            '/items/cheese': {},
        });
        expect(hrids.torch).toEqual(['/items/basic_torch', '/items/expert_torch']);
    });

    test('orders tiers worst-first however the map is ordered', () => {
        const hrids = resolveSupplyHrids({
            '/items/expert_shroud': {},
            '/items/basic_shroud': {},
            '/items/advanced_shroud': {},
        });
        expect(hrids.shroud).toEqual(['/items/basic_shroud', '/items/advanced_shroud', '/items/expert_shroud']);
    });

    test('falls back to the canonical list for a kind the map does not have', () => {
        const hrids = resolveSupplyHrids({ '/items/basic_torch': {} });
        expect(hrids.beacon).toEqual(SUPPLY_HRIDS.beacon);
    });

    test('no game data at all still yields a usable set of keys', () => {
        expect(resolveSupplyHrids(null)).toEqual(SUPPLY_HRIDS);
    });
});

describe('clamping a plan to what is held', () => {
    test('four beacons set against three owned plans three, and says so', () => {
        expect(clampToOwned(4, 3)).toEqual({
            effective: 3,
            requested: 4,
            owned: 3,
            short: 1,
            clamped: true,
        });
    });

    test('a request inside the budget is left alone and not flagged', () => {
        expect(clampToOwned(2, 3)).toMatchObject({ effective: 2, short: 0, clamped: false });
    });

    test('an unreadable inventory does not clamp — it would invent a limit', () => {
        expect(clampToOwned(4, 0, false)).toMatchObject({ effective: 4, short: 0, clamped: false });
    });
});

describe('saying what is missing', () => {
    test('a plan you can afford says nothing about owning things', () => {
        expect(describeSupplyNeed(2, 2, 'shroud')).toEqual({ text: '2 shrouds', short: 0, over: false });
    });

    test('the reported case reads as needed-versus-owned', () => {
        expect(describeSupplyNeed(13, 2, 'shroud')).toEqual({
            text: '13 shrouds needed · 2 owned',
            short: 11,
            over: true,
        });
    });

    test('one of a thing is not one things', () => {
        expect(describeSupplyNeed(1, 5, 'shroud').text).toBe('1 shroud');
    });

    test('an unreadable inventory reports the need without a verdict on it', () => {
        expect(describeSupplyNeed(13, 0, 'shroud', false)).toEqual({ text: '13 shrouds', short: 0, over: false });
    });
});

describe('what the missing ones would cost', () => {
    const market = (prices) => ({ isLoaded: () => true, getPrice: (hrid) => prices[hrid] || null });

    test('quotes the cheapest tier that has a price', () => {
        const cost = estimateRestockCost(11, SUPPLY_HRIDS.shroud, market({ '/items/basic_shroud': { ask: 1000 } }));
        expect(cost).toEqual({ total: 11000, unit: 1000, itemHrid: '/items/basic_shroud' });
    });

    test('skips a tier with no price rather than reporting nothing', () => {
        const cost = estimateRestockCost(
            2,
            SUPPLY_HRIDS.beacon,
            market({ '/items/basic_beacon': { ask: null }, '/items/advanced_beacon': { ask: 50 } })
        );
        expect(cost).toMatchObject({ itemHrid: '/items/advanced_beacon', total: 100 });
    });

    test('says nothing when nothing is missing, or when the market is not loaded', () => {
        expect(estimateRestockCost(0, SUPPLY_HRIDS.shroud, market({ '/items/basic_shroud': { ask: 5 } }))).toBeNull();
        expect(estimateRestockCost(3, SUPPLY_HRIDS.shroud, { isLoaded: () => false })).toBeNull();
    });
});
