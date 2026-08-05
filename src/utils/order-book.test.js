import { describe, test, expect } from 'vitest';
import { bestPrice, queueAt, estimateFillSeconds } from './order-book.js';

/**
 * A side of the book, newest listing last.
 * @param {number} count - How many listings
 * @param {number} price - Their price
 * @param {number} spanMs - How long they took to accumulate, ending now
 * @param {number} [quantity] - Each listing's size
 * @returns {Array<Object>}
 */
function listings(count, price, spanMs, quantity = 10) {
    const end = Date.now();
    return Array.from({ length: count }, (_, index) => ({
        price,
        quantity,
        createdTimestamp: new Date(end - spanMs + (index * spanMs) / Math.max(1, count - 1)).toISOString(),
    }));
}

describe('bestPrice', () => {
    test('is the head of the side, since the game sends them best-first', () => {
        expect(bestPrice([{ price: 100 }, { price: 90 }])).toBe(100);
    });

    test('an empty side has no price rather than zero', () => {
        expect(bestPrice([])).toBeNull();
        expect(bestPrice(null)).toBeNull();
    });
});

describe('queueAt', () => {
    test('adds up what sits at one price', () => {
        const side = [
            { price: 100, quantity: 5 },
            { price: 100, quantity: 7 },
            { price: 90, quantity: 99 },
        ];
        expect(queueAt(side, 100).quantity).toBe(12);
    });

    test('a partly-visible level is a fact, not an estimate', () => {
        expect(queueAt(listings(5, 100, 60_000), 100).estimated).toBe(false);
    });

    test('a full window at one price is deeper than it looks', () => {
        // Twenty listings all at the best price means the level runs past the
        // window, so the total is extrapolated from how fast they arrived
        const stale = listings(20, 100, 60_000).map((listing) => ({
            ...listing,
            createdTimestamp: new Date(new Date(listing.createdTimestamp).getTime() - 60_000).toISOString(),
        }));
        const result = queueAt(stale, 100);
        expect(result.estimated).toBe(true);
        expect(result.quantity).toBeGreaterThan(200);
    });

    test('a level whose newest listing just arrived is exactly its visible depth', () => {
        // Extrapolating to 1x is a real answer rather than an inapplicable one
        const result = queueAt(listings(20, 100, 60_000), 100);
        expect(result.estimated).toBe(true);
        expect(result.quantity).toBeCloseTo(200, 0);
    });

    test('survives a side with no timestamps to extrapolate from', () => {
        const side = Array.from({ length: 20 }, () => ({ price: 100, quantity: 1 }));
        expect(queueAt(side, 100).quantity).toBe(20);
    });
});

describe('estimateFillSeconds', () => {
    test('a fast-filling level fills an order fast', () => {
        // 20 listings of 10 arrived over a minute: 200 in 60s
        const fast = estimateFillSeconds(listings(20, 100, 60_000), 10);
        const slow = estimateFillSeconds(listings(20, 100, 7 * 86400_000), 10);
        expect(fast).toBeLessThan(slow);
    });

    test('a bigger order waits longer', () => {
        const side = listings(10, 100, 60_000);
        expect(estimateFillSeconds(side, 1000)).toBeGreaterThan(estimateFillSeconds(side, 10));
    });

    test('says nothing rather than guessing when there is nothing to measure', () => {
        // "Unknown" and "slow" are different answers and must not be confused
        expect(estimateFillSeconds([], 10)).toBeNull();
        expect(estimateFillSeconds([{ price: 100, quantity: 5 }], 10)).toBeNull();
    });

    test('a level with no quantity has no rate', () => {
        const empty = listings(5, 100, 60_000, 0);
        expect(estimateFillSeconds(empty, 10)).toBeNull();
    });
});
