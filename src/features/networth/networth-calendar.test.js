/**
 * The calendar's arithmetic, and in particular the three ways it is allowed to
 * say "I do not know": no snapshot, no earlier snapshot, and a snapshot so far
 * back that the change across it is not one day's.
 *
 * Every timestamp here is built with the local `Date` constructor rather than
 * an ISO string, because the whole point of the module is local-day bucketing
 * and a UTC literal would test the machine's timezone instead.
 */

import { describe, test, expect } from 'vitest';
import {
    localDayKey,
    localDayStart,
    daysApart,
    shiftDay,
    dailyLocalCloses,
    dailyDeltas,
    summarise,
    buildNetworthCalendar,
} from './networth-calendar.js';

/** A snapshot at a local wall-clock time */
const at = (year, month, day, hour, total) => ({ t: new Date(year, month - 1, day, hour).getTime(), total });

describe('localDayKey', () => {
    test('buckets by the reader’s own calendar day, not UTC', () => {
        // 23:30 local is the next UTC day for anyone east of Greenwich and the
        // same one west of it; either way it is still this day to the player
        const late = new Date(2026, 7, 20, 23, 30);
        expect(localDayKey(late.getTime())).toBe('2026-08-20');
    });

    test('pads month and day', () => {
        expect(localDayKey(new Date(2026, 0, 5, 9).getTime())).toBe('2026-01-05');
    });

    test('round-trips through localDayStart', () => {
        expect(localDayKey(localDayStart('2026-03-09'))).toBe('2026-03-09');
    });
});

describe('daysApart and shiftDay', () => {
    test('counts whole days across a month boundary', () => {
        expect(daysApart('2026-07-30', '2026-08-02')).toBe(3);
    });

    test('shifts backwards across a month boundary', () => {
        expect(shiftDay('2026-08-02', -3)).toBe('2026-07-30');
    });

    test('a day is zero from itself', () => {
        expect(daysApart('2026-08-02', '2026-08-02')).toBe(0);
    });
});

describe('dailyLocalCloses', () => {
    test('takes the last snapshot of each local day and counts the samples', () => {
        const closes = dailyLocalCloses([
            at(2026, 8, 20, 9, 100),
            at(2026, 8, 20, 21, 180),
            at(2026, 8, 20, 14, 150),
            at(2026, 8, 21, 8, 200),
        ]);

        expect(closes).toHaveLength(2);
        expect(closes[0]).toMatchObject({ day: '2026-08-20', total: 180, samples: 3 });
        expect(closes[1]).toMatchObject({ day: '2026-08-21', total: 200, samples: 1 });
    });

    test('ignores points with no timestamp or no total', () => {
        const closes = dailyLocalCloses([{ t: null, total: 5 }, { t: Date.now() }, null, at(2026, 8, 20, 9, 100)]);
        expect(closes).toHaveLength(1);
    });

    test('is order independent', () => {
        const points = [at(2026, 8, 21, 8, 200), at(2026, 8, 20, 21, 180)];
        expect(dailyLocalCloses(points).map((c) => c.day)).toEqual(['2026-08-20', '2026-08-21']);
        expect(dailyLocalCloses([...points].reverse()).map((c) => c.day)).toEqual(['2026-08-20', '2026-08-21']);
    });

    test('an empty or missing series is empty, not an error', () => {
        expect(dailyLocalCloses(null)).toEqual([]);
        expect(dailyLocalCloses([])).toEqual([]);
    });
});

describe('dailyDeltas', () => {
    test('a day is its close against the previous day’s close', () => {
        const deltas = dailyDeltas([at(2026, 8, 20, 21, 100), at(2026, 8, 21, 20, 130)]);
        expect(deltas.get('2026-08-21')).toMatchObject({ delta: 30, gapDays: 1, spansGap: false });
    });

    test('a lone snapshot has nothing to subtract, so its day has no delta', () => {
        // A single snapshot measures a balance, not a change. Reporting zero
        // here would draw a flat day the player never had
        const deltas = dailyDeltas([at(2026, 8, 20, 12, 100)]);
        expect(deltas.size).toBe(0);
        expect(deltas.get('2026-08-20')).toBeUndefined();
    });

    test('the first day of the history has no delta however many snapshots it holds', () => {
        const deltas = dailyDeltas([at(2026, 8, 20, 9, 100), at(2026, 8, 20, 21, 180), at(2026, 8, 21, 9, 200)]);
        expect(deltas.get('2026-08-20')).toBeUndefined();
        expect(deltas.get('2026-08-21').delta).toBe(20);
    });

    test('a day with one snapshot after an unbroken day still has a real delta', () => {
        const deltas = dailyDeltas([at(2026, 8, 20, 9, 100), at(2026, 8, 20, 21, 180), at(2026, 8, 21, 9, 250)]);
        expect(deltas.get('2026-08-21')).toMatchObject({ delta: 70, samples: 1, spansGap: false });
    });

    test('a multi-day gap puts the whole change on the later day and marks it', () => {
        const deltas = dailyDeltas([at(2026, 8, 17, 20, 100), at(2026, 8, 21, 20, 500)]);

        // Nothing is invented for the silent days
        expect(deltas.get('2026-08-18')).toBeUndefined();
        expect(deltas.get('2026-08-19')).toBeUndefined();
        expect(deltas.get('2026-08-20')).toBeUndefined();
        // and the arrival carries all of it, flagged as more than one day
        expect(deltas.get('2026-08-21')).toMatchObject({ delta: 400, gapDays: 4, spansGap: true });
    });

    test('a loss is a loss', () => {
        const deltas = dailyDeltas([at(2026, 8, 20, 20, 500), at(2026, 8, 21, 20, 300)]);
        expect(deltas.get('2026-08-21').delta).toBe(-200);
    });
});

describe('summarise', () => {
    test('names the best and worst day and counts the sides', () => {
        const summary = summarise([
            { day: '2026-08-18', delta: 50 },
            { day: '2026-08-19', delta: null },
            { day: '2026-08-20', delta: -200 },
            { day: '2026-08-21', delta: 900 },
            { day: '2026-08-22', delta: 0 },
        ]);

        expect(summary.best).toMatchObject({ day: '2026-08-21', delta: 900 });
        expect(summary.worst).toMatchObject({ day: '2026-08-20', delta: -200 });
        expect(summary.positive).toBe(2);
        // A flat day is measured but is neither up nor down, and a day with
        // no data is not measured at all
        expect(summary.negative).toBe(1);
        expect(summary.measured).toBe(4);
    });

    test('nothing measured is nothing claimed', () => {
        const summary = summarise([{ day: '2026-08-18', delta: null }]);
        expect(summary).toMatchObject({ best: null, worst: null, positive: 0, negative: 0, measured: 0 });
    });
});

describe('buildNetworthCalendar', () => {
    const now = new Date(2026, 7, 22, 15).getTime();

    test('covers whole weeks ending today', () => {
        const calendar = buildNetworthCalendar([], { now, weeks: 8 });

        expect(calendar.cells.length % 7).toBe(0);
        expect(calendar.cells.length).toBeGreaterThanOrEqual(56);
        expect(calendar.cells.length).toBeLessThan(63);
        expect(calendar.cells[calendar.cells.length - 1]).toMatchObject({ day: '2026-08-22', isToday: true });
        expect(calendar.weeks.every((week) => week.length === 7)).toBe(true);
        // The grid starts on a Sunday so the rows line up under their weekday
        expect(calendar.cells[0].weekday).toBe(0);
    });

    test('days with no snapshot are no data, not zero', () => {
        const calendar = buildNetworthCalendar([at(2026, 8, 20, 20, 100), at(2026, 8, 21, 20, 160)], { now });
        const byDay = Object.fromEntries(calendar.cells.map((cell) => [cell.day, cell]));

        expect(byDay['2026-08-21'].delta).toBe(60);
        expect(byDay['2026-08-22'].delta).toBeNull();
        expect(byDay['2026-08-19'].delta).toBeNull();
        // The opening snapshot's own day is no data too
        expect(byDay['2026-08-20'].delta).toBeNull();
    });

    test('the gap marker reaches the cell', () => {
        const calendar = buildNetworthCalendar([at(2026, 8, 16, 20, 100), at(2026, 8, 21, 20, 700)], { now });
        const cell = calendar.cells.find((entry) => entry.day === '2026-08-21');
        expect(cell).toMatchObject({ delta: 600, gapDays: 5, spansGap: true });
    });

    test('the summary is over the window and the scale is the largest day in it', () => {
        const calendar = buildNetworthCalendar(
            [at(2026, 8, 19, 20, 100), at(2026, 8, 20, 20, 900), at(2026, 8, 21, 20, 400)],
            { now }
        );

        expect(calendar.summary.best).toMatchObject({ day: '2026-08-20', delta: 800 });
        expect(calendar.summary.worst).toMatchObject({ day: '2026-08-21', delta: -500 });
        expect(calendar.summary.positive).toBe(1);
        expect(calendar.summary.negative).toBe(1);
        expect(calendar.maxMagnitude).toBe(800);
    });

    test('an empty history is a grid of no-data cells', () => {
        const calendar = buildNetworthCalendar([], { now });
        expect(calendar.cells.every((cell) => cell.delta === null)).toBe(true);
        expect(calendar.summary.measured).toBe(0);
        expect(calendar.maxMagnitude).toBe(0);
    });

    test('history older than the window does not appear in it', () => {
        const calendar = buildNetworthCalendar([at(2025, 1, 1, 12, 10), at(2025, 1, 2, 12, 20)], { now });
        expect(calendar.cells.every((cell) => cell.delta === null)).toBe(true);
    });
});
