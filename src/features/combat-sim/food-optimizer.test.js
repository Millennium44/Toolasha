/**
 * Tests for the cheapest-viable-food solver's pure parts: pool construction,
 * the price decision, and reading survival out of a sim result.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: vi.fn() }));

const { buildConsumablePools, buildFoodSlots, cheapestAtLeast, estimateFoodSimCount, readViability } =
    await import('./food-optimizer.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');

const HOUR_NS = 3600 * 1e9;

const PRICES = {
    '/items/cheese': 100,
    '/items/gourmet_cheese': 1_500,
    '/items/donut': 300,
    '/items/dragon_fruit_yogurt': 900,
    '/items/sword': 5_000,
    '/items/unpriced_cake': 0,
};

function foodGameData() {
    return {
        itemDetailMap: {
            '/items/cheese': {
                name: 'Cheese',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 50, manapointRestore: 0 },
            },
            '/items/gourmet_cheese': {
                name: 'Gourmet Cheese',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 500, manapointRestore: 0, recoveryDuration: 10 },
            },
            '/items/donut': {
                name: 'Donut',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 0, manapointRestore: 60 },
            },
            '/items/dragon_fruit_yogurt': {
                name: 'Dragon Fruit Yogurt',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 200, manapointRestore: 200 },
            },
            '/items/unpriced_cake': {
                name: 'Unpriced Cake',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 400, manapointRestore: 0 },
            },
            '/items/sword': {
                name: 'Sword',
                categoryHrid: '/item_categories/equipment',
                equipmentDetail: {},
            },
            '/items/coffee': {
                name: 'Coffee',
                categoryHrid: '/item_categories/drink',
                consumableDetail: { hitpointRestore: 0, manapointRestore: 0, buffs: [{ uniqueHrid: '/x' }] },
            },
        },
    };
}

beforeEach(() => {
    resolveItemPrice.mockImplementation((hrid) => ({ price: PRICES[hrid] ?? 0 }));
});

describe('buildConsumablePools', () => {
    test('collects HP and MP restore food, sorted by restore amount', () => {
        const pools = buildConsumablePools(foodGameData());

        expect(pools.hp.map((e) => e.hrid)).toEqual([
            '/items/cheese',
            '/items/dragon_fruit_yogurt',
            '/items/gourmet_cheese',
        ]);
        expect(pools.mp.map((e) => e.hrid)).toEqual(['/items/donut', '/items/dragon_fruit_yogurt']);
    });

    test('lists an item that restores both in both pools', () => {
        const pools = buildConsumablePools(foodGameData());
        expect(pools.hp.some((e) => e.hrid === '/items/dragon_fruit_yogurt')).toBe(true);
        expect(pools.mp.some((e) => e.hrid === '/items/dragon_fruit_yogurt')).toBe(true);
    });

    test('skips non-food categories and unpriced items', () => {
        const pools = buildConsumablePools(foodGameData());
        const all = [...pools.hp, ...pools.mp].map((e) => e.hrid);

        expect(all).not.toContain('/items/sword');
        expect(all).not.toContain('/items/coffee');
        // No market price means no way to call it cheap
        expect(all).not.toContain('/items/unpriced_cake');
    });

    test('records price per restored point', () => {
        const pools = buildConsumablePools(foodGameData());
        const cheese = pools.hp.find((e) => e.hrid === '/items/cheese');
        const gourmet = pools.hp.find((e) => e.hrid === '/items/gourmet_cheese');

        expect(cheese.pricePerPoint).toBeCloseTo(2);
        expect(gourmet.pricePerPoint).toBeCloseTo(3);
        expect(gourmet.overTime).toBe(true);
        expect(cheese.overTime).toBe(false);
    });

    test('returns empty pools without game data', () => {
        expect(buildConsumablePools(null)).toEqual({ hp: [], mp: [] });
    });
});

describe('cheapestAtLeast', () => {
    const pool = [
        { hrid: 'a', restore: 50, pricePerPoint: 3 },
        { hrid: 'b', restore: 200, pricePerPoint: 1.5 },
        { hrid: 'c', restore: 500, pricePerPoint: 2 },
    ];

    test('prefers a higher tier that costs less per point', () => {
        expect(cheapestAtLeast(pool, pool[0]).hrid).toBe('b');
    });

    test('never drops below the proven restore amount', () => {
        expect(cheapestAtLeast(pool, pool[2]).hrid).toBe('c');
    });

    test('keeps the reference when nothing beats it', () => {
        expect(cheapestAtLeast([pool[1]], pool[1]).hrid).toBe('b');
    });
});

describe('buildFoodSlots', () => {
    const itemDetailMap = {
        ...foodGameData().itemDetailMap,
        '/items/lucky_coffee_cake': {
            name: 'Lucky Cake',
            categoryHrid: '/item_categories/food',
            consumableDetail: { hitpointRestore: 0, manapointRestore: 0, buffs: [{ uniqueHrid: '/luck' }] },
        },
    };
    const hp = { hrid: '/items/cheese', triggers: null };
    const mp = { hrid: '/items/donut', triggers: null };

    test('always returns exactly three slots', () => {
        expect(buildFoodSlots(hp, mp, [], itemDetailMap)).toHaveLength(3);
        expect(buildFoodSlots(null, null, [], itemDetailMap)).toEqual([null, null, null]);
    });

    test('keeps a buff-only food the player already had', () => {
        const slots = buildFoodSlots(hp, mp, [{ hrid: '/items/lucky_coffee_cake' }], itemDetailMap);
        expect(slots.map((s) => s?.hrid)).toEqual(['/items/cheese', '/items/donut', '/items/lucky_coffee_cake']);
    });

    test('replaces the restore food the player had', () => {
        const slots = buildFoodSlots(hp, null, [{ hrid: '/items/gourmet_cheese' }], itemDetailMap);
        expect(slots).toEqual([{ hrid: '/items/cheese', triggers: null }, null, null]);
    });

    test('uses one slot when a single item covers both roles', () => {
        const both = { hrid: '/items/dragon_fruit_yogurt', triggers: null };
        const slots = buildFoodSlots(both, both, [], itemDetailMap);
        expect(slots.filter(Boolean)).toHaveLength(1);
    });
});

describe('readViability', () => {
    test('converts deaths to a per-hour rate over the simulated time', () => {
        const result = readViability(
            { simulatedTime: 2 * HOUR_NS, deaths: { player1: 5 }, playerRanOutOfManaTime: {} },
            'player1'
        );
        expect(result.deathsPerHour).toBeCloseTo(2.5);
        expect(result.oomFraction).toBe(0);
    });

    test('reports the out-of-mana share of the run', () => {
        const result = readViability(
            {
                simulatedTime: 10 * HOUR_NS,
                deaths: {},
                playerRanOutOfManaTime: {
                    player1: { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: HOUR_NS },
                },
            },
            'player1'
        );
        expect(result.oomFraction).toBeCloseTo(0.1);
    });

    test('counts an out-of-mana window still open at the end of the run', () => {
        const result = readViability(
            {
                simulatedTime: 10 * HOUR_NS,
                deaths: {},
                playerRanOutOfManaTime: {
                    player1: {
                        isOutOfMana: true,
                        startTimeForOutOfMana: 8 * HOUR_NS,
                        totalTimeForOutOfMana: HOUR_NS,
                    },
                },
            },
            'player1'
        );
        // 1h closed + 2h still open = 3h of 10
        expect(result.oomFraction).toBeCloseTo(0.3);
    });

    test('survives an empty sim result', () => {
        expect(readViability({}, 'player1')).toEqual({ deathsPerHour: 0, oomFraction: 0 });
    });
});

describe('estimateFoodSimCount', () => {
    test('scales with the binary searches it will run', () => {
        // 3 HP entries and 2 MP entries → 2 probes + 2 + 1 + 2 + 1
        expect(estimateFoodSimCount(foodGameData())).toBe(8);
    });

    test('counts only the fixed probes when there is nothing to search', () => {
        expect(estimateFoodSimCount({ itemDetailMap: {} })).toBe(4);
    });
});
