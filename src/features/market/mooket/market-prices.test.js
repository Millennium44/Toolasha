/**
 * Tests for the price cache that remembers size as well as price.
 */

import { describe, test, expect } from 'vitest';
import {
    priceKey,
    topOfSide,
    entryFromBook,
    foldPrice,
    specialPrice,
    pruneStale,
    levelsOfSide,
} from './market-prices.js';

describe('priceKey', () => {
    test('an enhanced item is its own market', () => {
        expect(priceKey('/items/cheese')).toBe('/items/cheese:0');
        expect(priceKey('/items/cheese', 3)).not.toBe(priceKey('/items/cheese', 0));
    });
});

describe('topOfSide', () => {
    test('the best price, and everything resting at it', () => {
        const side = [
            { price: 100, quantity: 5 },
            { price: 100, quantity: 7 },
            { price: 110, quantity: 90 },
        ];
        expect(topOfSide(side)).toEqual({ price: 100, quantity: 12 });
    });

    test('an empty side quotes nothing rather than zero', () => {
        // Zero would read as "worth nothing" instead of "nobody is offering"
        expect(topOfSide([])).toEqual({ price: -1, quantity: 0 });
        expect(topOfSide(null)).toEqual({ price: -1, quantity: 0 });
    });
});

describe('entryFromBook', () => {
    test('both sides and their sizes', () => {
        const book = { asks: [{ price: 120, quantity: 3 }], bids: [{ price: 100, quantity: 800 }] };
        expect(entryFromBook(book, 5)).toEqual({
            ask: 120,
            bid: 100,
            askQty: 3,
            bidQty: 800,
            at: 5,
            askLevels: [{ price: 120, quantity: 3 }],
            bidLevels: [{ price: 100, quantity: 800 }],
            depthAt: 5,
        });
    });
});

describe('foldPrice', () => {
    const existing = { ask: 120, bid: 100, askQty: 1, bidQty: 1, at: 1000 };

    test('an older reading is refused', () => {
        expect(foldPrice(existing, { ...existing, at: 999 })).toBeNull();
        expect(foldPrice(existing, { ...existing, at: 1000 })).toBeNull();
    });

    test('the move is measured across both sides together', () => {
        // Measuring either alone means a book whose ask vanishes and returns
        // reports hundreds of percent with nothing having happened
        const next = foldPrice(existing, { ask: 132, bid: 110, askQty: 1, bidQty: 1, at: 2000 });
        expect(next.rise).toBeCloseTo(0.1, 9);
    });

    /*
     * `-1` on a side is "nobody is quoting it", not a price. Folding it into the
     * sum made an emptying ask look like a crash, and an item that had no book
     * at all print thousands of percent when one appeared.
     */
    test('a side only one of the two readings quotes is not a move', () => {
        // The ask empties; the bid has not budged. Summing -1 in read this as
        // 89/190 — a chip announcing "▼53.2%" with nothing having happened.
        const emptied = foldPrice(existing, { ask: -1, bid: 100, askQty: 0, bidQty: 1, at: 2000 });
        // The bid is quoted in both readings and has not moved, so it — and it
        // alone — is the measurement
        expect(emptied.rise).toBe(0);
        expect(emptied.riseSpanMs).toBe(1000);

        // And the same ask coming back at the price it left at
        const restored = foldPrice(emptied, { ask: 120, bid: 100, askQty: 1, bidQty: 1, at: 3000 });
        expect(restored.rise).toBe(0);
    });

    test('an item with no book at all, then a book, is not a move of thousands of percent', () => {
        // Both sides -1 summed to -2, so the first real reading divided by a
        // negative denominator: a sign-flipped figure in the thousands
        const unquoted = { ask: -1, bid: -1, askQty: 0, bidQty: 0, at: 1000 };
        const next = foldPrice(unquoted, { ask: 120, bid: 100, askQty: 1, bidQty: 1, at: 2000 });
        expect(next.rise).toBe(0);
        expect(next.riseSpanMs).toBe(0);
    });

    test('one side quoted in both readings still measures that side', () => {
        const askless = { ask: -1, bid: 100, askQty: 0, bidQty: 1, at: 1000 };
        const next = foldPrice(askless, { ask: -1, bid: 110, askQty: 0, bidQty: 1, at: 2000 });
        expect(next.rise).toBeCloseTo(0.1, 9);
        expect(next.riseSpanMs).toBe(1000);
    });

    test('a first reading has moved by nothing', () => {
        expect(foldPrice(undefined, { ask: 1, bid: 1, askQty: 0, bidQty: 0, at: 1 }).rise).toBe(0);
    });

    test('the move carries how long it took', () => {
        // A percentage with no span behind it cannot be read: the pooled
        // dataset updates on trading activity, so the same 10% is news over an
        // hour and drift over a week
        const next = foldPrice(existing, { ask: 132, bid: 110, askQty: 1, bidQty: 1, at: 1000 + 3 * 3600_000 });
        expect(next.riseSpanMs).toBe(3 * 3600_000);
    });

    test('a first reading has no span, as it has no move', () => {
        expect(foldPrice(undefined, { ask: 1, bid: 1, askQty: 0, bidQty: 0, at: 1 }).riseSpanMs).toBe(0);
    });

    test('a stored reading from the future is replaced, not trusted', () => {
        const future = { ...existing, at: Date.now() + 60_000 };
        expect(foldPrice(future, { ...existing, at: Date.now() })).not.toBeNull();
    });
});

describe('specialPrice', () => {
    test('a coin is worth a coin', () => {
        expect(specialPrice('/items/coin', () => null, 5)).toMatchObject({ ask: 1, bid: 1 });
    });

    test('a cowbell is a tenth of the bag that is actually traded', () => {
        const bag = { ask: 1000, bid: 900, askQty: 4, bidQty: 6, rise: 0, at: 9 };
        expect(specialPrice('/items/cowbell', () => bag, 5)).toMatchObject({ ask: 100, bid: 90, askQty: 4 });
    });

    test('no bag means no cowbell price to derive', () => {
        expect(specialPrice('/items/cowbell', () => null, 5)).toBeNull();
    });

    test('an ordinary item has no special price', () => {
        expect(specialPrice('/items/cheese', () => null, 5)).toBeNull();
    });
});

describe('pruneStale', () => {
    test('drops what has not been seen since the cutoff', () => {
        const entries = { a: { at: 100 }, b: { at: 300 }, c: {} };
        expect(Object.keys(pruneStale(entries, 200))).toEqual(['b']);
    });
});

describe('book depth', () => {
    const book = {
        asks: [
            { listingId: 1, price: 100, quantity: 5 },
            { listingId: 2, price: 100, quantity: 7 },
            { listingId: 3, price: 110, quantity: 1 },
            { listingId: 4, price: 120, quantity: 2 },
            { listingId: 5, price: 130, quantity: 3 },
            { listingId: 6, price: 140, quantity: 4 },
            { listingId: 7, price: 150, quantity: 9 },
        ],
        bids: [],
    };

    test('a book keeps up to five price levels per side, one per price, with depthAt', () => {
        const entry = entryFromBook(book, 500);
        expect(entry.askLevels).toEqual([
            { price: 100, quantity: 12 },
            { price: 110, quantity: 1 },
            { price: 120, quantity: 2 },
            { price: 130, quantity: 3 },
            { price: 140, quantity: 4 },
        ]);
        // seen and empty, which is not the same as unknown
        expect(entry.bidLevels).toEqual([]);
        expect(entry.depthAt).toBe(500);
        expect(entry).toMatchObject({ ask: 100, askQty: 12, bid: -1, bidQty: 0, at: 500 });
    });

    test('a repeated price later in the book joins its level and does not take a slot', () => {
        const orders = [
            { price: 10, quantity: 1 },
            { price: 20, quantity: 1 },
            { price: 10, quantity: 2 },
        ];
        expect(levelsOfSide(orders, 2)).toEqual([
            { price: 10, quantity: 3 },
            { price: 20, quantity: 1 },
        ]);
    });

    test('a newer reading with a book replaces the depth', () => {
        const old = foldPrice(undefined, entryFromBook(book, 100));
        const next = foldPrice(old, entryFromBook({ asks: [{ price: 90, quantity: 1 }], bids: [] }, 200));
        expect(next.askLevels).toEqual([{ price: 90, quantity: 1 }]);
        expect(next.depthAt).toBe(200);
    });

    test('a newer sizeless sighting keeps the older depth and its older depthAt', () => {
        const old = foldPrice(undefined, entryFromBook(book, 100));
        const next = foldPrice(old, { ask: 105, bid: 80, askQty: 0, bidQty: 0, at: 300 });
        expect(next).toMatchObject({ ask: 105, bid: 80, askQty: 0, at: 300, depthAt: 100 });
        expect(next.askLevels).toEqual(old.askLevels);
        expect(next.bidLevels).toEqual([]);
    });

    test('a sizeless sighting over an entry with no depth leaves depth unknown, not empty', () => {
        const before = { ask: 1, bid: 1, askQty: 0, bidQty: 0, at: 1 };
        const next = foldPrice(before, { ask: 2, bid: 1, askQty: 0, bidQty: 0, at: 2 });
        expect(next.askLevels).toBeUndefined();
        expect(next.depthAt).toBeUndefined();
    });

    test('a cowbell quoted from the bag carries no depth', () => {
        const bag = { ...entryFromBook({ asks: [{ price: 1000, quantity: 3 }], bids: [] }, 5), rise: 0 };
        const quote = specialPrice('/items/cowbell', () => bag, 9);
        expect(quote.ask).toBe(100);
        expect(quote.askLevels).toBeUndefined();
        expect(quote.depthAt).toBeUndefined();
    });
});
