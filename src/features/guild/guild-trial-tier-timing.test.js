import { describe, expect, test } from 'vitest';

import {
    declineFit,
    MIN_TIER_CLEARS,
    RATE_FLOOR_FRACTION,
    rateAtTier,
    tierClearTimes,
    tierFillRates,
    tierTimingAsForecast,
    tierTimingForecast,
} from './guild-trial-tier-timing.js';
import { SKILLING_TIER_STEP, TRIAL_MAX_TIER, tierWorkShape } from './guild-trials-math.js';

/** A tier's share of the first tier's work, spelled out rather than imported into the expectation */
const share = (tier) => 1 + SKILLING_TIER_STEP * (tier - 1);

describe('tierClearTimes — only badges that were watched moving', () => {
    test('reads the record’s tier timestamps in tier order', () => {
        expect(tierClearTimes({ tierSeenAt: { 17: 2000, 16: 1000 } })).toEqual([
            { tier: 16, at: 1000 },
            { tier: 17, at: 2000 },
        ]);
    });

    test('a record with nothing timed has nothing to say', () => {
        expect(tierClearTimes({})).toEqual([]);
        expect(tierClearTimes(null)).toEqual([]);
        expect(tierClearTimes({ tierSeenAt: { 3: 'soon' } })).toEqual([]);
    });
});

describe('tierFillRates — the work behind each interval', () => {
    test('two consecutive badges give one rate, in shares per millisecond', () => {
        // T16 banked at 0, T17 at 100s: the guild filled T17's pool, which is
        // 1 + 0.1 × 16 = 2.6 shares of the first tier's work
        const rates = tierFillRates({ tierSeenAt: { 16: 0, 17: 100_000 } });
        expect(rates).toHaveLength(1);
        expect(rates[0].tier).toBe(17);
        expect(rates[0].sharePerMs).toBeCloseTo(share(17) / 100_000, 12);
    });

    test('a gap in the badges is skipped rather than averaged across two pools', () => {
        // The tab was shut through T18, so 17 → 19 covers two pools and is not
        // one interval. Only 19 → 20 is usable.
        const rates = tierFillRates({ tierSeenAt: { 17: 0, 19: 200_000, 20: 300_000 } });
        expect(rates.map((rate) => rate.tier)).toEqual([20]);
    });

    test('two badges at the same instant are not an interval', () => {
        expect(tierFillRates({ tierSeenAt: { 4: 5000, 5: 5000 } })).toEqual([]);
    });
});

describe('declineFit — one reading is not a trend', () => {
    test('a single interval is a flat rate with no slope', () => {
        const fit = declineFit([{ tier: 17, sharePerMs: 0.001 }]);
        expect(fit).toEqual({ atTier: 17, rate: 0.001, perTier: null, observations: 1 });
    });

    test('three intervals fit a straight decline through them', () => {
        const fit = declineFit([
            { tier: 15, sharePerMs: 0.003 },
            { tier: 16, sharePerMs: 0.002 },
            { tier: 17, sharePerMs: 0.001 },
        ]);
        expect(fit.atTier).toBe(17);
        expect(fit.rate).toBeCloseTo(0.001, 12);
        expect(fit.perTier).toBeCloseTo(-0.001, 12);
        expect(fit.observations).toBe(3);
    });
});

describe('rateAtTier — the decline flattens at the level cap', () => {
    const fit = { atTier: 10, rate: 0.002, perTier: -0.0001, observations: 3 };

    test('walks the fitted line up the ladder', () => {
        expect(rateAtTier(fit, 12)).toBeCloseTo(0.0018, 12);
    });

    test('past the top tier the rate stops falling, because the trial level stops rising', () => {
        // Trial levels cap at 300, which is T21. A participant's success rate
        // falls because the tier's level climbs past their skill; once the
        // level stops climbing the decline has nothing left to be caused by.
        const atCap = rateAtTier(fit, TRIAL_MAX_TIER);
        expect(rateAtTier(fit, TRIAL_MAX_TIER + 1)).toBe(atCap);
        expect(rateAtTier(fit, TRIAL_MAX_TIER + 8)).toBe(atCap);
    });

    test('a steep fit is floored rather than walked to zero', () => {
        const steep = { atTier: 2, rate: 0.002, perTier: -0.001, observations: 3 };
        expect(rateAtTier(steep, TRIAL_MAX_TIER)).toBeCloseTo(0.002 * RATE_FLOOR_FRACTION, 12);
    });

    test('one measured interval is held flat', () => {
        expect(rateAtTier({ atTier: 5, rate: 0.004, perTier: null }, 12)).toBe(0.004);
    });
});

describe('tierTimingForecast — a projection for a trial nobody here joined', () => {
    test('below two tier clears it says it is measuring rather than guessing', () => {
        const timing = tierTimingForecast({ tierSeenAt: { 16: 1000 } }, { timeLeftMs: 60_000 });
        expect(timing.reason).toContain('needs two tier clears');
        expect(timing.sharePerMs).toBeNull();
        expect(timing.expectedTier).toBeNull();
        expect(MIN_TIER_CLEARS).toBe(2);
    });

    test('two tier clears give a rate, an ETA and a walk', () => {
        // T16 banked at t=0, T17 at t=100s. T17's pool is 2.6 shares, so the
        // guild is filling 0.026 shares a second, and T18's 2.7 shares take
        // 2.7 / 0.026 ≈ 103.8s from the badge moving.
        const timing = tierTimingForecast(
            { tierSeenAt: { 16: 0, 17: 100_000 } },
            { timeLeftMs: 600_000, now: 100_000, participants: 40, workBase: 40_000 }
        );

        expect(timing.currentTier).toBe(18);
        expect(timing.sharePerMs).toBeCloseTo(share(17) / 100_000, 12);
        // One interval, so no trend to fit and the rate is held flat
        expect(timing.declinePerTier).toBeNull();
        expect(timing.etaMsToNextTier).toBeCloseTo((share(18) / share(17)) * 100_000, 6);

        // The work rate printed on the card is the share rate priced with the
        // skill's own base and the party's 1%-per-head penalty
        const poolNow = 40_000 * share(18) * 1.4;
        expect(timing.workPerSecond).toBeCloseTo((timing.sharePerMs * poolNow * 1000) / share(18), 6);
    });

    test('the walk is tier by tier at a falling rate, not a time divided by a constant', () => {
        // Rates measured at T17 and T18, falling. Flat, the hour left would
        // clear more tiers than a walk that keeps slowing does.
        const record = { tierSeenAt: { 3: 0, 4: 100_000, 5: 220_000 } };
        const timing = tierTimingForecast(record, { timeLeftMs: 1_000_000, now: 220_000 });

        expect(timing.currentTier).toBe(6);
        expect(timing.declinePerTier).toBeGreaterThan(0);

        // Each clear costs its own tier's rate, so the gaps between them grow
        const gaps = timing.clears.map((clear, index) =>
            index === 0 ? clear.atMs : clear.atMs - timing.clears[index - 1].atMs
        );
        expect(gaps.length).toBeGreaterThan(1);
        for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]).toBeGreaterThan(gaps[i - 1]);

        // …and the same hour walked at the newest rate held flat would reach
        // further, which is the whole reason the walk exists
        const flatRate = timing.sharePerMs;
        let flatTiers = 0;
        let spent = 0;
        for (let tier = timing.currentTier; tier <= TRIAL_MAX_TIER; tier += 1) {
            spent += tierWorkShape('skilling', tier) / flatRate;
            if (spent > 1_000_000) break;
            flatTiers += 1;
        }
        expect(timing.tiersBeforeEnd).toBe(4);
        expect(flatTiers).toBeGreaterThan(timing.tiersBeforeEnd);
    });

    test('the walk stops at the top of the ladder rather than inventing tiers', () => {
        const timing = tierTimingForecast(
            { tierSeenAt: { 18: 0, 19: 10_000 } },
            { timeLeftMs: 60 * 60_000, now: 10_000 }
        );
        expect(timing.expectedTier).toBe(TRIAL_MAX_TIER);
        expect(timing.limitedBy).toBe('ladder');
    });

    test('the analysis’ banked count wins where the badges have not caught up', () => {
        const timing = tierTimingForecast(
            { tierSeenAt: { 16: 0, 17: 100_000 } },
            { timeLeftMs: 600_000, now: 100_000, bankedTiers: 19 }
        );
        expect(timing.currentTier).toBe(20);
    });

    test('a trial that has banked the last tier projects nothing past it', () => {
        // T21 is the end of the ladder, so there is no T22 pool to time — and
        // `tierWorkShape` is deliberately unclamped, so one would price itself
        const timing = tierTimingForecast(
            { tierSeenAt: { 20: 0, 21: 100_000 } },
            { timeLeftMs: 30 * 60_000, now: 100_000, participants: 40, workBase: 40_000 }
        );

        expect(timing.atFinalTier).toBe(true);
        expect(timing.currentTier).toBe(TRIAL_MAX_TIER);
        expect(timing.expectedTier).toBe(TRIAL_MAX_TIER);
        expect(timing.etaMsToNextTier).toBeNull();
        expect(timing.tiersBeforeEnd).toBeNull();
        expect(timing.clears).toEqual([]);
        expect(timing.limitedBy).toBe('ladder');

        // The measured rate is a real reading and survives
        expect(timing.sharePerMs).toBeGreaterThan(0);
        expect(timing.workPerSecond).toBeGreaterThan(0);

        expect(tierTimingAsForecast(timing).atFinalTier).toBe(true);
    });

    test('a trial still fighting the last tier is not at the final tier yet', () => {
        const timing = tierTimingForecast(
            { tierSeenAt: { 19: 0, 20: 100_000 } },
            { timeLeftMs: 30 * 60_000, now: 100_000 }
        );
        expect(timing.atFinalTier).toBe(false);
        expect(timing.currentTier).toBe(TRIAL_MAX_TIER);
        expect(timing.etaMsToNextTier).toBeGreaterThan(0);
    });

    test('with no clock there is a rate but no walk', () => {
        const timing = tierTimingForecast({ tierSeenAt: { 3: 0, 4: 50_000 } }, { timeLeftMs: null, now: 50_000 });
        expect(timing.sharePerMs).toBeGreaterThan(0);
        expect(timing.tiersBeforeEnd).toBeNull();
        expect(timing.limitedBy).toBe('no-clock');
    });
});

describe('tierTimingAsForecast — the Expected row’s own shape', () => {
    test('a walked projection becomes a measured-looking forecast with its own source', () => {
        const timing = tierTimingForecast(
            { tierSeenAt: { 16: 0, 17: 100_000, 18: 220_000 } },
            { timeLeftMs: 900_000, now: 220_000 }
        );
        const forecast = tierTimingAsForecast(timing);

        expect(forecast.source).toBe('tier-timing');
        expect(forecast.tier).toBe(timing.expectedTier);
        expect(forecast.tiersCleared).toBe(timing.expectedTier);
        expect(forecast.reason).toBeNull();
        expect(forecast.decline.perTier).toBeCloseTo(timing.declinePerTier, 12);
    });

    test('nothing measured is nothing stated', () => {
        expect(tierTimingAsForecast(tierTimingForecast({}, { timeLeftMs: 60_000 }))).toBeNull();
        expect(tierTimingAsForecast(null)).toBeNull();
    });
});
