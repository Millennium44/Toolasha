/**
 * Tests for grouping the history chart's series into time buckets, and the axis
 * helpers that go with it. The worst failures guarded here: a missing price or
 * volume drawn as 0, and a grouped value presented as an exact trade.
 */

import { describe, test, expect } from 'vitest';
import {
    buildHistorySeries,
    historyLabels,
    tooltipFooterLines,
    groupSeries,
    groupedTitle,
    normalizeGroupHours,
    chartExtents,
    priceTickLabel,
} from './market-history-data.js';

const row = (over = {}) => ({ time: 1_700_000_000, a: 120, b: 100, p: 110, v: 100, ...over });

describe('missing volume is null, not 0', () => {
    test('a reading with no v has a null volume and split; a real 0 stays 0', () => {
        const noV = { time: 100, a: 10, b: 8, p: 9 };
        const [missing, zero] = buildHistorySeries([noV, row({ time: 200, v: 0 })], 1);
        expect(missing).toMatchObject({ volume: null, atAsk: null, atBid: null });
        expect(zero).toMatchObject({ volume: 0, atAsk: 0, atBid: 0 });
    });

    test('a day with no volume readings is null; with some, the sum of those', () => {
        const day = 24 * 60 * 60;
        const none = buildHistorySeries([{ time: day, a: 10, b: 8, p: 9 }], 30);
        expect(none[0].volume).toBeNull();
        const some = buildHistorySeries([{ time: day, a: 10, b: 8, p: 9 }, row({ time: day + 60, v: 7 })], 30);
        expect(some[0].volume).toBe(7);
    });

    test('the footer says nothing about a split that does not exist', () => {
        const out = tooltipFooterLines({ atAsk: null, atBid: null }, { hasVolume: true, showBaseValue: true }, String);
        expect(out).toBe('');
    });
});

describe('historyLabels with dates', () => {
    test('3 days up to a week carry the date and hour', () => {
        const series = [{ time: 1_700_000_000 }];
        expect(historyLabels(series, 3)[0]).toMatch(/^\d{2}\/\d{2} \d{2}h$/);
        expect(historyLabels(series, 7)[0]).toMatch(/^\d{2}\/\d{2} \d{2}h$/);
        expect(historyLabels(series, 1)[0]).toMatch(/^\d{2}:\d{2}$/);
        expect(historyLabels(series, 14)[0]).toMatch(/^\d{2}\/\d{2}$/);
    });
});

describe('groupSeries', () => {
    const HOUR = 3600;
    const NEWEST = 1_700_000_000;
    // One reading every 20 minutes for `hours` hours, newest at NEWEST
    const readings = (hours, make = () => ({})) => {
        const points = [];
        for (let t = NEWEST - hours * HOUR; t <= NEWEST; t += 1200) {
            points.push({ time: t, ask: 100, bid: 90, avg: 95, volume: 10, atAsk: 4, atBid: 6, ...make(t) });
        }
        return points;
    };

    test('buckets count back from the newest reading, which is always in the last bucket', () => {
        const { series, grouped } = groupSeries(readings(72), 3);
        expect(grouped).toBe(true);
        expect(series.at(-1).time).toBe(NEWEST);
        expect(series.at(-1).to).toBe(NEWEST);
        expect(series.at(-1).from).toBe(NEWEST - 3 * HOUR);
        expect(series[1].from).toBe(series[0].to);
        expect(series.every((point) => point.grouped === true)).toBe(true);
    });

    test('ask, bid, avg are medians; volume and split are sums over the bucket', () => {
        const input = readings(72, (t) => (t === NEWEST ? { ask: 1000, volume: 100, atAsk: 50, atBid: 50 } : {}));
        const last = groupSeries(input, 3).series.at(-1);
        expect(last.ask).toBe(100); // the one absurd reading does not move the median
        expect(last.bid).toBe(90);
        // (NEWEST-3h, NEWEST] holds 9 readings at 20-minute spacing
        expect(last.count).toBe(9);
        expect(last.volume).toBe(10 * 8 + 100);
        expect(last.atAsk).toBe(4 * 8 + 50);
    });

    test('a bucket with no readings for a field keeps null for it, never 0', () => {
        const input = readings(72, (t) =>
            t > NEWEST - 3 * HOUR ? { ask: 0, volume: null, atAsk: null, atBid: null } : {}
        );
        const last = groupSeries(input, 3).series.at(-1);
        expect(last.ask).toBeNull();
        expect(last.bid).toBe(90);
        expect(last.volume).toBeNull();
        expect(last.atAsk).toBeNull();
        expect(last.atBid).toBeNull();
    });

    test('an all-missing bucket is null on every field', () => {
        const all = groupSeries(
            readings(72, (t) => (t > NEWEST - 3 * HOUR ? { ask: 0, bid: 0, avg: 0, volume: null } : {})),
            3
        ).series.at(-1);
        expect([all.ask, all.bid, all.avg, all.volume]).toEqual([null, null, null, null]);
    });

    test('missing prices (0) inside a bucket are skipped, not counted as low prices', () => {
        const input = readings(72, (t) => (t % 2400 === 0 ? { ask: 0 } : {}));
        expect(groupSeries(input, 3).series.every((point) => point.ask === 100 || point.ask === null)).toBe(true);
    });

    test('zero volume sums to 0 (a real quiet period), distinct from missing', () => {
        const last = groupSeries(
            readings(72, () => ({ volume: 0, atAsk: 0, atBid: 0 })),
            3
        ).series.at(-1);
        expect(last.volume).toBe(0);
    });

    test('the base value is the median of the readings that have one, and absent otherwise', () => {
        const withMv = groupSeries(
            readings(72, (t) => (t === NEWEST ? { mv: 500 } : {})),
            3
        ).series.at(-1);
        expect(withMv.mv).toBe(500);
        expect('mv' in groupSeries(readings(72), 3).series.at(-1)).toBe(false);
    });

    test('Hourly leaves every reading alone', () => {
        const input = readings(72);
        const out = groupSeries(input, 1);
        expect(out.grouped).toBe(false);
        expect(out.series).toBe(input);
    });

    test('readings already 3 hours or more apart (long ranges) are untouched', () => {
        const daily = Array.from({ length: 30 }, (_, i) => ({ time: NEWEST - i * 24 * HOUR, ask: 1, bid: 1, avg: 1 }));
        daily.reverse();
        const out = groupSeries(daily, 3);
        expect(out.grouped).toBe(false);
        expect(out.series).toBe(daily);
    });

    test('a short range that would give under a dozen points is untouched', () => {
        const input = readings(24); // 8 buckets
        const out = groupSeries(input, 3);
        expect(out.grouped).toBe(false);
        expect(out.series).toBe(input);
    });

    test('empty, single and unreadable-time series are untouched and do not throw', () => {
        expect(groupSeries([], 3).series).toEqual([]);
        expect(groupSeries(null, 3).series).toEqual([]);
        const one = [{ time: NEWEST, ask: 1 }];
        expect(groupSeries(one, 3).series).toBe(one);
        expect(groupSeries([...readings(72), { time: 0, ask: 1 }], 3).grouped).toBe(false);
    });

    test('a stretch with no readings makes no point', () => {
        const input = readings(72).filter((p) => p.time < NEWEST - 30 * HOUR || p.time > NEWEST - 20 * HOUR);
        const { series } = groupSeries(input, 3);
        expect(series.length).toBeLessThan(24);
        expect(series.length).toBeGreaterThanOrEqual(12);
    });

    test('the footer labels a grouped split as a total and a base value as a median', () => {
        const last = groupSeries(
            readings(72, () => ({ mv: 50 })),
            3
        ).series.at(-1);
        const out = tooltipFooterLines(last, { hasVolume: true, showBaseValue: true }, String);
        expect(out).toContain('(3-hour total)');
        expect(out).toContain('Base value (median): 50');
    });
});

describe('groupedTitle', () => {
    test('shows the window', () => {
        expect(groupedTitle({ from: 1_700_000_000, to: 1_700_000_000 + 3 * 3600 })).toMatch(
            /^\d{2}\/\d{2} \d{2}:\d{2}-(\d{2}\/\d{2} )?\d{2}:\d{2}$/
        );
    });
});

describe('normalizeGroupHours', () => {
    test('defaults to 3 for a missing or unknown saved value', () => {
        expect(normalizeGroupHours(undefined)).toBe(3);
        expect(normalizeGroupHours('x')).toBe(3);
        expect(normalizeGroupHours(5)).toBe(3);
        expect(normalizeGroupHours(1)).toBe(1);
        expect(normalizeGroupHours('1')).toBe(1);
    });
});

describe('chartExtents', () => {
    const pts = [
        { ask: 120, bid: 100, avg: 0, volume: 50 },
        { ask: 130, bid: 110, avg: 0, volume: 200 },
    ];

    test('volume axis tops out at 4x the largest volume and the price axis leaves the bars room', () => {
        const { volumeMax, priceMin, priceLow } = chartExtents(pts, true);
        expect(volumeMax).toBe(800);
        expect(priceLow).toBe(100);
        expect(priceMin).toBeLessThan(100);
        expect(priceMin).toBeGreaterThanOrEqual(0);
    });

    test('a source with no volume, or only zero/null volume, reserves nothing', () => {
        expect(chartExtents(pts, false)).toMatchObject({ priceMin: undefined, volumeMax: undefined });
        const zero = pts.map((p) => ({ ...p, volume: 0 }));
        expect(chartExtents(zero, true)).toMatchObject({ priceMin: undefined, volumeMax: undefined });
        const nulls = pts.map((p) => ({ ...p, volume: null }));
        expect(chartExtents(nulls, true).volumeMax).toBeUndefined();
        expect(chartExtents([], true)).toMatchObject({ priceMin: undefined, volumeMax: undefined, priceLow: null });
    });

    test('a flat price still gets a finite axis, and never goes below 0', () => {
        const flat = chartExtents([{ ask: 2, bid: 2, volume: 10 }], true);
        expect(Number.isFinite(flat.priceMin)).toBe(true);
        expect(flat.priceMin).toBeGreaterThanOrEqual(0);
        expect(flat.priceMin).toBeLessThan(2);
    });

    test('no prices at all reserves nothing even with volume', () => {
        expect(chartExtents([{ ask: null, bid: null, volume: 10 }], true).priceMin).toBeUndefined();
    });
});

describe('priceTickLabel', () => {
    const short = (n) => {
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
        if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
        return n.toFixed(0);
    };
    const exact = (n) => n.toLocaleString('en-US');
    const ticks = (values) => values.map((value) => ({ value }));
    const labels = (values, low) => ticks(values).map((t) => priceTickLabel(t.value, ticks(values), low, short, exact));

    test('an axis mixing plain and abbreviated numbers is written out', () => {
        expect(labels([990, 995, 1000], 990)).toEqual(['990', '995', '1,000']);
    });

    test('a narrow range around 1,000 is written out instead of 1.0K twice', () => {
        expect(labels([998, 999, 1000, 1001, 1002], 998)).toEqual(['998', '999', '1,000', '1,001', '1,002']);
    });

    test('a wide range keeps the shorthand', () => {
        expect(labels([1000, 2000, 3000], 1000)).toEqual(['1.0K', '2.0K', '3.0K']);
    });

    test('a billion-range item with close ticks is written out; with far ticks it is short', () => {
        expect(labels([2_500_000_000, 2_500_010_000, 2_500_020_000], 2_500_000_000)[1]).toBe('2,500,010,000');
        expect(labels([1e9, 2e9, 3e9], 1e9)).toEqual(['1.0B', '2.0B', '3.0B']);
    });

    test('a 2-coin item does not collapse 0.5 steps into duplicates', () => {
        expect(labels([1, 1.5, 2], 1)).toEqual(['1', '1.5', '2']);
    });

    test('ticks under the lowest real price are blank', () => {
        expect(labels([50, 100, 150], 100)).toEqual(['', '100', '150']);
        expect(labels([50, 100, 150], null)).toEqual(['50', '100', '150']);
    });
});
