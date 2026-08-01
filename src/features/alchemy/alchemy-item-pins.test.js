import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => ({}), setJSON: async () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

const { togglePin, orderTiles, sameOrder } = await import('./alchemy-item-pins.js');

/** Stand-ins for tiles; the ordering never touches the DOM */
const tile = (hrid) => ({ hrid });
const hridOf = (t) => t.hrid;

describe('togglePin', () => {
    test('pins and unpins within one action', () => {
        const pinned = togglePin({}, 'coinify', '/items/cheese');
        expect(pinned.coinify).toEqual(['/items/cheese']);
        expect(togglePin(pinned, 'coinify', '/items/cheese').coinify).toEqual([]);
    });

    test('a new pin goes to the end, not the front', () => {
        // Otherwise the list rearranges itself every time you add to it, and the
        // one you reach for most keeps moving
        const pins = togglePin(togglePin({}, 'coinify', '/items/a'), 'coinify', '/items/b');
        expect(pins.coinify).toEqual(['/items/a', '/items/b']);
    });

    test('actions keep separate lists', () => {
        // What is worth coinifying is rarely what is worth decomposing
        const pins = togglePin(togglePin({}, 'coinify', '/items/a'), 'decompose', '/items/b');
        expect(pins).toEqual({ coinify: ['/items/a'], decompose: ['/items/b'] });
    });

    test('ignores a toggle with nothing to toggle', () => {
        expect(togglePin({ coinify: ['/items/a'] }, '', '/items/b')).toEqual({ coinify: ['/items/a'] });
        expect(togglePin(null, 'coinify', '')).toEqual({});
    });
});

describe('orderTiles', () => {
    const tiles = ['/items/a', '/items/b', '/items/c', '/items/d'].map(tile);

    test('pinned first, in pin order', () => {
        const out = orderTiles(tiles, ['/items/c', '/items/a'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('everything else keeps the order the game gave it', () => {
        const out = orderTiles(tiles, ['/items/d'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/d', '/items/a', '/items/b', '/items/c']);
    });

    test('a pin for an item not on screen changes nothing', () => {
        // The filter box hides most of the list most of the time
        const out = orderTiles(tiles, ['/items/zzz'], hridOf);
        expect(out.map(hridOf)).toEqual(['/items/a', '/items/b', '/items/c', '/items/d']);
    });

    test('a cell standing for no item keeps the front', () => {
        // The Remove cell shares the grid; pinning something must not push the
        // way to clear the selection down behind it
        const withRemove = [tile(''), ...tiles];
        const out = orderTiles(withRemove, ['/items/c'], hridOf);
        expect(out.map(hridOf)).toEqual(['', '/items/c', '/items/a', '/items/b', '/items/d']);
    });

    test('no pins leaves the order alone', () => {
        expect(orderTiles(tiles, [], hridOf)).toEqual(tiles);
        expect(orderTiles(tiles, null, hridOf)).toEqual(tiles);
    });

    test('survives having no tiles', () => {
        expect(orderTiles(null, ['/items/a'], hridOf)).toEqual([]);
    });
});

describe('sameOrder', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(tile);

    test('recognises an order that has not moved', () => {
        // Reordering is itself a mutation, and the watcher that reacts to
        // mutations would never stop if it could not tell
        expect(sameOrder([a, b, c], [a, b, c])).toBe(true);
    });

    test('spots a move and a length change', () => {
        expect(sameOrder([a, b, c], [b, a, c])).toBe(false);
        expect(sameOrder([a, b], [a, b, c])).toBe(false);
    });
});
