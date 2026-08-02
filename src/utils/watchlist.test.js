import { describe, test, expect } from 'vitest';
import {
    addToWatchlist,
    removeFromWatchlist,
    removeSource,
    vendorFloor,
    valueWatchlist,
    watchlistTotals,
    sortRows,
} from './watchlist.js';

const item = (hrid, name) => ({ hrid, name: name || hrid });

describe('addToWatchlist', () => {
    test('adds what is not already there, under the given set', () => {
        const list = addToWatchlist([], [item('/items/a'), item('/items/b')], 'aqua');
        expect(list).toEqual([
            { hrid: '/items/a', name: '/items/a', source: 'aqua' },
            { hrid: '/items/b', name: '/items/b', source: 'aqua' },
        ]);
    });

    test('an item already on the list keeps the home it has', () => {
        // The whole of un-ticking depends on this: if a second set took over the
        // row, turning that set off would take an item the first set still wants
        const first = addToWatchlist([], [item('/items/shared')], 'aqua');
        const second = addToWatchlist(first, [item('/items/shared')], 'jungle');

        expect(second).toHaveLength(1);
        expect(second[0].source).toBe('aqua');
    });

    test('adding by hand leaves no set on the row', () => {
        expect(addToWatchlist([], [item('/items/a')])[0].source).toBeNull();
    });

    test('an item with no hrid is not a row', () => {
        expect(addToWatchlist([], [{ name: 'nameless' }, null], 'aqua')).toEqual([]);
    });

    test('it does not modify the list it was given', () => {
        const original = [];
        addToWatchlist(original, [item('/items/a')], 'aqua');
        expect(original).toEqual([]);
    });
});

describe('removeFromWatchlist', () => {
    test('takes one row off whoever put it there', () => {
        const list = addToWatchlist([], [item('/items/a'), item('/items/b')], 'aqua');
        expect(removeFromWatchlist(list, '/items/a')).toHaveLength(1);
    });
});

describe('removeSource', () => {
    const list = [
        { hrid: '/items/only-aqua', name: 'Only Aqua', source: 'aqua' },
        { hrid: '/items/shared', name: 'Shared', source: 'aqua' },
        { hrid: '/items/only-jungle', name: 'Only Jungle', source: 'jungle' },
        { hrid: '/items/by-hand', name: 'By Hand', source: null },
    ];

    test('takes the set’s own items and leaves everything else', () => {
        const after = removeSource(list, 'aqua', []);
        expect(after.map((entry) => entry.hrid)).toEqual(['/items/only-jungle', '/items/by-hand']);
    });

    test('an item another enabled set also has is re-homed, not removed', () => {
        // Un-ticking Aqua must not empty part of Jungle
        const after = removeSource(list, 'aqua', [{ id: 'jungle', hrids: ['/items/shared', '/items/only-jungle'] }]);

        const shared = after.find((entry) => entry.hrid === '/items/shared');
        expect(shared).toBeDefined();
        expect(shared.source).toBe('jungle');
    });

    test('a row added by hand survives every set being turned off', () => {
        // It was never a set's to take
        let after = removeSource(list, 'aqua', []);
        after = removeSource(after, 'jungle', []);
        expect(after).toEqual([{ hrid: '/items/by-hand', name: 'By Hand', source: null }]);
    });

    test('re-homing picks the first enabled set, the same way every time', () => {
        const both = [
            { id: 'jungle', hrids: ['/items/shared'] },
            { id: 'gobo', hrids: ['/items/shared'] },
        ];
        expect(removeSource(list, 'aqua', both).find((e) => e.hrid === '/items/shared').source).toBe('jungle');

        const reversed = [...both].reverse();
        expect(removeSource(list, 'aqua', reversed).find((e) => e.hrid === '/items/shared').source).toBe('gobo');
    });

    test('turning a set off and on again gets back to the same list', () => {
        const off = removeSource(list, 'aqua', [{ id: 'jungle', hrids: ['/items/shared'] }]);
        const on = addToWatchlist(
            off,
            [item('/items/only-aqua', 'Only Aqua'), item('/items/shared', 'Shared')],
            'aqua'
        );

        expect(on.map((e) => e.hrid).sort()).toEqual(list.map((e) => e.hrid).sort());
    });

    test('turning off a set nobody is in changes nothing', () => {
        expect(removeSource(list, 'nowhere', [])).toEqual(list);
    });
});

describe('vendorFloor', () => {
    test('a bid above the vendor price stands on its own', () => {
        expect(vendorFloor(500, 100)).toEqual({ price: 500, flag: null });
    });

    test('a bid below the vendor price is not the item’s value', () => {
        // Reporting 40 here quietly advises the worse of two sales
        expect(vendorFloor(40, 100)).toEqual({ price: 100, flag: 'below-vendor' });
    });

    test('equal is worth saying, since either sale is the same', () => {
        expect(vendorFloor(100, 100)).toEqual({ price: 100, flag: 'equals-vendor' });
    });

    test('no market at all is the vendor price, not nothing', () => {
        // A bid of zero is the absence of a price, not a value of zero
        expect(vendorFloor(0, 250000)).toEqual({ price: 250000, flag: 'no-market' });
    });

    test('no vendor price leaves the bid to speak for itself', () => {
        expect(vendorFloor(500, 0)).toEqual({ price: 500, flag: null });
        expect(vendorFloor(0, 0)).toEqual({ price: 0, flag: null });
    });
});

describe('valueWatchlist', () => {
    const entries = [
        { hrid: '/items/a', name: 'A', source: 'aqua' },
        { hrid: '/items/b', name: 'B', source: null },
    ];
    const lookups = {
        quantityOf: (hrid) => ({ '/items/a': 10, '/items/b': 3 })[hrid],
        pricesFor: (hrid) => ({ '/items/a': { ask: 100, bid: 90 }, '/items/b': { ask: 50, bid: 5 } })[hrid],
        vendorOf: (hrid) => ({ '/items/b': 20 })[hrid],
    };

    test('multiplies out and keeps what the row already knew', () => {
        const [a] = valueWatchlist(entries, lookups);
        expect(a).toEqual({
            hrid: '/items/a',
            name: 'A',
            source: 'aqua',
            quantity: 10,
            ask: 100,
            bid: 90,
            flag: null,
            totalAsk: 1000,
            totalBid: 900,
        });
    });

    test('the vendor floor is applied before the multiplication', () => {
        // Three at the 5-coin bid is 15; three at the 20-coin vendor is 60
        const [, b] = valueWatchlist(entries, lookups);
        expect(b.flag).toBe('below-vendor');
        expect(b.totalBid).toBe(60);
    });

    test('an item with no price and none held is zero rather than NaN', () => {
        const [row] = valueWatchlist([{ hrid: '/items/x', name: 'X' }], {
            quantityOf: () => undefined,
            pricesFor: () => null,
        });
        expect(row.totalAsk).toBe(0);
        expect(row.totalBid).toBe(0);
    });
});

describe('watchlistTotals', () => {
    test('sums the columns and counts what is actually held', () => {
        const rows = [
            { totalAsk: 100, totalBid: 80, quantity: 5 },
            { totalAsk: 50, totalBid: 40, quantity: 0 },
        ];
        expect(watchlistTotals(rows)).toEqual({ ask: 150, bid: 120, items: 2, held: 1 });
    });

    test('an empty list is zero, not nothing', () => {
        expect(watchlistTotals([])).toEqual({ ask: 0, bid: 0, items: 0, held: 0 });
    });
});

describe('sortRows', () => {
    const rows = [
        { name: 'Cheese', totalAsk: 500 },
        { name: 'Apple', totalAsk: 500 },
        { name: 'Bacon', totalAsk: 9000 },
    ];

    test('by name, both ways', () => {
        expect(sortRows(rows, 'name', 'asc').map((r) => r.name)).toEqual(['Apple', 'Bacon', 'Cheese']);
        expect(sortRows(rows, 'name', 'desc').map((r) => r.name)).toEqual(['Cheese', 'Bacon', 'Apple']);
    });

    test('by value means by what you hold of it', () => {
        expect(sortRows(rows, 'value', 'desc')[0].name).toBe('Bacon');
    });

    test('equal values fall back to the name, so the order does not wander', () => {
        // Otherwise two rows worth the same swap places as unrelated sets are
        // ticked, and the list appears to shuffle on its own
        expect(sortRows(rows, 'value', 'asc').map((r) => r.name)).toEqual(['Apple', 'Cheese', 'Bacon']);
    });

    test('it does not modify the array it was given', () => {
        sortRows(rows, 'name', 'desc');
        expect(rows[0].name).toBe('Cheese');
    });
});
