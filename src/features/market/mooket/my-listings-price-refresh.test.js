import { describe, it, expect } from 'vitest';
import { freshestSighting, shouldApplySighting, distinctListedItems } from './my-listings-price-refresh.js';

describe('freshestSighting', () => {
    it('returns null for empty or non-array input', () => {
        expect(freshestSighting(null)).toBeNull();
        expect(freshestSighting([])).toBeNull();
        expect(freshestSighting(undefined)).toBeNull();
    });

    it('picks the row with the latest time and converts seconds to ms', () => {
        const rows = [
            { a: 100, b: 90, p: 95, v: 10, time: 1000 },
            { a: 110, b: 95, p: 100, v: 12, time: 3000 },
            { a: 105, b: 92, p: 98, v: 11, time: 2000 },
        ];
        expect(freshestSighting(rows)).toEqual({ time: 3000 * 1000, ask: 110, bid: 95 });
    });

    it('treats a non-positive side as no order (null), not a price of zero', () => {
        const rows = [{ a: -1, b: 0, p: 0, v: 0, time: 5000 }];
        expect(freshestSighting(rows)).toEqual({ time: 5000 * 1000, ask: null, bid: null });
    });

    it('skips rows whose time is unreadable', () => {
        const rows = [
            { a: 100, b: 90, time: 'not-a-date' },
            { a: 120, b: 110, time: 4000 },
        ];
        expect(freshestSighting(rows)).toEqual({ time: 4000 * 1000, ask: 120, bid: 110 });
    });
});

describe('shouldApplySighting', () => {
    it('applies a sighting that is strictly newer than the snapshot', () => {
        expect(shouldApplySighting(2000, 1000)).toBe(true);
    });

    it('leaves an equal or older sighting alone — not a refresh', () => {
        expect(shouldApplySighting(1000, 1000)).toBe(false);
        expect(shouldApplySighting(500, 1000)).toBe(false);
    });

    it('applies any sighting when there is no snapshot to protect', () => {
        expect(shouldApplySighting(1234, null)).toBe(true);
    });

    it('rejects an unusable sighting time', () => {
        expect(shouldApplySighting(0, null)).toBe(false);
        expect(shouldApplySighting(-5, null)).toBe(false);
        expect(shouldApplySighting(NaN, 1000)).toBe(false);
    });
});

describe('distinctListedItems', () => {
    // A minimal stand-in for a table row: a use[href] icon and an optional badge
    const makeRow = (iconId, level) => ({
        querySelectorAll: (sel) => (sel === 'use' ? [{ href: { baseVal: `sprite.svg#${iconId}` } }] : []),
        querySelector: (sel) => (sel.includes('enhancementLevel') && level ? { textContent: `+${level}` } : null),
    });

    it('reads the item hrid and enhancement level off a row', () => {
        expect(distinctListedItems([makeRow('cheese', 0)])).toEqual([
            { itemHrid: '/items/cheese', enhancementLevel: 0 },
        ]);
        expect(distinctListedItems([makeRow('sword', 7)])).toEqual([{ itemHrid: '/items/sword', enhancementLevel: 7 }]);
    });

    it('dedupes by item and enhancement level, keeping levels distinct', () => {
        const rows = [makeRow('cheese', 0), makeRow('cheese', 0), makeRow('cheese', 5)];
        expect(distinctListedItems(rows)).toEqual([
            { itemHrid: '/items/cheese', enhancementLevel: 0 },
            { itemHrid: '/items/cheese', enhancementLevel: 5 },
        ]);
    });

    it('skips a coin icon (the price column) and rows with no item icon', () => {
        const coinRow = makeRow('coin', 0);
        const emptyRow = { querySelectorAll: () => [], querySelector: () => null };
        expect(distinctListedItems([coinRow, emptyRow])).toEqual([]);
    });
});
