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
    priceIncrement,
    reconcileBook,
    clampToBand,
    _resetMarketValues,
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

describe('priceIncrement', () => {
    test("the ladder matches the game's getBinnedPrice tiering", () => {
        // first digit 1-2: 5x10^(d-4); 3-4: 10^(d-3); 5-9: 2x10^(d-3); floor 1
        expect(priceIncrement(7)).toBe(1);
        expect(priceIncrement(117)).toBe(1);
        expect(priceIncrement(450)).toBe(1);
        expect(priceIncrement(500)).toBe(2);
        expect(priceIncrement(1000)).toBe(5);
        expect(priceIncrement(2999)).toBe(5);
        expect(priceIncrement(3000)).toBe(10);
        expect(priceIncrement(5000)).toBe(20);
        expect(priceIncrement(44671)).toBe(100);
        expect(priceIncrement(339020)).toBe(1000);
        expect(priceIncrement(33110000000)).toBe(100000000);
    });
});

describe('bandFromValue', () => {
    test('reproduces the live band bounds measured across nine decades of price', () => {
        // Exact bands read off the test server 8/18/2026, fully recalibrated
        expect(bandFromValue(16)).toEqual({ min: 13, max: 19 }); // strawberry
        expect(bandFromValue(107)).toEqual({ min: 96, max: 119 }); // burble cheese
        expect(bandFromValue(40610)).toEqual({ min: 36800, max: 44800 }); // revive
        expect(bandFromValue(308200)).toEqual({ min: 279500, max: 341000 }); // royal cloth
        expect(bandFromValue(30100000000)).toEqual({ min: 27300000000, max: 33300000000 }); // umbral tunic
        expect(bandFromValue(474200000000)).toEqual({ min: 430000000000, max: 524000000000 }); // adv. defense charm
    });

    test('one increment wider than the snapped-outward ten percent on each side', () => {
        // 1100: raw max 1210 at step 5 -> 1215. The raw min is 1100/1.1 =
        // 999.999... in floats, landing a ladder tier down (step 2) -> 996 —
        // one coin narrower than exact-arithmetic 995, which errs safe
        expect(bandFromValue(1100)).toEqual({ min: 996, max: 1215 });
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

describe('clampToBand', () => {
    test('passes through untouched until the patch is live', () => {
        mocks.patchLive = false;
        expect(clampToBand(5000, '/items/cheese')).toBe(5000);
    });

    test('passes through when the item has no official value', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(clampToBand(5000, '/items/unknown')).toBe(5000);
    });

    test('clamps an out-of-band price to the nearest edge', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        // Value 1000 under the increment ladder: [906, 1105]
        expect(clampToBand(5000, '/items/cheese')).toBe(1105);
        expect(clampToBand(100, '/items/cheese')).toBe(906);
    });

    test('leaves an in-band price alone and never invents one', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(clampToBand(1050, '/items/cheese')).toBe(1050);
        // A missing price stays missing — null means "no market" to callers
        expect(clampToBand(null, '/items/cheese')).toBeNull();
        expect(clampToBand(undefined, '/items/cheese')).toBeNull();
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
        expect(ask).toBe(1105); // pulled down to band max
        expect(bid).toBe(906); // pulled up to band min
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
