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
 *   per-tier decline, a fraction the rate loses each tier, fitted to the log of
 *   the most recent rates ({@link declineFit}).
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

import { PARTICIPANT_SCALE_STEP, tierWorkShape, TRIAL_ACTIVE_MS, TRIAL_MAX_TIER } from './guild-trials-math.js';

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
 * How many of the most recent intervals the decline is fitted over.
 *
 * The guild's rate is a sum over members whose success rates fall to their floor
 * at different tiers, so the decline steepens as the trial climbs: a fit across
 * the whole hour reads the early, near-flat tiers as the trend.
 */
export const DECLINE_FIT_INTERVALS = 4;

/**
 * The steepest decline per tier a fit may report, as a fraction of the rate.
 *
 * Live parties' tier times grew 1.1-1.85x a tier, the tier's own 4% larger pool
 * included, which is a rate falling up to ~45% a tier. Held to this, the tier in
 * progress can take at most about twice as long as the last one did.
 */
export const MAX_DECLINE_PER_TIER = 0.5;

/**
 * The tier badges this record has been *watched* changing to, with their times —
 * or, where the guild payload stated it, when the server says the tier banked
 * ({@link foldServerTierClears}), which `recordServerTiers` writes over a
 * watched stamp.
 *
 * Only transitions count. A card first seen already badged T16 says nothing
 * about when T16 banked — it may have been an hour earlier — and pairing that
 * timestamp with the next one measures a fraction of the real interval and
 * reports a rate several times too high. `recordTileSample` therefore writes
 * `tierSeenAt` only when it sees the badge *move*, and this reads that.
 *
 * A record is the week's, and a week can hold more than one cycle: a stamp older
 * than a trial's hour before `now` is another cycle's clear, and is dropped
 * rather than paired with this cycle's. A previous cycle's T20 stamp made a T8
 * card read "banked 20 → ~1 more tier, Expected ~T21". Only the test server runs
 * more than one cycle a week, so live callers pass `windowed: false` and read
 * every stamp, as they always have.
 *
 * @param {Object} record - A tile record from the store
 * @param {Object} [options] - Options
 * @param {number|null} [options.now] - Clock; without it no stamp is too old
 * @param {boolean} [options.windowed=true] - Drop stamps older than a trial's hour before `now`
 * @returns {Array<{tier: number, at: number}>} Ascending by tier
 */
export function tierClearTimes(record, { now = null, windowed = true } = {}) {
    const seen = record?.tierSeenAt;
    if (!seen || typeof seen !== 'object') return [];
    return Object.entries(seen)
        .map(([tier, at]) => ({ tier: Number(tier), at: Number(at) }))
        .filter((entry) => Number.isFinite(entry.tier) && entry.tier >= 1 && Number.isFinite(entry.at))
        .filter((entry) => !windowed || !Number.isFinite(now) || now - entry.at <= TRIAL_ACTIVE_MS)
        .sort((a, b) => a.tier - b.tier);
}

/**
 * When each party's tiers banked, as the guild payload states it, folded into
 * what is already held.
 *
 * `guild_updated.currentTrialsData` covers every party — the ones this
 * character did not join included — but each message states only the tier a
 * party has banked *now* and when it banked (`highestTierReachedAtMs`, which is
 * also when the next tier started). A panel opened mid-hour needs the earlier
 * clears too, so they are kept here between messages: one stamp per tier, per
 * party, on the server's clock.
 *
 * A party's clears are started over when a message shows it lower than
 * something held — tiers only climb within a cycle — or a trial's hour past the
 * oldest stamp held: either is the next cycle.
 *
 * @param {Object|null} held - `{[kind]: {[partyKey]: {[tier]: serverMs}}}`, from the last fold
 * @param {Object|null} read - From `parseCurrentTrialsData`
 * @returns {Object} The clears held after this message; `held` itself is not changed
 */
export function foldServerTierClears(held, read) {
    const next = {};
    for (const kind of ['skilling', 'combat']) {
        const parties = { ...(held?.[kind] || {}) };
        const entry = read?.[kind];
        for (const [key, party] of Object.entries(entry?.trials || {})) {
            const tier = party?.highestTier;
            const at = Number.isFinite(party?.highestTierReachedAtMs)
                ? party.highestTierReachedAtMs
                : party?.tierStartedAtMs;
            if (!Number.isFinite(tier) || !Number.isFinite(at)) continue;

            const prior = parties[key] || {};
            const stamps = Object.entries(prior).map(([heldTier, heldAt]) => ({ tier: Number(heldTier), at: heldAt }));
            const nextCycle = stamps.some(
                (stamp) => stamp.tier > tier || stamp.at > at || at - stamp.at > TRIAL_ACTIVE_MS
            );
            const clears = nextCycle ? {} : { ...prior };
            // Tier 0 is the hour starting, not a clear
            if (tier >= 1) clears[tier] = at;
            parties[key] = clears;
        }
        if (Object.keys(parties).length) next[kind] = parties;
    }
    return next;
}

/**
 * How far the client's clock runs ahead of the server's, from one guild message.
 *
 * The payload's stamps are the server's clock and a card's age is worked out on
 * the client's, so a skew between the two would move every "banked N minutes
 * ago" by the same amount. No message states the server's time, but none can
 * carry a stamp from the server's future: the newest stamp in it is at or before
 * the moment it was sent. So `receivedAt − newest stamp` is an upper bound on
 * the skew (plus the trip), and the smallest bound seen is the best estimate.
 * The message is sent because a tier banked often enough — every party's clear
 * changes the payload — that the bound comes down to the trip within a tier or
 * two.
 *
 * An overestimate only ever places a stamp *later* than the clear, never after
 * the message that stated it, so an age derived from it is short rather than
 * long. The differences between stamps, which is what a rate is, do not depend
 * on it at all.
 *
 * @param {Object|null} read - From `parseCurrentTrialsData`
 * @param {number} receivedAt - Client clock when the message arrived
 * @param {number|null} [held] - The estimate so far
 * @returns {number|null} Milliseconds to add to a server stamp, or `held` when the message carries none
 */
export function serverClockOffset(read, receivedAt, held = null) {
    let newest = null;
    for (const kind of ['skilling', 'combat']) {
        for (const party of Object.values(read?.[kind]?.trials || {})) {
            for (const stamp of [party?.highestTierReachedAtMs, party?.tierStartedAtMs]) {
                if (Number.isFinite(stamp) && (newest === null || stamp > newest)) newest = stamp;
            }
        }
    }
    if (newest === null || !Number.isFinite(receivedAt)) return Number.isFinite(held) ? held : null;
    const bound = receivedAt - newest;
    return Number.isFinite(held) ? Math.min(held, bound) : bound;
}

/**
 * Older than this, a login payload read now is not one that just arrived.
 *
 * A feature that starts late reads `init_character_data` off the data manager,
 * where it may have sat since login. Taken as received now, its countdowns run
 * late by its age and its stamps bound the clock offset by hours.
 */
export const INIT_PAYLOAD_FRESH_MS = 2 * 60_000;

/**
 * How long ago a login payload was sent, on the client's clock.
 *
 * `currentTimestamp` is the server's clock when it was sent. Without a known
 * offset the two clocks are taken to agree, so a client running ahead reads a
 * fresh payload as older by the skew.
 *
 * @param {Object|null} payload - An `init_character_data` payload
 * @param {number} now - Client clock
 * @param {number|null} [offset] - From {@link serverClockOffset}
 * @returns {number|null} Milliseconds, or null when the payload carries no parsable `currentTimestamp`
 */
export function initPayloadAgeMs(payload, now, offset = null) {
    const serverNow = Date.parse(payload?.currentTimestamp ?? '');
    if (!Number.isFinite(serverNow) || !Number.isFinite(now)) return null;
    return now - serverNow - (Number.isFinite(offset) ? offset : 0);
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
 * @param {number|null} [options.now] - Clock, for {@link tierClearTimes}
 * @param {boolean} [options.windowed=true] - For {@link tierClearTimes}
 * @returns {Array<{tier: number, sharePerMs: number, ms: number}>} One entry per usable interval
 */
export function tierFillRates(record, { kind = 'skilling', now = null, windowed = true } = {}) {
    const clears = tierClearTimes(record, { now, windowed });
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
 * The fraction of the fill rate lost per tier, fitted over the most recent intervals.
 *
 * Geometric, not a straight line: a line through rates that fell fast early
 * has a slope larger than the newest rate itself, and extrapolated one tier it
 * goes negative. A live Milking party whose last tier took 520 s was projected
 * at the 5% floor as "falling ~1925%/tier, next tier in ~2h 59m". A least-squares
 * line through the log of the rates is a constant fraction lost per tier, which
 * can never cross zero; the fraction is held to `[0, MAX_DECLINE_PER_TIER]`, so a
 * rate that rose is walked flat and a burst of slow tiers cannot promise one
 * more than twice as slow.
 *
 * One interval is a reading, not a trend: the caller is told to walk flat
 * (`perTier: null`) rather than being handed a decline invented from one point.
 * The rate walked from is the newest measured one, not the fitted value.
 *
 * @param {Array<{tier: number, sharePerMs: number}>} rates - From {@link tierFillRates}
 * @returns {{atTier: number, rate: number, perTier: number|null, observations: number}|null} The fit;
 *   `perTier` is the fraction of the rate lost per tier, in `[0, MAX_DECLINE_PER_TIER]`
 */
export function declineFit(rates) {
    const points = (rates || []).filter((point) => Number.isFinite(point?.tier) && point?.sharePerMs > 0);
    if (!points.length) return null;

    const sorted = [...points].sort((a, b) => a.tier - b.tier).slice(-DECLINE_FIT_INTERVALS);
    const newest = sorted[sorted.length - 1];
    if (sorted.length < 2) {
        return { atTier: newest.tier, rate: newest.sharePerMs, perTier: null, observations: 1 };
    }

    const meanTier = sorted.reduce((sum, point) => sum + point.tier, 0) / sorted.length;
    const meanLog = sorted.reduce((sum, point) => sum + Math.log(point.sharePerMs), 0) / sorted.length;
    let top = 0;
    let bottom = 0;
    for (const point of sorted) {
        top += (point.tier - meanTier) * (Math.log(point.sharePerMs) - meanLog);
        bottom += (point.tier - meanTier) ** 2;
    }
    const lost = bottom > 0 ? 1 - Math.exp(top / bottom) : null;

    return {
        atTier: newest.tier,
        rate: newest.sharePerMs,
        perTier: Number.isFinite(lost) ? Math.min(MAX_DECLINE_PER_TIER, Math.max(0, lost)) : null,
        observations: sorted.length,
    };
}

/**
 * The rate a tier is projected to run at, in shares per millisecond.
 *
 * Flat when only one interval was measured. Otherwise the newest rate losing
 * the fitted fraction each tier, held above its floor, and **held flat past the
 * level cap**: the decline is the party's success rate falling as the tier's
 * level rises, and the level stops rising at the top of the ladder.
 *
 * @param {Object|null} fit - From {@link declineFit}
 * @param {number} tier - The tier wanted
 * @returns {number|null} Shares per millisecond, or null with nothing measured
 */
export function rateAtTier(fit, tier) {
    if (!fit || !Number.isFinite(tier)) return null;
    if (!Number.isFinite(fit.perTier)) return fit.rate;

    const capped = Math.min(tier, TRIAL_MAX_TIER);
    const projected = fit.rate * (1 - fit.perTier) ** (capped - fit.atTier);
    return Math.max(fit.rate * RATE_FLOOR_FRACTION, projected);
}

/**
 * A rate in shares of the first tier per millisecond, as work or damage a second.
 *
 * A share is the first tier's total before participants, on whichever ladder, so
 * pricing one needs only that total and the 1%-per-participant scale. Pricing it
 * through the skilling pool formula put a combat tier on the skilling ladder's
 * shape, a few percent off by T8.
 *
 * @param {number|null} sharePerMs - Shares per millisecond
 * @param {number|null} base - The first tier's total before participants
 * @param {number} participants - Members signed up
 * @returns {number|null} Per second, or null without a base
 */
function pricedPerSecond(sharePerMs, base, participants) {
    if (!Number.isFinite(sharePerMs) || !Number.isFinite(base) || base <= 0) return null;
    const party = 1 + PARTICIPANT_SCALE_STEP * Math.max(0, Number(participants) || 0);
    return sharePerMs * base * party * 1000;
}

/**
 * Everything a card can say about a trial this character did not join.
 *
 * @param {Object} record - A tile record from the store
 * @param {Object} [options] - Context
 * @param {'skilling'|'combat'} [options.kind] - Which ladder the pools sit on
 * @param {number} [options.participants] - Members signed up, for printing a work rate
 * @param {number|null} [options.workBase] - The first tier's total before participants — a skill's work,
 *   or a combat wave's health — for printing a rate
 * @param {number|null} [options.timeLeftMs] - Active time left in the trial
 * @param {number} [options.now] - Clock, for how far into the current tier the guild is
 * @param {number|null} [options.bankedTiers] - Tiers banked, when the analysis knows better than the badges
 * @param {boolean} [options.windowed=true] - For {@link tierClearTimes}
 * @returns {{measured: number, currentTier: number, sharePerMs: number, workPerSecond: number|null,
 *   declinePerTier: number|null, lastTier?: number, lastTierMs?: number,
 *   etaMsToNextTier: number|null, tiersBeforeEnd: number|null,
 *   expectedTier: number|null, partialFraction: number, clears: Array<Object>, limitedBy: string,
 *   atLevelCap: boolean, atFinalTier: boolean, reason: string|null}|null} The model, or null when
 *   nothing has been watched. `partialFraction` is how much of the tier after `expectedTier` the
 *   clock runs out in, 0..1, and 0 at the top of the ladder or with no clock. `atFinalTier` says the trial has banked {@link module:./guild-trials-math.TRIAL_MAX_TIER},
 *   the last tier there is — every next-tier field is then null because there is no next tier
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
        windowed = true,
    } = {}
) {
    const clears = tierClearTimes(record, { now, windowed });
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
            partialFraction: 0,
            clears: [],
            limitedBy: 'unmeasured',
            atLevelCap: false,
            atFinalTier: false,
            reason: 'measuring — needs two tier clears',
        };
    }

    const rates = tierFillRates(record, { kind, now, windowed });
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
            partialFraction: 0,
            clears: [],
            limitedBy: 'unmeasured',
            atLevelCap: false,
            atFinalTier: false,
            reason: 'measuring — needs two consecutive tier clears',
        };
    }

    // The badge counts tiers banked, so the pool being filled now is one past
    // the newest badge — unless the analysis has a higher banked count from
    // somewhere the badges have not caught up with.
    const newest = clears[clears.length - 1];
    const banked = Number.isFinite(bankedTiers) ? Math.max(bankedTiers, newest.tier) : newest.tier;

    // …unless there *is* no tier past it. T21 is the last tier the game has, so
    // a trial that has banked it has nothing left to reach and every next-tier
    // number is about a tier that does not exist: `tierWorkShape` is deliberately
    // unclamped, so a T22 pool priced itself happily and the card read "Next tier
    // in ~a few seconds · Before it ends ~0 more tiers · Expected ~T21". The
    // measured rate is still real and is still returned; the forecast is not.
    const atFinalTier = banked >= TRIAL_MAX_TIER;
    if (atFinalTier) {
        const fitRate = rateAtTier(fit, TRIAL_MAX_TIER);
        return {
            measured: clears.length,
            intervals: rates.length,
            currentTier: TRIAL_MAX_TIER,
            bankedTiers: banked,
            sharePerMs: fitRate,
            workPerSecond: pricedPerSecond(fitRate, workBase, participants),
            declinePerTier: Number.isFinite(fit.perTier) ? fit.perTier : null,
            lastTier: rates[rates.length - 1].tier,
            lastTierMs: rates[rates.length - 1].ms,
            etaMsToNextTier: null,
            tiersBeforeEnd: null,
            expectedTier: TRIAL_MAX_TIER,
            partialFraction: 0,
            clears: [],
            limitedBy: 'ladder',
            atLevelCap: true,
            atFinalTier: true,
            reason: null,
        };
    }

    const currentTier = banked + 1;

    const shareNow = rateAtTier(fit, currentTier);
    const needNow = tierWorkShape(kind, currentTier);

    // How far in the guild already is. Unjoined cards carry no fill bar, so the
    // only honest estimate is the time since the badge moved spent at the rate
    // this tier is projected to run at — which is exactly the walk's own
    // assumption, applied to the part of the tier that has already happened.
    // A newer banked count may come from the live analysis while this card's
    // badge timestamps have missed several clears. Time since the old badge
    // includes those completed tiers and cannot be assigned to the current one.
    const sinceMs =
        banked === newest.tier && Number.isFinite(newest.at) && Number.isFinite(now) ? Math.max(0, now - newest.at) : 0;
    const doneShare = Number.isFinite(shareNow) ? shareNow * sinceMs : 0;
    const remainingShare = Number.isFinite(needNow) ? Math.max(0, needNow - doneShare) : null;

    const etaMsToNextTier =
        Number.isFinite(remainingShare) && Number.isFinite(shareNow) && shareNow > 0 ? remainingShare / shareNow : null;

    // The walk. One tier at a time, each priced at its own projected rate — the
    // whole point of the model, and the thing dividing a time by a constant
    // rate cannot do.
    const walked = [];
    let limitedBy = 'time';
    // Of the whole tier the clock runs out in, not of what was left of it: the
    // payout credits partial progress through a tier (see `partialTierCredit`)
    let partialFraction = 0;
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
            if (spentMs + takesMs > timeLeftMs) {
                const whole = tier === currentTier ? needNow : need;
                const reached = whole - need + (timeLeftMs - spentMs) * rate;
                partialFraction = whole > 0 ? Math.min(1, Math.max(0, reached / whole)) : 0;
                break;
            }

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

    // Printed only where the first tier's total is known. The walk above never
    // needed it; a "12.4 work/s" caption does.
    const workPerSecond = pricedPerSecond(shareNow, workBase, participants);

    return {
        measured: clears.length,
        intervals: rates.length,
        currentTier,
        bankedTiers: banked,
        sharePerMs: shareNow,
        workPerSecond,
        declinePerTier: Number.isFinite(fit.perTier) ? fit.perTier : null,
        // The newest interval measured, for a card with no work base to price a rate in
        lastTier: rates[rates.length - 1].tier,
        lastTierMs: rates[rates.length - 1].ms,
        etaMsToNextTier,
        tiersBeforeEnd: Number.isFinite(timeLeftMs) ? walked.length : null,
        expectedTier: walked.length ? walked[walked.length - 1].tier : banked || null,
        partialFraction,
        clears: walked,
        limitedBy,
        // Whether the walk crosses the level cap, where the decline flattens —
        // worth saying in a tooltip, because past it a deep tier is merely big
        // rather than also slower
        atLevelCap: currentTier + walked.length > TRIAL_MAX_TIER,
        // The walk may *finish* the ladder without having started past it, which
        // is a different claim from the one above and is not this
        atFinalTier: false,
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
        partialFraction: Number.isFinite(timing.partialFraction) ? timing.partialFraction : 0,
        clears: timing.clears,
        source: 'tier-timing',
        limitedBy: timing.limitedBy,
        coverage: null,
        reason: null,
        decline: Number.isFinite(timing.declinePerTier)
            ? { perTier: timing.declinePerTier, observations: timing.intervals ?? 0 }
            : null,
        atLevelCap: timing.atLevelCap,
        // Carried through so the Expected row can be suppressed rather than made
        // to print the top of the ladder as if it were still ahead
        atFinalTier: timing.atFinalTier === true,
        measured: timing.measured,
    };
}
