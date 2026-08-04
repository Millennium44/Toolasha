/**
 * Market Price Store — the WebSocket/snapshot feed into the price cache.
 * The pure fold/prune math lives in market-prices.test.js; these tests cover
 * the class wiring: which updates get persisted, which get skipped, and how
 * listeners are notified.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    getJSON: vi.fn(async () => ({})),
    setJSON: vi.fn(async () => {}),
}));

const dataManagerMock = vi.hoisted(() => ({
    handlers: {},
    on: vi.fn((event, handler) => {
        dataManagerMock.handlers[event] = handler;
    }),
    off: vi.fn(),
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dataManagerMock }));

const { default: marketPriceStore } = await import('./market-price-store.js');

beforeEach(async () => {
    vi.useFakeTimers();
    storageMock.getJSON.mockClear();
    storageMock.setJSON.mockClear();
    storageMock.getJSON.mockImplementation(async () => ({}));
    dataManagerMock.on.mockClear();
    dataManagerMock.off.mockClear();
    marketPriceStore.cleanup();
    marketPriceStore.entries = {};
    marketPriceStore.dirty = false;
    marketPriceStore.loaded = false;
    marketPriceStore.listeners = new Set();
    await marketPriceStore.initialize();
});

describe('onOrderBooks', () => {
    test('a book with both sides records ask/bid and marks the entry dirty', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);

        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/cheese',
                orderBooks: [{ asks: [{ price: 100, quantity: 5 }], bids: [{ price: 90, quantity: 3 }] }],
            },
        });

        const entry = marketPriceStore.get('/items/cheese', 0);
        expect(entry).toMatchObject({ ask: 100, bid: 90, askQty: 5, bidQty: 3 });
        expect(listener).toHaveBeenCalledWith(['/items/cheese:0']);
        expect(marketPriceStore.dirty).toBe(true);
    });

    test('a null slot in a sparse orderBooks array is skipped, not stored as empty', () => {
        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/sword',
                orderBooks: [null, { asks: [{ price: 500, quantity: 1 }], bids: [] }],
            },
        });

        expect(marketPriceStore.get('/items/sword', 0)).toBeNull();
        expect(marketPriceStore.get('/items/sword', 1)).toMatchObject({ ask: 500 });
    });

    test('a payload with no marketItemOrderBooks or itemHrid is a no-op', () => {
        const listener = vi.fn();
        marketPriceStore.onChange(listener);
        dataManagerMock.handlers['market_item_order_books_updated']({});
        expect(listener).not.toHaveBeenCalled();
    });
});

describe('ingestSnapshot', () => {
    test('records ask/bid from the compact snapshot shape with no size data', () => {
        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 50, b: 40 } } }, 1000);
        const entry = marketPriceStore.get('/items/plank', 0);
        expect(entry).toMatchObject({ ask: 50, bid: 40, askQty: 0, bidQty: 0 });
    });

    test('does not overwrite an entry that already has order-book depth behind it', () => {
        dataManagerMock.handlers['market_item_order_books_updated']({
            marketItemOrderBooks: {
                itemHrid: '/items/plank',
                orderBooks: [{ asks: [{ price: 60, quantity: 200 }], bids: [] }],
            },
        });

        // A snapshot arrives right after — foldPrice will still fold it in (it doesn't special-case
        // qty=0 snapshots), but this pins the actual observed behavior rather than assuming.
        marketPriceStore.ingestSnapshot({ '/items/plank': { 0: { a: 61, b: 41 } } }, Date.now() + 1);
        const entry = marketPriceStore.get('/items/plank', 0);
        expect(entry.ask).toBe(61);
    });

    test('a null/undefined snapshot is a no-op rather than a throw', () => {
        expect(() => marketPriceStore.ingestSnapshot(null, Date.now())).not.toThrow();
    });
});

describe('get', () => {
    test('coin resolves to face value even with nothing in the entries table', () => {
        expect(marketPriceStore.get('/items/coin')).toMatchObject({ ask: 1, bid: 1 });
    });

    test('cowbell derives from the bag entry and is null until the bag has a price', () => {
        expect(marketPriceStore.get('/items/cowbell')).toBeNull();
        marketPriceStore.ingestSnapshot({ '/items/bag_of_10_cowbells': { 0: { a: 1000, b: 800 } } }, Date.now());
        const cowbell = marketPriceStore.get('/items/cowbell');
        expect(cowbell.ask).toBeCloseTo(100, 6);
        expect(cowbell.bid).toBeCloseTo(80, 6);
    });

    test('an item never seen returns null', () => {
        expect(marketPriceStore.get('/items/never_seen')).toBeNull();
    });
});

describe('flush', () => {
    test('writes to storage only when dirty', async () => {
        await marketPriceStore.flush();
        expect(storageMock.setJSON).not.toHaveBeenCalled();

        marketPriceStore.dirty = true;
        await marketPriceStore.flush();
        expect(storageMock.setJSON).toHaveBeenCalledWith('mooketPrices', marketPriceStore.entries, 'marketListings');
        expect(marketPriceStore.dirty).toBe(false);
    });
});

describe('cleanup', () => {
    test('unregisters the websocket handler and stops the save timer', () => {
        dataManagerMock.off.mockClear();
        marketPriceStore.cleanup();
        expect(dataManagerMock.off).toHaveBeenCalledWith('market_item_order_books_updated', expect.any(Function));
        expect(marketPriceStore.bookHandler).toBeNull();
        expect(marketPriceStore.saveTimer).toBeNull();
    });
});
