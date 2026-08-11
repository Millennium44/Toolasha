import { describe, it, expect } from 'vitest';
import { freshestSighting, fresherSide } from './live-price-check.js';

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

    it('parses a date-string time into ms', () => {
        const rows = [{ a: 50, b: 45, time: '2026-01-01T00:00:00Z' }];
        expect(freshestSighting(rows)).toEqual({
            time: Date.parse('2026-01-01T00:00:00Z'),
            ask: 50,
            bid: 45,
        });
    });
});

describe('fresherSide', () => {
    it('picks the smaller age when both are present', () => {
        expect(fresherSide(60_000, 10_000)).toBe('mooket');
        expect(fresherSide(10_000, 60_000)).toBe('game');
    });

    it('breaks a tie in favour of the game snapshot', () => {
        // Equal ages are not a win for Mooket — only a strictly newer sighting is
        expect(fresherSide(30_000, 30_000)).toBe('game');
    });

    it('returns the side that has a reading when the other is missing', () => {
        expect(fresherSide(null, 10_000)).toBe('mooket');
        expect(fresherSide(10_000, null)).toBe('game');
    });

    it('returns null when neither side has a usable age', () => {
        expect(fresherSide(null, null)).toBeNull();
        expect(fresherSide(-1, -1)).toBeNull();
    });
});
