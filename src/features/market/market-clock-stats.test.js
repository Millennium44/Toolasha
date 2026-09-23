/**
 * Market clock bucketing and statistics.
 *
 * Fixtures follow the rows mooket II actually returns: one per hour at :06,
 * `time` in Unix seconds, `a`/`b` = -1 for an empty side of the book, and
 * `p: 0, v: 0` for an hour in which nothing traded. They are built from local
 * dates so the hour a row lands in does not depend on the machine's zone —
 * except in the one test that is about the zone.
 */

import { describe, test, expect, afterEach } from 'vitest';
import {
    buildMarketClock,
    summarizeClock,
    trimmedMean,
    positivePrice,
    rowSeconds,
    MIN_HOUR_SAMPLES,
    MIN_WEEKDAY_SAMPLES,
} from './market-clock-stats.js';

/** Monday 2026-06-01, local */
const START = { year: 2026, month: 5, day: 1 };

/**
 * Hourly rows over `days` local days.
 * @param {number} days - How many days
 * @param {(dayIndex: number, hour: number, date: Date) => Object} make - Row fields for one hour
 */
function hourlyRows(days, make) {
    const rows = [];
    for (let d = 0; d < days; d += 1) {
        for (let h = 0; h < 24; h += 1) {
            const date = new Date(START.year, START.month, START.day + d, h, 6);
            rows.push({ time: date.getTime() / 1000, ...make(d, h, date) });
        }
    }
    return rows;
}

const flat = () => ({ a: 1000, b: 990, p: 995, v: 100 });

describe('small helpers', () => {
    test('an empty side and an hour with no trade are not prices', () => {
        expect(positivePrice(-1)).toBeNull();
        expect(positivePrice(0)).toBeNull();
        expect(positivePrice(NaN)).toBeNull();
        expect(positivePrice(12)).toBe(12);
    });

    test('row time is read as seconds, or from a date string', () => {
        expect(rowSeconds({ time: 1788919560 })).toBe(1788919560);
        expect(rowSeconds({ time: '2026-09-08T02:06:00Z' })).toBe(Date.parse('2026-09-08T02:06:00Z') / 1000);
        expect(rowSeconds({ time: 'nope' })).toBe(0);
    });

    test('the trimmed mean ignores one absurd sample', () => {
        const samples = [0, 0, 0, 0, 0, 0, 0, 0, 0, 500];
        expect(trimmedMean(samples)).toBe(0);
        expect(trimmedMean([])).toBeNull();
    });
});

describe('hour of day', () => {
    test('a price that is 1% cheaper at 04:00 every day is found at 04:00', () => {
        const rows = hourlyRows(14, (d, h) => ({ ...flat(), a: h === 4 ? 990 : 1000 }));
        const clock = buildMarketClock(rows);
        expect(clock.hours[4].ask.value).toBeCloseTo(-0.01, 5);
        expect(clock.hours[4].ask.n).toBe(14);

        const summary = summarizeClock(clock.hours, MIN_HOUR_SAMPLES);
        expect(summary.cheapestAsk).toMatchObject({ index: 4, flat: false, n: 14 });
    });

    test('a trend between days is not an hourly pattern', () => {
        // Doubles every day, never moves within one
        const rows = hourlyRows(14, (d) => ({ a: 100 * 2 ** d, b: 90 * 2 ** d, p: 95 * 2 ** d, v: 10 }));
        const clock = buildMarketClock(rows);
        for (const bucket of clock.hours) expect(bucket.ask.value).toBe(0);
        expect(summarizeClock(clock.hours, MIN_HOUR_SAMPLES).cheapestAsk.flat).toBe(true);
    });

    test('an empty side of the book (-1) is skipped, never counted as a price', () => {
        // Nobody bids between 00:00 and 05:59
        const rows = hourlyRows(10, (d, h) => ({ ...flat(), b: h < 6 ? -1 : 990 }));
        const clock = buildMarketClock(rows);
        for (let h = 0; h < 6; h += 1) {
            expect(clock.hours[h].bid).toEqual({ value: null, n: 0 });
        }
        for (let h = 6; h < 24; h += 1) expect(clock.hours[h].bid.value).toBe(0);
        // The asks in those hours still count
        expect(clock.hours[0].ask.n).toBe(10);
    });

    test('a bucket with too few samples is not named as a pattern', () => {
        const rows = hourlyRows(MIN_HOUR_SAMPLES - 1, (d, h) => ({ ...flat(), a: h === 4 ? 900 : 1000 }));
        const clock = buildMarketClock(rows);
        expect(clock.hours[4].ask.n).toBe(MIN_HOUR_SAMPLES - 1);
        expect(summarizeClock(clock.hours, MIN_HOUR_SAMPLES).cheapestAsk).toBeNull();
    });

    test('volume is a ratio to its day, and a zero-volume hour counts as zero', () => {
        const rows = hourlyRows(10, (d, h) => {
            if (h === 20) return { ...flat(), v: 300 };
            if (h === 3) return { ...flat(), p: 0, v: 0 };
            return flat();
        });
        const clock = buildMarketClock(rows);
        const dayMean = (22 * 100 + 300 + 0) / 24;
        expect(clock.hours[20].volume.value).toBeCloseTo(300 / dayMean, 6);
        expect(clock.hours[3].volume).toEqual({ value: 0, n: 10 });

        const summary = summarizeClock(clock.hours, MIN_HOUR_SAMPLES);
        expect(summary.busiest).toMatchObject({ index: 20, flat: false });
    });

    test('a source without volume produces no volume figures', () => {
        const rows = hourlyRows(10, () => ({ ...flat(), v: 0 }));
        const clock = buildMarketClock(rows, { hasVolume: false });
        for (const bucket of clock.hours) expect(bucket.volume).toEqual({ value: null, n: 0 });
        expect(summarizeClock(clock.hours, MIN_HOUR_SAMPLES).busiest).toBeNull();
    });

    test('a partial day contributes prices but not volume', () => {
        // Six sightings: enough for a price reference, not for a daily volume average
        const rows = hourlyRows(1, flat).slice(0, 6);
        const clock = buildMarketClock(rows);
        expect(clock.hours[0].ask.n).toBe(1);
        expect(clock.hours[0].volume.n).toBe(0);
    });
});

describe('day of week', () => {
    test('asks 2% lower every Saturday are found on Saturday', () => {
        const rows = hourlyRows(8 * 7, (d, h, date) => ({ ...flat(), a: date.getDay() === 6 ? 980 : 1000 }));
        const clock = buildMarketClock(rows);
        expect(clock.weekdays[6].ask.n).toBeGreaterThanOrEqual(MIN_WEEKDAY_SAMPLES);
        expect(clock.weekdays[6].ask.value).toBeCloseTo(-0.02, 5);

        const summary = summarizeClock(clock.weekdays, MIN_WEEKDAY_SAMPLES);
        expect(summary.cheapestAsk).toMatchObject({ index: 6, flat: false });
    });

    test('a month is not enough weeks to call a weekday', () => {
        const rows = hourlyRows(28, (d, h, date) => ({ ...flat(), a: date.getDay() === 6 ? 900 : 1000 }));
        const clock = buildMarketClock(rows);
        expect(clock.weekdays[6].ask.n).toBeLessThan(MIN_WEEKDAY_SAMPLES);
        expect(summarizeClock(clock.weekdays, MIN_WEEKDAY_SAMPLES).cheapestAsk).toBeNull();
    });

    test('a busy Sunday is a ratio to its week', () => {
        const rows = hourlyRows(8 * 7, (d, h, date) => ({ ...flat(), v: date.getDay() === 0 ? 200 : 100 }));
        const clock = buildMarketClock(rows);
        expect(clock.weekdays[0].volume.value).toBeGreaterThan(1.5);
        expect(clock.weekdays[3].volume.value).toBeLessThan(1);
        expect(summarizeClock(clock.weekdays, MIN_WEEKDAY_SAMPLES).busiest).toMatchObject({ index: 0 });
    });
});

describe('time zone', () => {
    const originalTz = globalThis.process.env.TZ;
    afterEach(() => {
        // Assigning undefined would store the string "undefined", which reads as UTC
        if (originalTz === undefined) delete globalThis.process.env.TZ;
        else globalThis.process.env.TZ = originalTz;
    });

    test('UTC server times are bucketed by the local hour', () => {
        globalThis.process.env.TZ = 'America/New_York';
        // 2026-09-08 00:06 UTC is 20:06 the previous evening in New York (EDT)
        const clock = buildMarketClock([{ time: Date.UTC(2026, 8, 8, 0, 6) / 1000, a: 10, b: 9, p: 9, v: 1 }]);
        expect(clock.dayCount).toBe(1);
        const date = new Date(Date.UTC(2026, 8, 8, 0, 6));
        expect(date.getHours()).toBe(20);
        expect(date.getDay()).toBe(1);

        // One sighting is below the day-reference minimum, so drive enough of them into one local day
        const rows = [];
        for (let h = 0; h < 6; h += 1) {
            rows.push({ time: Date.UTC(2026, 8, 7, 18 + h, 6) / 1000, a: h === 2 ? 5 : 10, b: 9, p: 9, v: 1 });
        }
        const zoned = buildMarketClock(rows);
        // 18:06–23:06 UTC is 14:06–19:06 EDT; the cheap one at 20:06 UTC is 16:00 local
        expect(zoned.hours[16].ask.value).toBeLessThan(0);
        expect(zoned.hours[20].ask.n).toBe(0);
    });
});
