import { describe, test, expect, vi, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    patchLive: true,
    september: false,
    payload: null,
    throws: false,
    calls: 0,
    handlers: new Map(),
    items: {},
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getMarketItemValues: () => {
            mocks.calls++;
            if (mocks.throws) throw new Error('localStorage exploded');
            return mocks.payload;
        },
        on: (event, handler) => mocks.handlers.set(event, handler),
        getItemDetails: (hrid) => mocks.items[hrid] ?? null,
    },
}));
vi.mock('./server-gate.js', () => ({
    isMarketplacePatchLive: () => mocks.patchLive,
    isSeptember2026MarketPatchLive: () => mocks.september,
}));

import {
    refreshMarketValues,
    marketValueFor,
    bandFromValue,
    priceIncrement,
    reconcileBook,
    clampToBand,
    applyMarketValuesMessage,
    nextPriceUp,
    nextPriceDown,
    _resetMarketValues,
} from './market-values.js';

const payload = (version, values) => ({ marketValuesVersion: version, marketItemValues: values });

afterEach(() => {
    _resetMarketValues();
    mocks.patchLive = true;
    mocks.september = false;
    mocks.items = {};
    vi.useRealTimers();
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

describe('priceIncrement under the September 2026 market patch (test server)', () => {
    // Every expected gap below is the client's binGap(price, enhLevel) from the
    // test-server bundle, evaluated on the same price.
    test.each([
        [7, 1, 1],
        [99, 1, 1],
        [100, 1, 2],
        [399, 1, 5],
        [400, 2, 10],
        [799, 2, 10],
        [800, 4, 20],
        [999, 4, 20],
        [1000, 4, 20],
        [1199, 4, 20],
        [1200, 5, 25],
        [1499, 5, 25],
        [1500, 6, 30],
        [1800, 8, 40],
        [2400, 10, 50],
        [3000, 12, 60],
        [3600, 16, 80],
        [4800, 20, 100],
        [6000, 25, 125],
        [7500, 30, 150],
        [8999, 30, 150],
        [9000, 40, 200],
        [9999, 40, 200],
        [10000, 40, 200],
        [11999, 40, 200],
        [12000, 50, 250],
        [123456, 500, 2500],
        [1234567, 5000, 25000],
    ])('%i: gap %i unenhanced, %i enhanced', (price, plain, enhanced) => {
        mocks.september = true;
        expect(priceIncrement(price)).toBe(plain);
        expect(priceIncrement(price, 0)).toBe(plain);
        expect(priceIncrement(price, 1)).toBe(enhanced);
        expect(priceIncrement(price, 10)).toBe(enhanced);
    });

    test('three-digit enhanced prices use their own table, not 5x', () => {
        mocks.september = true;
        expect([150, 250, 350, 450, 750, 850].map((p) => priceIncrement(p, 3))).toEqual([2, 5, 5, 10, 10, 20]);
    });

    test('fractions floor first, and the floor of 1 holds', () => {
        mocks.september = true;
        expect(priceIncrement(1199.9)).toBe(4);
        expect(priceIncrement(0)).toBe(1);
        expect(priceIncrement(-3, 5)).toBe(1);
    });

    test('the earlier ladder ignores enhancement level on live', () => {
        expect(priceIncrement(1000, 5)).toBe(5);
        expect(priceIncrement(150, 5)).toBe(1);
        expect(priceIncrement(44671, 12)).toBe(100);
    });
});

describe('nextPriceUp / nextPriceDown under the September 2026 market patch', () => {
    test('steps by the new gap, snapping to a multiple like getBinnedPrice', () => {
        mocks.september = true;
        // getBinnedPrice(1003, roundUp) = 1004; getBinnedPrice(1003) = 1000
        expect(nextPriceUp(1003)).toBe(1004);
        expect(nextPriceDown(1003)).toBe(1000);
        expect(nextPriceUp(1000)).toBe(1004);
        expect(nextPriceDown(1004)).toBe(1000);
        expect(nextPriceUp(123456)).toBe(123500);
        expect(nextPriceDown(123456)).toBe(123000);
    });

    test('an enhanced item steps five times as far', () => {
        mocks.september = true;
        expect(nextPriceUp(1000, 1)).toBe(1020);
        expect(nextPriceDown(1020, 1)).toBe(1000);
        expect(nextPriceUp(123456, 7)).toBe(125000);
        expect(nextPriceDown(123456, 7)).toBe(122500);
    });

    test('tier boundaries are reached exactly from either side', () => {
        mocks.september = true;
        expect(nextPriceUp(999)).toBe(1000);
        expect(nextPriceUp(1198)).toBe(1200);
        expect(nextPriceDown(1200)).toBe(1196);
        expect(nextPriceDown(1000)).toBe(996);
        expect(nextPriceUp(9960)).toBe(10000);
        expect(nextPriceDown(10000)).toBe(9960);
        expect(nextPriceUp(990, 2)).toBe(1000);
        expect(nextPriceDown(1000, 2)).toBe(980);
        expect(nextPriceUp(7480, 1)).toBe(7500);
        expect(nextPriceDown(7500, 1)).toBe(7375);
    });

    test('every price a step lands on is a valid bin (price % gap === 0)', () => {
        mocks.september = true;
        for (const level of [0, 1]) {
            let price = 2;
            while (price < 2_000_000) {
                price = nextPriceUp(price, level);
                expect(price % priceIncrement(price, level)).toBe(0);
                expect(nextPriceUp(nextPriceDown(price, level), level)).toBe(price);
            }
        }
    });
});

describe('nextPriceUp / nextPriceDown', () => {
    test('one step along the ladder inside a tier', () => {
        expect(nextPriceUp(1000)).toBe(1005);
        expect(nextPriceDown(1005)).toBe(1000);
        expect(nextPriceUp(44600)).toBe(44700);
        expect(nextPriceDown(44700)).toBe(44600);
        expect(nextPriceUp(600)).toBe(602);
        expect(nextPriceDown(602)).toBe(600);
    });

    test('crossing up into a coarser tier lands on the boundary, not past it', () => {
        expect(nextPriceUp(999)).toBe(1000);
        expect(nextPriceUp(998)).toBe(1000);
        expect(nextPriceUp(499)).toBe(500);
        expect(nextPriceUp(2995)).toBe(3000);
        expect(nextPriceUp(4990)).toBe(5000);
        expect(nextPriceUp(9980)).toBe(10000);
    });

    test('crossing down into a finer tier uses the finer step', () => {
        expect(nextPriceDown(1000)).toBe(998);
        expect(nextPriceDown(500)).toBe(499);
        expect(nextPriceDown(3000)).toBe(2995);
        expect(nextPriceDown(5000)).toBe(4990);
        expect(nextPriceDown(10000)).toBe(9980);
    });

    test('an off-ladder price snaps to the neighbouring ladder price', () => {
        expect(nextPriceUp(1001)).toBe(1005);
        expect(nextPriceDown(1003)).toBe(1000);
        expect(nextPriceDown(999)).toBe(998);
    });

    test('small prices step by one and never go below 1', () => {
        expect(nextPriceUp(1)).toBe(2);
        expect(nextPriceUp(7)).toBe(8);
        expect(nextPriceDown(8)).toBe(7);
        expect(nextPriceDown(2)).toBe(1);
        expect(nextPriceDown(1)).toBe(1);
        expect(nextPriceUp(0)).toBe(1);
    });

    test('fractions stay on the correct side of the price', () => {
        expect(nextPriceUp(999.5)).toBe(1000);
        expect(nextPriceDown(1000.5)).toBe(1000);
    });
});

describe('bandFromValue under the September 2026 market patch', () => {
    test('snaps outward on the new ladder and widens by one of its steps', () => {
        mocks.september = true;
        // 1100: raw max 1210 (on a gap-5 bin) + 5; raw min 999.99... at gap 4 -> 996 - 4
        expect(bandFromValue(1100)).toEqual({ min: 992, max: 1215 });
        // enhanced: raw max 1210 at gap 25 -> 1225 + 25; raw min at gap 20 -> 980 - 20
        expect(bandFromValue(1100, 3)).toEqual({ min: 960, max: 1250 });
    });

    test('the level reaches the band through clampToBand', () => {
        mocks.september = true;
        mocks.payload = payload(1, { '/items/sword': { 0: 1100, 3: 1100 } });
        expect(clampToBand(2000, '/items/sword', 0)).toBe(1215);
        expect(clampToBand(2000, '/items/sword', 3)).toBe(1250);
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

/**
 * The ladder's floating-point behaviour is the game's, not an error to correct.
 *
 * `value * 1.1` and `value / 1.1` are inexact for most values — 1821000 * 1.1 is
 * 2003100.0000000002, and 100000 * 1.1 is 110000.00000000001 — so `Math.ceil`
 * over the increment lands a whole tick wider than exact arithmetic would. That
 * looks like a bug worth fixing, and an audit did write the epsilon correction
 * before reverting it.
 *
 * Reverting was right, and this is the measurement that settles it. On
 * 2026-09-08 the live client showed **"Tradable range: 1650K – 2010K"** for
 * White Key Fragment at a published value of 1,821,000 — both ends exactly what
 * this module already returns. Exact arithmetic gives 1,655,455 and 2,003,100,
 * and the game shows neither. The ladder was read out of the game's own bundle,
 * which is JavaScript and hits the identical artefact, so reproducing it is what
 * being right means here.
 *
 * It is not rare: of 356 distinct unenhanced items in one real inventory, 87 —
 * about a quarter — have a value where this bites. An epsilon "fix" would put
 * this module at odds with the game on all of them, and in the unsafe direction
 * on the max side, where a too-narrow band would reject a price the game accepts.
 */
describe('the band reproduces the game, floating point and all', () => {
    test('a live-measured band matches on both ends', () => {
        expect(bandFromValue(1821000)).toEqual({ min: 1650000, max: 2010000 });
    });

    test('and exact arithmetic would disagree with the game on both', () => {
        // Stated so a future reader can see what the "correction" would produce
        const band = bandFromValue(1821000);
        expect(band.max).not.toBe(2003100);
        expect(band.min).not.toBe(1655455);
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

    test('a price of 0 reads as absent, not band.min — nothing trades at 0', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        // Value 1000 under the increment ladder: [906, 1105] — a naive clamp
        // would pull 0 up to 906, a price no order ever offered.
        expect(clampToBand(0, '/items/cheese')).toBeNull();
    });

    test('a negative price reads as absent too, not passed through raw', () => {
        // Nothing in the game ever quotes a negative price, but the function
        // used to hand one straight back unchanged — coherent with treating 0
        // as absent would be treating every non-positive price the same way.
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(clampToBand(-5, '/items/cheese')).toBeNull();
    });
});

describe('reconcileBook', () => {
    test('passes through untouched until the patch is live', () => {
        mocks.patchLive = false;
        expect(reconcileBook(5000, 100, '/items/cheese')).toEqual({
            ask: 5000,
            bid: 100,
            askSource: 'book',
            bidSource: 'book',
        });
    });

    test('passes through when the item has no official value', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);
        expect(reconcileBook(5000, 100, '/items/unknown')).toEqual({
            ask: 5000,
            bid: 100,
            askSource: 'book',
            bidSource: 'book',
        });
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
        expect(reconcileBook(1050, 950, '/items/cheese')).toEqual({
            ask: 1050,
            bid: 950,
            askSource: 'book',
            bidSource: 'book',
        });
    });

    test('fills a missing side with the value', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);

        expect(reconcileBook(null, 950, '/items/cheese')).toEqual({
            ask: 1000,
            bid: 950,
            askSource: 'value',
            bidSource: 'book',
        });
        expect(reconcileBook(1050, null, '/items/cheese')).toEqual({
            ask: 1050,
            bid: 1000,
            askSource: 'book',
            bidSource: 'value',
        });
        expect(reconcileBook(null, null, '/items/cheese')).toEqual({
            ask: 1000,
            bid: 1000,
            askSource: 'value',
            bidSource: 'value',
        });
    });

    test('a value-filled side is marked as such, so callers can tell an estimate from a quote', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);

        // A clamp is still the book speaking — the price moved, the source did not
        const clamped = reconcileBook(5000, null, '/items/cheese');
        expect(clamped.askSource).toBe('book');
        expect(clamped.bidSource).toBe('value');
    });

    test('a raw side of 0 is treated as missing and filled from the value, not clamped to band.min', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        refreshMarketValues(0);

        expect(reconcileBook(0, 950, '/items/cheese')).toEqual({
            ask: 1000,
            bid: 950,
            askSource: 'value',
            bidSource: 'book',
        });
        expect(reconcileBook(1050, 0, '/items/cheese')).toEqual({
            ask: 1050,
            bid: 1000,
            askSource: 'book',
            bidSource: 'value',
        });
    });
});

describe('band memo', () => {
    test('reuses the band for an item and level while the value map stands, and recomputes when it swaps', () => {
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000, 2: 5000 } });
        refreshMarketValues(0);
        const band = bandFromValue(1000);
        // Two clamps hit the same memo; the arithmetic is not run again
        const spy = vi.spyOn(Math, 'ceil');
        expect(clampToBand(band.max + 500, '/items/cheese', 0)).toBe(band.max);
        const callsAfterFirst = spy.mock.calls.length;
        expect(clampToBand(band.min - 500, '/items/cheese', 0)).toBe(band.min);
        expect(reconcileBook(band.max + 500, null, '/items/cheese', 0)).toEqual({
            ask: band.max,
            bid: 1000,
            askSource: 'book',
            bidSource: 'value',
        });
        expect(spy.mock.calls.length).toBe(callsAfterFirst);
        // Another level is its own memo
        expect(clampToBand(1, '/items/cheese', 2)).toBe(bandFromValue(5000).min);

        // A new value map retires the memo: the band follows the new value
        mocks.payload = payload(2, { '/items/cheese': { 0: 2000 } });
        // clampToBand refreshed with the real clock, so step past the interval from there
        refreshMarketValues(Date.now() + 40_000);
        const next = bandFromValue(2000);
        expect(clampToBand(next.max + 500, '/items/cheese', 0)).toBe(next.max);
        expect(clampToBand(1, '/items/cheese', 0)).toBe(next.min);
        // And a level the new map no longer prices is a pass-through again
        expect(clampToBand(1, '/items/cheese', 2)).toBe(1);
    });
});

describe('applyMarketValuesMessage', () => {
    test('a pushed payload swaps the map without a localStorage read', () => {
        expect(applyMarketValuesMessage(payload(7, { '/items/log': { 0: 200 } }))).toBe(true);
        expect(marketValueFor('/items/log')).toBe(200);
        expect(mocks.calls).toBe(0);
    });

    test('the pushed version wins over an identical stale one in localStorage', () => {
        // A localStorage map still on version 7 must not overwrite the pushed
        // one: the guard is by version, so re-reading has to be a no-op.
        applyMarketValuesMessage(payload(7, { '/items/log': { 0: 200 } }));
        mocks.payload = payload(7, { '/items/log': { 0: 1 } });
        refreshMarketValues(Date.now() + 60_000);
        expect(marketValueFor('/items/log')).toBe(200);
    });

    test.each([6, null])('a stored version %s cannot replace a newer pushed value map', (version) => {
        const now = Date.now();
        applyMarketValuesMessage(payload(7, { '/items/log': { 0: 1000 } }));
        const currentBand = bandFromValue(1000);
        expect(clampToBand(5000, '/items/log')).toBe(currentBand.max);

        mocks.payload = payload(version, { '/items/log': { 0: 100 } });
        refreshMarketValues(now + 60_000);
        expect(marketValueFor('/items/log')).toBe(1000);
        expect(clampToBand(5000, '/items/log')).toBe(currentBand.max);

        // Retaining the pushed map must not prevent a later stored update.
        mocks.payload = payload(8, { '/items/log': { 0: 2000 } });
        refreshMarketValues(now + 120_000);
        expect(marketValueFor('/items/log')).toBe(2000);
        expect(clampToBand(5000, '/items/log')).toBe(bandFromValue(2000).max);
    });

    test('a consumer memoised on the old version recomputes', () => {
        applyMarketValuesMessage(payload(1, { '/items/log': { 0: 1000 } }));
        const before = clampToBand(5000, '/items/log');
        expect(before).toBeLessThan(5000); // clamped into the ~1000 band
        applyMarketValuesMessage(payload(2, { '/items/log': { 0: 5000 } }));
        // The band cache is derived from the map, so it must have been dropped
        expect(clampToBand(5000, '/items/log')).toBe(5000);
    });

    test('a payload with no map is ignored rather than blanking the cache', () => {
        applyMarketValuesMessage(payload(1, { '/items/log': { 0: 1000 } }));
        expect(applyMarketValuesMessage({ marketValuesVersion: 2 })).toBe(false);
        expect(applyMarketValuesMessage(undefined)).toBe(false);
        expect(applyMarketValuesMessage({ marketValuesVersion: 2, marketItemValues: 'nope' })).toBe(false);
        expect(marketValueFor('/items/log')).toBe(1000);
    });

    test('an empty map is ignored rather than blanking every official value', () => {
        // {} is truthy and typeof 'object', so a naive `!values` guard lets it
        // through — exactly the payload that would blank the whole cache.
        applyMarketValuesMessage(payload(1, { '/items/log': { 0: 1000 } }));
        expect(applyMarketValuesMessage(payload(2, {}))).toBe(false);
        expect(marketValueFor('/items/log')).toBe(1000);
    });

    test('an array payload is ignored rather than accepted as a map', () => {
        // Arrays are typeof 'object' too, so this also slips past a naive guard.
        applyMarketValuesMessage(payload(1, { '/items/log': { 0: 1000 } }));
        expect(applyMarketValuesMessage(payload(2, []))).toBe(false);
        expect(marketValueFor('/items/log')).toBe(1000);
    });

    test('a payload older than the cached version does not downgrade it', () => {
        applyMarketValuesMessage(payload(5, { '/items/log': { 0: 1000 } }));
        expect(applyMarketValuesMessage(payload(3, { '/items/log': { 0: 1 } }))).toBe(false);
        expect(marketValueFor('/items/log')).toBe(1000);
    });

    test('the very first push applies even with no cached version to compare against', () => {
        expect(applyMarketValuesMessage(payload(1, { '/items/log': { 0: 42 } }))).toBe(true);
        expect(marketValueFor('/items/log')).toBe(42);
    });

    test('the module subscribes to the pushed message', () => {
        const handler = mocks.handlers.get('market_item_values_updated');
        expect(typeof handler).toBe('function');
        handler(payload(3, { '/items/log': { 0: 42 } }));
        expect(marketValueFor('/items/log')).toBe(42);
    });
});

describe('the band against the game on the test server (2026-09-25)', () => {
    // [item, level, market value, vendor sell price, game priceBandMins, game priceBandMaxs],
    // read off market_item_order_books_updated payloads on test.milkywayidle.com
    test.each([
        ['holy_cheese', 0, 460, 0, 416, 510],
        ['cheese', 0, 67, 0, 59, 75],
        ['rainbow_sword', 0, 274766.92, 0, 248000, 303600],
        ['rainbow_sword', 1, 335409.52, 0, 295000, 384000],
        ['rainbow_sword', 2, 405547.12, 0, 360000, 456000],
        ['holy_sword', 0, 863090.12, 0, 780000, 956000],
        ['holy_sword', 1, 863365.59, 0, 765000, 980000],
        ['holy_sword', 2, 857166.8, 0, 750000, 980000],
        ['star_fragment', 0, 100.55, 100, 100, 112],
    ])('%s +%i (value %d)', (item, level, value, vendor, min, max) => {
        mocks.september = true;
        expect(bandFromValue(value, level, vendor)).toEqual({ min, max });
    });

    test('the min widens by the gap below the snapped edge, not the raw figure', () => {
        mocks.september = true;
        // raw min 304,917 snaps to 300,000 on its 6,000 gap; one bin below is 295,000
        expect(bandFromValue(335409.52, 1).min).toBe(295000);
    });

    test('the vendor floor reaches clampToBand through the item data', () => {
        mocks.september = true;
        mocks.items['/items/star_fragment'] = { sellPrice: 100 };
        mocks.payload = payload(1, { '/items/star_fragment': { 0: 100.55 } });
        expect(clampToBand(50, '/items/star_fragment')).toBe(100);
    });

    test('on live the earlier edge rule and no vendor floor stand', () => {
        expect(bandFromValue(100.55, 0, 100)).toEqual({ min: 90, max: 112 });
        expect(bandFromValue(1100)).toEqual({ min: 996, max: 1215 });
    });
});

describe('the band pushed with an order book', () => {
    const push = (itemHrid, mins, maxs) =>
        mocks.handlers.get('market_item_order_books_updated')({
            type: 'market_item_order_books_updated',
            marketItemOrderBooks: { itemHrid, orderBooks: [], priceBandMins: mins, priceBandMaxs: maxs },
        });

    test('is preferred over the computed band, per level', () => {
        mocks.payload = payload(1, { '/items/rainbow_sword': { 0: 274766.92, 1: 335409.52 } });
        push('/items/rainbow_sword', { 0: 250000, 1: 297000 }, { 0: 300000, 1: 380000 });
        expect(clampToBand(1, '/items/rainbow_sword', 0)).toBe(250000);
        expect(clampToBand(9e9, '/items/rainbow_sword', 1)).toBe(380000);
        expect(reconcileBook(9e9, 1, '/items/rainbow_sword', 1)).toMatchObject({ ask: 380000, bid: 297000 });
    });

    test('clamps an item with no official value, without inventing a missing side', () => {
        push('/items/new_thing', { 0: 100 }, { 0: 200 });
        expect(clampToBand(500, '/items/new_thing')).toBe(200);
        expect(reconcileBook(500, null, '/items/new_thing')).toEqual({
            ask: 200,
            bid: null,
            askSource: 'book',
            bidSource: null,
        });
    });

    test('goes stale after an hour and falls back to the computed band', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000_000_000);
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        push('/items/cheese', { 0: 950 }, { 0: 1050 });
        expect(clampToBand(5000, '/items/cheese')).toBe(1050);
        vi.setSystemTime(1_000_000_000_000 + 61 * 60_000);
        expect(clampToBand(5000, '/items/cheese')).toBe(1105);
    });

    test('skips missing, non-positive or inverted bounds', () => {
        push('/items/cheese', { 0: 0, 1: 300, 2: 100 }, { 0: 200, 1: 200 });
        expect(clampToBand(5000, '/items/cheese', 0)).toBe(5000);
        expect(clampToBand(5000, '/items/cheese', 1)).toBe(5000);
        expect(clampToBand(5000, '/items/cheese', 2)).toBe(5000);
    });
});

describe('books that mix old-grid and new-grid prices (test server)', () => {
    // Listings placed before the patch keep their prices, so a book can hold
    // prices that are not bins under the new rules.
    test('undercutting or outbidding an off-grid price lands on the nearest new bin past it', () => {
        mocks.september = true;
        expect(nextPriceDown(1003)).toBe(1000);
        expect(nextPriceUp(1003)).toBe(1004);
        expect(nextPriceDown(1005)).toBe(1004);
        expect(nextPriceUp(1005)).toBe(1008);
        expect(nextPriceDown(2995)).toBe(2990);
        expect(nextPriceUp(2995)).toBe(3000);
        expect(nextPriceDown(44700)).toBe(44640);
        expect(nextPriceUp(44700)).toBe(44800);
        expect(nextPriceDown(1003, 1)).toBe(1000);
        expect(nextPriceUp(1003, 1)).toBe(1020);
    });

    test('from every old-ladder price, the step lands on the nearest valid new bin past it', () => {
        mocks.september = false;
        const oldLadder = [];
        for (let price = 100; price < 200000; price = nextPriceUp(price)) oldLadder.push(price);
        mocks.september = true;
        for (const level of [0, 3]) {
            for (const price of oldLadder) {
                const up = nextPriceUp(price, level);
                const down = nextPriceDown(price, level);
                expect(up).toBeGreaterThan(price);
                expect(down).toBeLessThan(price);
                expect(up % priceIncrement(up, level)).toBe(0);
                expect(down % priceIncrement(down, level)).toBe(0);
                // nothing valid is skipped: the bin before `up` and after `down` are not past `price`
                expect(nextPriceDown(up, level)).toBeLessThanOrEqual(price);
                expect(nextPriceUp(down, level)).toBeGreaterThanOrEqual(price);
            }
        }
    });

    test('clamping and reconciling leave an off-grid book price as it is', () => {
        mocks.september = true;
        mocks.payload = payload(1, { '/items/cheese': { 0: 1000 } });
        expect(clampToBand(1003, '/items/cheese')).toBe(1003);
        expect(reconcileBook(1005, 995, '/items/cheese')).toMatchObject({ ask: 1005, bid: 995 });
    });
});
