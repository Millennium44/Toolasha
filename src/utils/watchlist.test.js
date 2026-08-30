import { describe, test, expect } from 'vitest';
import {
    addToWatchlist,
    removeFromWatchlist,
    removeSource,
    vendorFloor,
    valueWatchlist,
    listedCounts,
    watchlistTotals,
    sortRows,
    mergeWatchlists,
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
            held: 10,
            listed: 0,
            unclaimed: 0,
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

describe('listedCounts', () => {
    test('a sell order is holding items you still own', () => {
        // A checklist that counts only the bag says you have none of something
        // you have two hundred of, which is the difference between "go farm
        // this" and "wait"
        const counts = listedCounts([{ itemHrid: '/items/a', isSell: true, orderQuantity: 200, filledQuantity: 40 }]);
        expect(counts['/items/a']).toEqual({ listed: 160, unclaimed: 0 });
    });

    test('a buy order is holding coin, not items', () => {
        expect(listedCounts([{ itemHrid: '/items/a', isSell: false, orderQuantity: 200, filledQuantity: 0 }])).toEqual(
            {}
        );
    });

    test('unclaimed items are yours whichever way the order went', () => {
        const counts = listedCounts([
            { itemHrid: '/items/a', isSell: false, orderQuantity: 5, filledQuantity: 5, unclaimedItemCount: 5 },
        ]);
        expect(counts['/items/a']).toEqual({ listed: 0, unclaimed: 5 });
    });

    test('several orders for one item add up', () => {
        const counts = listedCounts([
            { itemHrid: '/items/a', isSell: true, orderQuantity: 10, filledQuantity: 0 },
            { itemHrid: '/items/a', isSell: true, orderQuantity: 7, filledQuantity: 2 },
        ]);
        expect(counts['/items/a'].listed).toBe(15);
    });

    test('nothing listed is nothing counted', () => {
        expect(listedCounts(null)).toEqual({});
    });

    test('a cancelled sell counts its returned items once, not twice', () => {
        // The book now keeps a cancelled listing while it is still holding a
        // refund. Its unsold units have moved into `unclaimedItemCount`, so
        // counting the order's remainder as still listed would double them
        const counts = listedCounts([
            {
                itemHrid: '/items/a',
                isSell: true,
                status: '/market_listing_status/cancelled',
                orderQuantity: 100,
                filledQuantity: 20,
                unclaimedItemCount: 80,
            },
        ]);
        expect(counts['/items/a']).toEqual({ listed: 0, unclaimed: 80 });
    });
});

describe('valueWatchlist counts what is on the market', () => {
    const entries = [{ hrid: '/items/a', name: 'A' }];

    test('listed and unclaimed count towards what you own', () => {
        const [row] = valueWatchlist(entries, {
            quantityOf: () => 3,
            pricesFor: () => ({ ask: 100, bid: 100 }),
            listedOf: () => ({ listed: 160, unclaimed: 5 }),
        });

        expect(row.held).toBe(3);
        expect(row.quantity).toBe(168);
        // And the value follows everything you own, not only the bag
        expect(row.totalAsk).toBe(16800);
    });

    test('with no listings it is what the bag says', () => {
        const [row] = valueWatchlist(entries, { quantityOf: () => 3, pricesFor: () => ({ ask: 100, bid: 100 }) });
        expect(row.quantity).toBe(3);
        expect(row.listed).toBe(0);
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

describe('an enhancement level is part of which row this is', () => {
    test('the +5 and the +0 of one item are two rows', () => {
        // Watched from the upgrade advisor, "Cheese Sword +5" is a different
        // purchase at a different price from the +0 already on the list
        const list = addToWatchlist([], [item('/items/sword')], 'aqua');
        const both = addToWatchlist(list, [{ hrid: '/items/sword', name: 'Sword +5', enhancementLevel: 5 }]);

        expect(both).toHaveLength(2);
        expect(both[1]).toEqual({
            hrid: '/items/sword',
            name: 'Sword +5',
            source: null,
            enhancementLevel: 5,
        });
    });

    test('the same level twice is still one row', () => {
        const once = addToWatchlist([], [{ hrid: '/items/sword', name: 'Sword +5', enhancementLevel: 5 }]);
        const twice = addToWatchlist(once, [{ hrid: '/items/sword', name: 'Sword +5', enhancementLevel: 5 }]);
        expect(twice).toHaveLength(1);
    });

    test('a +0 row is stored exactly as it always was', () => {
        // Every row written before levels existed is a +0, and a `+0` field on
        // all of them would be a stored-shape change for nothing
        const [row] = addToWatchlist([], [{ hrid: '/items/sword', name: 'Sword', enhancementLevel: 0 }]);
        expect(row).toEqual({ hrid: '/items/sword', name: 'Sword', source: null });
    });

    test('taking off the +5 leaves the +0 where it is', () => {
        const list = addToWatchlist(addToWatchlist([], [item('/items/sword')]), [
            { hrid: '/items/sword', name: 'Sword +5', enhancementLevel: 5 },
        ]);

        const left = removeFromWatchlist(list, '/items/sword', 5);
        expect(left).toHaveLength(1);
        expect(left[0].enhancementLevel).toBeUndefined();
    });

    test('a row is priced and counted at its own level', () => {
        const [plain, enhanced] = valueWatchlist(
            [
                { hrid: '/items/sword', name: 'Sword' },
                { hrid: '/items/sword', name: 'Sword +5', enhancementLevel: 5 },
            ],
            {
                quantityOf: (hrid, level) => (level === 5 ? 1 : 4),
                pricesFor: (hrid, level) => (level === 5 ? { ask: 900, bid: 800 } : { ask: 100, bid: 90 }),
            }
        );

        expect(plain.ask).toBe(100);
        expect(plain.quantity).toBe(4);
        expect(enhanced.ask).toBe(900);
        expect(enhanced.quantity).toBe(1);
    });

    test('a listing of the +5 counts against the +5 row, not the +0', () => {
        const counts = listedCounts([
            { itemHrid: '/items/sword', isSell: true, orderQuantity: 2, filledQuantity: 0 },
            { itemHrid: '/items/sword', enhancementLevel: 5, isSell: true, orderQuantity: 1, filledQuantity: 0 },
        ]);

        expect(counts['/items/sword'].listed).toBe(2);
        expect(counts['/items/sword::5'].listed).toBe(1);
    });
});

describe('merging two devices watchlists', () => {
    const row = (hrid, extra = {}) => ({ hrid, name: hrid.split('/').pop(), source: null, ...extra });

    test('the union keeps rows ticked on either device', () => {
        const merged = mergeWatchlists(
            { entries: [row('/items/cheese')] },
            { entries: [row('/items/milk', { source: 'zone:cow' })] }
        );

        expect(merged.entries.map((entry) => entry.hrid)).toEqual(['/items/cheese', '/items/milk']);
    });

    test('the +0 and the +5 of one item stay two rows', () => {
        const merged = mergeWatchlists(
            { entries: [row('/items/cheese_sword')] },
            { entries: [row('/items/cheese_sword', { enhancementLevel: 5 })] }
        );

        expect(merged.entries).toHaveLength(2);
        expect(merged.entries[1].enhancementLevel).toBe(5);
    });

    test('the same entry key resolves to the incoming row', () => {
        const local = { entries: [row('/items/cheese', { source: 'zone:a' })] };
        const incoming = { entries: [row('/items/cheese', { source: 'zone:b' })] };

        expect(mergeWatchlists(local, incoming).entries).toEqual([row('/items/cheese', { source: 'zone:b' })]);
        expect(mergeWatchlists(incoming, local).entries).toEqual([row('/items/cheese', { source: 'zone:a' })]);
    });

    test('the ticked set maps are unioned and the sort order is a setting', () => {
        const merged = mergeWatchlists(
            { zones: { cow: true }, chests: { blue: true }, sortBy: 'name', direction: 'asc' },
            { zones: { planet: true }, chests: {}, sortBy: 'value', direction: 'desc' }
        );

        expect(merged.zones).toEqual({ cow: true, planet: true });
        expect(merged.chests).toEqual({ blue: true });
        expect(merged.sortBy).toBe('value');
        expect(merged.direction).toBe('desc');
    });

    test('a legacy row with no enhancementLevel keys as the bare hrid', () => {
        // Every row a set ever added, and every row written before levels
        // existed, has no level on it at all
        const legacy = { entries: [{ hrid: '/items/cheese', name: 'Cheese', source: 'zone:cow' }] };
        const modern = { entries: [row('/items/cheese', { enhancementLevel: 0 })] };

        expect(mergeWatchlists(legacy, modern).entries).toHaveLength(1);
        expect(mergeWatchlists(modern, legacy).entries).toHaveLength(1);
    });

    test('an absent or malformed side merges to the side that exists', () => {
        expect(mergeWatchlists(null, { entries: [row('/items/cheese')] }).entries).toHaveLength(1);
        expect(mergeWatchlists({ entries: [row('/items/cheese')] }, null).entries).toHaveLength(1);
        expect(mergeWatchlists(undefined, undefined)).toEqual({ entries: [], zones: {}, chests: {} });
        // A row with no hrid cannot be identified and is not carried
        expect(mergeWatchlists({ entries: [{ name: 'nothing' }] }, {}).entries).toEqual([]);
    });

    test('a row un-ticked on one device comes back — no tombstones, documented', () => {
        const removed = { entries: [] };
        const stillHas = { entries: [row('/items/cheese')] };

        expect(mergeWatchlists(removed, stillHas).entries).toHaveLength(1);
        expect(mergeWatchlists(stillHas, removed).entries).toHaveLength(1);
    });
});
