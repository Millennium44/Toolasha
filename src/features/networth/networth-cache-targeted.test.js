/**
 * The net-worth enhancement cost cache drops only the costs a price change reached.
 *
 * Driven against the real market API (storage and the network mocked), so the change log, the
 * read recording and the cache's own index are exercised together the way the badge pass and the
 * net-worth calculation use them: a get() miss, the cost computed from getPrice() reads, a set().
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'alice', on: () => {} },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({ enhancingLevel: 120 }) }));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async () => null),
        setJSON: vi.fn(),
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
    },
}));
vi.mock('../../features/market/network-alert.js', () => ({ default: { hide: vi.fn(), show: vi.fn() } }));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({ pricingStamp: () => state.stamp }));

const state = vi.hoisted(() => ({ stamp: 'ask|ask|buy' }));

const marketAPI = (await import('../../api/marketplace.js')).default;
const networthCache = (await import('./networth-cache.js')).default;
const { validateNetworthCache } = await import('./networth-cache-validation.js');

/** The snapshot shape marketplace.json carries: hrid -> level -> {a, b} */
function snapshot() {
    return {
        '/items/holy_sword': { 0: { a: 2_000_000, b: 1_900_000 }, 13: { a: 90_000_000, b: 80_000_000 } },
        '/items/holy_bow': { 0: { a: 1_800_000, b: 1_700_000 } },
        '/items/holy_cheese': { 0: { a: 900, b: 850 } },
        '/items/coin': { 0: { a: 1, b: 1 } },
        '/items/mirror_of_protection': { 0: { a: 9_000_000, b: 8_800_000 } },
        '/items/lumber': { 0: { a: 400, b: 380 } },
    };
}

/**
 * Cache a cost the way the callers do: a miss, then the path reads its prices, then a set.
 * @param {string} itemHrid
 * @param {number} level
 * @param {string[]} inputs - Hrids the path prices (at level 0)
 * @param {number} cost
 */
function cacheCost(itemHrid, level, inputs, cost) {
    expect(networthCache.get(itemHrid, level)).toBeNull();
    marketAPI.getPrice(itemHrid, 0);
    for (const hrid of inputs) marketAPI.getPrice(hrid, 0);
    networthCache.set(itemHrid, level, cost);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
    state.stamp = 'ask|ask|buy';
    marketAPI.pricePatchs = {};
    marketAPI.marketData = null;
    marketAPI.lastFetchTimestamp = null;
    marketAPI._installSnapshot(snapshot(), Math.floor(Date.now() / 1000) - 600);
    networthCache.clear();
    validateNetworthCache();
});

describe('targeted invalidation', () => {
    test('a patch to one input drops only the costs that read it', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese', '/items/coin', '/items/mirror_of_protection'], 500);
        // Two levels of one item, and a third cost of the same base
        cacheCost('/items/holy_sword', 14, ['/items/holy_cheese', '/items/coin'], 700);
        cacheCost('/items/holy_sword', 15, ['/items/holy_cheese', '/items/coin'], 900);
        cacheCost('/items/holy_bow', 13, ['/items/lumber', '/items/coin'], 400);
        validateNetworthCache({ force: false });

        marketAPI.updatePrice('/items/holy_cheese', 0, 950, 870);
        validateNetworthCache({ force: false });

        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        expect(networthCache.get('/items/holy_sword', 14)).toBeNull();
        expect(networthCache.get('/items/holy_sword', 15)).toBeNull();
        expect(networthCache.get('/items/holy_bow', 13)).toBe(400);
    });

    test('an hrid with underscores is matched whole, at any level of its book', () => {
        cacheCost('/items/holy_sword', 13, ['/items/mirror_of_protection'], 500);
        cacheCost('/items/holy_bow', 13, ['/items/lumber'], 400);
        validateNetworthCache();

        // The item's own book at another level counts as its input too
        marketAPI.updatePrice('/items/holy_sword', 10, 30_000_000, 28_000_000);
        validateNetworthCache();
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        expect(networthCache.get('/items/holy_bow', 13)).toBe(400);
    });

    test('re-opening a book whose top has not moved drops nothing', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        validateNetworthCache();

        marketAPI.updatePrice('/items/holy_cheese', 0, 900, 850);
        validateNetworthCache();

        expect(networthCache.get('/items/holy_sword', 13)).toBe(500);
    });

    test('a cost whose reads were not recorded is dropped on any move', () => {
        // A set() with no get() miss before it: nothing says what it read
        networthCache.set('/items/holy_bow', 13, 400);
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        validateNetworthCache();

        marketAPI.updatePrice('/items/lumber', 0, 410, 390);
        validateNetworthCache();

        expect(networthCache.get('/items/holy_bow', 13)).toBeNull();
        expect(networthCache.get('/items/holy_sword', 13)).toBe(500);
    });

    test('reads a memo replays (a cached production cost) count as the cost’s own', () => {
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        marketAPI.getPrice('/items/holy_sword', 0);
        // The crafted base's cost came out of a memo, which hands over the prices behind it
        marketAPI.notePriceReads(['/items/lumber:0']);
        networthCache.set('/items/holy_sword', 13, 500);
        validateNetworthCache();

        marketAPI.updatePrice('/items/lumber', 0, 410, 390);
        validateNetworthCache();
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
    });

    test('a memo that cannot say what it read makes the cost wide', () => {
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        marketAPI.notePriceReads(null);
        networthCache.set('/items/holy_sword', 13, 500);
        validateNetworthCache();

        marketAPI.updatePrice('/items/lumber', 0, 410, 390);
        validateNetworthCache();
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
    });

    test('a cache hit hands its reads to an outer recorder', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        const recorder = marketAPI.recordPriceReads();
        expect(networthCache.get('/items/holy_sword', 13)).toBe(500);
        recorder.stop();
        expect(recorder.keys.has('/items/holy_cheese:0')).toBe(true);
    });

    test('a miss that never reaches set() stops recording at the next lookup', () => {
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        expect(marketAPI._readRecorders.size).toBe(1);
        networthCache.get('/items/holy_bow', 13);
        expect(marketAPI._readRecorders.size).toBe(1);
        networthCache.clear();
        expect(marketAPI._readRecorders.size).toBe(0);
    });

    test('a miss that never reaches set() stops recording at the end of the tick', async () => {
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        expect(marketAPI._readRecorders.size).toBe(1);
        await Promise.resolve();
        expect(marketAPI._readRecorders.size).toBe(0);
        // A cost set after that has no known reads: it is dropped on any move
        networthCache.set('/items/holy_sword', 13, 500);
        validateNetworthCache();
        marketAPI.updatePrice('/items/lumber', 0, 410, 390);
        validateNetworthCache();
        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
    });
});

describe('what still empties the cache', () => {
    test('a new snapshot clears every cost', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        cacheCost('/items/holy_bow', 13, ['/items/lumber'], 400);
        validateNetworthCache();

        marketAPI._installSnapshot(snapshot(), Math.floor(Date.now() / 1000));
        validateNetworthCache();

        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
        expect(networthCache.get('/items/holy_bow', 13)).toBeNull();
    });

    test('re-reading the snapshot already held clears nothing', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        validateNetworthCache();

        const held = marketAPI.lastFetchTimestamp / 1000;
        expect(marketAPI._installSnapshot(snapshot(), held)).toBe(false);
        validateNetworthCache();

        expect(networthCache.get('/items/holy_sword', 13)).toBe(500);
    });

    test('a changed pricing stamp clears every cost', () => {
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        validateNetworthCache();

        state.stamp = 'bid|bid|buy';
        validateNetworthCache({ force: false });

        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
    });

    test('a reader further behind than the change log clears every cost', () => {
        cacheCost('/items/holy_bow', 13, ['/items/lumber'], 400);
        validateNetworthCache();

        for (let i = 0; i <= marketAPI.CHANGE_LOG_LIMIT; i++) {
            marketAPI.updatePrice('/items/holy_cheese', 0, 1000 + i, 900);
        }
        validateNetworthCache();

        expect(networthCache.get('/items/holy_bow', 13)).toBeNull();
    });

    test('a change between a clear and the next check is not lost', () => {
        networthCache.clear();
        cacheCost('/items/holy_sword', 13, ['/items/holy_cheese'], 500);
        marketAPI.updatePrice('/items/holy_cheese', 0, 950, 870);
        validateNetworthCache();

        expect(networthCache.get('/items/holy_sword', 13)).toBeNull();
    });
});
