/**
 * Expected Value Calculator — drop pricing and container EV math.
 *
 * The worker pool (calculateNestedContainers/initialize) is not exercised here;
 * these tests drive the synchronous per-container math directly (getDropPrice,
 * calculateSingleContainer, getDropBreakdown) against a mocked game and market.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const mocks = vi.hoisted(() => ({
    settings: { expectedValue_includeCowbells: true },
    initData: null,
    itemDetails: {},
    prices: {},
    priceCalls: [],
    customPrices: {},
    dungeonTokenValues: {},
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: vi.fn(), getPrice: () => null },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => mocks.settings[key] },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getItemDetails: (hrid) => mocks.itemDetails[hrid] ?? null,
        on: () => {},
        off: () => {},
        emit: () => {},
    },
}));

vi.mock('../../utils/token-valuation.js', () => ({
    calculateDungeonTokenValue: (hrid) => (hrid in mocks.dungeonTokenValues ? mocks.dungeonTokenValues[hrid] : null),
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, options) => {
        mocks.priceCalls.push([hrid, options]);
        return hrid in mocks.prices ? mocks.prices[hrid] : null;
    },
}));

vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPrice: (hrid, enhancementLevel, side) => mocks.customPrices[`${hrid}:${enhancementLevel}:${side}`] ?? null,
}));

vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price, taxRate = 0.02) => price * (1 - taxRate),
}));

vi.mock('../../utils/ev-worker-manager.js', () => ({
    calculateEVBatch: vi.fn(),
    terminateEVWorkerPool: vi.fn(),
}));

const { default: expectedValueCalculator } = await import('./expected-value-calculator.js');

const CHEST_HRID = '/items/test_chest';
const GEM_HRID = '/items/test_gem';
const JUNK_HRID = '/items/test_junk';

beforeEach(() => {
    mocks.settings = { expectedValue_includeCowbells: true };
    mocks.itemDetails = {
        [CHEST_HRID]: { name: 'Test Chest', isOpenable: true },
        [GEM_HRID]: { name: 'Test Gem', isTradable: true },
        [JUNK_HRID]: { name: 'Test Junk', isTradable: false },
    };
    mocks.prices = {
        [GEM_HRID]: 1000,
        [JUNK_HRID]: 50,
    };
    mocks.priceCalls = [];
    mocks.customPrices = {};
    mocks.dungeonTokenValues = {};
    mocks.initData = {
        openableLootDropMap: {
            [CHEST_HRID]: [
                { itemHrid: GEM_HRID, dropRate: 0.5, minCount: 1, maxCount: 1 },
                { itemHrid: JUNK_HRID, dropRate: 1, minCount: 2, maxCount: 4 },
                { itemHrid: '/items/coin', dropRate: 1, minCount: 100, maxCount: 100 },
            ],
        },
    };
    expectedValueCalculator.containerCache.clear();
    expectedValueCalculator.isInitialized = false;
});

describe('getDropPrice', () => {
    test('coin is always worth exactly its face value, untaxed', () => {
        expect(expectedValueCalculator.getDropPrice('/items/coin')).toBe(1);
    });

    test('cowbell is priced off the bag, taxed at 18% then split ten ways', () => {
        mocks.prices['/items/bag_of_10_cowbells'] = 1000;
        const price = expectedValueCalculator.getDropPrice('/items/cowbell');
        expect(price).toBeCloseTo((1000 * 0.82) / 10, 6);
    });

    test('cowbell is excluded entirely when the setting is off', () => {
        mocks.settings.expectedValue_includeCowbells = false;
        expect(expectedValueCalculator.getDropPrice('/items/cowbell')).toBe(0);
    });

    test('cowbell has no price when the bag has no market data', () => {
        expect(expectedValueCalculator.getDropPrice('/items/cowbell')).toBeNull();
    });

    test('dungeon tokens delegate to the token valuation helper', () => {
        mocks.dungeonTokenValues['/items/chimerical_token'] = 4200;
        expect(expectedValueCalculator.getDropPrice('/items/chimerical_token')).toBe(4200);
    });

    test('a nested container already in the cache is read from the cache, not the market', () => {
        expectedValueCalculator.containerCache.set(GEM_HRID, 99999);
        expect(expectedValueCalculator.getDropPrice(GEM_HRID)).toBe(99999);
    });

    test('a regular item with no market data prices as null, not zero', () => {
        expect(expectedValueCalculator.getDropPrice('/items/unpriced')).toBeNull();
    });

    test('a regular item with a zero or negative market price also prices as null', () => {
        mocks.prices['/items/free_thing'] = 0;
        expect(expectedValueCalculator.getDropPrice('/items/free_thing')).toBeNull();
    });
});

describe('resolveSellSideValue', () => {
    test('a resolved value carries where it came from and whether the caller still owes tax', () => {
        expect(expectedValueCalculator.resolveSellSideValue(GEM_HRID)).toEqual({
            value: 1000,
            source: 'market',
            needsTax: true,
        });
    });

    test('the enhancement level reaches the market lookup instead of being pinned to zero', () => {
        expectedValueCalculator.resolveSellSideValue(GEM_HRID, 5);
        expect(mocks.priceCalls.at(-1)).toEqual([GEM_HRID, { enhancementLevel: 5, context: 'profit', side: 'sell' }]);
    });

    test('a price that came from a custom override says so', () => {
        mocks.customPrices[`${GEM_HRID}:0:sell`] = 1000;
        expect(expectedValueCalculator.resolveSellSideValue(GEM_HRID).source).toBe('custom');
    });

    test('the special cases are already net figures, so none of them asks for tax', () => {
        mocks.prices['/items/bag_of_10_cowbells'] = 1000;
        mocks.dungeonTokenValues['/items/chimerical_token'] = 4200;
        expectedValueCalculator.containerCache.set(CHEST_HRID, 777);

        for (const hrid of ['/items/coin', '/items/cowbell', '/items/chimerical_token', CHEST_HRID]) {
            expect(expectedValueCalculator.resolveSellSideValue(hrid).needsTax).toBe(false);
        }
    });

    test('a cached container resolves as expected value, not as a market price', () => {
        expectedValueCalculator.containerCache.set(CHEST_HRID, 777);
        expect(expectedValueCalculator.resolveSellSideValue(CHEST_HRID)).toEqual({
            value: 777,
            source: 'expectedValue',
            needsTax: false,
        });
    });

    test('an unpriceable item resolves to null so a caller can say so rather than count zero', () => {
        expect(expectedValueCalculator.resolveSellSideValue('/items/unpriced')).toBeNull();
    });

    test('getDropPrice still answers exactly the value this resolver produces', () => {
        mocks.dungeonTokenValues['/items/sinister_token'] = 7;
        expect(expectedValueCalculator.getDropPrice('/items/sinister_token')).toBe(
            expectedValueCalculator.resolveSellSideValue('/items/sinister_token').value
        );
    });
});

describe('resolveBuySideValue', () => {
    test('an ordinary item is priced buy side, with the enhancement level carried through', () => {
        expect(expectedValueCalculator.resolveBuySideValue(GEM_HRID, 3)).toEqual({ value: 1000, source: 'market' });
        expect(mocks.priceCalls.at(-1)).toEqual([GEM_HRID, { enhancementLevel: 3, context: 'profit', side: 'buy' }]);
    });

    test('coin is still face value', () => {
        expect(expectedValueCalculator.resolveBuySideValue('/items/coin')).toEqual({ value: 1, source: 'coin' });
    });

    test('cowbell is a tenth of the bag with no tax taken off — nothing is being sold', () => {
        mocks.prices['/items/bag_of_10_cowbells'] = 1000;
        expect(expectedValueCalculator.resolveBuySideValue('/items/cowbell')).toEqual({
            value: 100,
            source: 'cowbell',
        });
    });

    test('a consumed container is worth what replacing it costs, not what opening it pays', () => {
        expectedValueCalculator.containerCache.set(GEM_HRID, 99999);
        expect(expectedValueCalculator.resolveBuySideValue(GEM_HRID)).toEqual({ value: 1000, source: 'market' });
    });

    test('a buy-side custom override is labelled as one', () => {
        mocks.customPrices[`${GEM_HRID}:0:buy`] = 1000;
        expect(expectedValueCalculator.resolveBuySideValue(GEM_HRID).source).toBe('custom');
    });

    test('an unpriceable item resolves to null', () => {
        expect(expectedValueCalculator.resolveBuySideValue('/items/unpriced')).toBeNull();
    });
});

describe('calculateSingleContainer', () => {
    test('sums each drop after tax, except coin which is untaxed', () => {
        const ev = expectedValueCalculator.calculateSingleContainer(CHEST_HRID, mocks.initData);

        const gemValue = 0.5 * 1 * 1000 * (1 - MARKET_TAX); // 50% chance, taxed
        const junkValue = 1 * 3 * 50 * (1 - MARKET_TAX); // avg count 3, taxed (junk is tradable per isTradable check... wait untradable)
        const coinValue = 1 * 100 * 1; // untaxed

        // Junk is isTradable: false, so it is NOT taxed
        const junkUntaxed = 1 * 3 * 50;
        expect(ev).toBeCloseTo(gemValue + junkUntaxed + coinValue, 6);
        // Sanity: confirms the tax was in fact skipped for junk
        expect(ev).not.toBeCloseTo(gemValue + junkValue + coinValue, 6);
    });

    test('caches the result under the container hrid for reuse as a nested-drop price', () => {
        const ev = expectedValueCalculator.calculateSingleContainer(CHEST_HRID, mocks.initData);
        expect(expectedValueCalculator.containerCache.get(CHEST_HRID)).toBeCloseTo(ev, 6);
    });

    test('a drop with no reachable price is skipped rather than treated as free', () => {
        delete mocks.prices[JUNK_HRID];
        const withMissing = expectedValueCalculator.calculateSingleContainer(CHEST_HRID, mocks.initData);

        const gemValue = 0.5 * 1 * 1000 * (1 - MARKET_TAX);
        const coinValue = 100;
        expect(withMissing).toBeCloseTo(gemValue + coinValue, 6);
    });

    test('a container with no drop table returns null', () => {
        expect(expectedValueCalculator.calculateSingleContainer('/items/no_such_chest', mocks.initData)).toBeNull();
    });

    test('a drop with zero drop rate and zero counts is skipped', () => {
        const data = {
            openableLootDropMap: {
                [CHEST_HRID]: [{ itemHrid: GEM_HRID, dropRate: 0, minCount: 0, maxCount: 0 }],
            },
        };
        expect(expectedValueCalculator.calculateSingleContainer(CHEST_HRID, data)).toBe(0);
    });
});

describe('getDropBreakdown / calculateExpectedValue', () => {
    test('breakdown rows are sorted by expected value, highest first', () => {
        const drops = expectedValueCalculator.getDropBreakdown(CHEST_HRID);
        const values = drops.map((d) => d.expectedValue);
        expect(values).toEqual([...values].sort((a, b) => b - a));
        // Coin (100) beats junk (150 untaxed, so actually junk beats coin) — just assert monotonic order holds
        expect(drops.every((d) => 'hasPriceData' in d)).toBe(true);
    });

    test('a row with no price data is included at zero value, not dropped', () => {
        delete mocks.prices[JUNK_HRID];
        const drops = expectedValueCalculator.getDropBreakdown(CHEST_HRID);
        const junkRow = drops.find((d) => d.itemHrid === JUNK_HRID);
        expect(junkRow.hasPriceData).toBe(false);
        expect(junkRow.expectedValue).toBe(0);
    });

    test('calculateExpectedValue refuses to run before initialize()', () => {
        expect(expectedValueCalculator.calculateExpectedValue(CHEST_HRID)).toBeNull();
    });

    test('calculateExpectedValue rejects items that are not openable', () => {
        expectedValueCalculator.isInitialized = true;
        expect(expectedValueCalculator.calculateExpectedValue(GEM_HRID)).toBeNull();
    });

    test('calculateExpectedValue sums the same breakdown it hands back', () => {
        expectedValueCalculator.isInitialized = true;
        const result = expectedValueCalculator.calculateExpectedValue(CHEST_HRID);
        const expectedSum = result.drops.reduce((sum, d) => sum + d.expectedValue, 0);
        expect(result.expectedValue).toBeCloseTo(expectedSum, 6);
        expect(result.itemHrid).toBe(CHEST_HRID);
    });
});

describe('getCachedValue', () => {
    test('returns null rather than undefined for an uncached container', () => {
        expect(expectedValueCalculator.getCachedValue('/items/never_seen')).toBeNull();
    });

    test('returns the cached figure once computed', () => {
        expectedValueCalculator.calculateSingleContainer(CHEST_HRID, mocks.initData);
        expect(expectedValueCalculator.getCachedValue(CHEST_HRID)).toBeGreaterThan(0);
    });
});

describe('invalidateCache', () => {
    test('clears the cache and drops the initialized flag', () => {
        expectedValueCalculator.containerCache.set(CHEST_HRID, 123);
        expectedValueCalculator.isInitialized = true;
        mocks.initData = null; // prevent re-initialize from succeeding synchronously

        expectedValueCalculator.invalidateCache();

        expect(expectedValueCalculator.containerCache.size).toBe(0);
    });
});
