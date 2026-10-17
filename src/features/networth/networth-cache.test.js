/**
 * The enhancement-cost cache, and whose cost it is holding.
 *
 * The key was the item and the target level, which is only half the question:
 * what a +10 costs depends on the enhancer — their level, gear, tea and
 * Observatory. Two characters, or one character before and after re-gearing,
 * asked the same question and got each other's answer.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    characterId: 'alice',
    params: { level: 140, tea: 'blessed' },
    switchHandler: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        on: (event, handler) => {
            if (event === 'character_switching') state.switchHandler = handler;
        },
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => state.params,
}));

const networthCache = (await import('./networth-cache.js')).default;

/**
 * Move past the window the params fingerprint is memoised for.
 *
 * The fingerprint is held for a moment so a sweep of hundreds of items does not
 * rebuild it per item; a test changing the enhancer has to outlive that.
 */
function afterTheMemo() {
    vi.advanceTimersByTime(2000);
}

beforeEach(() => {
    vi.useFakeTimers();
    state.characterId = 'alice';
    state.params = { level: 140, tea: 'blessed' };
    networthCache.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the cache key', () => {
    test('separates two characters asking the same question', () => {
        networthCache.set('/items/sword', 10, 5000);
        expect(networthCache.get('/items/sword', 10)).toBe(5000);

        state.characterId = 'bob';
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        networthCache.set('/items/sword', 10, 9000);
        expect(networthCache.get('/items/sword', 10)).toBe(9000);

        state.characterId = 'alice';
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBe(5000);
    });

    test('separates one character before and after their enhancing setup changes', () => {
        networthCache.set('/items/sword', 10, 5000);

        state.params = { level: 40, tea: 'none' };
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        state.params = { level: 140, tea: 'blessed' };
        afterTheMemo();
        expect(networthCache.get('/items/sword', 10)).toBe(5000);
    });

    test('does not read the params afresh for every item of a sweep', () => {
        const key = networthCache.generateKey('/items/a', 1);
        state.params = { level: 40, tea: 'none' };
        // Same moment, so the memoised fingerprint still stands
        expect(networthCache.generateKey('/items/a', 1)).toBe(key);
    });
});

describe('a character switch', () => {
    test('empties the cache rather than leaving the old entries to age out', () => {
        networthCache.set('/items/sword', 10, 5000);
        expect(networthCache.getStats().size).toBe(1);

        state.switchHandler({ oldId: 'alice', newId: 'bob' });

        expect(networthCache.getStats().size).toBe(0);
    });
});

describe('live price patches', () => {
    const snapshot = { '/items/cheese': [{ a: 10, b: 8 }] };

    beforeEach(() => {
        networthCache.clear();
        networthCache.marketDataHash = null;
    });

    test('a patch with an unchanged snapshot invalidates the cache', () => {
        networthCache.checkAndInvalidate({ marketData: snapshot, pricePatchs: {} });
        networthCache.set('/items/sword', 5, 1234);
        expect(networthCache.get('/items/sword', 5)).toBe(1234);

        networthCache.checkAndInvalidate({
            marketData: snapshot,
            pricePatchs: { '/items/cheese:0': { a: 20, b: 18, timestamp: 5000 } },
        });
        expect(networthCache.get('/items/sword', 5)).toBeNull();
    });

    test('the same patches again keep the cache, and a newer patch for the same key clears it', () => {
        const patches = { '/items/cheese:0': { a: 20, b: 18, timestamp: 5000 } };
        networthCache.checkAndInvalidate({ marketData: snapshot, pricePatchs: patches });
        networthCache.set('/items/sword', 5, 1234);
        networthCache.checkAndInvalidate({ marketData: snapshot, pricePatchs: { ...patches } });
        expect(networthCache.get('/items/sword', 5)).toBe(1234);

        networthCache.checkAndInvalidate({
            marketData: snapshot,
            pricePatchs: { '/items/cheese:0': { a: 20, b: 18, timestamp: 6000 } },
        });
        expect(networthCache.get('/items/sword', 5)).toBeNull();
    });
});

describe('what the market hash cannot see', () => {
    const book = { marketData: { '/items/sword': [{ a: 10, b: 9 }] } };

    test('a change in the net-worth mode or the custom prices empties the cache, an unchanged salt does not', () => {
        networthCache.checkAndInvalidate(book, 'ask|1');
        networthCache.set('/items/sword', 10, 5000);

        networthCache.checkAndInvalidate(book, 'ask|1');
        expect(networthCache.get('/items/sword', 10)).toBe(5000);

        // A custom price was typed: the costs held were priced without it
        networthCache.checkAndInvalidate(book, 'ask|2');
        expect(networthCache.get('/items/sword', 10)).toBeNull();

        networthCache.set('/items/sword', 10, 5000);
        networthCache.checkAndInvalidate(book, 'bid|2');
        expect(networthCache.get('/items/sword', 10)).toBeNull();
    });
});

describe('the partial flag rides with the cost', () => {
    test('a cached cost remembers whether it was a partial bill, and defaults to complete', () => {
        networthCache.set('/items/sword', 10, 5000, true);
        networthCache.set('/items/axe', 10, 6000);
        expect(networthCache.get('/items/sword', 10)).toBe(5000);
        expect(networthCache.isPartial('/items/sword', 10)).toBe(true);
        expect(networthCache.isPartial('/items/axe', 10)).toBe(false);
        expect(networthCache.isPartial('/items/never', 10)).toBe(false);
    });
});
