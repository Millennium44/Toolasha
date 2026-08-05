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
 * The longest a card's name may be before it is prose.
 *
 * The longest real one is "Trial Chameleon" with a level and a tier badge beside
 * it — "Trial Chameleon Lv.140 T6", twenty-five characters — so forty is
 * generous for every name the game has been seen to write and refuses anything
 * that is a sentence.
 */
export const MAX_TRIAL_NAME_CHARS = 40;

/**
 * Whether a card's name is a trial's name.
 *
 * A trial card's name is *only* the trial's name — "Milking", "Alchemy", "Trial
 * Chameleon" — optionally with the level or tier badge the card carries beside
 * it, which is stripped before this is asked. So this matches the whole string
 * rather than looking for the word inside it.
 *
 * It used to be a substring test, and that is what put the trial panel on the
 * guild's **Overview** tab: the notice board is prose, prose mentions skills,
 * and "we're milking at Level 90 if anyone wants to join" contains "milking".
 * Paired with the guild XP bar — which reads `4,120 / 20,000` and so looks
 * exactly like a progress reading — that was enough to build a card out of a
 * paragraph and draw a payout block over somebody's notice board.
 *
 * The permitted decorations are the ones the game has actually been seen to
 * write: a leading "Trial", a trailing level (`Lv.130`), a tier badge (`T6`) and
 * ordinary punctuation. Anything else is prose.
 *
 * @param {string} name - A card's name
 * @returns {boolean} True when it names a trial
 */
export function isTrialName(name) {
    const raw = String(name || '');
    // A precondition, not a match: a trial's name is one short line, and asking
    // the matcher about anything else is asking the wrong question. A guild's
    // **notice board** — braille art, "Welcome to Milkmaxxing!", three Discord
    // links and the kick rules, 987 characters over twenty lines — reached this
    // as a card name, and the two Discord channel ids in it read as a progress
    // bar. The matcher happened to reject that particular paragraph; it is not
    // the sort of thing that should depend on happening to.
    if (!raw || raw.length > MAX_TRIAL_NAME_CHARS || /[\r\n]/.test(raw)) return false;

    const lowered = raw
        .toLowerCase()
        .replace(/\b(?:lv\.?\s*\d+|tier\s*\d+|t\d+)\b/g, ' ')
        .replace(/^\s*trial\s+/, ' ')
        .replace(/[^a-z]+/g, ' ')
        .trim();
    if (!lowered) return false;

    return [...COMBAT_ENCOUNTERS, ...TRIAL_SKILLS].includes(lowered);
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

/**
 * What one level of a payout building is worth, as a fraction.
 *
 * Confirmed from the in-game upgrade popups, both of them, on a guild whose
 * levels are known: the Builder's Hall at Lv.10 reads "Level 10 → Level 11,
 * Guild Points: +20% → +22%", and the Treasury at Lv.5 reads "Level 5 → Level 6,
 * Guild Token Rewards: +10% → +12%". Two percent per level, on both, and the
 * bonus is `level × 0.02` rather than a step on top of a base.
 *
 * That closes the payout arithmetic end to end. Against four days of the guild's
 * own chat announcements, `(stated points / (1 + 0.02 × hall)) / 2 × (1 + 0.02 ×
 * treasury)` reproduces 990, 880, 1,375 and 1,320 tokens per eligible member
 * exactly — the "extra ×1.1" that the numbers alone could not explain is the
 * Treasury at Lv.5.
 */
export const BUILDING_BONUS_PER_LEVEL = 0.02;

/**
 * Highest level a guild building can reach, from the in-game "Lv. 10 / 20".
 *
 * A different ladder from the 21 trial tiers {@link TRIAL_MAX_TIER} counts, and
 * the two must never be conflated.
 */
export const GUILD_BUILDING_MAX_LEVEL = 20;

/** The largest bonus either payout building can grant */
export const MAX_BUILDING_BONUS = GUILD_BUILDING_MAX_LEVEL * BUILDING_BONUS_PER_LEVEL;

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
 * How close two points figures have to be to be the same claim.
 *
 * Recovering a base figure from a bonused one is a division, and a bonus of
 * 0.2 recovered from 840 gives 699.9999999999999 often enough to matter. A
 * tenth of a point is far tighter than the hundred-point steps of the ladder.
 */
const POINTS_EPSILON = 0.1;

/**
 * What the game's own "840 pts" on a trial card is counting.
 *
 * Two questions, not one, and the second was missed for long enough to put a
 * wrong warning on the screen.
 *
 * **Is it bonused?** Yes. Confirmed from a live panel: the cards read "840 pts"
 * at skilling T6, "1,080 pts" at T8 and "480 pts" at combat T1, and the ladder
 * derives 700, 900 and 400 — every one of them the ladder figure × 1.2, against
 * a guild whose Builders Hall was granting +20%. The card states **Guild
 * Points**, which the guide defines as `Base × (1 + Builders Hall bonus)`. So a
 * card figure is divided back down to base before it is compared to anything,
 * and everything downstream stays in base points, which is the one unit the
 * payout arithmetic uses.
 *
 * Without a known Builders Hall bonus that division cannot be done, and guessing
 * the 1.2 that happened to be true of one guild would silently corrupt every
 * other guild's payout. The reading then comes back `interpretation: 'unbonused'`
 * with `basePoints: null`, and the caller is expected to say the level is needed
 * rather than to use the figure.
 *
 * **Which total is it?** Once in base points:
 *
 * - **Cumulative**: what the trial has been worth in total by the time this tier
 *   is cleared. Matches `trialBasePoints(type, tier)`.
 * - **Marginal**: what this one tier adds. Matches {@link tierMarginalPoints}.
 *
 * At tier 1 the two are the same number, so the reading is reported as
 * `ambiguous` rather than pretending one of them was confirmed. A card that
 * matches neither *after* the bonus is accounted for is `disagrees` — which is
 * now a real finding rather than the everyday state it used to be.
 *
 * @param {Object} input - Inputs
 * @param {'skilling'|'combat'} input.type - Trial type
 * @param {number} input.tier - The tier the card is showing
 * @param {number} input.statedPoints - The card's own figure, as Guild Points
 * @param {number|null} [input.buildersHallBonus] - Builders Hall bonus as a fraction, null when unknown
 * @returns {{interpretation: string, ambiguous: boolean, statedPoints: number, basePoints: number|null,
 *   bonusKnown: boolean, ladderCumulative: number, ladderMarginal: number|null}|null} The reading,
 *   or null on unusable input
 */
export function interpretCardPoints({ type, tier, statedPoints, buildersHallBonus = null } = {}) {
    if (!Number.isFinite(statedPoints) || !Number.isFinite(tier) || tier < 1) return null;
    if (FIRST_TIER_POINTS[type] === undefined) return null;

    const ladderCumulative = trialBasePoints(type, tier);
    const ladderMarginal = tierMarginalPoints(type, tier);
    const ambiguous = ladderCumulative === ladderMarginal;
    const bonusKnown = Number.isFinite(buildersHallBonus) && buildersHallBonus > -1;

    if (!bonusKnown) {
        return {
            interpretation: 'unbonused',
            ambiguous,
            statedPoints,
            basePoints: null,
            bonusKnown: false,
            ladderCumulative,
            ladderMarginal,
        };
    }

    const basePoints = statedPoints / (1 + buildersHallBonus);
    const same = (candidate) => Number.isFinite(candidate) && Math.abs(basePoints - candidate) <= POINTS_EPSILON;

    let interpretation = 'disagrees';
    if (same(ladderCumulative)) interpretation = 'cumulative';
    else if (same(ladderMarginal)) interpretation = 'marginal';
    else if (withinMidTrialUpgrade(statedPoints, ladderCumulative, buildersHallBonus)) {
        // Not a near-miss: a total banked across a Builder's Hall upgrade, which
        // is a mixture of two bonuses by construction — see
        // {@link MAX_MID_TRIAL_UPGRADE_LEVELS}
        interpretation = 'mid-trial-upgrade';
    }

    return {
        interpretation,
        ambiguous,
        statedPoints,
        basePoints,
        bonusKnown: true,
        ladderCumulative,
        ladderMarginal,
    };
}

/**
 * Whether a stated total is the ladder banked across a building upgrade.
 *
 * The window is closed at the top — a total that matches today's bonus exactly
 * is already `cumulative` and never reaches here — and open at the bottom by as
 * many levels as {@link MAX_MID_TRIAL_UPGRADE_LEVELS} allows. Anything under
 * that is a figure no arrangement of this guild's buildings produces, and stays
 * a genuine disagreement.
 *
 * @param {number} statedPoints - The card's own figure
 * @param {number} ladderCumulative - The ladder's base total for that tier
 * @param {number} bonus - The Builder's Hall bonus in force now, as a fraction
 * @returns {boolean} True when a mid-trial upgrade explains it
 */
export function withinMidTrialUpgrade(statedPoints, ladderCumulative, bonus) {
    if (!Number.isFinite(statedPoints) || !Number.isFinite(ladderCumulative) || ladderCumulative <= 0) return false;
    if (!Number.isFinite(bonus)) return false;

    const atNow = ladderCumulative * (1 + bonus);
    const older = Math.max(-1, bonus - BUILDING_BONUS_PER_LEVEL * MAX_MID_TRIAL_UPGRADE_LEVELS);
    const atThen = ladderCumulative * (1 + older);

    return statedPoints < atNow - POINTS_EPSILON && statedPoints >= atThen - POINTS_EPSILON;
}

/**
 * How many Builder's Hall levels a guild may gain during one trial.
 *
 * A trial banks its points **live**, tier by tier, at the bonus in force when
 * each tier clears — so a guild that levels its Builder's Hall partway through
 * an hour pays the early tiers at the old bonus and the late ones at the new. A
 * card's total is then a *mixture*, and dividing it by today's bonus does not
 * give a whole number of base points. That is not a wrong figure and it is not a
 * wrinkle in the ladder; it is the ladder plus a clock.
 *
 * Confirmed by the guild it happened to, whose Hall went 5 → 6 (+10% → +12%)
 * during the skilling hour. The three cards decompose exactly, with nothing
 * rounded:
 *
 * ```
 * Milking  T10  base 1,100 =  500 × 1.10 +  600 × 1.12 =  550 + 672 = 1,222
 * Foraging T11  base 1,200 =  600 × 1.10 +  600 × 1.12 =  660 + 672 = 1,332
 * Crafting T12  base 1,300 =  600 × 1.10 +  700 × 1.12 =  660 + 784 = 1,444
 * ```
 *
 * The upgrade lands between each trial's fourth and fifth clear, and the combat
 * hour ran afterwards — entirely at +12% — which is why those cards divided
 * cleanly and these did not. **The ladder is uniform at every tier**: cumulative
 * base is 100 × (tier + 1) for skilling and 200 × (tier + 1) for combat, exact
 * across three guilds and five bonuses.
 *
 * So the envelope is a statement about buildings rather than a tolerance. Two
 * levels is generous — a guild banking two Hall levels inside one hour is
 * remarkable — and at 2% a level it is a four-percent window that no genuinely
 * wrong figure has ever landed in.
 */
export const MAX_MID_TRIAL_UPGRADE_LEVELS = 2;

/**
 * What a trial has banked, in Guild Points and in base points.
 *
 * ## The card is the answer, and it was being second-guessed
 *
 * Calibrated against four days of the guild's own chat announcements, which are
 * the only ground truth this feature has ever had. On the day the trials were
 * watched, the three cards read 840 (Milking), 1,080 (Alchemy) and 960 (Trial
 * Chameleon), and the announcement read *"2880 Guild Points earned"* — the sum,
 * exactly, and the same figure as the panel's own "Weekly Guild Points" header.
 * The same identity holds on the other three days.
 *
 * Two things follow, and the second is what was wrong here:
 *
 * 1. A card's figure is **Guild Points, bonused**, not base points. 840 is
 *    700 × 1.2 against a Builders Hall granting +20%, and 960 is 800 × 1.2. So
 *    the base figure the token arithmetic needs is the card's divided by
 *    `(1 + buildersHallBonus)`, and multiplying it *again* — which is what the
 *    payout block did — inflates every downstream number by the bonus twice.
 * 2. The figure covers the tier the card itself names, and is not to be looked
 *    up under this script's own inference about how many tiers are banked. That
 *    lookup missed by one tier on every trial, fell through to the ladder, and
 *    is why the panel reported 2.4K against an announced 2,880.
 *
 * So the card's figure is taken as the trial's banked Guild Points whenever
 * there is one. Where there is none the ladder is used, and where the Builders
 * Hall bonus is unknown the base figure cannot be recovered at all — reported as
 * `needsBuildersHall` rather than guessed at, because the 1.2 that is true of
 * this guild is not true of any other.
 *
 * @param {Object} input - Inputs
 * @param {'skilling'|'combat'} input.type - Trial type
 * @param {number} input.bankedTiers - Tiers this trial has cleared, for the ladder fallback
 * @param {Object<string|number, number>} [input.pointsByTier] - Tier → the card's stated Guild Points
 * @param {number|null} [input.buildersHallBonus] - Builders Hall bonus as a fraction, null when unknown
 * @returns {{basePoints: number, guildPoints: number|null, source: 'ladder'|'game'|'mixed',
 *   interpretation: string|null, bonusKnown: boolean, needsBuildersHall: boolean, cardTier: number|null,
 *   ladder: number, quoted: {tier: number, statedPoints: number}|null}} What was banked and where it came from
 */
export function trialBankedBasePoints({ type, bankedTiers, pointsByTier = {}, buildersHallBonus = null } = {}) {
    const banked = Math.max(0, Math.floor(Number(bankedTiers) || 0));
    const ladder = trialBasePoints(type, banked);
    const bonusKnown = Number.isFinite(buildersHallBonus) && buildersHallBonus > -1;
    const scale = bonusKnown ? 1 + buildersHallBonus : null;
    const stated = (tier) => {
        const value = Number(pointsByTier?.[tier]);
        return Number.isFinite(value) ? value : null;
    };

    // The reading is taken from the highest tier the game has quoted, because
    // that is the one most likely to be unambiguous — tier 1 cannot tell the two
    // interpretations apart at all
    // Zero is not a figure the card is stating; it is a card with nothing to
    // state yet. A combat trial that has not started reads "0 pts", and letting
    // that into the comparison put "Trial Chameleon T1 states 0 pts, which is
    // neither the running total nor the per-tier step" on the screen of every
    // guild whose combat hour had not begun.
    const quoted = Object.keys(pointsByTier || {})
        .map(Number)
        .filter((tier) => Number.isFinite(tier) && stated(tier) > 0)
        .sort((a, b) => b - a);

    const reading = quoted.length
        ? interpretCardPoints({ type, tier: quoted[0], statedPoints: stated(quoted[0]), buildersHallBonus })
        : null;
    const interpretation = reading?.interpretation ?? null;
    const quotedAt = reading ? { tier: quoted[0], statedPoints: reading.statedPoints } : null;

    const fromLadder = {
        basePoints: ladder,
        guildPoints: bonusKnown ? ladder * scale : null,
        source: 'ladder',
        interpretation,
        bonusKnown,
        needsBuildersHall: Boolean(reading) && !bonusKnown,
        cardTier: quotedAt?.tier ?? null,
        ladder,
        quoted: quotedAt,
    };

    if (!reading) return fromLadder;
    // A card figure that cannot be divided back down to base is still worth
    // showing, but it cannot feed the token arithmetic
    if (!bonusKnown) return { ...fromLadder, guildPoints: reading.statedPoints };

    if (interpretation === 'marginal') {
        // Each tier's own step, added up to the tier the cards have reached,
        // with the ladder filling any tier whose card was never on screen
        const top = Math.max(quotedAt.tier, banked);
        let total = 0;
        let sawGame = false;
        let sawLadder = false;
        for (let tier = 1; tier <= top; tier += 1) {
            const value = stated(tier);
            if (value === null) {
                total += (tierMarginalPoints(type, tier) ?? 0) * scale;
                sawLadder = true;
            } else {
                total += value;
                sawGame = true;
            }
        }

        return {
            basePoints: total / scale,
            guildPoints: total,
            source: sawGame && sawLadder ? 'mixed' : sawGame ? 'game' : 'ladder',
            interpretation,
            bonusKnown,
            needsBuildersHall: false,
            cardTier: quotedAt.tier,
            ladder,
            quoted: quotedAt,
        };
    }

    // Cumulative, or a figure the ladder cannot explain: either way it is the
    // game stating what this trial has earned, and the announcements say the sum
    // of exactly these figures is what the guild is paid
    return {
        basePoints: reading.basePoints,
        guildPoints: reading.statedPoints,
        source: 'game',
        interpretation,
        bonusKnown,
        needsBuildersHall: false,
        cardTier: quotedAt.tier,
        ladder,
        quoted: quotedAt,
    };
}

/**
 * How much of the first tier's work each later tier adds.
 *
 * Derived, and exact on every observation there is. A live skilling trial was
 * watched through three tiers with two members signed up, and its pools read
 * 40,800 / 44,880 / 48,960 — which is 40,000 / 44,000 / 48,000 with the same
 * 1%-per-participant multiplier the combat side uses, and those are the first
 * tier's work plus a tenth of it per tier. Linear, not geometric, which is why
 * fitting a growth *factor* to two tiers was always going to drift.
 */
export const SKILLING_TIER_STEP = 0.1;

/**
 * The work one tier of a skilling trial needs.
 *
 * The counterpart of {@link module:./guild-trial-forecast.tierMonsterHp} for the
 * other half of a trial week, and derived the same way — from observations that
 * it reproduces exactly rather than from a curve fitted through them. A tier
 * actually read off the panel still wins; this is what fills in the tiers nobody
 * has seen yet, which before now was every tier past the second.
 *
 * @param {Object} input - Inputs
 * @param {number} input.baseWork - The first tier's work, before participants
 * @param {number} input.tier - The tier wanted
 * @param {number} [input.participants] - Members signed up
 * @returns {number|null} Work, or null on unusable input
 */
export function tierPoolWork({ baseWork, tier, participants = 0 } = {}) {
    if (!Number.isFinite(baseWork) || baseWork <= 0) return null;
    if (!Number.isFinite(tier) || tier < 1 || tier > TRIAL_MAX_TIER) return null;

    const byTier = 1 + SKILLING_TIER_STEP * (tier - 1);
    const byParty = 1 + PARTICIPANT_SCALE_STEP * Math.max(0, Number(participants) || 0);
    return baseWork * byTier * byParty;
}

/**
 * The first tier's work, backed out of any tier that has been observed.
 *
 * A trial joined at tier three still knows what tier one needed, because the
 * step between tiers is known — so one reading anywhere on the ladder gives the
 * whole of it.
 *
 * @param {Array<{tier: number, total: number}>} observations - Pool sizes seen
 * @param {number} [participants] - Members signed up
 * @returns {number|null} The first tier's work, or null with nothing to derive from
 */
export function baseWorkFromObservations(observations, participants = 0) {
    const byParty = 1 + PARTICIPANT_SCALE_STEP * Math.max(0, Number(participants) || 0);

    for (const observation of observations || []) {
        const tier = Number(observation?.tier);
        const total = Number(observation?.total);
        if (!Number.isFinite(tier) || tier < 1 || !Number.isFinite(total) || total <= 0) continue;
        return total / byParty / (1 + SKILLING_TIER_STEP * (tier - 1));
    }
    return null;
}

/**
 * The Builders Hall bonus, read back out of the cards themselves.
 *
 * A last resort, and a surprisingly good one. A card states Guild Points and the
 * ladder states base points for the same tier, so their ratio *is* `1 + bonus` —
 * and the three cards seen on one day give 840/700, 1,080/900 and 960/800, which
 * are all exactly 1.2 across two trial types and three different tiers. That is
 * the guild's own Builder's Hall at Lv.10, recovered without the Buildings tab
 * ever being opened.
 *
 * It is deliberately hard to satisfy, because a wrong bonus here would corrupt
 * every token figure downstream. Every card must agree, the ratio must be a
 * whole number of 2% steps, and it must lie within the twenty levels a building
 * has. Anything else returns null and the caller reports the level as unknown.
 *
 * The step and the ceiling are the building's own, so a rebalance that changes
 * either does not turn this into a wrong answer: `guild-trials-store.js` reads
 * both off the game's `guildBuildingDetailMap` and passes them in, and the
 * confirmed constants stand in when there is no client data to read.
 *
 * @param {Array<{type: string, pointsByTier: Object}>} tiles - Trials with their stated points
 * @param {Object} [rules] - The building's own rules
 * @param {number} [rules.bonusPerLevel] - Bonus one level grants
 * @param {number} [rules.maxLevel] - Levels the building has
 * @returns {{bonus: number, level: number, ratio: number, cards: number}|null} The bonus, or null
 */
export function inferBuildersHallBonus(
    tiles,
    { bonusPerLevel = BUILDING_BONUS_PER_LEVEL, maxLevel = GUILD_BUILDING_MAX_LEVEL } = {}
) {
    const step = Number.isFinite(bonusPerLevel) && bonusPerLevel > 0 ? bonusPerLevel : BUILDING_BONUS_PER_LEVEL;
    const ceiling = (Number.isFinite(maxLevel) && maxLevel > 0 ? maxLevel : GUILD_BUILDING_MAX_LEVEL) * step;
    const ratios = [];
    for (const tile of tiles || []) {
        for (const [tier, points] of Object.entries(tile?.pointsByTier || {})) {
            const ladder = trialBasePoints(tile?.type, Number(tier));
            const stated = Number(points);
            if (!(ladder > 0) || !Number.isFinite(stated) || stated <= 0) continue;
            ratios.push(stated / ladder);
        }
    }
    if (!ratios.length) return null;

    const ratio = ratios[0];
    if (ratios.some((candidate) => Math.abs(candidate - ratio) > 0.005)) return null;

    const bonus = ratio - 1;
    if (bonus < 0 || bonus > ceiling + 1e-9) return null;

    const level = Math.round(bonus / step);
    if (Math.abs(level * step - bonus) > 0.001) return null;

    return { bonus: level * step, level, ratio, cards: ratios.length };
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
 * banked, divided back down to base by {@link trialBankedBasePoints}. It wins
 * where it is present, because the card is the game talking about this trial and
 * the ladder is a rule reconstructed from the guide's prose.
 *
 * `guildPointsOverride` is the card's figure *as the card stated it*, and it is
 * the one number here that is known to be exactly right: four days of the
 * guild's chat announcements say the sum of the cards is the Guild Points
 * earned. Carrying it through rather than recomputing `base × (1 + hall)` keeps
 * the panel's total equal to the game's own to the digit, whatever rounding the
 * game does.
 *
 * The token half of the arithmetic is unchanged and now has its own check:
 * against those same four days, `0.5 × base × (1 + treasury)` reproduces the
 * announced 990, 880, 1,375 and 1,320 tokens per eligible member exactly, with
 * this guild's +20% Builders Hall and +10% Treasury. The apparent "×1.1 on top
 * of half the base" is the Treasury bonus — it is already in the model, and
 * nothing needed inventing to fit it.
 *
 * @param {Object} input - Inputs
 * @param {Array<{type: string, tiersCleared: number, name?: string, basePointsOverride?: number,
 *   guildPointsOverride?: number}>} input.trials - The week's trials
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
        const statedGuildPoints = Number(trial?.guildPointsOverride);
        const base = Number.isFinite(override) ? override : trialBasePoints(trial?.type, trial?.tiersCleared);
        return {
            name: trial?.name ?? null,
            type: trial?.type ?? null,
            tiersCleared: Math.max(0, Math.floor(Number(trial?.tiersCleared) || 0)),
            basePoints: base,
            basePointsSource: Number.isFinite(override) ? 'game' : 'ladder',
            guildPoints: Number.isFinite(statedGuildPoints) ? statedGuildPoints : guildPoints(base, hall),
        };
    });

    const basePoints = perTrial.reduce((sum, trial) => sum + trial.basePoints, 0);
    const eligibleTokens = eligibleMemberTokens(basePoints, treasury);
    const participantBonusTokens = eligibleTokens * PARTICIPANT_BONUS_SHARE;

    return {
        basePoints,
        guildPoints: perTrial.reduce((sum, trial) => sum + trial.guildPoints, 0),
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

/**
 * How much of a boss's health the party has taken off, per millisecond.
 *
 * Separate from {@link ratePerMs} because a combat trial's bar does not behave
 * like a pool's. Confirmed from a live client: the In Progress combat card
 * carries **two** bars, the boss's health and the boss's mana, and it is the
 * first of them that damage is measured on — the second moves for reasons that
 * have nothing to do with the party's DPS.
 *
 * The harder half is that a combat trial is a *ladder of bosses*, not one bar
 * running down. The observed pair of readings straddles a tier clear:
 *
 * ```
 * 23,031 / 618,000   ← tier 2's boss, nearly dead
 * 506,273 / 669,500  ← tier 3's boss, already damaged (and 669,500 is the ladder step up from 618,000)
 * ```
 *
 * Reading that as "health rose, so the party dealt no damage" is what a
 * monotonic run does with it, and it is why a combat card could never produce a
 * rate: the classifier looked for a bar that *falls*, and across a tier boundary
 * neither of them does. Damage is therefore accumulated pair by pair:
 *
 * - **Within a tier** — same maximum, health fell: the difference.
 * - **Across a boundary** — the maximum changed, or health rose: what was left
 *   of the old boss (`before.current`) plus what has already come off the new
 *   one (`after.max - after.current`).
 *
 * A boundary the readings straddle may have been *more than one* tier, and
 * nothing in a pair of readings can say so on its own. Where a growth factor has
 * been fitted the jump is checked against it; where it has not, or where the
 * jump is too large for one step, `multiTier` is returned true and the caller is
 * expected to caption the figure as a lower bound rather than quietly under-report
 * a party's damage.
 *
 * @param {Array<{t: number, current: number, max: number}>} samples - Boss health readings, any order
 * @param {Object} [options] - Options
 * @param {number|null} [options.growthPerTier] - Fitted per-tier growth, for the single-step check
 * @param {number} [options.windowMs] - Ignore readings older than this before the newest
 * @returns {{rate: number|null, damage: number, spanMs: number, boundaries: number, multiTier: boolean,
 *   samples: number}} The measurement
 */
export function combatDamageRate(samples, { growthPerTier = null, windowMs = TRIAL_ACTIVE_MS } = {}) {
    const usable = (samples || [])
        .filter((sample) => Number.isFinite(sample?.t) && Number.isFinite(sample?.current) && Number(sample?.max) > 0)
        .sort((a, b) => a.t - b.t);

    // A trial runs an hour, so a reading older than that belongs to a different
    // trial and folding it in would average two events together
    const newest = usable.length ? usable[usable.length - 1].t : 0;
    const window = Number.isFinite(windowMs) ? usable.filter((sample) => newest - sample.t <= windowMs) : usable;

    const nothing = { rate: null, damage: 0, spanMs: 0, boundaries: 0, multiTier: false, samples: window.length };
    if (window.length < 2) return nothing;

    let damage = 0;
    let boundaries = 0;
    let multiTier = false;

    for (let index = 1; index < window.length; index += 1) {
        const before = window[index - 1];
        const after = window[index];
        const cleared = after.max !== before.max || after.current > before.current;

        if (!cleared) {
            damage += before.current - after.current;
            continue;
        }

        boundaries += 1;
        damage += before.current + (after.max - after.current);

        // One step up the ladder, or several? Only a fitted growth factor can
        // answer that, and a boss *smaller* than the last one is not a step at all
        const ratio = after.max / before.max;
        const step = Number.isFinite(growthPerTier) && growthPerTier > 1 ? growthPerTier : null;
        if (ratio < 1 || !step || ratio > Math.pow(step, 1.5)) multiTier = true;
    }

    const spanMs = window[window.length - 1].t - window[0].t;
    if (spanMs <= 0 || damage <= 0) return { ...nothing, damage, spanMs, boundaries, multiTier };

    return { rate: damage / spanMs, damage, spanMs, boundaries, multiTier, samples: window.length };
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
