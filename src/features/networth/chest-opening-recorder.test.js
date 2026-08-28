/**
 * The fold is the whole arithmetic of this recorder — everything else is
 * storage plumbing already covered where it lives — so that is what is tested
 * here: several openings of the same chest have to accumulate rather than
 * replace, and a message that says nothing must not create a row that claims
 * something.
 */

import { describe, test, expect } from 'vitest';
import { foldOpening } from './chest-opening-recorder.js';

/** A blank day row */
const row = () => ({ d: '2026-08-20', openings: {} });

describe('foldOpening', () => {
    test('records how many were opened and everything that came out', () => {
        const day = foldOpening(row(), '/items/purple_chest', 2, [
            { itemHrid: '/items/cheese', count: 10 },
            { itemHrid: '/items/coin', count: 500 },
        ]);

        expect(day.openings['/items/purple_chest']).toEqual({
            count: 2,
            gained: { '/items/cheese': 10, '/items/coin': 500 },
        });
    });

    test('a second opening of the same chest adds to the first', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [{ itemHrid: '/items/cheese', count: 4 }]);
        foldOpening(day, '/items/purple_chest', 3, [
            { itemHrid: '/items/cheese', count: 6 },
            { itemHrid: '/items/milk', count: 1 },
        ]);

        expect(day.openings['/items/purple_chest']).toEqual({
            count: 4,
            gained: { '/items/cheese': 10, '/items/milk': 1 },
        });
    });

    test('different chests are kept apart, because they are priced apart', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [{ itemHrid: '/items/cheese', count: 1 }]);
        foldOpening(day, '/items/blue_chest', 5, [{ itemHrid: '/items/milk', count: 2 }]);

        expect(Object.keys(day.openings)).toEqual(['/items/purple_chest', '/items/blue_chest']);
        expect(day.openings['/items/blue_chest'].count).toBe(5);
    });

    test('an opening that paid nothing is still an opening, and costs what it cost', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, []);
        expect(day.openings['/items/purple_chest']).toEqual({ count: 1, gained: {} });
    });

    test('a message with no chest or no count leaves the row untouched', () => {
        expect(foldOpening(row(), '', 2, []).openings).toEqual({});
        expect(foldOpening(row(), '/items/purple_chest', 0, []).openings).toEqual({});
        expect(foldOpening(row(), '/items/purple_chest', undefined, []).openings).toEqual({});
    });

    test('a nameless or empty gained entry is skipped rather than counted as one', () => {
        const day = foldOpening(row(), '/items/purple_chest', 1, [
            { count: 5 },
            { itemHrid: '/items/cheese', count: 0 },
            { itemHrid: '/items/milk', count: 2 },
        ]);
        expect(day.openings['/items/purple_chest'].gained).toEqual({ '/items/milk': 2 });
    });
});
