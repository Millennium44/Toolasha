/**
 * Trade Ledger View — the item-name filter box.
 *
 * The modal itself is a lot of DOM chrome shared with the Market History
 * viewer; this only exercises the pure predicate the filter box and the CSV
 * export both run through, so it stays testable without building the modal.
 */

import { describe, test, expect } from 'vitest';
import { filterItemsByName } from './trade-ledger-view.js';

const items = [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/coarse_cheese' }, { itemHrid: '/items/rye_flour' }];
const nameOf = (itemHrid) => itemHrid.split('/').pop().replace(/_/g, ' ');

describe('filterItemsByName', () => {
    test('a blank query returns every item, unfiltered', () => {
        expect(filterItemsByName(items, '', nameOf)).toBe(items);
        expect(filterItemsByName(items, '   ', nameOf)).toBe(items);
    });

    test('matches by substring, case-insensitively', () => {
        expect(filterItemsByName(items, 'CHEESE', nameOf)).toEqual([
            { itemHrid: '/items/cheese' },
            { itemHrid: '/items/coarse_cheese' },
        ]);
    });

    test('leading/trailing whitespace in the query is ignored', () => {
        expect(filterItemsByName(items, '  rye  ', nameOf)).toEqual([{ itemHrid: '/items/rye_flour' }]);
    });

    test('no match empties the list rather than falling back to everything', () => {
        expect(filterItemsByName(items, 'dragon scale', nameOf)).toEqual([]);
    });
});
