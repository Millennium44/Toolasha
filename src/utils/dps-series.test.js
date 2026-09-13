/**
 * DPS over time from cumulative totals.
 */

import { describe, test, expect } from 'vitest';
import { newDpsSeries, noteTotals, seriesView, BUCKET_MS, MAX_BUCKETS } from './dps-series.js';

const T0 = 1_000_000;
const at = (bucket) => T0 + bucket * BUCKET_MS;

describe('noteTotals', () => {
    test('the first reading is a baseline, not two seconds of everything done so far', () => {
        const series = newDpsSeries();
        noteTotals(series, at(0), [{ key: '0', name: 'Abe', damage: 50_000 }]);
        noteTotals(series, at(1), [{ key: '0', damage: 50_200 }]);
        expect(series.buckets[0].party).toBe(0);
        expect(series.buckets[1].damage['0']).toBe(200);
        expect(series.names['0']).toBe('Abe');
    });

    test('a series that began with the tracker counts from zero', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), [{ key: '0', damage: 300 }]);
        expect(series.buckets[0].party).toBe(300);
    });

    test('a late reading is spread across the buckets it covers', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), [{ key: '0', damage: 0 }]);
        noteTotals(series, at(30), [{ key: '0', damage: 3000 }]);
        for (let i = 1; i <= 30; i++) expect(series.buckets[i].party).toBeCloseTo(100, 9);
    });

    test('a player who appears later starts from zero, and a total that falls is a new baseline', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), [{ key: '0', damage: 100 }]);
        noteTotals(series, at(1), [
            { key: '0', damage: 50 },
            { key: '1', damage: 40 },
        ]);
        expect(series.buckets[1].damage['0']).toBeUndefined();
        expect(series.buckets[1].damage['1']).toBe(40);
        noteTotals(series, at(2), [{ key: '0', damage: 80 }]);
        expect(series.buckets[2].damage['0']).toBe(30);
    });

    test('a boss flag marks the buckets the reading covers', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), [], { boss: false });
        noteTotals(series, at(3), [], { boss: true });
        expect(series.buckets.map((bucket) => bucket.boss)).toEqual([false, true, true, true]);
    });

    test('the oldest buckets are dropped past the cap, keeping time aligned', () => {
        const series = newDpsSeries({ fromZero: true, maxBuckets: 10 });
        noteTotals(series, at(0), [{ key: '0', damage: 0 }]);
        noteTotals(series, at(14), [{ key: '0', damage: 1400 }]);
        expect(series.buckets).toHaveLength(10);
        expect(series.startAt).toBe(at(5));
        noteTotals(series, at(15), [{ key: '0', damage: 1500 }]);
        expect(series.buckets[10 - 1].party).toBe(100);
        expect(MAX_BUCKETS).toBeGreaterThan(1800);
    });
});

describe('seriesView', () => {
    function steady(buckets, rate = 100) {
        const series = newDpsSeries({ fromZero: true });
        for (let i = 0; i <= buckets; i++) {
            noteTotals(series, at(i), [
                { key: 'a', name: 'Abe', damage: i * rate * 2 },
                { key: 'b', name: 'Bo', damage: i * rate },
            ]);
        }
        return series;
    }

    test('nothing to draw before two whole buckets', () => {
        const series = newDpsSeries();
        expect(seriesView(series, { now: T0 })).toBeNull();
        noteTotals(series, at(0), []);
        expect(seriesView(series, { now: at(1) })).toBeNull();
    });

    test('a steady fight reads as its rate per second, players ordered by damage', () => {
        const view = seriesView(steady(20), { now: at(21), smooth: 1 });
        const last = view.points.at(-1);
        expect(last.players.a).toBeCloseTo(100, 9);
        expect(last.players.b).toBeCloseTo(50, 9);
        expect(last.party).toBeCloseTo(150, 9);
        expect(view.keys).toEqual(['a', 'b']);
        expect(view.names).toEqual({ a: 'Abe', b: 'Bo' });
    });

    test('the bucket still filling is left out, and idle time after the last reading falls to zero', () => {
        const view = seriesView(steady(10), { now: at(40) + 500, smooth: 1 });
        expect(view.points.at(-1).t).toBe(39 * BUCKET_MS);
        expect(view.points.at(-1).party).toBe(0);
    });

    test('the recent window is five minutes; the session window is everything kept', () => {
        const series = steady(400);
        expect(seriesView(series, { now: at(401), window: 'recent', maxPoints: 1000 }).points).toHaveLength(150);
        const session = seriesView(series, { now: at(401), window: 'session', maxPoints: 1000 });
        expect(session.points).toHaveLength(401);
    });

    test('a long window is averaged down, keeping any boss bucket visible', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), []);
        for (let i = 1; i <= 600; i++) noteTotals(series, at(i), [{ key: 'a', damage: i * 200 }], { boss: i === 300 });
        // Buckets 0..599 are whole at this clock: 600 points, six to a point
        const view = seriesView(series, { now: at(600), window: 'session', maxPoints: 100, smooth: 1 });
        expect(view.points.length).toBeLessThanOrEqual(100);
        expect(view.bucketMs).toBe(BUCKET_MS * 6);
        expect(view.points.filter((point) => point.boss)).toHaveLength(1);
        expect(view.points[10].players.a).toBeCloseTo(100, 9);
    });

    test('the trailing average smooths a burst over sixteen seconds', () => {
        const series = newDpsSeries({ fromZero: true });
        for (let i = 0; i <= 9; i++) noteTotals(series, at(i), [{ key: 'a', damage: 0 }]);
        noteTotals(series, at(10), [{ key: 'a', damage: 1600 }]);
        for (let i = 11; i <= 22; i++) noteTotals(series, at(i), [{ key: 'a', damage: 1600 }]);
        const view = seriesView(series, { now: at(23) });
        expect(Math.max(...view.points.map((point) => point.party))).toBeCloseTo(100, 9);
    });

    test('at the very start the average is over the buckets that exist, not padded with zeros', () => {
        const series = newDpsSeries({ fromZero: true });
        noteTotals(series, at(0), [{ key: 'a', damage: 200 }]);
        noteTotals(series, at(1), [{ key: 'a', damage: 400 }]);
        noteTotals(series, at(2), [{ key: 'a', damage: 600 }]);
        const view = seriesView(series, { now: at(3) });
        expect(view.points.map((point) => point.party)).toEqual([100, 100, 100]);
    });
});
