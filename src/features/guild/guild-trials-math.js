/**
 * Guild trial arithmetic.
 *
 * Everything here is pure: tiers, points, token payouts, participant scaling,
 * measured rates and the pace projection built on them. The panel that draws it
 * and the scraper that feeds it are elsewhere, so this file can be tested
 * against hand-computed numbers without a DOM, a socket or a clock.
 *
 * ## The rules this encodes
 *
 * From the in-game guide, quoted here because the numbers below are meaningless
 * without them and the guide is not in the repository:
 *
 * - The trial week resets **Friday 00:00 UTC**. Each week draws 4 random
 *   skilling trials and 2 random combat trials. A member may sign up for at
 *   most one skilling and one combat trial; slots are limited, and raised by the
 *   Skilling and Combat Encampment buildings. Only members who joined *before*
 *   the week started are eligible. Skilling trials run first, then combat, and
 *   each trial runs for up to **one hour** of active time. Trials do not
 *   interrupt normal actions.
 * - **Tiers** start at level 100 and step +10 per tier to a maximum of level
 *   300 — 21 tiers. A trial climbs until a tier fails, the hour runs out, or the
 *   top tier is cleared.
 * - **Skilling trials** pool every participant's actions into one shared bar; a
 *   tier clears when the pool fills, higher tiers need more work, and each
 *   signed-up participant raises the required work by 1%. Participants use a
 *   snapshot of their chosen loadout, without consumables.
 * - **Combat trials** put the party against one of five encounters (Badger,
 *   Chameleon, Jellyfish, Hedgehog, Swarm) scaled to the tier's level. Each
 *   participant adds 1% to monster HP. A win advances a tier; a defeat ends the
 *   trial for the week. No XP or loot; food and drinks are replaced by a flat
 *   +3% HP/MP regeneration, and each incoming attack allows at most 5 parry
 *   attempts.
 * - **Points and tokens.** Skilling base points are 200 for the first tier plus
 *   100 for each additional tier; combat base points are 400 plus 200 each.
 *   Guild Points = Base × (1 + Builders Hall bonus). Every eligible member is
 *   paid 0.5 × TotalBasePoints × (1 + Treasury bonus) in tokens once all trials
 *   have finished, and a participant is paid a further 50% of that on top.
 *
 * ## What is derived rather than known
 *
 * The guide gives the *shape* of tier scaling ("higher tiers need more work")
 * but not the curve, and the curve is not in any client data this script can
 * read. So it is measured: {@link estimateGrowthPerTier} fits a per-tier growth
 * factor to whatever tier totals have actually been observed this week, and
 * every projection that needs the next tier's size goes through it. With fewer
 * than two observed tiers there is no fit, the helpers return null, and the
 * panel says it does not know rather than inventing a curve.
 *
 * The 1%-per-participant part *is* exact, and is applied separately
 * ({@link participantScale}) so a caller can show the next tier's cost with the
 * party's own penalty folded in even when the growth fit is still missing.
 */

// ─── Tiers ──────────────────────────────────────────────────────────────────

/** Level of the first trial tier */
export const TRIAL_START_LEVEL = 100;

/** Levels added per tier */
export const TRIAL_LEVEL_STEP = 10;

/** Level of the highest trial tier */
export const TRIAL_MAX_LEVEL = 300;

/** Number of tiers between {@link TRIAL_START_LEVEL} and {@link TRIAL_MAX_LEVEL} */
export const TRIAL_MAX_TIER = (TRIAL_MAX_LEVEL - TRIAL_START_LEVEL) / TRIAL_LEVEL_STEP + 1;

/** How long one trial runs, in milliseconds of active time */
export const TRIAL_ACTIVE_MS = 60 * 60 * 1000;

/** Day of the week the trial week resets on, as `Date#getUTCDay` numbers it */
export const WEEKLY_RESET_UTC_DAY = 5;

/** The five combat trial encounters, lowercased for matching */
export const COMBAT_ENCOUNTERS = ['badger', 'chameleon', 'jellyfish', 'hedgehog', 'swarm'];

/**
 * The skills a skilling trial can be run in, lowercased.
 *
 * A closed list, and that is what makes it useful: the guild panel's cards are
 * found by *shape* rather than by class name, so something has to say that a
 * card reading "Guild Experience 4,120 / 20,000" is not a trial. A name is the
 * only part of a card that is not a number, and every trial's name is either one
 * of these or one of {@link COMBAT_ENCOUNTERS}.
 */
export const TRIAL_SKILLS = [
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'cooking',
    'brewing',
    'alchemy',
    'enhancing',
];

/**
 * Whether a card's name is a trial's name.
 *
 * Substring rather than equality: the game writes combat trials as "Trial
 * Chameleon" and skilling trials as bare "Milking" on the Trials tab and
 * "Alchemy" on the In Progress tab, and a card may carry a level or a tier badge
 * on the same line.
 *
 * @param {string} name - A card's name
 * @returns {boolean} True when it names a trial
 */
export function isTrialName(name) {
    const lowered = String(name || '').toLowerCase();
    if (!lowered) return false;
    return [...COMBAT_ENCOUNTERS, ...TRIAL_SKILLS].some((trial) => lowered.includes(trial));
}

/**
 * Which tier a trial level belongs to.
 * @param {number} level - Trial level, e.g. 140
 * @returns {number|null} 1-based tier, or null below the first tier
 */
export function tierFromLevel(level) {
    if (!Number.isFinite(level) || level < TRIAL_START_LEVEL) return null;
    const tier = Math.floor((level - TRIAL_START_LEVEL) / TRIAL_LEVEL_STEP) + 1;
    return Math.min(TRIAL_MAX_TIER, tier);
}

/**
 * The level a tier is fought at.
 * @param {number} tier - 1-based tier
 * @returns {number|null} Trial level, or null for a tier outside the ladder
 */
export function levelFromTier(tier) {
    if (!Number.isFinite(tier) || tier < 1 || tier > TRIAL_MAX_TIER) return null;
    return TRIAL_START_LEVEL + (tier - 1) * TRIAL_LEVEL_STEP;
}

// ─── Points and tokens ──────────────────────────────────────────────────────

/** Base points for the first tier cleared, by trial type */
export const FIRST_TIER_POINTS = { skilling: 200, combat: 400 };

/** Base points for each tier after the first, by trial type */
export const EXTRA_TIER_POINTS = { skilling: 100, combat: 200 };

/** Share of total base points paid as tokens to every eligible member */
export const ELIGIBLE_TOKEN_SHARE = 0.5;

/** Extra share of the eligible payout a participant receives on top of it */
export const PARTICIPANT_BONUS_SHARE = 0.5;

/**
 * Base points a single trial is worth for the tiers it cleared.
 *
 * Zero tiers is zero points — a trial that failed its first tier pays nothing.
 *
 * @param {'skilling'|'combat'} type - Trial type
 * @param {number} tiersCleared - Tiers cleared by this trial
 * @returns {number} Base points, before any building bonus
 */
export function trialBasePoints(type, tiersCleared) {
    const first = FIRST_TIER_POINTS[type];
    const extra = EXTRA_TIER_POINTS[type];
    if (first === undefined) return 0;

    const tiers = Math.floor(Number(tiersCleared) || 0);
    if (tiers <= 0) return 0;
    return first + extra * (tiers - 1);
}

/**
 * Base points across a week's trials.
 * @param {Array<{type: string, tiersCleared: number}>} trials - The week's trials
 * @returns {number} Summed base points
 */
export function totalBasePoints(trials) {
    return (trials || []).reduce((sum, trial) => sum + trialBasePoints(trial?.type, trial?.tiersCleared), 0);
}

/**
 * What clearing one particular tier is worth on its own.
 * @param {'skilling'|'combat'} type - Trial type
 * @param {number} tier - 1-based tier
 * @returns {number|null} Base points for that tier alone, or null for an unusable tier
 */
export function tierMarginalPoints(type, tier) {
    const first = FIRST_TIER_POINTS[type];
    const extra = EXTRA_TIER_POINTS[type];
    if (first === undefined || !Number.isFinite(tier) || tier < 1) return null;
    return tier === 1 ? first : extra;
}

/**
 * What the game's own "600 pts" on a trial card is counting.
 *
 * The ladder above is derived from the in-game guide's wording, and the card
 * states a number outright. Where the two disagree the card is right — it is the
 * game talking about this trial rather than a rule reconstructed from prose — so
 * the point of this is to work out *which question* the card is answering before
 * anything is believed:
 *
 * - **Cumulative**: what the trial has been worth in total by the time this tier
 *   is cleared. Matches `trialBasePoints(type, tier)`.
 * - **Marginal**: what this one tier adds. Matches {@link tierMarginalPoints}.
 *
 * At tier 1 the two are the same number, so the reading is reported as
 * `ambiguous` rather than pretending one of them was confirmed. A card that
 * matches neither is `disagrees`, which is the interesting outcome: it means the
 * ladder in this file is wrong somewhere and the caller should say so rather
 * than quietly average them.
 *
 * @param {Object} input - Inputs
 * @param {'skilling'|'combat'} input.type - Trial type
 * @param {number} input.tier - The tier the card is showing
 * @param {number} input.statedPoints - The card's own figure
 * @returns {{interpretation: string, ambiguous: boolean, statedPoints: number,
 *   ladderCumulative: number, ladderMarginal: number|null}|null} The reading, or null on unusable input
 */
export function interpretCardPoints({ type, tier, statedPoints } = {}) {
    if (!Number.isFinite(statedPoints) || !Number.isFinite(tier) || tier < 1) return null;
    if (FIRST_TIER_POINTS[type] === undefined) return null;

    const ladderCumulative = trialBasePoints(type, tier);
    const ladderMarginal = tierMarginalPoints(type, tier);
    const ambiguous = ladderCumulative === ladderMarginal;

    let interpretation = 'disagrees';
    if (statedPoints === ladderCumulative) interpretation = 'cumulative';
    else if (statedPoints === ladderMarginal) interpretation = 'marginal';

    return { interpretation, ambiguous, statedPoints, ladderCumulative, ladderMarginal };
}

/**
 * The base points a trial has actually banked, preferring the game's own figures.
 *
 * `pointsByTier` is what the Trials tab said each tier was worth, collected as
 * the trial climbed. Given a reading of what those figures *mean*
 * ({@link interpretCardPoints}), the banked total is either one of them read off
 * directly (cumulative) or the banked ones added up (marginal), and where a tier
 * was never seen the ladder fills the gap — which is reported as `mixed` rather
 * than presented as the game's own number.
 *
 * A card that matches neither reading is still believed where it covers the tier
 * that was banked: it is the game stating what this trial is worth, and the
 * ladder is a rule reconstructed from prose. It is read as a running total,
 * which is the plainer meaning of a number on a card, and the disagreement is
 * handed back so the caller can say the ladder needs correcting rather than
 * hiding a figure it does not understand.
 *
 * @param {Object} input - Inputs
 * @param {'skilling'|'combat'} input.type - Trial type
 * @param {number} input.bankedTiers - Tiers this trial has cleared
 * @param {Object<string|number, number>} [input.pointsByTier] - Tier → the card's stated points
 * @returns {{basePoints: number, source: 'ladder'|'game'|'mixed', interpretation: string|null,
 *   stated: number|null, ladder: number, quoted: {tier: number, statedPoints: number}|null}}
 *   What was banked and where the figure came from
 */
export function trialBankedBasePoints({ type, bankedTiers, pointsByTier = {} } = {}) {
    const banked = Math.max(0, Math.floor(Number(bankedTiers) || 0));
    const ladder = trialBasePoints(type, banked);
    const stated = (tier) => {
        const value = Number(pointsByTier?.[tier]);
        return Number.isFinite(value) ? value : null;
    };

    // The reading is taken from the highest tier the game has quoted, because
    // that is the one most likely to be unambiguous — tier 1 cannot tell the two
    // interpretations apart at all
    const quoted = Object.keys(pointsByTier || {})
        .map(Number)
        .filter((tier) => Number.isFinite(tier) && stated(tier) !== null)
        .sort((a, b) => b - a);

    const reading = quoted.length
        ? interpretCardPoints({ type, tier: quoted[0], statedPoints: stated(quoted[0]) })
        : null;
    const interpretation = reading?.interpretation ?? null;
    const quotedAt = reading ? { tier: quoted[0], statedPoints: reading.statedPoints } : null;
    const nothing = { basePoints: ladder, source: 'ladder', interpretation, stated: null, ladder, quoted: quotedAt };

    if (banked <= 0 || !reading) return nothing;

    if (interpretation === 'cumulative' || interpretation === 'disagrees') {
        const exact = stated(banked);
        if (exact === null) return nothing;
        return { basePoints: exact, source: 'game', interpretation, stated: exact, ladder, quoted: quotedAt };
    }

    // Marginal: add up what each banked tier was quoted at, falling back to the
    // ladder for tiers whose card was never seen
    let total = 0;
    let sawGame = false;
    let sawLadder = false;
    for (let tier = 1; tier <= banked; tier += 1) {
        const value = stated(tier);
        if (value === null) {
            total += tierMarginalPoints(type, tier) ?? 0;
            sawLadder = true;
        } else {
            total += value;
            sawGame = true;
        }
    }

    return {
        basePoints: total,
        source: sawGame && sawLadder ? 'mixed' : sawGame ? 'game' : 'ladder',
        interpretation,
        stated: sawGame ? total : null,
        ladder,
        quoted: quotedAt,
    };
}

/**
 * Guild Points from base points.
 * @param {number} basePoints - Base points
 * @param {number} [buildersHallBonus] - Builders Hall bonus as a fraction (0.15 for +15%)
 * @returns {number} Guild Points
 */
export function guildPoints(basePoints, buildersHallBonus = 0) {
    const base = Number(basePoints) || 0;
    const bonus = Number.isFinite(buildersHallBonus) ? buildersHallBonus : 0;
    return base * (1 + bonus);
}

/**
 * Tokens paid to every eligible member once all trials have finished.
 * @param {number} basePoints - Total base points across the week's trials
 * @param {number} [treasuryBonus] - Treasury bonus as a fraction
 * @returns {number} Tokens per eligible member
 */
export function eligibleMemberTokens(basePoints, treasuryBonus = 0) {
    const base = Number(basePoints) || 0;
    const bonus = Number.isFinite(treasuryBonus) ? treasuryBonus : 0;
    return ELIGIBLE_TOKEN_SHARE * base * (1 + bonus);
}

/**
 * The whole payout picture for a set of trials.
 *
 * `bonusesKnown` is false when either building bonus was passed as null, which
 * is the state a player is in until they have opened the guild Buildings tab
 * once. The figures are still returned — they are simply the un-bonused ones,
 * and the caller is expected to say so.
 *
 * `basePointsOverride` on a trial is the game's own figure for what it has
 * banked, from the Trials tab's "600 pts" rather than from the ladder above. It
 * wins where it is present, because the card is the game talking about this
 * trial and the ladder is a rule reconstructed from the guide's prose.
 *
 * @param {Object} input - Inputs
 * @param {Array<{type: string, tiersCleared: number, name?: string, basePointsOverride?: number}>}
 *   input.trials - The week's trials
 * @param {number|null} [input.buildersHallBonus] - Builders Hall bonus fraction, null when unknown
 * @param {number|null} [input.treasuryBonus] - Treasury bonus fraction, null when unknown
 * @returns {{basePoints: number, guildPoints: number, eligibleTokens: number, participantBonusTokens: number,
 *   participantTokens: number, bonusesKnown: boolean, perTrial: Array<Object>}} Payout breakdown
 */
export function payoutProjection({ trials = [], buildersHallBonus = null, treasuryBonus = null } = {}) {
    const hallKnown = Number.isFinite(buildersHallBonus);
    const treasuryKnown = Number.isFinite(treasuryBonus);
    const hall = hallKnown ? buildersHallBonus : 0;
    const treasury = treasuryKnown ? treasuryBonus : 0;

    const perTrial = trials.map((trial) => {
        const override = Number(trial?.basePointsOverride);
        const base = Number.isFinite(override) ? override : trialBasePoints(trial?.type, trial?.tiersCleared);
        return {
            name: trial?.name ?? null,
            type: trial?.type ?? null,
            tiersCleared: Math.max(0, Math.floor(Number(trial?.tiersCleared) || 0)),
            basePoints: base,
            basePointsSource: Number.isFinite(override) ? 'game' : 'ladder',
            guildPoints: guildPoints(base, hall),
        };
    });

    const basePoints = perTrial.reduce((sum, trial) => sum + trial.basePoints, 0);
    const eligibleTokens = eligibleMemberTokens(basePoints, treasury);
    const participantBonusTokens = eligibleTokens * PARTICIPANT_BONUS_SHARE;

    return {
        basePoints,
        guildPoints: guildPoints(basePoints, hall),
        eligibleTokens,
        participantBonusTokens,
        participantTokens: eligibleTokens + participantBonusTokens,
        bonusesKnown: hallKnown && treasuryKnown,
        perTrial,
    };
}

// ─── Participant scaling ────────────────────────────────────────────────────

/** How much one extra participant adds to monster HP or to required work */
export const PARTICIPANT_SCALE_STEP = 0.01;

/**
 * The multiplier a party of this size puts on monster HP or required work.
 * @param {number} participants - Signed-up participants
 * @returns {number} Multiplier, 1 for an empty or unknown party
 */
export function participantScale(participants) {
    const count = Number(participants);
    if (!Number.isFinite(count) || count <= 0) return 1;
    return 1 + PARTICIPANT_SCALE_STEP * count;
}

/**
 * Re-scale a total measured with one party size to a different one.
 *
 * Party size does not change within a week, so this exists mostly for the
 * "what if two more people signed up" question and for tests.
 *
 * @param {number} total - Observed total (HP or work)
 * @param {number} fromParticipants - Participants it was measured with
 * @param {number} toParticipants - Participants to re-scale to
 * @returns {number|null} Re-scaled total, or null on unusable input
 */
export function rescaleForParticipants(total, fromParticipants, toParticipants) {
    if (!Number.isFinite(total)) return null;
    const from = participantScale(fromParticipants);
    if (from <= 0) return null;
    return (total * participantScale(toParticipants)) / from;
}

// ─── Tier growth, measured ──────────────────────────────────────────────────

/**
 * Fit a per-tier growth factor to observed tier totals.
 *
 * Geometric rather than arithmetic because the observations span different tier
 * gaps — a jump from tier 3 to tier 6 carries three steps of growth, and
 * averaging raw ratios would weight it as one. Each consecutive pair
 * contributes `(b/a)^(1/gap)` and the result is the geometric mean of those.
 *
 * @param {Array<{tier: number, total: number}>} observations - Tier totals seen this trial
 * @returns {number|null} Growth factor per tier, or null with fewer than two distinct tiers
 */
export function estimateGrowthPerTier(observations) {
    const points = new Map();
    for (const observation of observations || []) {
        const tier = Number(observation?.tier);
        const total = Number(observation?.total);
        if (!Number.isFinite(tier) || !Number.isFinite(total) || total <= 0) continue;
        // Last writer wins: a later reading of the same tier is the better one
        points.set(tier, total);
    }

    const sorted = [...points.entries()].sort((a, b) => a[0] - b[0]);
    if (sorted.length < 2) return null;

    let logSum = 0;
    let steps = 0;
    for (let index = 1; index < sorted.length; index += 1) {
        const [tierA, totalA] = sorted[index - 1];
        const [tierB, totalB] = sorted[index];
        const gap = tierB - tierA;
        if (gap <= 0) continue;
        logSum += Math.log(totalB / totalA);
        steps += gap;
    }

    if (steps <= 0) return null;
    return Math.exp(logSum / steps);
}

/**
 * What a tier's total should be, extrapolated from what has been seen.
 *
 * Anchored on the *nearest* observation rather than the first, so a projection
 * one tier ahead compounds the fitted growth once rather than five times.
 *
 * @param {Object} input - Inputs
 * @param {Array<{tier: number, total: number}>} input.observations - Tier totals seen
 * @param {number} input.tier - Tier to project
 * @param {number} [input.growthPerTier] - Growth factor; fitted from the observations when omitted
 * @returns {number|null} Projected total, or null without an anchor and a growth factor
 */
export function projectTierTotal({ observations = [], tier, growthPerTier } = {}) {
    if (!Number.isFinite(tier)) return null;

    const usable = (observations || []).filter(
        (observation) => Number.isFinite(observation?.tier) && Number(observation?.total) > 0
    );
    if (!usable.length) return null;

    const exact = usable.filter((observation) => observation.tier === tier).pop();
    if (exact) return Number(exact.total);

    const growth = Number.isFinite(growthPerTier) ? growthPerTier : estimateGrowthPerTier(usable);
    if (!Number.isFinite(growth) || growth <= 0) return null;

    const anchor = usable.reduce((best, observation) =>
        Math.abs(observation.tier - tier) < Math.abs(best.tier - tier) ? observation : best
    );
    return Number(anchor.total) * Math.pow(growth, tier - anchor.tier);
}

/**
 * The next tier's total, with the party's own 1%-per-head penalty already in it.
 *
 * The observed totals already include that penalty — they are what the party is
 * fighting — so this does not re-apply it. `participants` is carried through
 * only so a caller can show "and 21 people put +21% on that" beside the figure.
 *
 * @param {Object} input - Inputs
 * @param {Array<{tier: number, total: number}>} input.observations - Tier totals seen
 * @param {number} input.currentTier - Tier now in progress
 * @param {number} [input.participants] - Signed-up participants, for the returned penalty
 * @returns {{tier: number, level: number|null, total: number, participantPenalty: number,
 *   growthPerTier: number}|null} The next tier, or null at the top of the ladder or without a fit
 */
export function nextTierPreview({ observations = [], currentTier, participants = 0 } = {}) {
    if (!Number.isFinite(currentTier)) return null;
    const tier = currentTier + 1;
    if (tier > TRIAL_MAX_TIER) return null;

    const growthPerTier = estimateGrowthPerTier(observations);
    const total = projectTierTotal({ observations, tier, growthPerTier });
    if (!Number.isFinite(total) || !Number.isFinite(growthPerTier)) return null;

    return {
        tier,
        level: levelFromTier(tier),
        total,
        participantPenalty: participantScale(participants) - 1,
        growthPerTier,
    };
}

// ─── Rates from samples ─────────────────────────────────────────────────────

/**
 * The trailing run of samples that moves one way.
 *
 * A pool bar resets to zero and a boss bar jumps back to full when a tier is
 * cleared, and a rate fitted across that jump is meaningless. Walking back from
 * the newest sample and stopping at the first move against `direction` leaves
 * exactly the current tier's readings.
 *
 * @param {Array<{t: number, value: number}>} samples - Samples, oldest first
 * @param {1|-1} direction - +1 for a value that rises (a pool), -1 for one that falls (boss HP)
 * @returns {Array<{t: number, value: number}>} The trailing monotonic run, newest last
 */
export function trailingRun(samples, direction) {
    const list = (samples || []).filter((sample) => Number.isFinite(sample?.t) && Number.isFinite(sample?.value));
    if (list.length < 2) return list;

    let start = list.length - 1;
    for (let index = list.length - 1; index > 0; index -= 1) {
        const step = (list[index].value - list[index - 1].value) * direction;
        if (step < 0) break;
        start = index - 1;
    }
    return list.slice(start);
}

/**
 * How fast a value is moving, per millisecond, over its current run.
 *
 * Returned unsigned and in the direction asked for: a pool that gained 1,000 in
 * ten seconds and a boss that lost 1,000 in ten seconds both read 0.1.
 *
 * @param {Array<{t: number, value: number}>} samples - Samples, oldest first
 * @param {1|-1} direction - +1 for a rising value, -1 for a falling one
 * @returns {number|null} Units per millisecond, or null without two samples spanning real time
 */
export function ratePerMs(samples, direction) {
    const run = trailingRun(samples, direction);
    if (run.length < 2) return null;

    const first = run[0];
    const last = run[run.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs <= 0) return null;

    const moved = (last.value - first.value) * direction;
    if (moved <= 0) return null;
    return moved / spanMs;
}

/**
 * Time to cover a remaining amount at a measured rate.
 * @param {number} remaining - Units left
 * @param {number|null} rate - Units per millisecond
 * @returns {number|null} Milliseconds, or null without a usable rate
 */
export function etaMs(remaining, rate) {
    if (!Number.isFinite(remaining) || remaining < 0) return null;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return remaining / rate;
}

// ─── Pace ───────────────────────────────────────────────────────────────────

/**
 * How far up the ladder this trial gets before its hour runs out.
 *
 * Walks the ladder at the measured rate, spending the current tier's *remaining*
 * work first and each later tier's projected total after it, and stops at the
 * first tier that does not fit in the time left. A tier only counts as cleared
 * when it fits whole — the partial progress into the tier that did not is
 * reported separately as `partialFraction`, because a tier 90% cleared is worth
 * exactly as much as one not started.
 *
 * @param {Object} input - Inputs
 * @param {number} input.currentTier - Tier now in progress
 * @param {number} input.remainingInTier - Work or HP left in it
 * @param {number|null} input.rate - Units per millisecond
 * @param {number} input.timeLeftMs - Active time left in the trial
 * @param {Function} input.totalForTier - `(tier) => number|null`, the work a tier needs
 * @param {number} [input.tiersAlreadyCleared] - Tiers this trial has already banked
 * @returns {{finalTier: number|null, tiersCleared: number, clears: Array<{tier: number, atMs: number}>,
 *   partialFraction: number, limitedBy: string}|null} Projection, or null without a rate
 */
export function projectPace({
    currentTier,
    remainingInTier,
    rate,
    timeLeftMs,
    totalForTier,
    tiersAlreadyCleared = 0,
} = {}) {
    if (!Number.isFinite(currentTier) || !Number.isFinite(remainingInTier)) return null;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    if (!Number.isFinite(timeLeftMs) || timeLeftMs < 0) return null;

    const clears = [];
    let spentMs = 0;
    let tier = currentTier;
    let need = Math.max(0, remainingInTier);
    let partialFraction = 0;
    let limitedBy = 'time';

    while (tier <= TRIAL_MAX_TIER) {
        const takesMs = need / rate;
        if (spentMs + takesMs > timeLeftMs) {
            const affordable = (timeLeftMs - spentMs) * rate;
            partialFraction = need > 0 ? Math.min(1, Math.max(0, affordable / need)) : 0;
            break;
        }

        spentMs += takesMs;
        clears.push({ tier, atMs: spentMs });

        if (tier === TRIAL_MAX_TIER) {
            limitedBy = 'ladder';
            break;
        }

        const nextTotal = totalForTier ? totalForTier(tier + 1) : null;
        if (!Number.isFinite(nextTotal) || nextTotal <= 0) {
            limitedBy = 'unknown-next-tier';
            break;
        }

        tier += 1;
        need = nextTotal;
    }

    const finalTier = clears.length ? clears[clears.length - 1].tier : null;
    return {
        finalTier,
        tiersCleared: tiersAlreadyCleared + clears.length,
        clears,
        partialFraction,
        limitedBy,
    };
}

// ─── The trial week ─────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * The most recent Friday 00:00 UTC at or before `now`.
 * @param {number} [now] - Clock, in ms
 * @returns {number} Week start, in ms
 */
export function trialWeekStart(now = Date.now()) {
    const date = new Date(now);
    const midnightUTC = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const daysSinceReset = (date.getUTCDay() - WEEKLY_RESET_UTC_DAY + 7) % 7;
    return midnightUTC - daysSinceReset * DAY_MS;
}

/**
 * When the current trial week ends.
 * @param {number} [now] - Clock, in ms
 * @returns {number} Week end, in ms
 */
export function trialWeekEnd(now = Date.now()) {
    return trialWeekStart(now) + WEEK_MS;
}

/**
 * Time left before the weekly reset.
 * @param {number} [now] - Clock, in ms
 * @returns {number} Milliseconds until Friday 00:00 UTC
 */
export function msUntilWeekReset(now = Date.now()) {
    return trialWeekEnd(now) - now;
}

/**
 * Active time left in a trial that started at a known moment.
 * @param {number} startedAtMs - When the trial started
 * @param {number} [now] - Clock, in ms
 * @returns {number|null} Milliseconds left, clamped at zero; null without a start time
 */
export function trialTimeLeftMs(startedAtMs, now = Date.now()) {
    if (!Number.isFinite(startedAtMs)) return null;
    return Math.max(0, TRIAL_ACTIVE_MS - (now - startedAtMs));
}
