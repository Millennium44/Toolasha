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
    isStalePrice,
    DISPLAY_MODES,
    MAX_WATCHED,
    STALE_PRICE_MS,
    describeMove,
    formatMoveSpan,
    MAX_MOVE_SPAN_MS,
    normaliseTarget,
    setWatchedTarget,
    targetMet,
    describeTarget,
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

describe('isStalePrice', () => {
    const now = 1_000_000_000;

    test('a price with no reading yet is stale — nothing fresher to trust', () => {
        expect(isStalePrice(null, now)).toBe(true);
        expect(isStalePrice(undefined, now)).toBe(true);
        expect(isStalePrice(0, now)).toBe(true);
    });

    test('within the threshold is not stale', () => {
        expect(isStalePrice(now - (STALE_PRICE_MS - 1), now)).toBe(false);
    });

    test('past the threshold is stale', () => {
        expect(isStalePrice(now - (STALE_PRICE_MS + 1), now)).toBe(true);
    });

    test('a custom threshold is honored', () => {
        expect(isStalePrice(now - 5000, now, 1000)).toBe(true);
        expect(isStalePrice(now - 500, now, 1000)).toBe(false);
    });
});

describe('formatMoveSpan', () => {
    test('minutes below an hour', () => {
        expect(formatMoveSpan(12 * 60_000)).toBe('12m');
        expect(formatMoveSpan(59 * 60_000)).toBe('59m');
    });

    test('hours above one', () => {
        expect(formatMoveSpan(3 * 3600_000)).toBe('3h');
        expect(formatMoveSpan(90 * 60_000)).toBe('2h');
    });

    test('anything under a minute reads as a minute, not as seconds', () => {
        // The gap between two readings is not measured finely enough for the
        // difference between forty seconds and ninety to be a claim worth making
        expect(formatMoveSpan(4_000)).toBe('1m');
        expect(formatMoveSpan(0)).toBe('1m');
    });
});

describe('describeMove', () => {
    const HOUR = 3600_000;

    test('a rise reads with an up arrow and its span', () => {
        expect(describeMove(0.021, 3 * HOUR).text).toBe('▲2.1% / 3h');
    });

    test('a fall reads with a down arrow and no minus sign', () => {
        // The arrow already carries the direction; a minus beside it is noise
        expect(describeMove(-0.043, 25 * 60_000).text).toBe('▼4.3% / 25m');
    });

    test('the percentage is signed for the caller, which colours it', () => {
        expect(describeMove(-0.043, HOUR).percent).toBeCloseTo(-4.3, 9);
        expect(describeMove(0.043, HOUR).percent).toBeCloseTo(4.3, 9);
    });

    test('no chip at all beyond the sanity bound', () => {
        // A move spanning a week is not a move; it is the market drifting, and
        // drawing it the same way as an hourly step would be the chip's lie
        expect(describeMove(0.08, MAX_MOVE_SPAN_MS + 1)).toBeNull();
        expect(describeMove(0.08, 9 * 24 * HOUR)).toBeNull();
        expect(describeMove(0.08, MAX_MOVE_SPAN_MS)).not.toBeNull();
    });

    test('no chip without a span behind the move', () => {
        // A first reading, or an entry stored before spans were kept
        expect(describeMove(0.08, 0)).toBeNull();
        expect(describeMove(0.08, undefined)).toBeNull();
        expect(describeMove(0.08, -5)).toBeNull();
    });

    test('no chip for a move that rounds away to nothing', () => {
        expect(describeMove(0, HOUR)).toBeNull();
        expect(describeMove(0.0002, HOUR)).toBeNull();
        expect(describeMove(0.0006, HOUR).text).toBe('▲0.1% / 1h');
    });

    test('no chip for a move that is not a number', () => {
        expect(describeMove(undefined, HOUR)).toBeNull();
        expect(describeMove(null, HOUR)).toBeNull();
        expect(describeMove(Infinity, HOUR)).toBeNull();
    });

    test('the bound is injectable, so the chip can be retuned without a rewrite', () => {
        expect(describeMove(0.08, 2 * HOUR, HOUR)).toBeNull();
        expect(describeMove(0.08, 2 * HOUR, 3 * HOUR)).not.toBeNull();
    });
});

describe('normaliseTarget', () => {
    test('defaults to the ask side, which is the one a buyer is watching', () => {
        expect(normaliseTarget({ price: 100 })).toEqual({ side: 'ask', price: 100 });
    });

    test('keeps a bid target', () => {
        expect(normaliseTarget({ side: 'bid', price: 100 })).toEqual({ side: 'bid', price: 100 });
    });

    test('an unusable price is no target at all', () => {
        // Zero would be reached by an empty book and a negative never; both
        // would be a pin quietly carrying a rule nobody could have meant
        expect(normaliseTarget({ price: 0 })).toBeNull();
        expect(normaliseTarget({ price: -5 })).toBeNull();
        expect(normaliseTarget({ price: 'soon' })).toBeNull();
        expect(normaliseTarget(null)).toBeNull();
    });

    test('a numeric string is a price, since that is what an input hands back', () => {
        expect(normaliseTarget({ price: '4200' })).toEqual({ side: 'ask', price: 4200 });
    });

    test('an unrecognised side is an ask rather than a third kind of target', () => {
        expect(normaliseTarget({ side: 'middle', price: 10 }).side).toBe('ask');
    });
});

describe('addWatched with a target', () => {
    test('a seeded pin carries its target', () => {
        const list = addWatched([], '/items/cheese:0', price, { side: 'ask', price: 90 });
        expect(list[0].target).toEqual({ side: 'ask', price: 90 });
    });

    test('an unusable seed leaves the pin plain rather than half-targeted', () => {
        const list = addWatched([], '/items/cheese:0', price, { price: null });
        expect(list[0]).not.toHaveProperty('target');
    });
});

describe('setWatchedTarget', () => {
    const pinned = addWatched([], '/items/cheese:0', price);

    test('sets a target on the named pin', () => {
        expect(setWatchedTarget(pinned, '/items/cheese:0', { side: 'bid', price: 150 })[0].target).toEqual({
            side: 'bid',
            price: 150,
        });
    });

    test('clearing removes the field, so a cleared pin reads like one never targeted', () => {
        const targeted = setWatchedTarget(pinned, '/items/cheese:0', { price: 90 });
        expect(setWatchedTarget(targeted, '/items/cheese:0', null)[0]).not.toHaveProperty('target');
    });

    test('an unusable price clears rather than storing something unreachable', () => {
        const targeted = setWatchedTarget(pinned, '/items/cheese:0', { price: 90 });
        expect(setWatchedTarget(targeted, '/items/cheese:0', { price: 0 })[0]).not.toHaveProperty('target');
    });

    test('leaves every other pin alone', () => {
        const two = addWatched(pinned, '/items/milk:0', price);
        const after = setWatchedTarget(two, '/items/cheese:0', { price: 90 });
        expect(after[1]).toBe(two[1]);
    });

    test('a pin that is not there changes nothing', () => {
        expect(setWatchedTarget(pinned, '/items/milk:0', { price: 90 })).toEqual(pinned);
    });
});

describe('targetMet', () => {
    test('an ask target is reached at or under the price named', () => {
        const target = { side: 'ask', price: 100 };
        expect(targetMet(target, { ask: 101 })).toBe(false);
        expect(targetMet(target, { ask: 100 })).toBe(true);
        expect(targetMet(target, { ask: 99 })).toBe(true);
    });

    test('a bid target is reached at or over the price named', () => {
        const target = { side: 'bid', price: 100 };
        expect(targetMet(target, { bid: 99 })).toBe(false);
        expect(targetMet(target, { bid: 100 })).toBe(true);
        expect(targetMet(target, { bid: 101 })).toBe(true);
    });

    test('each side looks only at its own quote', () => {
        // A bid of 5 says nothing about whether the ask target was reached
        expect(targetMet({ side: 'ask', price: 100 }, { bid: 5 })).toBeNull();
    });

    test('an unquoted side is unknown rather than unreached', () => {
        // The distinction the alert leans on: null leaves the armed bit alone,
        // false re-arms it, and an empty book must not do the latter
        expect(targetMet({ side: 'ask', price: 100 }, { ask: -1 })).toBeNull();
        expect(targetMet({ side: 'ask', price: 100 }, null)).toBeNull();
    });

    test('no target is no verdict', () => {
        expect(targetMet(null, { ask: 1 })).toBeNull();
    });
});

describe('describeTarget', () => {
    test('says which way the comparison runs, in words', () => {
        expect(describeTarget({ side: 'ask', price: 4_200_000 })).toBe('under 4.2M ask');
        expect(describeTarget({ side: 'bid', price: 4_200_000 })).toBe('over 4.2M bid');
    });

    test('no target, nothing to say', () => {
        expect(describeTarget(null)).toBe('');
    });
});
