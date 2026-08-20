/**
 * @vitest-environment happy-dom
 *
 * Filling a listing price the market will actually admit. The failure that
 * matters: the best standing offer sits outside the game's daily tradable
 * band (a stale order from before the band moved), and matching it fills a
 * price nobody can trade against.
 */

import { describe, test, expect } from 'vitest';

import { tradableRangeFrom, clampToRange } from './auto-fill-price.js';

describe('reading the tradable range off the modal', () => {
    test('suffixed bounds parse to real numbers', () => {
        expect(tradableRangeFrom('Tradable range: 307M – 375M')).toEqual({ min: 307_000_000, max: 375_000_000 });
        expect(tradableRangeFrom('Tradable range: 1.5K – 2K')).toEqual({ min: 1500, max: 2000 });
    });

    test('plain and separator-formatted bounds parse too', () => {
        expect(tradableRangeFrom('Tradable range: 1,200 – 1,800')).toEqual({ min: 1200, max: 1800 });
    });

    test('a hyphen instead of an en-dash still reads', () => {
        expect(tradableRangeFrom('Tradable range: 100 - 200')).toEqual({ min: 100, max: 200 });
    });

    test('a modal stating no range yields null rather than a guess', () => {
        expect(tradableRangeFrom('Price (Best Buy Offer: 300,000,000)')).toBeNull();
        expect(tradableRangeFrom('')).toBeNull();
        expect(tradableRangeFrom(null)).toBeNull();
    });

    test('an inverted band is treated as unreadable', () => {
        expect(tradableRangeFrom('Tradable range: 400M – 300M')).toBeNull();
    });
});

describe('clamping the filled price', () => {
    const range = { min: 307_000_000, max: 375_000_000 };

    test('a stale best offer under the floor lands on the floor', () => {
        // The reported case: best buy offer 300M against a 307M–375M band
        expect(clampToRange(300_000_000, range)).toBe(307_000_000);
    });

    test('a price over the ceiling lands on the ceiling', () => {
        expect(clampToRange(400_000_000, range)).toBe(375_000_000);
    });

    test('a price inside the band is left exactly as filled', () => {
        expect(clampToRange(310_000_000, range)).toBe(310_000_000);
        expect(clampToRange(307_000_000, range)).toBe(307_000_000);
        expect(clampToRange(375_000_000, range)).toBe(375_000_000);
    });
});
