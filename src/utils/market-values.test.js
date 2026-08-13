import { describe, test, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({ patchLive: true, payload: null, throws: false, calls: 0 }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getMarketItemValues: () => {
            mocks.calls++;
            if (mocks.throws) throw new Error('localStorage exploded');
            return mocks.payload;
        },
    },
}));
vi.mock('./server-gate.js', () => ({ isMarketplacePatchLive: () => mocks.patchLive }));

import {
    refreshMarketValues,
    marketValueFor,
    bandFromValue,
    reconcileBook,
    _resetMarketValues,
    BAND_FACTOR,
} from './market-values.js';

const payload = (version, values) => ({ marketValuesVersion: version, marketItemValues: values });

afterEach(() => {
    _resetMarketValues();
    mocks.patchLive = true;
    mocks.payload = null;
    mocks.throws = false;
    mocks.calls = 0;
    vi.restoreAllMocks();
});

describe('bandFromValue', () => {
    test('is about ±10% around the value', () => {
        const band = bandFromValue(1100);
        expect(band.min).toBeCloseTo(1100 / BAND_FACTOR, 6);
        expect(band.max).toBeCloseTo(1100 * BAND_FACTOR, 6);
    });

    test('null for a missing or non-positive value', () => {
        expect(bandFromValue(0)).toBeNull();
        expect(bandFromValue(null)).toBeNull();
        expect(bandFromValue(-5)).toBeNull();
    });
});

describe('reading the official value map', () => {
    test('marketValueFor reads the cached map by item and level', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 500, 3: 9000 } });
        refreshMarketValues(0);

        expect(marketValueFor('/items/cheese', 0)).toBe(500);
        expect(marketValueFor('/items/cheese', 3)).toBe(9000);
        expect(marketValueFor('/items/cheese', 5)).toBeNull(); // level not priced
        expect(marketValueFor('/items/unknown')).toBeNull();
    });

    test('throttles the game util between refreshes', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 500 } });
        refreshMarketValues(0);
        expect(mocks.calls).toBe(1);

        refreshMarketValues(1000); // within the interval — served from cache
        expect(mocks.calls).toBe(1);

        refreshMarketValues(40_000); // past the interval — re-reads
        expect(mocks.calls).toBe(2);
    });

    test('swaps the map only when the version changes', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 500 } });
        refreshMarketValues(0);
        expect(marketValueFor('/items/cheese')).toBe(500);

        // same version, different numbers — a re-read past the interval keeps the old map
        mocks.payload = payload(1, { '/items/cheese': { 0: 800 } });
        refreshMarketValues(40_000);
        expect(marketValueFor('/items/cheese')).toBe(500);

        // new version — the map swaps
        mocks.payload = payload(2, { '/items/cheese': { 0: 800 } });
        refreshMarketValues(80_000);
        expect(marketValueFor('/items/cheese')).toBe(800);
    });

    test('is dormant until the patch is live', () => {
        mocks.patchLive = false;
        mocks.payload = payload(1, { '/items/cheese': { 0: 500 } });

        expect(refreshMarketValues(0)).toBeNull();
        expect(mocks.calls).toBe(0); // never even reads the util
        expect(marketValueFor('/items/cheese')).toBeNull();
    });

    test('keeps the last good map if a later read throws', () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.payload = payload(1, { '/items/cheese': { 0: 500 } });
        refreshMarketValues(0);

        mocks.throws = true;
        refreshMarketValues(40_000);
        expect(marketValueFor('/items/cheese')).toBe(500);
    });
});

describe('reconcileBook', () => {
    test('passes through untouched until the patch is live', () => {
        mocks.patchLive = false;
        expect(reconcileBook(5000, 100, '/items/cheese')).toEqual({ ask: 5000, bid: 100 });
    });

    test('passes through when the item has no official value', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(reconcileBook(5000, 100, '/items/unknown')).toEqual({ ask: 5000, bid: 100 });
    });

    test('clamps stale prices into the tradable range', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);

        const { ask, bid } = reconcileBook(5000, 100, '/items/cheese');
        expect(ask).toBeCloseTo(1000 * BAND_FACTOR, 6); // pulled down to band max
        expect(bid).toBeCloseTo(1000 / BAND_FACTOR, 6); // pulled up to band min
    });

    test('leaves an in-band price alone', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(reconcileBook(1050, 950, '/items/cheese')).toEqual({ ask: 1050, bid: 950 });
    });

    test('fills a missing side with the value', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);

        expect(reconcileBook(null, 950, '/items/cheese')).toEqual({ ask: 1000, bid: 950 });
        expect(reconcileBook(1050, null, '/items/cheese')).toEqual({ ask: 1050, bid: 1000 });
        expect(reconcileBook(null, null, '/items/cheese')).toEqual({ ask: 1000, bid: 1000 });
    });
});
