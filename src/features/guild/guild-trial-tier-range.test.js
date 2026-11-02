import { describe, expect, test } from 'vitest';

import {
    fallingIntervals,
    flatWalkTier,
    rangeHalfWidth,
    rangeHover,
    RANGE_HALF_WIDTH_ONE_INTERVAL,
    RANGE_HALF_WIDTH_SETTLED,
    RANGE_HALF_WIDTH_UNSETTLED,
    tierFillRates,
    tierTimingAsForecast,
    tierTimingForecast,
} from './guild-trial-tier-timing.js';
import { SKILLING_TIER_STEP, TRIAL_ACTIVE_MS, TRIAL_MAX_TIER, tierWorkShape } from './guild-trials-math.js';

const share = (tier) => 1 + SKILLING_TIER_STEP * (tier - 1);
const BASE_RATE = 0.00002; // shares of the first tier's work per millisecond

/** Stamps for tiers startTier.. with each interval's rate as a multiple of the base rate */
const stamped = (startTier, factors) => {
    const tierSeenAt = { [startTier]: 0 };
    let at = 0;
    factors.forEach((factor, index) => {
        const tier = startTier + 1 + index;
        at += Math.round(share(tier) / (BASE_RATE * factor));
        tierSeenAt[tier] = at;
    });
    return { record: { tierSeenAt }, last: at };
};
const forecast = (startTier, factors, options = {}) => {
    const { record, last } = stamped(startTier, factors);
    return tierTimingForecast(record, { timeLeftMs: 3_000_000, now: last, windowed: false, ...options });
};

describe('the Expected tier as a range — the rule of rates', () => {
    test('the three half-widths are one constant each, widest for a single reading', () => {
        expect(RANGE_HALF_WIDTH_ONE_INTERVAL).toBeGreaterThan(RANGE_HALF_WIDTH_UNSETTLED);
        expect(RANGE_HALF_WIDTH_UNSETTLED).toBeGreaterThan(RANGE_HALF_WIDTH_SETTLED);
        expect(rangeHalfWidth({ intervals: 1, falling: 0, banked: 3 }).halfWidth).toBe(RANGE_HALF_WIDTH_ONE_INTERVAL);
        expect(rangeHalfWidth({ intervals: 3, falling: 0, banked: 4 })).toEqual({
            halfWidth: RANGE_HALF_WIDTH_UNSETTLED,
            state: 'flat',
        });
        expect(rangeHalfWidth({ intervals: 4, falling: 2, banked: 5 }).state).toBe('falling');
        expect(rangeHalfWidth({ intervals: 5, falling: 3, banked: 6 })).toEqual({
            halfWidth: RANGE_HALF_WIDTH_SETTLED,
            state: 'settled',
        });
        // Thirteen tiers done settles it; twelve does not
        expect(rangeHalfWidth({ intervals: 4, falling: 0, banked: 13 }).state).toBe('settled');
        expect(rangeHalfWidth({ intervals: 4, falling: 0, banked: 12 }).state).toBe('flat');
    });

    test('fallingIntervals counts from the onset and goes back to zero on a recovery', () => {
        const rates = (...values) => values.map((sharePerMs) => ({ sharePerMs }));
        expect(fallingIntervals(rates(1))).toBe(0);
        expect(fallingIntervals(rates(1, 1, 1))).toBe(0);
        expect(fallingIntervals(rates(1, 1.4, 1.9))).toBe(0);
        expect(fallingIntervals(rates(1, 0.9, 0.88))).toBe(0); // within 15% of the best
        expect(fallingIntervals(rates(1, 0.8))).toBe(1);
        expect(fallingIntervals(rates(1, 1, 0.8, 0.7))).toBe(2);
        expect(fallingIntervals(rates(1, 0.8, 0.7, 0.6, 0.5))).toBe(4);
        expect(fallingIntervals(rates(1, 0.7, 0.6, 1))).toBe(0);
        expect(fallingIntervals(null)).toBe(0);
    });

    test('one measured interval: six tiers either side, capped at the top', () => {
        const timing = forecast(1, [1]);
        expect(timing.range).toMatchObject({ state: 'one-interval', halfWidth: 6, falling: 0 });
        expect(timing.expectedTier).toBe(TRIAL_MAX_TIER);
        expect(timing.range.high).toBe(TRIAL_MAX_TIER);
        expect(timing.range.low).toBe(TRIAL_MAX_TIER - 6);
    });

    test('a rate that has not started falling reads as three tiers either side, ending at the top tier', () => {
        const timing = forecast(1, [1, 1, 1]);
        expect(timing.range).toMatchObject({ state: 'flat', halfWidth: 3, falling: 0 });
        expect(`~T${timing.range.low}–${timing.range.high}`).toBe('~T18–21');
        // The count of tiers left is a range too, not a certainty
        expect(timing.tiersBeforeEndRange).toEqual({ low: 18 - 4, high: 21 - 4 });
    });

    test('a rate that has just begun to fall is still three tiers either side', () => {
        const timing = forecast(1, [1, 1, 0.8, 0.7], { timeLeftMs: 400_000 });
        expect(timing.range.falling).toBe(2);
        expect(timing.range).toMatchObject({ state: 'falling', halfWidth: 3 });
        expect(timing.range.low).toBe(Math.max(5, timing.expectedTier - 3));
        expect(timing.range.high).toBeGreaterThanOrEqual(timing.expectedTier);
    });

    test('three or more falling intervals narrow it to one tier either side', () => {
        const timing = forecast(1, [1, 0.8, 0.7, 0.6, 0.5], { timeLeftMs: 600_000 });
        expect(timing.range.falling).toBe(4);
        expect(timing.range).toMatchObject({ state: 'settled', halfWidth: 1 });
        expect(timing.range.low).toBe(timing.expectedTier - 1);
        expect(timing.range.high).toBeLessThanOrEqual(timing.expectedTier + 1);
    });

    test('thirteen tiers done settles it whatever the rate did', () => {
        const timing = forecast(12, [1, 1, 1], { timeLeftMs: 400_000 });
        expect(timing.bankedTiers).toBe(15);
        expect(timing.range).toMatchObject({ state: 'settled', halfWidth: 1, falling: 0 });
    });

    test('a rate that rises is walked flat and stays unsettled', () => {
        const timing = forecast(1, [1, 1.3, 1.6]);
        expect(timing.declinePerTier).toBe(0);
        expect(timing.range).toMatchObject({ state: 'flat', halfWidth: 3 });
    });

    test('a rate that fell and recovered is no surer than a flat one', () => {
        const timing = forecast(1, [1, 0.7, 0.6, 1.0]);
        expect(timing.range.falling).toBe(0);
        expect(timing.range).toMatchObject({ state: 'flat', halfWidth: 3 });
    });

    test('the range never goes below the tiers already banked', () => {
        const timing = forecast(1, [1, 1, 1], { timeLeftMs: 60_000 });
        expect(timing.range.low).toBeGreaterThanOrEqual(timing.bankedTiers);
    });

    test('with almost no time left the range collapses to what is banked', () => {
        const timing = forecast(5, [1, 1, 1], { timeLeftMs: 5_000 });
        expect(timing.expectedTier).toBe(timing.bankedTiers);
        expect(timing.range).toMatchObject({ low: timing.bankedTiers, high: timing.bankedTiers });
        expect(timing.tiersBeforeEndRange).toEqual({ low: 0, high: 0 });
    });

    test('the range is held under what the fastest tier measured could do in the time left', () => {
        const factors = [1, 0.5, 0.4, 0.3, 0.2];
        const { record, last } = stamped(1, factors);
        const timing = tierTimingForecast(record, { timeLeftMs: 400_000, now: last, windowed: false });
        const fastest = Math.max(...tierFillRates(record, { windowed: false }).map((rate) => rate.sharePerMs));
        const ceiling = flatWalkTier({
            kind: 'skilling',
            currentTier: timing.currentTier,
            remainingShare: tierWorkShape('skilling', timing.currentTier),
            rate: fastest,
            timeLeftMs: 400_000,
        });
        expect(timing.range.high).toBeLessThanOrEqual(Math.max(ceiling, timing.expectedTier));
    });

    test('flatWalkTier stops at the clock and at the top of the ladder', () => {
        const rate = BASE_RATE;
        expect(flatWalkTier({ kind: 'skilling', currentTier: 5, remainingShare: share(5), rate, timeLeftMs: 0 })).toBe(
            4
        );
        expect(
            flatWalkTier({ kind: 'skilling', currentTier: 5, remainingShare: share(5), rate, timeLeftMs: 1e12 })
        ).toBe(TRIAL_MAX_TIER);
        expect(flatWalkTier({ kind: 'skilling', currentTier: 5, remainingShare: NaN, rate, timeLeftMs: 1e9 })).toBe(4);
        expect(flatWalkTier({ kind: 'skilling', currentTier: 5, remainingShare: 1, rate: 0, timeLeftMs: 1e9 })).toBe(4);
    });

    test('a tier running past what its rate says is stale, and a settled range goes back to three tiers', () => {
        const { record, last } = stamped(1, [1, 0.8, 0.7, 0.6, 0.5]);
        const fresh = tierTimingForecast(record, { timeLeftMs: 3_000_000, now: last, windowed: false });
        expect(fresh.range.halfWidth).toBe(1);
        const stale = tierTimingForecast(record, {
            timeLeftMs: 3_000_000,
            now: last + 2 * 60 * 60_000,
            windowed: false,
        });
        expect(stale.range.halfWidth).toBe(3);
    });

    test('figures older than a trial’s hour are dropped, and with them the estimate: no range, no tier', () => {
        const { record, last } = stamped(1, [1, 1, 1]);
        const timing = tierTimingForecast(record, { timeLeftMs: 3_000_000, now: last + TRIAL_ACTIVE_MS + 1_000 });
        expect(timing.expectedTier).toBeNull();
        expect(timing.range ?? null).toBeNull();
        expect(tierTimingAsForecast(timing)).toBeNull();
    });

    test('a record with one stamp or none has no range', () => {
        expect(tierTimingForecast({ tierSeenAt: { 4: 1000 } }, { timeLeftMs: 60_000 }).range ?? null).toBeNull();
        expect(tierTimingForecast({}, { timeLeftMs: 60_000 }).range ?? null).toBeNull();
    });

    test('a trial that has banked the top tier states no range: there is nothing above it', () => {
        const timing = forecast(19, [1, 1]);
        expect(timing.atFinalTier).toBe(true);
        expect(timing.range ?? null).toBeNull();
        expect(tierTimingAsForecast(timing).range).toBeNull();
    });

    test('no clock, no range', () => {
        const { record, last } = stamped(1, [1, 1, 1]);
        const timing = tierTimingForecast(record, { now: last, windowed: false });
        expect(timing.range).toBeNull();
        expect(timing.tiersBeforeEndRange).toBeNull();
    });

    test('a combat ladder reads the same rule', () => {
        const record = { tierSeenAt: { 3: 0, 4: 60_000, 5: 125_000, 6: 190_000 } };
        const timing = tierTimingForecast(record, { kind: 'combat', timeLeftMs: 3_000_000, now: 190_000 });
        expect(timing.range.halfWidth).toBeGreaterThan(0);
        expect(timing.range.low).toBeLessThanOrEqual(timing.expectedTier);
        expect(timing.range.high).toBeGreaterThanOrEqual(timing.expectedTier);
    });

    test('the forecast the Expected row draws carries the range, and the hover says why', () => {
        const timing = forecast(1, [1, 1, 1]);
        const drawn = tierTimingAsForecast(timing);
        expect(drawn.range).toEqual(timing.range);
        expect(rangeHover(drawn.range)).toContain('has not started falling');
        expect(rangeHover({ low: 20, high: 20, halfWidth: 3, state: 'flat' })).toBe('');
        expect(rangeHover(null)).toBe('');
    });

    test('a stamp set shaped like a real trial: wide early, settled late', () => {
        // Seconds per tier of a test-server skilling hour, names and ids synthesized: quick flat tiers, then slowing
        const seconds = [35, 38, 40, 44, 47, 52, 57, 64, 75, 90, 110, 140, 185, 250, 340, 470];
        const tierSeenAt = { 1: 1_790_000_000_000 };
        seconds.forEach((s, i) => {
            tierSeenAt[i + 2] = tierSeenAt[i + 1] + s * 1000;
        });
        const upTo = (count) => Object.fromEntries(Object.entries(tierSeenAt).slice(0, count));
        const early = tierTimingForecast(
            { tierSeenAt: upTo(7) },
            { timeLeftMs: 3_100_000, now: tierSeenAt[7], windowed: false }
        );
        expect(early.range.halfWidth).toBeGreaterThanOrEqual(3);
        const late = tierTimingForecast(
            { tierSeenAt: upTo(15) },
            { timeLeftMs: 700_000, now: tierSeenAt[15], windowed: false }
        );
        expect(late.range.halfWidth).toBe(1);
    });
});
