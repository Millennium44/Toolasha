/**
 * Trade Ledger View — the item-name filter box.
 *
 * The modal itself is a lot of DOM chrome shared with the Market History
 * viewer; this only exercises the pure predicate the filter box and the CSV
 * export both run through, so it stays testable without building the modal.
 */

import { describe, test, expect } from 'vitest';
import { filterItemsByName, summarizeItems } from './trade-ledger-view.js';

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

describe('summarizeItems', () => {
    test('an empty set summarizes to null, not zeroes', () => {
        expect(summarizeItems([])).toBeNull();
        expect(summarizeItems(null)).toBeNull();
    });

    test('sums bought/sold quantity and coins across rows', () => {
        const rows = [
            {
                boughtQty: 10,
                boughtCoins: 1000,
                soldQty: 4,
                soldCoinsNet: 480,
                realizedProfit: 80,
                unmatchedRevenue: 0,
            },
            { boughtQty: 5, boughtCoins: 600, soldQty: 5, soldCoinsNet: 700, realizedProfit: 100, unmatchedRevenue: 0 },
        ];
        expect(summarizeItems(rows)).toEqual({
            boughtQty: 15,
            boughtCoins: 1600,
            soldQty: 9,
            soldCoinsNet: 1180,
            realizedProfit: 180,
            unmatchedRevenue: 0,
        });
    });

    test('realized profit is null when no row has a ledger-known cost, not zero', () => {
        const rows = [
            {
                boughtQty: 0,
                boughtCoins: 0,
                soldQty: 3,
                soldCoinsNet: 300,
                realizedProfit: null,
                unmatchedRevenue: 300,
            },
        ];
        expect(summarizeItems(rows).realizedProfit).toBeNull();
        expect(summarizeItems(rows).unmatchedRevenue).toBe(300);
    });

    test('rows with a known cost and rows without both contribute, only the known ones to realized profit', () => {
        const rows = [
            { boughtQty: 2, boughtCoins: 200, soldQty: 2, soldCoinsNet: 240, realizedProfit: 40, unmatchedRevenue: 0 },
            { boughtQty: 0, boughtCoins: 0, soldQty: 1, soldCoinsNet: 90, realizedProfit: null, unmatchedRevenue: 90 },
        ];
        const totals = summarizeItems(rows);
        expect(totals.realizedProfit).toBe(40);
        expect(totals.unmatchedRevenue).toBe(90);
        expect(totals.soldQty).toBe(3);
    });
});
