/**
 * The calibration arithmetic.
 *
 * What is worth pinning down here is not that a percentage divides — it is the
 * two ways this feature could lie. Calling a gap "persistent" off three runs
 * would have players rebuilding a loadout because of one bad drop table roll,
 * and letting a single spectacular run set the verdict would do the same from
 * the other direction. Both rules are asserted below.
 */

import { describe, test, expect } from 'vitest';
import {
    deviationPercent,
    median,
    mean,
    summarizeCalibration,
    dailySeries,
    DEFAULT_GAP_PERCENT,
} from './calibration-math.js';

const HOUR = 3600_000;

/**
 * A record, with only the fields the arithmetic reads.
 * @param {string} actionType - Skill
 * @param {number} predicted - Predicted per hour
 * @param {number} actual - Actual per hour
 * @param {number} [t] - When it finished
 * @returns {Object}
 */
const record = (actionType, predicted, actual, t = Date.now()) => ({ actionType, predicted, actual, t });

describe('deviationPercent', () => {
    test('is negative when the run paid less than promised', () => {
        expect(deviationPercent(1000, 800)).toBe(-20);
        expect(deviationPercent(1000, 1250)).toBe(25);
    });

    test('refuses a prediction with no scale to be wrong against', () => {
        expect(deviationPercent(0, 500)).toBeNull();
        expect(deviationPercent(0.5, 500)).toBeNull();
        expect(deviationPercent(NaN, 500)).toBeNull();
        expect(deviationPercent(1000, undefined)).toBeNull();
    });

    test('measures a negative prediction against its own size', () => {
        // A loss forecast at -1000 that came in at -500 is 50% better, not worse
        expect(deviationPercent(-1000, -500)).toBe(50);
    });
});

describe('median and mean', () => {
    test('median takes the middle, mean takes the weight', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(mean([1, 2, 3])).toBe(2);
    });

    test('nothing in, null out', () => {
        expect(median([])).toBeNull();
        expect(mean([NaN, undefined])).toBeNull();
    });
});

describe('summarizeCalibration', () => {
    test('groups by action type and ranks the worst gap first', () => {
        const records = [
            ...Array.from({ length: 6 }, () => record('milking', 1000, 950)),
            ...Array.from({ length: 6 }, () => record('cooking', 1000, 500)),
        ];

        const summary = summarizeCalibration(records);

        expect(summary.groups.map((group) => group.actionType)).toEqual(['cooking', 'milking']);
        expect(summary.groups[0].medianDeviation).toBe(-50);
        expect(summary.overall.samples).toBe(12);
    });

    test('needs enough runs before it calls a gap persistent', () => {
        const few = Array.from({ length: 4 }, () => record('cooking', 1000, 400));
        expect(summarizeCalibration(few).flagged).toHaveLength(0);

        const enough = Array.from({ length: 5 }, () => record('cooking', 1000, 400));
        const flagged = summarizeCalibration(enough).flagged;
        expect(flagged).toHaveLength(1);
        expect(flagged[0].direction).toBe('optimistic');
    });

    test('one lucky run does not speak for the skill', () => {
        // Five honest runs and one that hit a rare drop worth ten hours of profit
        const records = [
            ...Array.from({ length: 5 }, () => record('foraging', 1000, 1000)),
            record('foraging', 1000, 11000),
        ];

        const group = summarizeCalibration(records).groups[0];

        // The mean is dragged way up; the median — and so the verdict — is not
        expect(group.actualMean).toBeGreaterThan(2000);
        expect(group.medianDeviation).toBe(0);
        expect(group.flagged).toBe(false);
    });

    test('a pessimistic calculator is flagged too', () => {
        const records = Array.from({ length: 6 }, () => record('brewing', 1000, 1000 + DEFAULT_GAP_PERCENT * 20));
        expect(summarizeCalibration(records).flagged[0].direction).toBe('pessimistic');
    });

    test('honours a window and ignores unusable pairs', () => {
        const now = 10 * 24 * HOUR;
        const records = [
            record('milking', 1000, 500, now - 9 * 24 * HOUR),
            record('milking', 1000, 900, now - HOUR),
            record('milking', null, 900, now - HOUR),
        ];

        const summary = summarizeCalibration(records, { now, windowMs: 24 * HOUR });
        expect(summary.overall.samples).toBe(1);
        expect(summary.overall.medianDeviation).toBe(-10);
    });
});

describe('dailySeries', () => {
    /** `YYYY-MM-DD` for a local time, the way the reader's own calendar reads it. */
    const localDay = (date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    /** A local time on a given day, so the test says the same thing in every timezone. */
    const at = (year, month, day, hour) => new Date(year, month - 1, day, hour, 0, 0).getTime();

    test('buckets by day, oldest first, inside the window', () => {
        const now = at(2026, 8, 4, 12);
        const records = [
            record('milking', 1000, 900, at(2026, 8, 3, 2)),
            record('milking', 1000, 700, at(2026, 8, 3, 22)),
            record('milking', 1000, 1100, at(2026, 8, 4, 9)),
            // Older than the window
            record('milking', 1000, 100, at(2026, 7, 1, 9)),
        ];

        const series = dailySeries(records, { now, days: 7 });

        expect(series.map((day) => day.day)).toEqual(['2026-08-03', '2026-08-04']);
        expect(series[0].samples).toBe(2);
        expect(series[0].actualMean).toBe(800);
        expect(series[1].deviation).toBe(10);
    });

    test('a day is the reader’s own day, not a UTC one', () => {
        // Late evening local time: west of Greenwich this is already tomorrow in UTC, and
        // bucketing by UTC would file an evening's actions under the next day's heading
        const evening = new Date(2026, 7, 3, 23, 30, 0);
        const morning = new Date(2026, 7, 3, 7, 0, 0);
        const now = new Date(2026, 7, 4, 12, 0, 0).getTime();

        const series = dailySeries(
            [record('milking', 1000, 900, morning.getTime()), record('milking', 1000, 700, evening.getTime())],
            { now, days: 7 }
        );

        expect(series).toHaveLength(1);
        expect(series[0].day).toBe(localDay(evening));
        expect(series[0].day).toBe(localDay(morning));
        expect(series[0].samples).toBe(2);
    });
});
