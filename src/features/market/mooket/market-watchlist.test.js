/**
 * Tests for the pinned-item list. Order is the point, so most of these are
 * about it surviving.
 */

import { describe, test, expect } from 'vitest';
import {
    addWatched,
    removeWatched,
    moveWatched,
    nextDisplayMode,
    watchedChange,
    normaliseWatchlist,
    describeUpdateAge,
    DISPLAY_MODES,
    MAX_WATCHED,
} from './market-watchlist.js';

const price = { ask: 120, bid: 100, at: 500 };

describe('addWatched', () => {
    test('remembers the price it was pinned at', () => {
        // So the chip shows a move from a moment you chose, not from whenever
        // the cache last happened to update
        expect(addWatched([], '/items/cheese:0', price)[0]).toMatchObject({ ask: 120, bid: 100, at: 500 });
    });

    test('pinning twice does nothing', () => {
        const once = addWatched([], '/items/cheese:0', price);
        expect(addWatched(once, '/items/cheese:0', price)).toBe(once);
    });

    test('an item never seen is still pinnable', () => {
        expect(addWatched([], '/items/cheese:0', null)[0]).toMatchObject({ ask: -1, bid: -1 });
    });

    test('refuses past the point the row stops being readable', () => {
        const full = Array.from({ length: MAX_WATCHED }, (_, i) => ({ key: `k${i}` }));
        expect(addWatched(full, 'one-more', price)).toBe(full);
    });
});

describe('moveWatched', () => {
    const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];

    test('swaps with its neighbour', () => {
        expect(moveWatched(list, 'b', -1).map((e) => e.key)).toEqual(['b', 'a', 'c']);
        expect(moveWatched(list, 'b', 1).map((e) => e.key)).toEqual(['a', 'c', 'b']);
    });

    test('stops at either end rather than wrapping', () => {
        expect(moveWatched(list, 'a', -1)).toBe(list);
        expect(moveWatched(list, 'c', 1)).toBe(list);
    });

    test('an entry that is not there cannot move', () => {
        expect(moveWatched(list, 'z', 1)).toBe(list);
    });
});

describe('removeWatched', () => {
    test('drops just the one', () => {
        expect(removeWatched([{ key: 'a' }, { key: 'b' }], 'a').map((e) => e.key)).toEqual(['b']);
    });
});

describe('nextDisplayMode', () => {
    test('cycles and wraps', () => {
        expect(nextDisplayMode(DISPLAY_MODES[0])).toBe(DISPLAY_MODES[1]);
        expect(nextDisplayMode(DISPLAY_MODES[DISPLAY_MODES.length - 1])).toBe(DISPLAY_MODES[0]);
    });

    test('an unknown mode starts the cycle', () => {
        expect(nextDisplayMode('nonsense')).toBe(DISPLAY_MODES[0]);
    });
});

describe('watchedChange', () => {
    test('per side, against the price it was pinned at', () => {
        const change = watchedChange({ ask: 100, bid: 100 }, { ask: 110, bid: 90 });
        expect(change.askChange).toBeCloseTo(10, 9);
        expect(change.bidChange).toBeCloseTo(-10, 9);
    });

    test('a side that was empty when pinned has no baseline to move from', () => {
        // Treating "nobody was selling" as a price of zero would report an
        // infinite rise the moment somebody listed
        expect(watchedChange({ ask: -1, bid: 100 }, { ask: 500, bid: 100 }).askChange).toBeNull();
        expect(watchedChange({ ask: 100, bid: 100 }, { ask: -1, bid: 100 }).askChange).toBeNull();
    });
});

describe('normaliseWatchlist', () => {
    test('an older keyed watchlist is converted, not dropped', () => {
        const old = { '/items/cheese:0': { ask: 5, bid: 4 } };
        expect(normaliseWatchlist(old)).toEqual([{ key: '/items/cheese:0', ask: 5, bid: 4 }]);
    });

    test('junk reads as an empty list', () => {
        expect(normaliseWatchlist(null)).toEqual([]);
        expect(normaliseWatchlist([{ nope: 1 }])).toEqual([]);
    });
});

describe('describeUpdateAge', () => {
    const now = 1_000_000_000;

    test('a price with no reading yet says so honestly, not "0 ago"', () => {
        expect(describeUpdateAge(null, now)).toBe('Updated —');
        expect(describeUpdateAge(undefined, now)).toBe('Updated —');
        expect(describeUpdateAge(0, now)).toBe('Updated —');
    });

    test('under a minute reads as "just now", not "Just now ago"', () => {
        expect(describeUpdateAge(now - 30_000, now)).toBe('Updated just now');
    });

    test('older readings carry the relative age and "ago"', () => {
        expect(describeUpdateAge(now - 5 * 60_000, now)).toBe('Updated 5m ago');
        expect(describeUpdateAge(now - 2 * 3_600_000, now)).toBe('Updated 2h 0m ago');
    });
});
