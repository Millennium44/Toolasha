/**
 * What a trial you did NOT join is doing, measured from when its tiers clear.
 *
 * ## Why the old points model was the wrong signal
 *
 * The Trials tab states each card's running total points, and this feature used
 * to fit a points-per-second across timestamped readings of that total. But the
 * stated total is a **step function**: it only moves when a tier banks, and sits
 * flat in between. A regression over it therefore alternates between ~0 and a
 * spike, and every number built on it — "Est. fill 12 pts/s", "Next tier in
 * 4m" — was noise dressed as a measurement.
 *
 * ## What is actually observable
 *
 * The one honest signal a card gives for a trial nobody here joined is **when
 * its tier badge changes**. That is a timestamped event, and the work behind it
 * is known exactly: a skilling tier's pool is the first tier's work plus a tenth
 * of it per tier ({@link module:./guild-trials-math.SKILLING_TIER_STEP}), a
 * combat tier's is the boss-health ladder, and both scale by the same
 * 1%-per-participant factor. So between two consecutive badges the guild filled
 * a pool of known size in a known time, which is a **work rate**.
 *
 * Better still, the walk needs no work base at all. Every pool on the ladder is
 * `base × party × shape(tier)`, so working in units of `shape` — the tier's
 * share of the first tier's work — cancels both the base and the participant
 * scale. A trial whose skill has never been seen from the inside can still be
 * projected; only *printing* a rate as "work/s" needs a base.
 *
 * ## What is measured and what is walked
 *
 * - **Measured**: the time between consecutive tier badges, one rate per
 *   interval. Two badges give one rate; three or more give a rate *and* the
 *   per-tier decline, fitted by least squares exactly as the joined-side
 *   success-rate slowdown is ({@link module:./guild-trial-forecast.successDecline}).
 * - **Walked**: everything ahead. The next tier's ETA is what is left of its
 *   pool over the rate projected *for that tier*, and the tiers before the hour
 *   ends are counted one at a time with the rate falling as it goes — never a
 *   time divided by a constant.
 *
 * The decline is a proxy for the participants' success rates falling as the
 * tier's level climbs past their skill, and that is why it **flattens at the
 * level cap**: trial levels stop at {@link module:./guild-trials-math.TRIAL_MAX_LEVEL},
 * so past {@link module:./guild-trials-math.TRIAL_MAX_TIER} nobody's success
 * rate falls any further and a linear extrapolation would walk the rate to zero
 * for no reason.
 *
 * Pure throughout: records in, numbers out, no DOM and no clock of its own.
 */

import { tierPoolWork, tierWorkShape, TRIAL_MAX_TIER } from './guild-trials-math.js';

/** Below this many timestamped tier badges there is no interval to measure. */
export const MIN_TIER_CLEARS = 2;

/**
 * How far the projected rate may fall, as a fraction of the rate measured.
 *
 * The joined-side model floors a member's success rate at 5% rather than
 * letting it reach zero, and the guild's fill rate is that success rate summed
 * over the party — so the same floor applies to it. Without one, a steep fit
 * extrapolated a few tiers out produces a negative rate and an infinite ETA.
 */
export const RATE_FLOOR_FRACTION = 0.05;

/**
 * The tier badges this record has been *watched* changing to, with their times.
 *
 * Only transitions count. A card first seen already badged T16 says nothing
 * about when T16 banked — it may have been an hour earlier — and pairing that
 * timestamp with the next one measures a fraction of the real interval and
 * reports a rate several times too high. `recordTileSample` therefore writes
 * `tierSeenAt` only when it sees the badge *move*, and this reads that.
 *
 * @param {Object} record - A tile record from the store
 * @returns {Array<{tier: number, at: number}>} Ascending by tier
 */
export function tierClearTimes(record) {
    const seen = record?.tierSeenAt;
    if (!seen || typeof seen !== 'object') return [];
    return Object.entries(seen)
        .map(([tier, at]) => ({ tier: Number(tier), at: Number(at) }))
        .filter((entry) => Number.isFinite(entry.tier) && entry.tier >= 1 && Number.isFinite(entry.at))
        .sort((a, b) => a.tier - b.tier);
}

/**
 * The guild's fill rate over each interval between consecutive tier badges.
 *
 * Between the badge that says "t tiers banked" and the one that says "t+1", the
 * guild filled tier **t+1**'s pool — the badge counts what is finished, so the
 * pool being worked is one past it. Rates are in *shares* of the first tier's
 * work per millisecond, which is what makes the base and the party size cancel.
 *
 * Non-consecutive badges are skipped rather than averaged: a tab that was shut
 * for two tiers gives an interval covering two pools, and folding that in as if
 * it were one would halve the rate.
 *
 * @param {Object} record - A tile record from the store
 * @param {Object} [options] - Options
 * @param {'skilling'|'combat'} [options.kind] - Which ladder the pools sit on
 * @returns {Array<{tier: number, sharePerMs: number, ms: number}>} One entry per usable interval
 */
export function tierFillRates(record, { kind = 'skilling' } = {}) {
    const clears = tierClearTimes(record);
    const rates = [];
    for (let i = 1; i < clears.length; i += 1) {
        const from = clears[i - 1];
        const to = clears[i];
        if (to.tier !== from.tier + 1) continue;

        const ms = to.at - from.at;
        if (!(ms > 0)) continue;

        const share = tierWorkShape(kind, to.tier);
        if (!Number.isFinite(share) || share <= 0) continue;

        rates.push({ tier: to.tier, sharePerMs: share / ms, ms });
    }
    return rates;
}

/**
 * A straight line through the measured rates, tier against rate.
 *
 * The same shape as the joined side's success-rate fit, and for the same
 * reason: one interval is a reading, two or more are a trend. With a single
 * reading the caller is told to walk flat (`perTier: null`) rather than being
 * handed a slope invented from one point.
 *
 * @param {Array<{tier: number, sharePerMs: number}>} rates - From {@link tierFillRates}
 * @returns {{atTier: number, rate: number, perTier: number|null, observations: number}|null} The fit
 */
export function declineFit(rates) {
    const points = (rates || []).filter((point) => Number.isFinite(point?.tier) && point?.sharePerMs > 0);
    if (!points.length) return null;

    const sorted = [...points].sort((a, b) => a.tier - b.tier);
    const newest = sorted[sorted.length - 1];
    if (sorted.length < 2) {
        return { atTier: newest.tier, rate: newest.sharePerMs, perTier: null, observations: 1 };
    }

    const meanTier = sorted.reduce((sum, point) => sum + point.tier, 0) / sorted.length;
    const meanRate = sorted.reduce((sum, point) => sum + point.sharePerMs, 0) / sorted.length;
    let top = 0;
    let bottom = 0;
    for (const point of sorted) {
        top += (point.tier - meanTier) * (point.sharePerMs - meanRate);
        bottom += (point.tier - meanTier) ** 2;
    }

    return {
        atTier: newest.tier,
        rate: newest.sharePerMs,
        perTier: bottom > 0 ? top / bottom : null,
        observations: sorted.length,
    };
}

/**
 * The rate a tier is projected to run at, in shares per millisecond.
 *
 * Flat when only one interval was measured. Otherwise the fitted line, held
 * above its floor, and **held flat past the level cap**: the decline is the
 * party's success rate falling as the tier's level rises, and the level stops
 * rising at the top of the ladder.
 *
 * @param {Object|null} fit - From {@link declineFit}
 * @param {number} tier - The tier wanted
 * @returns {number|null} Shares per millisecond, or null with nothing measured
 */
export function rateAtTier(fit, tier) {
    if (!fit || !Number.isFinite(tier)) return null;
    if (!Number.isFinite(fit.perTier)) return fit.rate;

    const capped = Math.min(tier, TRIAL_MAX_TIER);
    const projected = fit.rate + fit.perTier * (capped - fit.atTier);
    return Math.max(fit.rate * RATE_FLOOR_FRACTION, projected);
}

/**
 * Everything a card can say about a trial this character did not join.
 *
 * @param {Object} record - A tile record from the store
 * @param {Object} [options] - Context
 * @param {'skilling'|'combat'} [options.kind] - Which ladder the pools sit on
 * @param {number} [options.participants] - Members signed up, for printing a work rate
 * @param {number|null} [options.workBase] - The skill's first-tier work, for printing a work rate
 * @param {number|null} [options.timeLeftMs] - Active time left in the trial
 * @param {number} [options.now] - Clock, for how far into the current tier the guild is
 * @param {number|null} [options.bankedTiers] - Tiers banked, when the analysis knows better than the badges
 * @returns {{measured: number, currentTier: number, sharePerMs: number, workPerSecond: number|null,
 *   declinePerTier: number|null, etaMsToNextTier: number|null, tiersBeforeEnd: number|null,
 *   expectedTier: number|null, clears: Array<Object>, limitedBy: string, atLevelCap: boolean,
 *   reason: string|null}|null} The model, or null when nothing has been watched
 */
export function tierTimingForecast(
    record,
    {
        kind = 'skilling',
        participants = 0,
        workBase = null,
        timeLeftMs = null,
        now = Date.now(),
        bankedTiers = null,
    } = {}
) {
    const clears = tierClearTimes(record);
    if (clears.length < MIN_TIER_CLEARS) {
        return {
            measured: clears.length,
            currentTier: null,
            sharePerMs: null,
            workPerSecond: null,
            declinePerTier: null,
            etaMsToNextTier: null,
            tiersBeforeEnd: null,
            expectedTier: null,
            clears: [],
            limitedBy: 'unmeasured',
            atLevelCap: false,
            reason: 'measuring — needs two tier clears',
        };
    }

    const rates = tierFillRates(record, { kind });
    const fit = declineFit(rates);
    if (!fit) {
        return {
            measured: clears.length,
            currentTier: null,
            sharePerMs: null,
            workPerSecond: null,
            declinePerTier: null,
            etaMsToNextTier: null,
            tiersBeforeEnd: null,
            expectedTier: null,
            clears: [],
            limitedBy: 'unmeasured',
            atLevelCap: false,
            reason: 'measuring — needs two consecutive tier clears',
        };
    }

    // The badge counts tiers banked, so the pool being filled now is one past
    // the newest badge — unless the analysis has a higher banked count from
    // somewhere the badges have not caught up with.
    const newest = clears[clears.length - 1];
    const banked = Number.isFinite(bankedTiers) ? Math.max(bankedTiers, newest.tier) : newest.tier;
    const currentTier = banked + 1;

    const shareNow = rateAtTier(fit, currentTier);
    const needNow = tierWorkShape(kind, currentTier);

    // How far in the guild already is. Unjoined cards carry no fill bar, so the
    // only honest estimate is the time since the badge moved spent at the rate
    // this tier is projected to run at — which is exactly the walk's own
    // assumption, applied to the part of the tier that has already happened.
    const sinceMs = Number.isFinite(newest.at) && Number.isFinite(now) ? Math.max(0, now - newest.at) : 0;
    const doneShare = Number.isFinite(shareNow) ? shareNow * sinceMs : 0;
    const remainingShare = Number.isFinite(needNow) ? Math.max(0, needNow - doneShare) : null;

    const etaMsToNextTier =
        Number.isFinite(remainingShare) && Number.isFinite(shareNow) && shareNow > 0 ? remainingShare / shareNow : null;

    // The walk. One tier at a time, each priced at its own projected rate — the
    // whole point of the model, and the thing dividing a time by a constant
    // rate cannot do.
    const walked = [];
    let limitedBy = 'time';
    if (Number.isFinite(timeLeftMs) && timeLeftMs >= 0 && Number.isFinite(remainingShare)) {
        let spentMs = 0;
        let tier = currentTier;
        let need = remainingShare;
        while (tier <= TRIAL_MAX_TIER) {
            const rate = rateAtTier(fit, tier);
            if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(need)) {
                limitedBy = 'unknown-next-tier';
                break;
            }
            const takesMs = need / rate;
            if (spentMs + takesMs > timeLeftMs) break;

            spentMs += takesMs;
            walked.push({ tier, atMs: spentMs, share: need });
            if (tier === TRIAL_MAX_TIER) {
                limitedBy = 'ladder';
                break;
            }
            tier += 1;
            need = tierWorkShape(kind, tier);
        }
    } else {
        limitedBy = 'no-clock';
    }

    // Printed only where the skill's first-tier work is known. The walk above
    // never needed it; a "12.4 work/s" caption does.
    const poolNow = Number.isFinite(workBase)
        ? tierPoolWork({ baseWork: workBase, tier: currentTier, participants })
        : null;
    const workPerSecond =
        Number.isFinite(poolNow) && Number.isFinite(needNow) && needNow > 0 && Number.isFinite(shareNow)
            ? (shareNow * poolNow * 1000) / needNow
            : null;

    // As a fraction of the rate this tier runs at, which is how a caption wants
    // it: "falling ~7%/tier" rather than a slope in shares per millisecond.
    const declinePerTier =
        Number.isFinite(fit.perTier) && Number.isFinite(shareNow) && shareNow > 0 ? -fit.perTier / shareNow : null;

    return {
        measured: clears.length,
        intervals: rates.length,
        currentTier,
        bankedTiers: banked,
        sharePerMs: shareNow,
        workPerSecond,
        declinePerTier,
        etaMsToNextTier,
        tiersBeforeEnd: Number.isFinite(timeLeftMs) ? walked.length : null,
        expectedTier: walked.length ? walked[walked.length - 1].tier : banked || null,
        clears: walked,
        limitedBy,
        // Whether the walk crosses the level cap, where the decline flattens —
        // worth saying in a tooltip, because past it a deep tier is merely big
        // rather than also slower
        atLevelCap: currentTier + walked.length > TRIAL_MAX_TIER,
        reason: null,
    };
}

/**
 * The tier-timing model dressed as a forecast, so the panel's Expected row can
 * draw it with no idea which side of the join it came from.
 *
 * `forecastTrial` cannot produce this one: its skilling branch needs a measured
 * fill rate, and a trial nobody here joined never streams a bar to measure. The
 * shape returned is the same, with a source of its own so the caption can say
 * what it rests on.
 *
 * @param {Object|null} timing - From {@link tierTimingForecast}
 * @returns {Object|null} A forecast, or null when there is nothing to state
 */
export function tierTimingAsForecast(timing) {
    if (!timing || !Number.isFinite(timing.expectedTier) || timing.expectedTier <= 0) return null;
    return {
        tier: timing.expectedTier,
        tiersCleared: timing.expectedTier,
        finalTier: timing.expectedTier,
        clears: timing.clears,
        source: 'tier-timing',
        limitedBy: timing.limitedBy,
        coverage: null,
        reason: null,
        decline: Number.isFinite(timing.declinePerTier)
            ? { perTier: timing.declinePerTier, observations: timing.intervals ?? 0 }
            : null,
        atLevelCap: timing.atLevelCap,
        measured: timing.measured,
    };
}
