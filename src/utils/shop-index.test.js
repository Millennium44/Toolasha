import { describe, it, expect, beforeEach, vi } from 'vitest';
import { shopEntriesFor, _resetShopIndex } from './shop-index.js';

function countingMap(entries) {
    const map = { ...entries };
    return map;
}

describe('shop-index', () => {
    beforeEach(() => _resetShopIndex());

    it('returns entries in map order, with duplicates kept', () => {
        const map = {
            a: { itemHrid: '/items/x', n: 1 },
            b: { itemHrid: '/items/y' },
            c: { itemHrid: '/items/x', n: 2 },
            d: {},
        };
        expect(shopEntriesFor(map, '/items/x').map(([k]) => k)).toEqual(['a', 'c']);
        expect(shopEntriesFor(map, '/items/none')).toEqual([]);
        expect(shopEntriesFor(null, '/items/x')).toEqual([]);
    });

    it('does not rebuild when alternating between several maps', () => {
        const spy = vi.spyOn(Object, 'entries');
        const m1 = countingMap({ a: { itemHrid: '/items/x' } });
        const m2 = countingMap({ b: { itemHrid: '/items/x' } });
        shopEntriesFor(m1, '/items/x');
        shopEntriesFor(m2, '/items/x');
        const before = spy.mock.calls.filter((c) => c[0] === m1 || c[0] === m2).length;
        for (let i = 0; i < 10; i++) {
            expect(shopEntriesFor(m1, '/items/x')[0][0]).toBe('a');
            expect(shopEntriesFor(m2, '/items/x')[0][0]).toBe('b');
        }
        const after = spy.mock.calls.filter((c) => c[0] === m1 || c[0] === m2).length;
        spy.mockRestore();
        expect(before).toBe(2);
        expect(after).toBe(2);
    });
});
