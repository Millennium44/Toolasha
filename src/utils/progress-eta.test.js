/**
 * Estimating what is left of a run.
 *
 * The clock is injected rather than advanced with fake timers: what is being
 * tested is arithmetic over timestamps, and handing it the timestamps directly
 * is both faster and clearer about which readings produce which estimate.
 */

import { describe, test, expect } from 'vitest';
import { createEtaTracker, formatEta } from './progress-eta.js';

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
