/**
 * The Top Order Price column preferred the last-opened order book, which excludes
 * your own orders but goes stale the moment you leave the item. A fresh snapshot
 * undercut then stayed hidden until you re-opened the item. `_getTopOrderPrice`
 * now surfaces the snapshot when it is fresher than the book AND shows a price
 * that beats you — a price better than your own is a rival's, never your own
 * order — so an undercut appears without opening the item, and never at the cost
 * of showing your own listing or downgrading a fresher book.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { marketMock, ageMock } = vi.hoisted(() => ({
    marketMock: { getPrice: vi.fn(), getPriceTimestamp: vi.fn(), on: vi.fn(), off: vi.fn() },
    ageMock: {
        orderBooksCache: {},
        estimateTimestamp: vi.fn(() => 0),
        getStalenessTooltip: vi.fn(),
        getStalenessColor: vi.fn(),
    },
}));

vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: () => 1, COLOR_TEXT_SECONDARY: '#999' },
}));
vi.mock('../../api/marketplace.js', () => ({ default: marketMock }));
vi.mock('./estimated-listing-age.js', () => ({ default: ageMock }));
vi.mock('./listing-markers.js', () => ({ default: {}, markerStateFor: () => ({}) }));

import listingPriceDisplay from './listing-price-display.js';

const ITEM = '/items/bag';

/** An order book whose only bid/ask is your own listing (id 1), so it has no competitor */
function bookWithOwnOnly(isSell, ownPrice, lastUpdated) {
    const side = isSell ? 'asks' : 'bids';
    return { lastUpdated, data: { orderBooks: { 0: { [side]: [{ listingId: 1, price: ownPrice }] } } } };
}

beforeEach(() => {
    ageMock.orderBooksCache = {};
    marketMock.getPrice.mockReset();
    marketMock.getPriceTimestamp.mockReset();
});

describe('_getTopOrderPrice — fresh undercut over a stale book', () => {
    test('a fresher snapshot bid above your buy is surfaced', () => {
        ageMock.orderBooksCache[ITEM] = bookWithOwnOnly(false, 16_000_000, 1000);
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(17_000_000);
    });

    test('a fresher snapshot ask below your sell is surfaced', () => {
        ageMock.orderBooksCache[ITEM] = bookWithOwnOnly(true, 920_000, 1000);
        marketMock.getPrice.mockReturnValue({ ask: 900_000, bid: null });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, true, new Map(), new Set([1]), 920_000);
        expect(price).toBe(900_000);
    });

    test('a snapshot that does not beat you never overrides — and never shows your own price', () => {
        // Book has a real competitor below you (15M); snapshot bid equals your own
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 1000,
            data: {
                orderBooks: {
                    0: {
                        bids: [
                            { listingId: 1, price: 16_000_000 }, // your own
                            { listingId: 2, price: 15_000_000 }, // competitor
                        ],
                    },
                },
            },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 16_000_000 }); // == your own, not a beat
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(15_000_000); // the book's own-excluding competitor, not your 16M
    });

    test('a book fresher than the snapshot is trusted even if the snapshot beats you', () => {
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 3000, // fresher than the snapshot
            data: { orderBooks: { 0: { bids: [{ listingId: 2, price: 15_000_000 }] } } },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000); // older than the book

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), 16_000_000);
        expect(price).toBe(15_000_000);
    });

    test('with no opened book, a snapshot undercut is surfaced directly', () => {
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set(), 16_000_000);
        expect(price).toBe(17_000_000);
    });

    test('without the listing price it cannot judge a beat, so the book is kept', () => {
        ageMock.orderBooksCache[ITEM] = {
            lastUpdated: 1000,
            data: { orderBooks: { 0: { bids: [{ listingId: 2, price: 15_000_000 }] } } },
        };
        marketMock.getPrice.mockReturnValue({ ask: null, bid: 17_000_000 });
        marketMock.getPriceTimestamp.mockReturnValue(2000);

        const price = listingPriceDisplay._getTopOrderPrice(ITEM, 0, false, new Map(), new Set([1]), null);
        expect(price).toBe(15_000_000);
    });
});
