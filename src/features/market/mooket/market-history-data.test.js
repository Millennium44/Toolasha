/**
 * Tests for turning pooled history rows into a drawable series.
 *
 * The volume split is the part worth pinning down: the server says how much
 * traded and at what average price, never who crossed, so which side was doing
 * the trading is inferred from where in the spread that average landed.
 */

import { describe, test, expect } from 'vitest';
import { median, splitVolume, buildHistorySeries, historyLabels, freshestSighting } from './market-history-data.js';

const row = (over = {}) => ({ time: 1_700_000_000, a: 120, b: 100, p: 110, v: 100, ...over });

describe('median', () => {
    test('the middle of an odd list, and the mean of the middle two of an even one', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([1, 2, 3, 4])).toBe(2.5);
    });

    test('an empty side is not a low price', () => {
        // -1 and 0 mean nothing was listed. Counting them would drag a day's ask
        // toward zero every time the book emptied.
        expect(median([100, -1, 200])).toBe(150);
        expect(median([0, 0, 50])).toBe(50);
        expect(median([])).toBe(0);
        expect(median(null)).toBe(0);
    });

    test('one absurd listing does not move it', () => {
        // A 300-coin item listed at 40 million to see if anyone bites moves a
        // mean for the whole day and a median not at all
        expect(median([300, 310, 320, 40_000_000])).toBe(315);
    });
});

describe('splitVolume', () => {
    test('trading at the ask was buyers lifting offers', () => {
        expect(splitVolume(row({ p: 120 }))).toEqual({ atAsk: 100, atBid: 0 });
        expect(splitVolume(row({ p: 130 }))).toEqual({ atAsk: 100, atBid: 0 });
    });

    test('trading at the bid was sellers hitting them', () => {
        expect(splitVolume(row({ p: 100 }))).toEqual({ atAsk: 0, atBid: 100 });
        expect(splitVolume(row({ p: 90 }))).toEqual({ atAsk: 0, atBid: 100 });
    });

    test('in between, the split is how far up the spread it landed', () => {
        // 110 is halfway between 100 and 120
        expect(splitVolume(row({ p: 110 }))).toEqual({ atAsk: 50, atBid: 50 });
        expect(splitVolume(row({ p: 115 }))).toEqual({ atAsk: 75, atBid: 25 });
    });

    test('one side quoted leaves nothing to interpolate against', () => {
        expect(splitVolume(row({ a: -1 }))).toEqual({ atAsk: 100, atBid: 0 });
        expect(splitVolume(row({ b: -1 }))).toEqual({ atAsk: 0, atBid: 100 });
    });

    test('neither side quoted is halved, as an admission rather than a measurement', () => {
        expect(splitVolume(row({ a: -1, b: -1 }))).toEqual({ atAsk: 50, atBid: 50 });
    });

    test('nothing traded splits to nothing', () => {
        expect(splitVolume(row({ v: 0 }))).toEqual({ atAsk: 0, atBid: 0 });
        expect(splitVolume(null)).toEqual({ atAsk: 0, atBid: 0 });
    });
});

describe('buildHistorySeries', () => {
    test('a short range keeps every sighting', () => {
        const series = buildHistorySeries([row(), row({ time: 1_700_000_100 })], 1);
        expect(series).toHaveLength(2);
        expect(series[0]).toMatchObject({ ask: 120, bid: 100, avg: 110, volume: 100 });
    });

    test('sightings come back oldest first however they arrived', () => {
        const series = buildHistorySeries([row({ time: 200 }), row({ time: 100 })], 1);
        expect(series.map((point) => point.time)).toEqual([100, 200]);
    });

    test('a long range is one point per day', () => {
        const day = 24 * 60 * 60;
        const rows = [
            row({ time: day * 1, a: 100 }),
            row({ time: day * 1 + 3600, a: 200 }),
            row({ time: day * 2, a: 300 }),
        ];
        const series = buildHistorySeries(rows, 30);

        expect(series).toHaveLength(2);
        expect(series[0].ask).toBe(150); // median of 100 and 200
        expect(series[0].volume).toBe(200); // both sightings' volume
    });

    test('a grouped day is stamped with its latest sighting', () => {
        // So a part-finished day sits where it belongs on the axis rather than
        // at midnight
        const day = 24 * 60 * 60;
        const series = buildHistorySeries([row({ time: day }), row({ time: day + 3600 })], 30);
        expect(series[0].time).toBe(day + 3600);
    });

    test('anything but rows draws nothing', () => {
        expect(buildHistorySeries(null, 1)).toEqual([]);
        expect(buildHistorySeries({}, 1)).toEqual([]);
    });
});

describe('historyLabels', () => {
    test('hours within a week, dates beyond it', () => {
        const series = [{ time: 1_700_000_000 }];
        expect(historyLabels(series, 1)[0]).toMatch(/^\d{2}:\d{2}$/);
        expect(historyLabels(series, 30)[0]).toMatch(/^\d{2}\/\d{2}$/);
    });
});

describe('freshestSighting', () => {
    test('returns null for empty or non-array input', () => {
        expect(freshestSighting(null)).toBeNull();
        expect(freshestSighting([])).toBeNull();
        expect(freshestSighting(undefined)).toBeNull();
    });

    test('picks the row with the latest time and converts seconds to ms', () => {
        const rows = [
            { a: 100, b: 90, p: 95, v: 10, time: 1000 },
            { a: 110, b: 95, p: 100, v: 12, time: 3000 },
            { a: 105, b: 92, p: 98, v: 11, time: 2000 },
        ];
        expect(freshestSighting(rows)).toEqual({ time: 3000 * 1000, ask: 110, bid: 95 });
    });

    test('treats a non-positive side as no order (null), not a price of zero', () => {
        expect(freshestSighting([{ a: -1, b: 0, p: 0, v: 0, time: 5000 }])).toEqual({
            time: 5000 * 1000,
            ask: null,
            bid: null,
        });
    });

    test('skips rows whose time is unreadable', () => {
        const rows = [
            { a: 100, b: 90, time: 'not-a-date' },
            { a: 120, b: 110, time: 4000 },
        ];
        expect(freshestSighting(rows)).toEqual({ time: 4000 * 1000, ask: 120, bid: 110 });
    });
});
