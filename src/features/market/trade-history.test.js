/**
 * Personal Trade History — persistence of the per-item last buy/sell prices.
 *
 * A failed read must not blank the map, a save must not overwrite prices
 * another tab recorded, and a save that cannot read first must not write.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset() {
            stores.clear();
        },
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'market123',
    on: () => {},
    off: () => {},
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));

const { default: tradeHistory, mergeHistory } = await import('./trade-history.js');

const KEY = 'tradeHistory_market123';
const stored = () => storageMock.storeFor('settings').get(KEY);

/**
 * A filled order, as `market_listings_updated` reports it.
 * @param {string} itemHrid - Item
 * @param {boolean} isSell - Side
 * @param {number} price - Price
 * @returns {Object} Order
 */
const order = (itemHrid, isSell, price) => ({ itemHrid, enhancementLevel: 0, isSell, price, filledQuantity: 1 });

beforeEach(() => {
    storageMock.reset();
    storageMock.unavailable = false;
    dataManagerMock.characterId = 'market123';
    tradeHistory.characterId = 'market123';
    tradeHistory.history = {};
    tradeHistory.isLoaded = false;
    tradeHistory._saveChain = null;
    for (const fn of [storageMock.getJSON, storageMock.setJSON, storageMock.tryGet]) fn.mockClear();
});

describe('mergeHistory', () => {
    test('folds per item and per side, the fresh side winning', () => {
        expect(
            mergeHistory(
                { '/items/a:0': { buy: 1, sell: 2 }, '/items/b:0': { sell: 5 } },
                { '/items/a:0': { buy: 3 }, '/items/c:0': { buy: 7 } }
            )
        ).toEqual({ '/items/a:0': { buy: 3, sell: 2 }, '/items/b:0': { sell: 5 }, '/items/c:0': { buy: 7 } });
        expect(mergeHistory(null, [])).toEqual({});
    });
});

describe('the history cannot be wiped by a failed read or a stale copy', () => {
    test('a load while storage is unavailable keeps the in-memory map rather than blanking it', async () => {
        tradeHistory.history = { '/items/a:0': { buy: 10 } };
        storageMock.unavailable = true;

        await tradeHistory.loadHistory();

        expect(tradeHistory.history).toEqual({ '/items/a:0': { buy: 10 } });
        expect(tradeHistory.isLoaded).toBe(true);
    });

    test('a load folds what is stored under what is in memory', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1, sell: 2 } });
        tradeHistory.history = { '/items/a:0': { buy: 3 } };

        await tradeHistory.loadHistory();

        expect(tradeHistory.history).toEqual({ '/items/a:0': { buy: 3, sell: 2 } });
        expect(tradeHistory.getHistory('/items/a')).toEqual({ buy: 3, sell: 2 });
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored map', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 } });
        // The failure mode that used to wipe histories: memory emptied by a
        // failed load, then a fill saves that emptiness back
        tradeHistory.history = {};
        storageMock.unavailable = true;

        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', true, 9)] });
        await tradeHistory._saveChain;

        expect(stored()).toEqual({ '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 } });
        expect(storageMock.setJSON).not.toHaveBeenCalled();
        expect(tradeHistory.getHistory('/items/c')).toEqual({ sell: 9 });
    });

    test('a save merges what is stored under what is in memory, so rows from another writer survive', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1, sell: 2 }, '/items/b:0': { sell: 5 } });
        tradeHistory.history = { '/items/a:0': { buy: 3 } };

        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', false, 7)] });
        await tradeHistory._saveChain;

        expect(stored()).toEqual({
            '/items/a:0': { buy: 3, sell: 2 },
            '/items/b:0': { sell: 5 },
            '/items/c:0': { buy: 7 },
        });
        expect(tradeHistory.history).toEqual(stored());
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1 } });
        storageMock.unavailable = true;
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/b', true, 2)] });
        await tradeHistory._saveChain;
        expect(stored()).toEqual({ '/items/a:0': { buy: 1 } });

        storageMock.unavailable = false;
        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/c', false, 3)] });
        await tradeHistory._saveChain;

        expect(stored()).toEqual({ '/items/a:0': { buy: 1 }, '/items/b:0': { sell: 2 }, '/items/c:0': { buy: 3 } });
    });

    test('clearHistory is the one write allowed to lose rows, and stays cleared', async () => {
        storageMock.storeFor('settings').set(KEY, { '/items/a:0': { buy: 1 } });
        tradeHistory.history = { '/items/a:0': { buy: 1 } };

        await tradeHistory.clearHistory();
        expect(stored()).toEqual({});

        tradeHistory.handleMarketUpdate({ endMarketListings: [order('/items/b', true, 2)] });
        await tradeHistory._saveChain;
        expect(stored()).toEqual({ '/items/b:0': { sell: 2 } });
    });
});
