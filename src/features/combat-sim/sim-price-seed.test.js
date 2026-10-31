/**
 * The helper that takes a run's price quotes up front (#651 T01): which cache keys it asks the adapter to fill,
 * for which sale taxes, and which consumables.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./combat-sim-adapter.js', () => ({ seedSimPriceCache: vi.fn((cache) => cache) }));

const { seedSimPriceCache } = await import('./combat-sim-adapter.js');
const { seedRunPriceCache, consumableHridsOf } = await import('./sim-price-seed.js');

beforeEach(() => {
    seedSimPriceCache.mockClear();
});

describe('consumableHridsOf', () => {
    test('collects every food and drink of every player once, skipping empty slots', () => {
        const players = [
            { food: [{ hrid: '/items/donut' }, null], drinks: [{ hrid: '/items/coffee' }, { hrid: '/items/coffee' }] },
            { food: [{ hrid: '/items/donut' }], drinks: [null, { hrid: '/items/tea' }] },
            null,
            {},
        ];
        expect(consumableHridsOf(players).sort()).toEqual(['/items/coffee', '/items/donut', '/items/tea']);
        expect(consumableHridsOf([])).toEqual([]);
        expect(consumableHridsOf(undefined)).toEqual([]);
    });
});

describe('seedRunPriceCache', () => {
    const gameData = { itemDetailMap: {} };

    test("asks for the live character's drop keys when no sale tax map is given", () => {
        const cache = new Map();
        const returned = seedRunPriceCache(cache, gameData, {
            zoneHrid: '/actions/combat/fly',
            playerDTOs: [{ drinks: [{ hrid: '/items/coffee' }] }],
            extraHrids: ['/items/super_coffee'],
        });

        expect(returned).toBe(cache);
        expect(seedSimPriceCache).toHaveBeenCalledTimes(1);
        const [, data, options] = seedSimPriceCache.mock.calls[0];
        expect(data).toBe(gameData);
        expect('saleTaxRate' in options).toBe(false);
        expect(options.consumableHrids).toEqual(['/items/coffee', '/items/super_coffee']);
    });

    test('seeds each distinct sale tax once: the live tax, an Iron Cow at 0, a taxed teammate', () => {
        seedRunPriceCache(new Map(), gameData, {
            zoneHrid: '/z',
            playerDTOs: [],
            saleTaxRates: { me: null, cow: 0, mate: 0.02, mate2: 0.02 },
        });

        const rates = seedSimPriceCache.mock.calls.map(([, , options]) => options.saleTaxRate ?? null);
        expect(rates.sort()).toEqual([0, 0.02, null].sort());
    });

    test('does nothing for a missing zone or a cache that is not a Map', () => {
        const notMap = {};
        expect(seedRunPriceCache(notMap, gameData, { zoneHrid: '/z' })).toBe(notMap);
        seedRunPriceCache(new Map(), gameData, {});
        expect(seedSimPriceCache).not.toHaveBeenCalled();
    });
});
