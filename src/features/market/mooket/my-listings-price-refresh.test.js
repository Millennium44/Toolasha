import { describe, it, expect } from 'vitest';
import { shouldApplySighting, distinctListedItems } from './my-listings-price-refresh.js';

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
