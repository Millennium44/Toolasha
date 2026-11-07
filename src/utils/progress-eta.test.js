/**
 * Estimating what is left of a run.
 *
 * The clock is injected rather than advanced with fake timers: what is being
 * tested is arithmetic over timestamps, and handing it the timestamps directly
 * is both faster and clearer about which readings produce which estimate.
 */

import { describe, test, expect } from 'vitest';
import { createEtaTracker, createWorkEstimator, formatEta } from './progress-eta.js';

/** A tracker whose clock is a variable this test moves by hand */
function tracked(options = {}) {
    let clock = 0;
    const tracker = createEtaTracker({ now: () => clock, ...options });
    return {
        /** Advance the clock, then report progress */
        at(ms, fraction) {
            clock = ms;
            return tracker.update(fraction);
        },
        tracker,
    };
}

describe('saying how long is left', () => {
    test('a steady run is estimated from its own pace', () => {
        const run = tracked();

        // A tenth done after ten seconds is ninety seconds left
        run.at(5_000, 0.05);
        const estimate = run.at(10_000, 0.1);

        expect(estimate.remainingMs).toBeCloseTo(90_000, -2);
        expect(estimate.text).toBe('~1m 30s left');
    });

    test('it notices when the run slows down', () => {
        // Ranking modes front-load the cheap candidates; an estimate that only
        // ever averages the whole run keeps promising a finish it has missed
        const run = tracked();
        run.at(1_000, 0.1);
        run.at(2_000, 0.2);
        run.at(3_000, 0.3);
        const brisk = run.at(4_000, 0.4);

        // A fifth of the pace, twice over
        const slowing = run.at(20_000, 0.45);
        const slower = run.at(36_000, 0.5);

        expect(slowing.remainingMs).toBeGreaterThan(brisk.remainingMs);
        expect(slower.remainingMs).toBeGreaterThan(brisk.remainingMs * 2);
    });

    test('and does not lurch on a single slow step', () => {
        // Averaging in the whole run's pace is what keeps one expensive
        // candidate from claiming another ten minutes
        const run = tracked();
        for (let ms = 1_000; ms <= 10_000; ms += 1_000) run.at(ms, ms / 100_000);
        const steady = run.at(10_000, 0.1);

        const blip = run.at(13_000, 0.11);

        expect(blip.remainingMs).toBeLessThan(steady.remainingMs * 2);
    });

    test('a run that has not moved is not a run that has stalled forever', () => {
        const run = tracked();
        run.at(5_000, 0.25);
        const repeated = run.at(6_000, 0.25);

        expect(repeated.remainingMs).toBeGreaterThan(0);
        expect(Number.isFinite(repeated.remainingMs)).toBe(true);
    });
});

describe('when it declines to say', () => {
    test('the first second is mostly workers starting, and says so', () => {
        const run = tracked();
        run.at(200, 0.05);

        expect(run.at(400, 0.1)).toMatchObject({ remainingMs: null, text: 'estimating…' });
    });

    test('a run barely off the mark says nothing either, however long it has been', () => {
        // 0.5% in, a rate is a rounding error multiplied by two hundred
        const run = tracked();
        run.at(30_000, 0.002);

        expect(run.at(60_000, 0.004).text).toBe('estimating…');
    });

    test('a finished run says nothing rather than "0s left"', () => {
        const run = tracked();
        run.at(1_000, 0.1);

        expect(run.at(10_000, 1).text).toBe('');
    });

    test('progress past the end is still finished', () => {
        const run = tracked();
        run.at(1_000, 0.1);

        expect(run.at(10_000, 1.4).remainingMs).toBe(0);
    });
});

describe('how the estimate reads', () => {
    test('under ten seconds is not worth a number', () => {
        expect(formatEta(4_000)).toBe('a few seconds');
    });

    test('seconds round to five, minutes to fifteen', () => {
        expect(formatEta(43_000)).toBe('45s');
        expect(formatEta(190_000)).toBe('3m 15s');
    });

    test('and a long run rounds to the minute', () => {
        expect(formatEta(1_000_000)).toBe('17m');
        expect(formatEta(4_000_000)).toBe('1h 7m');
    });

    test('a round number does not carry a trailing zero', () => {
        expect(formatEta(120_000)).toBe('2m');
        expect(formatEta(3_600_000)).toBe('1h');
    });

    test('nothing left is not a negative estimate', () => {
        expect(formatEta(-5_000)).toBe('a few seconds');
        expect(formatEta(undefined)).toBe('a few seconds');
    });
});

describe('the elapsed side', () => {
    test('is measured from when the tracker was made', () => {
        const run = tracked();
        run.at(7_500, 0.3);

        expect(run.tracker.elapsedMs()).toBe(7_500);
    });
});

describe('time left weighted by what each piece of work costs', () => {
    /** An estimator whose clock this test moves by hand */
    function estimator(options = {}) {
        const clock = { at: 0 };
        const work = createWorkEstimator({ now: () => clock.at, ...options });
        /** Run one planned piece from `from` to `to` ms */
        const run = (kind, units, from, to) => {
            clock.at = from;
            const job = work.start(kind, units);
            clock.at = to;
            work.finish(job);
        };
        return { work, clock, run };
    }

    test('says nothing until a piece has finished', () => {
        const { work } = estimator();
        work.add('house', 1, 3);
        expect(work.remainingMs()).toBeNull();
    });

    test('a combat level (three sims) left to run is not priced like a house room (one)', () => {
        const { work, run } = estimator({ priorWeight: 0 });
        work.add('baseline', 1);
        work.add('house', 1, 2);
        work.add('combat_level', 1, 5);
        run('baseline', 1, 0, 1000);
        run('house', 1, 1000, 2000);
        run('combat_level', 1, 2000, 5000);
        // Left: one house room (1 s) and four combat levels (3 s each). A plain per-item average (5 s over three
        // items done) would say 5 × 1.67 s = 8.3 s
        expect(work.remainingMs()).toBe(1000 + 4 * 3000);
    });

    test('a kind not seen yet is costed at the run average; one seen once leans on the average', () => {
        const { work, run } = estimator({ priorWeight: 1 });
        work.add('house', 1, 2);
        work.add('drink', 1, 1);
        run('house', 1, 0, 1000);
        expect(work.rateMs('drink')).toBe(1000);
        expect(work.remainingMs()).toBe(2000);
        work.add('combat_level', 1, 1);
        run('combat_level', 1, 1000, 4000);
        // Average now 2 s a unit; combat level's own 3 s blended with one unit of it is 2.5 s
        expect(work.rateMs('combat_level')).toBe(2500);
    });

    test('units scale the cost: a 4× re-sim of a kind is four of its first-pass pieces', () => {
        const { work, run } = estimator({ priorWeight: 0 });
        work.add('enhancement', 1, 2);
        run('enhancement', 1, 0, 2000);
        work.add('baseline', 4);
        work.add('enhancement', 4, 2);
        // One enhancement left at 1 unit, two at 4 units, a baseline at 4 units costed at the run average (2 s)
        expect(work.remainingMs()).toBe(2000 + 2 * 8000 + 8000);
    });

    test('a running piece counts what is left of it; lanes divide the total', () => {
        const { work, run, clock } = estimator({ priorWeight: 0, lanes: 2 });
        work.add('house', 1, 3);
        run('house', 1, 0, 2000);
        work.start('house', 1);
        clock.at = 3500;
        // One pending (2 s) plus 0.5 s left of the running one, over two lanes
        expect(work.remainingMs()).toBe((2000 + 500) / 2);
    });

    test('a piece Stop cut short teaches nothing; complete() records a piece timed from outside', () => {
        const { work, clock } = estimator({ priorWeight: 0 });
        work.add('food', 1, 3);
        const job = work.start('food', 1);
        clock.at = 100;
        work.finish(job, false);
        expect(work.remainingMs()).toBeNull();
        work.complete('food', 1, 400);
        expect(work.remainingMs()).toBe(400);
    });
});

describe('a smoothed estimate the run worked out itself', () => {
    test('counts down between reports and moves only part of the way to a new reading', () => {
        let clock = 0;
        const eta = createEtaTracker({ now: () => clock, minElapsedMs: 0 });
        expect(eta.updateRemaining(null, 0).text).toBe('estimating…');
        clock = 2000;
        expect(eta.updateRemaining(60_000, 0.1).remainingMs).toBe(60_000);
        // Ten seconds on with the same reading: the countdown says 50 s, the reading 60 s
        clock = 12_000;
        expect(eta.updateRemaining(60_000, 0.2).remainingMs).toBeCloseTo(50_000 + 0.3 * 10_000);
        // A round of re-sims doubles the reading: the shown figure moves 30% of the way, not all of it
        clock = 12_000;
        const before = eta.updateRemaining(53_000, 0.2).remainingMs;
        const after = eta.updateRemaining(120_000, 0.2).remainingMs;
        expect(after).toBeCloseTo(before + 0.3 * (120_000 - before));
        expect(after).toBeLessThan(80_000);
    });

    test('quiet while the run is young, empty once finished', () => {
        let clock = 0;
        const eta = createEtaTracker({ now: () => clock, minElapsedMs: 1500 });
        clock = 500;
        expect(eta.updateRemaining(10_000, 0.5).text).toBe('estimating…');
        clock = 2000;
        expect(eta.updateRemaining(10_000, 0.5).text).toMatch(/left$/);
        expect(eta.updateRemaining(0, 1).text).toBe('');
    });
});
