import { describe, test, expect } from 'vitest';

import {
    addWatched,
    setWatchedTarget,
    noteTargetEvent,
    noteTargetReached,
    targetReachedSinceSet,
    sightingsFromRows,
    aftermathReading,
    targetAftermath,
    describeAftermath,
    TARGET_LIFE_MAX,
    AFTERMATH_TOLERANCE_MS,
} from './market-watchlist.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/**
 * A history row as the pooled dataset ships one: seconds, `a` ask, `b` bid.
 * @param {number} atMs - When the sighting was taken
 * @param {number|null} ask - Best ask, or null for an empty side
 * @param {number|null} bid - Best bid, or null for an empty side
 * @returns {Object}
 */
function row(atMs, ask, bid = null) {
    return { time: atMs / 1000, a: ask ?? 0, b: bid ?? 0 };
}

describe('the ring', () => {
    test('an entry with no events has no life field at all', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        expect(pinned[0]).not.toHaveProperty('life');
    });

    test('setting a target with a clock records set-at and the price then', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const after = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'ask', price: 90 },
            {
                at: T0,
                price: { ask: 120, bid: 100 },
            }
        );

        expect(after[0].life).toEqual([{ kind: 'set', at: T0, price: 120, side: 'ask' }]);
    });

    test('setting a target without a clock stores nothing, so old callers are unchanged', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        expect(setWatchedTarget(pinned, '/items/cheese:0', { price: 90 })[0]).not.toHaveProperty('life');
    });

    test('an empty side stores null rather than a price of zero', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const after = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'bid', price: 150 },
            {
                at: T0,
                price: { ask: 120, bid: 0 },
            }
        );
        expect(after[0].life[0].price).toBeNull();
    });

    test('re-setting the identical target is not a new life', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const target = { side: 'ask', price: 90 };
        const once = setWatchedTarget(pinned, '/items/cheese:0', target, { at: T0, price: { ask: 120 } });
        const twice = setWatchedTarget(once, '/items/cheese:0', target, { at: T0 + HOUR, price: { ask: 118 } });
        expect(twice[0].life).toHaveLength(1);
    });

    test('changing the price is a new intention, and starts a new life', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const once = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'ask', price: 90 },
            {
                at: T0,
                price: { ask: 120 },
            }
        );
        const twice = setWatchedTarget(
            once,
            '/items/cheese:0',
            { side: 'ask', price: 80 },
            {
                at: T0 + HOUR,
                price: { ask: 118 },
            }
        );
        expect(twice[0].life.map((e) => e.kind)).toEqual(['set', 'set']);
    });

    test('clearing a target that never fired records cleared-unreached', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const set = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'ask', price: 90 },
            {
                at: T0,
                price: { ask: 120 },
            }
        );
        const cleared = setWatchedTarget(set, '/items/cheese:0', null, { at: T0 + HOUR, price: { ask: 118 } });

        expect(cleared[0]).not.toHaveProperty('target');
        expect(cleared[0].life.at(-1)).toEqual({
            kind: 'cleared',
            at: T0 + HOUR,
            price: 118,
            side: 'ask',
            unreached: true,
        });
    });

    test('clearing a target that did fire is not marked unreached', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const set = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'ask', price: 90 },
            {
                at: T0,
                price: { ask: 120 },
            }
        );
        const hit = noteTargetReached(set, '/items/cheese:0', { at: T0 + HOUR, price: { ask: 88 } });
        const cleared = setWatchedTarget(hit, '/items/cheese:0', null, { at: T0 + 2 * HOUR, price: { ask: 88 } });

        expect(cleared[0].life.at(-1)).not.toHaveProperty('unreached');
    });

    test('the ring is bounded, dropping the oldest', () => {
        let entry = { key: '/items/cheese:0' };
        for (let i = 0; i < TARGET_LIFE_MAX + 5; i++) {
            entry = noteTargetEvent(entry, { kind: 'set', at: T0 + i * HOUR, price: 100 + i });
        }
        expect(entry.life).toHaveLength(TARGET_LIFE_MAX);
        expect(entry.life[0].at).toBe(T0 + 5 * HOUR);
        expect(entry.life.at(-1).at).toBe(T0 + (TARGET_LIFE_MAX + 4) * HOUR);
    });

    test('the ring bound is injectable and never falls below one', () => {
        let entry = { key: 'k' };
        entry = noteTargetEvent(entry, { kind: 'set', at: T0, price: 1 }, 2);
        entry = noteTargetEvent(entry, { kind: 'set', at: T0 + 1, price: 2 }, 2);
        entry = noteTargetEvent(entry, { kind: 'set', at: T0 + 2, price: 3 }, 2);
        expect(entry.life).toHaveLength(2);
        expect(noteTargetEvent({ key: 'k' }, { kind: 'set', at: T0, price: 1 }, 0).life).toHaveLength(1);
    });

    test('an unusable event is refused rather than stored', () => {
        const entry = { key: 'k' };
        expect(noteTargetEvent(entry, { kind: 'exploded', at: T0 })).toBe(entry);
        expect(noteTargetEvent(entry, { kind: 'set', at: 0 })).toBe(entry);
        expect(noteTargetEvent(entry, null)).toBe(entry);
        expect(noteTargetEvent(null, { kind: 'set', at: T0 })).toBeNull();
    });

    test('a reach is recorded once per arming', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        const set = setWatchedTarget(
            pinned,
            '/items/cheese:0',
            { side: 'ask', price: 90 },
            {
                at: T0,
                price: { ask: 120 },
            }
        );
        const once = noteTargetReached(set, '/items/cheese:0', { at: T0 + HOUR, price: { ask: 88 } });
        const twice = noteTargetReached(once, '/items/cheese:0', { at: T0 + 2 * HOUR, price: { ask: 87 } });

        expect(twice).toBe(once);
        expect(once[0].life.filter((e) => e.kind === 'reached')).toHaveLength(1);
    });

    test('a pin with no target records no reach', () => {
        const pinned = addWatched([], '/items/cheese:0', { ask: 120, bid: 100, at: T0 });
        expect(noteTargetReached(pinned, '/items/cheese:0', { at: T0, price: { ask: 88 } })).toBe(pinned);
        expect(noteTargetReached(pinned, '/items/milk:0', { at: T0, price: { ask: 88 } })).toBe(pinned);
    });

    test('targetReachedSinceSet reads back only to the newest set', () => {
        const life = [
            { kind: 'set', at: 1 },
            { kind: 'reached', at: 2 },
            { kind: 'set', at: 3 },
        ];
        expect(targetReachedSinceSet({ life })).toBe(false);
        expect(targetReachedSinceSet({ life: [...life, { kind: 'reached', at: 4 }] })).toBe(true);
        expect(targetReachedSinceSet({})).toBe(false);
    });
});

describe('sightingsFromRows', () => {
    test('turns seconds into milliseconds and orders oldest first', () => {
        const sightings = sightingsFromRows([row(T0 + HOUR, 100), row(T0, 90)]);
        expect(sightings.map((s) => s.time)).toEqual([T0, T0 + HOUR]);
    });

    test('an empty side is null, not zero', () => {
        expect(sightingsFromRows([row(T0, 0, 50)])[0]).toEqual({ time: T0, ask: null, bid: 50 });
    });

    test('an undated row is dropped, and a non-array is empty', () => {
        expect(sightingsFromRows([{ a: 100 }])).toEqual([]);
        expect(sightingsFromRows(null)).toEqual([]);
    });
});

describe('aftermathReading', () => {
    const sightings = sightingsFromRows([row(T0, 100), row(T0 + 24 * HOUR, 90), row(T0 + 72 * HOUR, 80)]);

    test('reads the sighting at the window', () => {
        expect(aftermathReading(sightings, T0, 24, 'ask').price).toBe(90);
        expect(aftermathReading(sightings, T0, 72, 'ask').price).toBe(80);
    });

    test('takes the closest sighting inside the tolerance', () => {
        const near = sightingsFromRows([row(T0 + 22 * HOUR, 95), row(T0 + 25 * HOUR, 92)]);
        expect(aftermathReading(near, T0, 24, 'ask').price).toBe(92);
    });

    test('a gap returns nothing rather than interpolating between the readings either side', () => {
        // Readings well before and well after the window, and nothing in it —
        // a straight line between them would say 85, which is not an observation
        const gapped = sightingsFromRows([row(T0, 100), row(T0 + 60 * HOUR, 70)]);
        expect(aftermathReading(gapped, T0, 24, 'ask')).toBeNull();
    });

    test('the tolerance is the boundary, and is injectable', () => {
        const edge = sightingsFromRows([row(T0 + 24 * HOUR + AFTERMATH_TOLERANCE_MS, 90)]);
        expect(aftermathReading(edge, T0, 24, 'ask')).not.toBeNull();

        const past = sightingsFromRows([row(T0 + 24 * HOUR + AFTERMATH_TOLERANCE_MS + 1, 90)]);
        expect(aftermathReading(past, T0, 24, 'ask')).toBeNull();
        expect(aftermathReading(past, T0, 24, 'ask', 10 * HOUR)).not.toBeNull();
    });

    test('reads the side asked for, and a side that was empty is a gap', () => {
        const bidOnly = sightingsFromRows([row(T0 + 24 * HOUR, 0, 70)]);
        expect(aftermathReading(bidOnly, T0, 24, 'bid').price).toBe(70);
        expect(aftermathReading(bidOnly, T0, 24, 'ask')).toBeNull();
    });
});

describe('targetAftermath', () => {
    /**
     * A pin whose target fired at each of the moments given, at `firedAt` price.
     * @param {Array<{at: number, price: number}>} reaches - The reaches
     * @returns {Object}
     */
    function pin(reaches) {
        return {
            key: '/items/cheese:0',
            life: [
                { kind: 'set', at: T0 - HOUR, price: 120, side: 'ask' },
                ...reaches.map((r) => ({ kind: 'reached', at: r.at, price: r.price, side: 'ask' })),
            ],
        };
    }

    test('a pin that has never fired reports no reaches, so nothing is drawn', () => {
        const never = { key: '/items/cheese:0', life: [{ kind: 'set', at: T0, price: 120, side: 'ask' }] };
        expect(targetAftermath(never, []).reaches).toBe(0);
        expect(describeAftermath(targetAftermath(never, []))).toBe('');
        expect(describeAftermath(targetAftermath(null, []))).toBe('');
    });

    test('measures each window against the price at the moment it fired', () => {
        const sightings = sightingsFromRows([row(T0 + 24 * HOUR, 90), row(T0 + 72 * HOUR, 80)]);
        const result = targetAftermath(pin([{ at: T0, price: 100 }]), sightings);

        expect(result.reaches).toBe(1);
        expect(result.windows[0]).toEqual({ hours: 24, readings: 1, gaps: 0, medianPercent: -10 });
        expect(result.windows[1]).toEqual({ hours: 72, readings: 1, gaps: 0, medianPercent: -20 });
    });

    test('pools several reaches as a median, so one crash is not the whole answer', () => {
        const sightings = sightingsFromRows([
            row(T0 + 24 * HOUR, 90),
            row(T0 + 100 * HOUR + 24 * HOUR, 50),
            row(T0 + 200 * HOUR + 24 * HOUR, 99),
        ]);
        const result = targetAftermath(
            pin([
                { at: T0, price: 100 },
                { at: T0 + 100 * HOUR, price: 100 },
                { at: T0 + 200 * HOUR, price: 100 },
            ]),
            sightings,
            { hours: [24] }
        );

        expect(result.windows[0].readings).toBe(3);
        // −10, −50, −1 → median −10, not the −20.3 mean a crash would drag it to
        expect(result.windows[0].medianPercent).toBe(-10);
    });

    test('an even number of readings averages the two in the middle', () => {
        const sightings = sightingsFromRows([row(T0 + 24 * HOUR, 90), row(T0 + 100 * HOUR + 24 * HOUR, 80)]);
        const result = targetAftermath(
            pin([
                { at: T0, price: 100 },
                { at: T0 + 100 * HOUR, price: 100 },
            ]),
            sightings,
            { hours: [24] }
        );
        expect(result.windows[0].medianPercent).toBe(-15);
    });

    test('a reach landing in a sighting gap is counted as a gap, not read from a neighbour', () => {
        const sightings = sightingsFromRows([row(T0 + 24 * HOUR, 90)]);
        const result = targetAftermath(
            pin([
                { at: T0, price: 100 },
                { at: T0 + 500 * HOUR, price: 100 },
            ]),
            sightings,
            { hours: [24] }
        );

        expect(result.windows[0]).toEqual({ hours: 24, readings: 1, gaps: 1, medianPercent: -10 });
    });

    test('a reach with no recorded price is not measurable and is left out entirely', () => {
        const sightings = sightingsFromRows([row(T0 + 24 * HOUR, 90)]);
        const blind = {
            key: '/items/cheese:0',
            life: [{ kind: 'reached', at: T0, price: null, side: 'ask' }],
        };
        expect(targetAftermath(blind, sightings).reaches).toBe(0);
    });

    test('a bid target is measured against the bid side', () => {
        const sightings = sightingsFromRows([row(T0 + 24 * HOUR, 999, 110)]);
        const seller = {
            key: '/items/cheese:0',
            life: [{ kind: 'reached', at: T0, price: 100, side: 'bid' }],
        };
        expect(targetAftermath(seller, sightings, { hours: [24] }).windows[0].medianPercent).toBe(10);
    });
});

describe('describeAftermath', () => {
    test('says how many times it fired and what each window did', () => {
        const text = describeAftermath({
            reaches: 3,
            windows: [
                { hours: 24, readings: 3, gaps: 0, medianPercent: -2.14 },
                { hours: 72, readings: 2, gaps: 1, medianPercent: 4 },
            ],
        });
        expect(text).toBe(
            'After the target fired 3 times: 24h −2.1% (n=3) · 72h +4.0% (n=2, 1 with no follow-up reading)'
        );
    });

    test('a window with no readings at all says so rather than being dropped', () => {
        const text = describeAftermath({
            reaches: 1,
            windows: [
                { hours: 24, readings: 1, gaps: 0, medianPercent: -3 },
                { hours: 72, readings: 0, gaps: 1, medianPercent: null },
            ],
        });
        expect(text).toContain('72h no follow-up reading');
        expect(text).toContain('fired 1 time:');
    });
});
