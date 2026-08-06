/**
 * Guild trials, while they are running.
 *
 * The game's In Progress tab shows a bar and a level. It does not say how fast
 * the bar is moving, whether the tier in front of the party is reachable before
 * the hour ends, what the tier after that will cost, or what any of it is worth
 * when the tokens are paid out on Friday. Those are the four questions a guild
 * actually argues about while a trial is live, and all four are answerable from
 * the bar plus the rules — which is what this draws.
 *
 * The rules themselves, and every formula derived from them, are pinned in
 * `guild-trials-math.js`; reading the panel is `guild-trials-scrape.js`; the
 * samples and the building levels are `guild-trials-store.js`. This file is the
 * wiring: observe the tab, take a reading every few seconds while it is open,
 * and put three blocks on the screen.
 *
 * ## What it can and cannot know
 *
 * **Rates are measured, not computed.** Nothing in the client's static data
 * gives a tier's required work or a trial boss's health, so the first reading of
 * a tier says "measuring" and the second gives a rate. That is also why samples
 * are persisted: a player who checks the tab twice a minute should not restart
 * the measurement each time.
 *
 * **Tier growth is exact, anchored on one observation.** Projecting the tier
 * after the current one needs the curve the totals grow along, which is not in
 * client data — but both kinds' curves are now known exactly (`exactTierTotal`:
 * a tenth of the first tier's work per skilling tier, `10 + level` for a combat
 * boss), and they are ratios, so the bar in hand anchors the whole ladder. The
 * fitted growth factor survives only as a fallback.
 *
 * **A skilling tier can be known from its bar alone.** The bar's target is
 * `base × (1 + 0.1 × (tier − 1)) × (1 + 0.01 × participants)`, and the base is
 * learned per skill the first time a stated tier, the target and the
 * participant count are on screen together — after which a mid-trial join on
 * the In Progress tab, which carries no tier at all, still knows which tier it
 * is watching (`tierFromWorkTarget`, `tierSource: 'work-ladder'`).
 *
 * **Tiers cleared is inferred from the tier on screen.** A trial starts at tier
 * 1 and climbs one at a time, so a trial showing tier 7 has banked six. This is
 * the only inference here that is not measured, and it is the one thing on the
 * block that nothing has ever confirmed — so the payout no longer rests on it:
 * the points come from what the cards state (below), which is checked against
 * the guild's own announcements. It still drives the "Banked N tiers" line and
 * where the pace projection starts from.
 *
 * **Token payouts are worth something, approximately.** Tokens have no market
 * price, but the guild shop trades them for guild credits and credits are priced
 * off the items that convert into them, so the payout rows carry a derived gold
 * figure labelled "via credit exchange" (`guild-token-value.js`). Without an
 * exchange rate the rows show the bare token count they always did.
 *
 * **Nothing arrives while the tab is shut.** This is the honest limit of the
 * whole feature and it is worth stating where somebody will read it: no socket
 * message carries a running trial's pool fill or a boss's health, so a reading
 * only exists because the tab was on screen when the sampler ran. A trial can
 * therefore be live, and this can have nothing to say about it, and both of
 * those can be true at once. Everything downstream — the blocks here, the
 * overlay tile in `guild-trials-row.js` — must say *that* rather than going
 * quiet, because a blank surface during a live trial is indistinguishable from a
 * broken one. It was reported as a broken one.
 *
 * **Zero is a claim, and usually the wrong one.** Three separate things used to
 * reach the screen as `0`: a tier that has not been seen because only the In
 * Progress tab was ever open (it carries no tier), a trial genuinely still on
 * its first tier, and a pace that could not be projected. The first is *unknown*
 * and the block now says which of the three it is, along with what to open to
 * fix it. A player who joins a trial midway sees the first of these until they
 * look at the Trials tab once, and it is not a failure of the arithmetic.
 *
 * **The game states what a trial has earned, and it wins.** The Trials tab's
 * cards carry an "840 pts" line, and four days of the guild's own chat
 * announcements say the sum of exactly those figures is the Guild Points the
 * guild is paid. So the payout block sums the cards. They are *Guild Points* —
 * base points with the Builder's Hall bonus already applied — which is the one
 * thing this file used to get wrong in both directions at once: it compared them
 * against the ladder's un-bonused figures and reported a disagreement on every
 * card of every week, and it looked each figure up under its own inference about
 * how many tiers were banked, missed by a tier every time, and fell back to the
 * ladder. Announced 2,880; panel said 2.4K.
 *
 * **A combat trial's DPS can be split per player.** The card's "Party DPS" is
 * measured off the boss bar and cannot say who is producing it. The fight itself
 * is an ordinary battle on the wire, so `guild-trial-damage.js` attributes it —
 * but only for fights this client is actually in, and only when the fight can be
 * shown to be the trial's.
 *
 * **Payout bonuses are 2% per level, both of them.** Guild Points scale with the
 * Builder's Hall and token payouts with the Treasury, and both in-game upgrade
 * popups confirm the same rule ("Guild Points: +20% → +22%" at Hall level 10,
 * "Guild Token Rewards: +10% → +12%" at Treasury level 5). The *levels* arrive
 * on guild traffic and are captured and persisted the moment they are seen. When
 * a level has not been seen the Builder's Hall bonus can still be recovered from
 * the cards themselves — a card states Guild Points for a tier whose base the
 * ladder knows, and the ratio is the bonus — and the Treasury, which has no such
 * shortcut, is left out of the token figures with the block saying so.
 *
 * **A combat card is health then mana.** Both bars belong to the boss, and only
 * the first is damage. The rate is accumulated across tier clears rather than
 * fitted to a falling bar, because a combat trial is a ladder of bosses and the
 * bar jumps *up* every time one dies — see `combatDamageRate`.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { formatEta } from '../../utils/progress-eta.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import {
    EXTRA_TIER_POINTS,
    TRIAL_ACTIVE_MS,
    TRIAL_MAX_TIER,
    baseWorkFromObservations,
    combatDamageRate,
    estimateGrowthPerTier,
    etaMs,
    exactTierTotal,
    inferBuildersHallBonus,
    levelFromTier,
    nextTierPreview,
    payoutProjection,
    projectPace,
    projectTierTotal,
    ratePerMs,
    participantScale,
    tierFromWorkTarget,
    trialBankedBasePoints,
    trialWeekStart,
} from './guild-trials-math.js';
import guildTrialDamage, { encounterOf } from './guild-trial-damage.js';
import guildTrialSkilling from './guild-trial-skilling.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import guildTrialRecorder, { buildTrialExport, downloadTrialExport } from './guild-trial-recorder.js';
import guildTrialScoreboard from './guild-trial-scoreboard.js';
import guildMemberSkills from './guild-member-skills.js';
import { forecastTrial } from './guild-trial-forecast.js';
import guildTrialAlerts from '../notifications/guild-trial-alerts.js';
import { describeGuildTokenGold } from './guild-token-value.js';
import {
    NOT_A_CLOCK_RE,
    classifyReadings,
    findTrialClockMs,
    findTrialsRoot,
    inFloatingDialog,
    matchTrialHrid,
    onTrialTab,
    parseClockMs,
    readPersonalStats,
    readTrialStatus,
    readTrialTiles,
} from './guild-trials-scrape.js';
import {
    archiveCycle,
    emptyRecord,
    loadTrialRecord,
    loadWorkBases,
    mergeTrialRecords,
    purgeLegacyTrialRecord,
    readPayoutBonuses,
    recordProvenance,
    recordTileSample,
    saveTrialRecord,
    saveWorkBases,
    tileKey,
} from './guild-trials-store.js';
import { FOREIGN_CYCLE_REASON, pastWeekLine, summariseArchivedCycle } from './guild-trial-history.js';

/** Class every injected element carries, so cleanup is one query */
const CSS_CLASS = 'mwi-trial-info';

/** How often a reading is taken while the tab is open */
const SAMPLE_MS = 5000;

/** Every trial starts here, which is what makes the first tier knowable */
const FIRST_TIER = 1;

/**
 * How stale a spectated pool reading may be before it stops standing in.
 *
 * The stream ticks several times a second while the fight view is open and stops
 * dead when it closes. Ten seconds is long enough to bridge a redraw and short
 * enough that a closed view stops feeding the card a health that is no longer
 * moving — which would read as a rate of zero on a trial that is running fine.
 */
const SPECTATED_POOL_FRESH_MS = 10_000;

/**
 * How old a bar reading may be and still teach a skill's base work.
 *
 * The record's last target survives tab switches, and a tier that cleared
 * while the tab was shut would pair the *old* target with the *new* badge —
 * a wrong base learned once states wrong tiers with confidence from then on.
 * Fifteen seconds matches the skilling stream's own freshness window.
 */
const WORK_BASE_LEARN_FRESH_MS = 15_000;

const ACCENT = '#8fd3ff';
const DIM = '#9ca3af';
const GOOD = '#4ade80';
const WARN = '#f0a830';

/**
 * First-tier totals confirmed by direct observation, as cold-start seeds.
 *
 * The learned store answers first and overrides these; the seeds exist because
 * the store cannot cross a browser profile — the user's second account, in a
 * second browser, mid-joined a trial and had base and bar in front of it with
 * no way to connect them ("tier not known yet" over a bar reading 8,276/51,360
 * = 40,000 × 1.2 × 1.07 exactly). Each entry is backed by observations this
 * codebase already carries:
 *
 * - **crafting 40,000** — two guilds and an export: 49,920 = ×1.2×1.04 (T3,
 *   4 signed), 88,920 = ×1.9×1.17 (T10, 17 signed), and a full T2–T15 ladder
 *   41,600 × (1 + 0.1(t−1)) in the recorded week.
 * - **foraging 40,000** — a live trial watched through 40,800 / 44,880 /
 *   48,960 with 2 signed up.
 * - **alchemy 40,000** — a live card at 65,280 = ×1.6×1.02 (T7, 2 signed).
 * - **Trial Chameleon 550,000** — the pool bar's own ladder 550,000 / 600,000
 *   / 650,000 / 700,000 = (100 + 10t) × 5,000, with the HP bar exactly ×1.04
 *   beside it in a 4-participant guild and ×1.03 in a 3-participant one.
 * - **Trial Badger 330,000** — a `new_guild_battle` sheet: 429,000 with 30 in
 *   the trial, 330,000 × 1.3 exactly.
 *
 * Every observed skilling base has been 40,000 so far, but only the observed
 * skills are seeded: a wrong seed states wrong tiers with confidence, and an
 * unseeded skill merely learns on its first stated-tier moment as before.
 */
const DEFAULT_WORK_BASES = {
    crafting: 40_000,
    foraging: 40_000,
    alchemy: 40_000,
    'trial chameleon': 550_000,
    'trial badger': 330_000,
};

/**
 * Everything derivable about one trial, from its stored samples.
 *
 * Pure, and exported for tests: it takes a record and returns numbers, and never
 * touches the DOM, the clock or storage.
 *
 * @param {Object} record - A tile record from `guild-trials-store.js`
 * @param {Object} [options] - Context
 * @param {number} [options.participants] - Signed-up participants, for the next-tier caption
 * @param {number|null} [options.timeLeftMs] - Active time left in the trial
 * @param {number|null} [options.buildersHallBonus] - Builders Hall bonus fraction, for reading the card's points
 * @param {string|null} [options.phase] - `scheduled`, `live` or `completed`, for the first-tier rule
 * @param {number|null} [options.workBase] - The skill's learned first-tier work, for the work-ladder tier rung
 * @returns {{kind: string, tier: number|null, level: number|null, tiersClearedSoFar: number,
 *   rate: number|null, rateNote: string|null, remaining: number|null, total: number|null,
 *   etaMs: number|null, growthPerTier: number|null, next: Object|null, pace: Object|null,
 *   samples: number, timeLeftMs: number|null}} Analysis
 */
export function analyseTrial(
    record,
    { participants = 0, timeLeftMs = null, buildersHallBonus = null, phase = null, workBase = null } = {}
) {
    const samples = Array.isArray(record?.samples) ? record.samples : [];
    const kind = record?.kind === 'combat' ? 'combat' : 'skilling';

    // What the badge on the card means, which is not what this assumed.
    //
    // Watched through a live trial: after the first tier cleared the card read
    // "Lv.100, 236 pts, T1", and after the second "Lv.110, 354 pts, T2" — while
    // the pool on the In Progress tab was plainly the *third* one. So the badge
    // counts tiers **banked**, and the tier being fought is one past it. The old
    // rule (badge is the tier in progress, banked is one fewer) was wrong in
    // both directions at once and produced "Banked 1 tier" under a T2 badge.
    //
    // That also settles the completed case the same way, which is what the
    // points identity already said: a finished card's badge is what it reached.
    //
    // Before any badge exists, a running trial is on its first tier and has
    // banked nothing — every trial starts there. A card already stating points
    // is a mid-trial join and keeps the unknown-tier behaviour.
    const badge = Number.isFinite(record?.tier) ? record.tier : null;
    const statedPoints = Object.keys(record?.pointsByTier || {}).some(
        (entry) => Number(record.pointsByTier[entry]) > 0
    );
    const completed = Boolean(record?.completed);

    // Whether this trial has finished anything at all. The points are what say
    // so, and they are what tells the two readings of a badge apart:
    //
    //   "Lv.100, 0 pts, T1"   — tier one, in progress, nothing banked
    //   "Lv.100, 236 pts, T1" — tier one banked, tier two being fought
    //
    // Both were watched on the same card an hour apart. Without the points half
    // of that rule a combat card sitting at Lv.100 during the *skilling* hour
    // claimed a banked tier for a trial that had not started, and put it in the
    // payout.
    //
    // A card that *states* zero is the third reading, and it is a wipe: the
    // Hedgehog party fell before clearing tier one, so its card read "Lv.100,
    // 0 pts, Completed". Letting `completed` imply "earned" credited it the tier
    // it was fighting, and the block said "Banked 1 tier · finished" for a trial
    // that banked nothing. A stated zero outranks the completed badge; a card
    // whose points were never seen at all is unchanged.
    const statedZero = record?.points === 0;
    const earned = statedPoints || record?.points > 0 || (completed && !statedZero);
    const assumeFirst = phase === 'live' && badge === null && !earned;
    const observations = Array.isArray(record?.tiers) ? record.tiers : [];

    const history = samples.map((sample) => sample?.readings || []);
    const { bossIndex, poolIndex } = classifyReadings(history, kind);
    const index = kind === 'combat' ? bossIndex : poolIndex;
    const direction = kind === 'combat' ? -1 : 1;

    // Read ahead of the tier because the tier may now be derived *from* it: the
    // bar's target is the one thing the In Progress card does carry
    const latest = index === null ? null : samples[samples.length - 1]?.readings?.[index] || null;
    const total = Number.isFinite(latest?.max) ? latest.max : null;
    const remaining = latest ? (direction === -1 ? latest.current : Math.max(0, latest.max - latest.current)) : null;

    // The tier being fought, which is what a rate, a pace and a forecast are
    // about — from the best of four rungs, each labelled so a caption can say
    // where the number came from:
    //
    // 1. **The badge** ('card'), read as the comment above explains it.
    // 2. **The socket** ('socket'): `guild_skilling_updated.tier` states the
    //    tier in progress outright, and the store keeps it as `liveTier`.
    // 3. **The work ladder** ('work-ladder'): the bar's target identifies the
    //    tier once the skill's base work is known — see `tierFromWorkTarget`.
    //    This is what makes a mid-trial join on the In Progress tab knowable
    //    without ever opening the Trials tab.
    // 4. **The first-tier rule** ('first-tier-rule'), as before.
    //
    // ## The rungs go stale at different speeds, and that decides who wins
    //
    // Live evidence, one moment, two tabs: the In Progress bar read
    // 17,353/99,840 — a target only T15 produces — while the panel said
    // "Banked 8 tiers" and "Next tier work (T10)". A `liveTier` of 9, stated
    // hours earlier when the trial genuinely was on tier 9, had been persisted
    // and never invalidated, and the rung order let it outrank the bar in
    // front of the player until a Trials-tab visit rewrote the badge.
    //
    // So staleness is now handled twice over:
    //
    // - A socket-stated tier is only believed **for the pool it was stated
    //   with**. The update carries `targetWorkValue`, the store keeps it as
    //   `liveTierTarget`, and the moment the bar's target no longer matches,
    //   the statement is about a tier that has since cleared and is dropped.
    // - Tiers only climb, so the winner is the **largest** valid rung — the
    //   badge and the socket can lag but never lead, and the work ladder reads
    //   the bar as it is *now*. Ties go to the stated sources over the derived
    //   one.
    //
    // The work ladder no longer needs the learned store to have spoken: any
    // correctly-filed tier observation from this trial backs the base out
    // (`baseWorkFromObservations`), so a record that once knew its tier keeps
    // knowing it as later tiers clear with the tab sitting open.
    const fromBadge = badge !== null ? (completed || !earned ? badge : badge + 1) : null;

    const socketTarget = Number.isFinite(record?.liveTierTarget) ? record.liveTierTarget : null;
    const socketStale = socketTarget !== null && Number.isFinite(total) && total !== socketTarget;
    const fromSocket = !completed && !socketStale && Number.isFinite(record?.liveTier) ? record.liveTier : null;

    // Only an observation above the first tier may seed the fallback base: a
    // tier-1 observation may be the first-tier rule's own filing, and a base
    // derived from it "confirms" tier 1 by construction — an assumption
    // relabelled as arithmetic. Combat records file both of a card's bars as
    // observations and the two sit on differently-scaled ladders, so the
    // observation fallback is a skilling-only shortcut; a combat base comes
    // from the learned store.
    const anchoredObservations = observations.filter((observation) => Number(observation?.tier) >= 2);
    const ladderBase =
        Number.isFinite(workBase) && workBase > 0
            ? workBase
            : kind === 'skilling'
              ? baseWorkFromObservations(anchoredObservations, participants, kind)
              : null;

    // A combat card's *second* bar is the cleaner tier anchor: it is the
    // tier's own pool, scaling purely with the tier's level — observed live as
    // 547,970/550,000 at T1 becoming 597,970/600,000 at T2, exactly 110 → 120
    // on a 5,000-per-unit base, with no participant factor to get right. The
    // boss health (first bar) carries the 1%-per-participant scale and backs
    // out the *same* base, so it still identifies the tier when the second bar
    // is absent, at the cost of needing the participant count.
    const combatPoolTarget =
        kind === 'combat' && Number.isFinite(samples[samples.length - 1]?.readings?.[1]?.max)
            ? samples[samples.length - 1].readings[1].max
            : null;
    const fromWorkLadder = !completed
        ? ((combatPoolTarget !== null
              ? tierFromWorkTarget({ target: combatPoolTarget, baseWork: ladderBase, participants: 0, kind })
              : null) ?? tierFromWorkTarget({ target: total, baseWork: ladderBase, participants, kind }))
        : null;

    let tier = null;
    let tierSource = null;
    for (const [candidate, source] of [
        [fromBadge, 'card'],
        [fromSocket, 'socket'],
        [fromWorkLadder, 'work-ladder'],
    ]) {
        if (candidate === null || (tier !== null && candidate <= tier)) continue;
        tier = candidate;
        tierSource = source;
    }
    if (tier === null && assumeFirst && !(Number.isFinite(ladderBase) && Number.isFinite(total))) {
        // The first-tier rule stands down when the work ladder has actively
        // contradicted it: a known base and a target that fits no tier is not
        // a trial provably on tier one, whatever the rule would like to assume
        tier = FIRST_TIER;
        tierSource = 'first-tier-rule';
    }

    // What it has finished, which is what the payout is about. A trial climbs
    // one tier at a time from the first, so a stated or derived tier in
    // progress banks everything below it — that is how "Banked 2 tiers" is
    // known on a mid-trial join whose cards were never on screen.
    let bankedTiers = badge !== null && earned ? badge : 0;
    if ((tierSource === 'socket' || tierSource === 'work-ladder') && Number.isFinite(tier)) {
        bankedTiers = Math.max(bankedTiers, tier - 1);
    }

    // Everything downstream of the tier — what is banked, what the payout is
    // worth, whether a pace can be walked — is unavailable rather than zero when
    // the tier has not been seen. The In Progress card carries no tier at all,
    // so a player who only ever opens that tab is in this state permanently, and
    // reporting it as "0 banked" is what made a live trial's payout read as
    // nothing at all.
    const tierKnown = Number.isFinite(tier);
    const tiersClearedSoFar = bankedTiers;
    const pointsByTier = record?.pointsByTier && typeof record.pointsByTier === 'object' ? record.pointsByTier : {};

    const base = {
        kind,
        tier,
        tierKnown,
        // Where the tier came from, so a caption can say "assumed" or "derived
        // from the tier's work total" rather than implying the panel stated it
        tierSource,
        completed,
        // The card's own "840 pts", where it has been seen. It is Guild Points
        // rather than base points — see `trialBankedBasePoints` — so the Builders
        // Hall bonus is needed to divide it back down for the token arithmetic
        points: trialBankedBasePoints({
            type: kind,
            bankedTiers: tiersClearedSoFar,
            pointsByTier,
            buildersHallBonus,
        }),
        pointsByTier,
        // Set below for a combat trial whose readings straddle a tier clear
        rateNote: null,
        level: Number.isFinite(record?.level) ? record.level : null,
        tiersClearedSoFar,
        rate: null,
        remaining: null,
        total: null,
        etaMs: null,
        growthPerTier: estimateGrowthPerTier(observations),
        next: null,
        pace: null,
        samples: samples.length,
        // Carried through so the block can tell "no pace because no clock" from
        // "no pace because no rate yet" — they read identically on screen and
        // only one of them is something the player can do anything about
        timeLeftMs: Number.isFinite(timeLeftMs) ? timeLeftMs : null,
    };

    if (index === null) return base;

    const growthPerTier = base.growthPerTier;

    // A combat trial is a ladder of bosses, and its rate is damage rather than
    // movement along one bar: the readings straddle tier clears, where the bar
    // *rises* and the run-of-monotonic-samples fit gives up. See
    // `combatDamageRate` — this is the only reason a combat card ever produced a
    // "Party DPS" of nothing while the party was plainly killing things.
    let rate = null;
    let rateNote = null;
    if (kind === 'combat') {
        const measured = combatDamageRate(
            samples.map((sample) => ({
                t: sample?.t,
                current: sample?.readings?.[index]?.current,
                max: sample?.readings?.[index]?.max,
            })),
            { growthPerTier }
        );
        rate = measured.rate;
        if (measured.multiTier) {
            rateNote =
                'A tier cleared between two readings and the gap may have covered more than one, ' +
                'so the damage counted is a lower bound.';
        } else if (measured.boundaries > 0) {
            rateNote = 'Counted across a tier clear: what was left of the last boss plus what is off this one.';
        }
    } else {
        const series = samples
            .map((sample) => ({ t: sample?.t, value: sample?.readings?.[index]?.current }))
            .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value));
        rate = ratePerMs(series, direction);
    }

    // Every tier total this trial has shown, plus the bar in hand: the live
    // target is the one anchor a player who never opens the Trials tab has,
    // and `observations` may still be empty when nothing has banked while
    // watched. One anchor is all the exact ladder needs.
    const anchors =
        Number.isFinite(tier) && Number.isFinite(total) && total > 0
            ? [...observations, { tier, total }]
            : observations;

    // The next tier's size, off the exact ladder first — both kinds' curves are
    // known exactly, so a preview no longer waits for a fit — with the fitted
    // growth kept only as the fallback for a trial neither rule covers
    const exactNext =
        Number.isFinite(tier) && tier + 1 <= TRIAL_MAX_TIER ? exactTierTotal({ kind, anchors, tier: tier + 1 }) : null;
    const next = Number.isFinite(exactNext)
        ? {
              tier: tier + 1,
              level: levelFromTier(tier + 1),
              total: exactNext,
              participantPenalty: participantScale(participants) - 1,
              growthPerTier: null,
          }
        : Number.isFinite(tier)
          ? nextTierPreview({ observations, currentTier: tier, participants })
          : null;

    // The pace walks the same ladder the next-tier row states, so the two can
    // never disagree. The fitted-growth walk this replaces starved with fewer
    // than two observed tiers: it stopped after the tier in hand with
    // `limitedBy: 'unknown-next-tier'`, and "2 banked + the tier in hand" was
    // then presented as a time verdict — a live trial that cleared far past T3
    // had been captioned "On pace for 3 tiers → T3".
    const pace =
        Number.isFinite(tier) && Number.isFinite(remaining) && Number.isFinite(timeLeftMs)
            ? projectPace({
                  currentTier: tier,
                  remainingInTier: remaining,
                  rate,
                  timeLeftMs,
                  totalForTier: (candidate) =>
                      exactTierTotal({ kind, anchors, tier: candidate }) ??
                      projectTierTotal({ observations, tier: candidate, growthPerTier }),
                  tiersAlreadyCleared: base.tiersClearedSoFar,
              })
            : null;

    return { ...base, rate, rateNote, remaining, total, etaMs: etaMs(remaining, rate), next, pace };
}

/**
 * Participants per trial, from the sign-ups the socket reports.
 *
 * The panel does not list who is in a trial, but every guild character carries
 * the hrid they signed up for, and the tracker already keeps those. Only members
 * whose sign-up belongs to the current week are counted — a stale hrid from last
 * week would inflate the 1%-per-head penalty.
 *
 * @param {Object} [tracker] - The XP tracker, injectable for tests
 * @returns {Object<string, number>} trial hrid → participant count
 */
export function participantCounts(tracker = guildXPTracker) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const counts = {};

    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        if (currentWeek && meta?.signupWeekStartAt !== currentWeek) continue;
        for (const hrid of [meta?.signedUpSkillingTrialHrid, meta?.signedUpCombatTrialHrid]) {
            if (hrid) counts[hrid] = (counts[hrid] || 0) + 1;
        }
    }

    return counts;
}

/**
 * Whether this character is in a given trial, as far as anything can tell.
 *
 * Three answers, and the third is why this exists. A trial's progress can only
 * ever be measured for a trial the player is *in*: the In Progress tab shows
 * their own trials and nothing else, so no reading will ever arrive for the
 * others. A card for somebody else's trial that says "measuring…" is promising
 * a number that cannot come, and it said so for the whole week.
 *
 * `null` means the sign-up sheet has not been seen — the XP tracker is where
 * that comes from and it can be switched off — and a caller must keep the older,
 * vaguer wording rather than accusing the player of not joining.
 *
 * @param {string} trialName - The card's trial name
 * @param {Object} [options] - Injectables, for tests
 * @param {Object} [options.tracker] - The XP tracker
 * @param {string|number|null} [options.characterId] - This character's id
 * @param {Object} [options.skilling] - The socket's own participant list
 * @returns {boolean|null} In it, not in it, or not knowable
 */
export function ownParticipation(
    trialName,
    { tracker = guildXPTracker, characterId, skilling = guildTrialSkilling } = {}
) {
    const id = characterId ?? dataManager.getCurrentCharacterId?.() ?? null;
    if (id === null || id === undefined) return null;

    // The game's own answer, when it has given one. `guild_skilling_updated`
    // carries `participantIds` — character ids of everyone in the trial — which
    // settles this without a sign-up sheet that may never have been on screen
    const stated = skilling?.participating?.(trialName, id);
    if (stated !== null && stated !== undefined) return stated;

    // The map is keyed by whatever the socket used; an id that arrived as a
    // number and is asked for as a string is the same member
    const meta =
        tracker?.getMemberMeta?.(id) || tracker?.getMemberMeta?.(String(id)) || tracker?.getMemberMeta?.(Number(id));
    if (!meta) return null;

    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    if (currentWeek && meta.signupWeekStartAt && meta.signupWeekStartAt !== currentWeek) return false;

    const hrids = [meta.signedUpSkillingTrialHrid, meta.signedUpCombatTrialHrid].filter(Boolean);
    if (!hrids.length) return false;

    return Boolean(matchTrialHrid(trialName, hrids));
}

/**
 * Who signed up for a trial, by name.
 *
 * The estimated per-player split needs a roster to cover, and a member with no
 * captured build must be *named* as unestimated rather than dropped — a
 * leaderboard that silently omits three people reads as three people who did
 * nothing. The count of these is what `participantCounts` already returns; this
 * is the same walk keeping the names.
 *
 * @param {string} trialName - The card's trial name
 * @param {Object} [tracker] - The XP tracker, injectable for tests
 * @returns {string[]} Member names, in roster order
 */
export function signedUpMembers(trialName, tracker = guildXPTracker) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const names = [];

    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        if (currentWeek && meta?.signupWeekStartAt !== currentWeek) continue;

        const hrids = [meta?.signedUpSkillingTrialHrid, meta?.signedUpCombatTrialHrid].filter(Boolean);
        if (!hrids.length || !matchTrialHrid(trialName, hrids)) continue;

        const name = meta?.name || member?.name || null;
        if (name && !names.includes(name)) names.push(name);
    }

    return names;
}

/**
 * A number, or a dash.
 * @param {number|null} value - The number
 * @returns {string} Formatted
 */
function num(value) {
    return Number.isFinite(value) ? formatKMB(Math.round(value)) : '—';
}

/**
 * A fraction as a percentage, without trailing noise.
 * @param {number|null} value - A fraction, e.g. 0.02
 * @returns {string} e.g. `2%`
 */
function formatPercent(value) {
    if (!Number.isFinite(value)) return '2%';
    const percent = value * 100;
    return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%`;
}

/**
 * A number in full, with thousands separators, or a dash.
 *
 * The payout block uses this and not {@link num}. Everywhere else an
 * abbreviation is the right call — a rate of 5.0K dmg/s is easier to read than
 * 4,981 — but a payout is a figure the player checks against what the guild
 * announces, and "1.3K" cannot be checked against anything.
 *
 * @param {number|null} value - The number
 * @returns {string} Formatted
 */
function exact(value) {
    return Number.isFinite(value) ? formatWithSeparator(Math.round(value)) : '—';
}

/**
 * Longest a value can be before the row stacks instead of sitting in columns.
 *
 * "106 work/s" is a figure and belongs in a column beside its label. Anything
 * much longer is a phrase, and a phrase in the right-hand column of a block
 * beside a 126px card leaves nothing for the label — which produced two
 * successive reported screenshots. First a tall ragged noodle with two words per
 * line; then, after the value was told not to wrap, labels ellipsized past
 * recognition: `C… | 0 tiers → T1 (Lv.100)`, `Ban… | tier not seen yet`.
 *
 * A label cut to one letter is worse than either. So the threshold is low enough
 * that a phrase gets the full width with its label above it, and the label in
 * the column form is allowed to *wrap* rather than being cut — these are two-word
 * labels and two lines of "On pace for" reads perfectly well.
 */
const VALUE_MAX_CHARS = 16;

/**
 * Longest a label can be before its row stacks.
 *
 * "Expected" and "On pace for" fit beside a figure; "Next tier work (T3)" does
 * not, and squeezing it in is what produced a wrapped label with a single
 * letter on the second line.
 */
const LABEL_MAX_CHARS = 12;

/**
 * A row of label and value, or a label with a caption under it.
 *
 * The shape is chosen by the content rather than by the caller, so a row that is
 * usually a figure and occasionally a sentence — "Rate" is `106 work/s` on a
 * trial you are in and a full explanation on one you are not — gets the right
 * layout in both cases without every call site having to think about it.
 *
 * @param {string} label - Left side
 * @param {string} value - Right side, or the caption
 * @param {string} [color] - Value colour
 * @param {string} [title] - Tooltip
 * @returns {string} HTML
 */
function line(label, value, color = '#e8ecf5', title = '') {
    const tip = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
    const text = String(value ?? '');
    // A label that cannot fit its column stacks too. "Next tier work (T3)" has
    // no share of a narrow row worth having, and the alternative is what the
    // screenshots showed: a word broken across lines with an orphan letter
    // under it — "Expecte / d".
    const isSentence = text.length > VALUE_MAX_CHARS || String(label ?? '').length > LABEL_MAX_CHARS;

    if (isSentence) {
        return (
            `<div style="margin:2px 0;"${tip}>` +
            `<div style="color:${DIM};">${label}</div>` +
            `<div style="color:${color}; font-weight:600; line-height:1.45;">${text}</div></div>`
        );
    }

    // Neither side ever breaks mid-word — a figure split from its unit is
    // unreadable, and a label wrapped mid-phrase floats a word between rows:
    // "Party DPS | 737 dmg/s" rendered as "Party  737 dmg/s" over an orphaned
    // "DPS", which was reported. So the label holds one line too, and when the
    // row genuinely cannot fit both, the *whole value* wraps under the label
    // as its own right-aligned line — still a legible pair, never a shuffle.
    return (
        `<div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:baseline; ` +
        `gap:2px 8px;"${tip}>` +
        `<span style="color:${DIM}; flex:1 1 auto; overflow-wrap:normal; ` +
        `word-break:normal; hyphens:none; white-space:nowrap;">${label}</span>` +
        `<span style="color:${color}; font-weight:600; text-align:right; white-space:nowrap; ` +
        `flex:0 0 auto; margin-left:auto;">${text}</span></div>`
    );
}

/**
 * A token payout, with what those tokens are approximately worth beside it.
 *
 * Tokens are the whole point of a trial week and a payout of forty thousand of
 * them means nothing without a scale. They have no market price, but the guild
 * shop trades them for credits and credits do have a gold value, so a derived
 * figure exists — and is labelled as derived, because it is a chain of two
 * conversions rather than a price. With no exchange rate and no credit price to
 * be had the caption is left exactly as it was: a bare token count.
 *
 * @param {number} tokens - Tokens paid
 * @param {string} baseTitle - The tooltip the row already had
 * @returns {{value: string, title: string}} Row value and tooltip
 */
export function tokenPayoutLine(tokens, baseTitle) {
    // Exact, on both halves. This block's arithmetic reproduces the guild's own
    // announcement to the token — "1,320 tokens each" — and printing it as
    // "1.3K" throws away the only thing that makes it worth checking.
    const gold = describeGuildTokenGold(tokens, 'ask', { exact: true });
    const count = exact(tokens);
    return {
        value: gold ? `${count} (${gold.text})` : count,
        title: gold ? `${baseTitle} ${gold.title}` : baseTitle,
    };
}

/**
 * Where the tier figure came from, as a caption sentence.
 *
 * The tier drives everything on the block — the pace, the ladder, the banked
 * count — and three of its four sources are inference rather than something the
 * game wrote on this card. A caption that implies the panel stated it is
 * claiming more than is known, so each rung says what it is.
 *
 * @param {Object} analysis - From {@link analyseTrial}
 * @returns {string} A sentence to append to a tooltip, or an empty string
 */
function tierProvenance(analysis) {
    if (analysis.tierSource === 'work-ladder') {
        if (analysis.kind === 'combat') {
            return (
                ' The tier is derived from the boss’s full health: the health bar’s maximum ' +
                'uniquely identifies the tier once the encounter’s base health is known, and ' +
                'this encounter’s has been learned from an earlier reading.'
            );
        }
        return (
            ' The tier is derived from the tier’s work total: the bar’s target uniquely ' +
            'identifies the tier once the skill’s base work is known, and this skill’s has ' +
            'been learned from an earlier reading.'
        );
    }
    if (analysis.tierSource === 'socket') {
        return ' The tier was stated outright by the game’s own trial update on the socket.';
    }
    if (analysis.tierSource === 'first-tier-rule') {
        return ' The tier is assumed: every trial starts at tier 1, and nothing has said otherwise.';
    }
    return '';
}

/**
 * What the trial has banked, as one row.
 *
 * Pulled out because all three phases want it and nothing else about them is
 * the same: it is the one figure that means what it says whether the trial has
 * not started, is running, or is over.
 *
 * @param {Object} analysis - From {@link analyseTrial}
 * @returns {string} HTML
 */
function bankedRow(analysis) {
    // A trial that ended on nothing is an outcome, not a reading that has not
    // arrived — and it is answered before "tier not seen yet", because a card
    // that wiped on tier one carries no badge either. Reported from exactly
    // that: the Hedgehog party fell before clearing the first tier, so its card
    // read Completed with no points and no badge, and this said "nothing yet —
    // tier 1 in progress" underneath it
    if (analysis.completed && !analysis.tiersClearedSoFar) {
        return line(
            'Banked',
            '0 tiers — fell before tier 1',
            DIM,
            'This trial is over and its card states no points, so nothing was banked: the party did not ' +
                'finish the first tier. Zero here is a result rather than a figure still to arrive.'
        );
    }

    if (!analysis.tierKnown) {
        return line(
            'Banked',
            'tier not seen yet',
            DIM,
            'Tiers cleared are read off the tier on screen, and the In Progress card carries no tier. ' +
                'Open the Trials tab beside it once — the tier is on the card there, and everything banked ' +
                'follows from it. Nothing is lost meanwhile; this is what is not yet known, not zero.'
        );
    }

    if (analysis.tiersClearedSoFar === 0) {
        return line(
            'Banked',
            `nothing yet — tier ${analysis.tier} in progress`,
            DIM,
            'A trial starts at tier 1, so nothing is banked until the first tier completes.' + tierProvenance(analysis)
        );
    }

    return line(
        'Banked',
        `${analysis.tiersClearedSoFar} tier${analysis.tiersClearedSoFar === 1 ? '' : 's'}` +
            (analysis.completed ? ' · finished' : ''),
        DIM,
        analysis.completed
            ? 'This trial is over, so the tier on the card is the tier it reached — and the points it ' +
                  'states are the ladder’s total for exactly that many tiers, which is what makes this ' +
                  'figure exact rather than inferred.'
            : analysis.tierSource === 'card'
              ? 'The tier on the card counts what this trial has *finished* — it read T1 after the first ' +
                'tier cleared and T2 after the second, while the pool on screen was the next one along. ' +
                'So the tier being fought is one past the badge.'
              : 'A trial climbs one tier at a time from the first, so everything below the tier in ' +
                'progress is banked.' +
                tierProvenance(analysis)
    );
}

/**
 * The block drawn under one trial tile.
 * @param {Object} analysis - From {@link analyseTrial}
 * @param {number} participants - Signed-up participants
 * @param {Object} [breakdown] - Per-player damage, from `guildTrialDamage.breakdown()`
 * ## One row set per phase
 *
 * The three states of a trial are not one layout with rows switched off. A card
 * whose trial has not started has one thing to say; a card whose trial is over
 * has results and no process; only a running trial wants the projections. Drawn
 * as a single set with per-row guards, the screen filled with variations of
 * nothing — a scheduled card stacked "scheduled — nothing running yet" over
 * "tier not seen yet" over "no trial fight seen here", and a finished one
 * offered to fit a growth curve for a next tier that will never be fought.
 *
 * So the phase picks the row set, and the participation rule composes with it:
 * a trial this character did not join, once it is over, shows the facts the
 * Trials tab states about it and no rows about data that can no longer arrive.
 *
 * @param {Object} [options] - Context
 * @param {boolean|null} [options.participating] - Whether this character is in this trial
 * @param {string|null} [options.phase] - `scheduled`, `live` or `completed`
 * @param {number|null} [options.startsInMs] - Countdown to the scheduled start
 * @param {Object|null} [options.forecast] - From `guild-trial-forecast.js`
 * @returns {string} HTML
 */
export function renderTrialBlock(
    analysis,
    participants,
    breakdown = guildTrialDamage.breakdown(),
    { participating = null, phase = null, startsInMs = null, forecast = null } = {}
) {
    const unit = analysis.kind === 'combat' ? 'dmg' : 'work';
    const rows = [];

    // Nothing has started. One line, and the countdown the header already
    // states, because everything else on this card would be about the absence
    // of data rather than about the trial
    if (phase === 'scheduled') {
        const when = Number.isFinite(startsInMs) && startsInMs > 0 ? ` — starts in ${formatEta(startsInMs)}` : '';
        return line(
            'Trial',
            `scheduled${when}`,
            DIM,
            'The guild panel says this cycle has not started. Nothing is measured until it does, and ' +
                'anything this script already holds belongs to the previous cycle.'
        );
    }

    // Over. Results only: what it reached, what that is worth, and the rate it
    // ran at if one was ever measured. No next tier, no pace, no waiting.
    if (phase === 'completed') {
        if (Number.isFinite(analysis.rate)) {
            rows.push(
                line(
                    analysis.kind === 'combat' ? 'Final party DPS' : 'Final fill rate',
                    `${num(analysis.rate * 1000)}\u00a0${unit}/s`,
                    DIM,
                    'The last rate measured while this trial ran. It is not a live figure.'
                )
            );
        }
        rows.push(bankedRow(analysis));
        return rows.join('');
    }

    // A trial this character did not join sends nothing: the In Progress tab
    // carries only their own trials, so no reading for this card will ever
    // arrive. Saying "measuring…" there promises a number that cannot come.
    const notMine = participating === false && !Number.isFinite(analysis.rate);

    if (notMine) {
        rows.push(
            line(
                'Rate',
                'no data — only trials you join can be measured',
                DIM,
                'Every figure here is read off the guild panel, and the In Progress tab only ever shows the ' +
                    'trials this character signed up for. Nothing arrives for the others — not from the ' +
                    'socket, not from the screen — so this is a limit rather than a measurement in progress.\n' +
                    'What the Trials tab states about this card — its tier, its points, its sign-ups — is ' +
                    'still read and still shown below.'
            )
        );
    } else if (!Number.isFinite(analysis.rate)) {
        rows.push(line('Rate', analysis.samples < 2 ? 'measuring…' : 'no movement yet', DIM));
    } else {
        const perSecond = analysis.rate * 1000;
        const measuredFrom =
            analysis.kind === 'combat'
                ? 'Measured from the boss bar on this card — the health one; the second bar is its mana.'
                : 'Measured from the bar on this card, over its current tier only.';
        rows.push(
            line(
                analysis.kind === 'combat' ? 'Party DPS' : 'Fill rate',
                `${num(perSecond)}\u00a0${unit}/s`,
                ACCENT,
                analysis.rateNote ? `${measuredFrom}\n${analysis.rateNote}` : measuredFrom
            )
        );

        // Two independent measurements of the same thing: this one off the card's
        // bar, and `guild-trial-damage.js`' off the battle feed. They should
        // agree, and where they do not one of them is measuring the wrong fight
        // — worth saying rather than showing two numbers that quietly differ.
        const attributed = breakdown?.measured ? breakdown.partyDps : null;
        if (Number.isFinite(attributed) && attributed > 0 && perSecond > 0) {
            const ratio = perSecond / attributed;
            if (ratio > 1.4 || ratio < 1 / 1.4) {
                rows.push(
                    line(
                        'Split disagrees',
                        `${num(attributed)}\u00a0${unit}/s`,
                        WARN,
                        'The per-player split adds up to a different party DPS than the boss bar shows. ' +
                            'The bar covers everybody in the trial; the split covers only the fights this ' +
                            'client took part in, so a difference is expected when the party is larger than ' +
                            'this fight — and unexpected otherwise.'
                    )
                );
            }
        }
        rows.push(
            line(
                analysis.kind === 'combat' ? 'Kill in' : 'Tier clears in',
                analysis.etaMs === null ? '—' : formatEta(analysis.etaMs),
                GOOD,
                `${formatWithSeparator(Math.round(analysis.remaining || 0))} of ${formatWithSeparator(
                    Math.round(analysis.total || 0)
                )} left.`
            )
        );
    }

    if (!analysis.pace && !notMine) {
        // Silently omitting the row was indistinguishable from the feature not
        // having this idea at all — and the no-clock case was the only one that
        // said so. A pace needs four things and going quiet about the other
        // three read as the same broken row.
        const missing =
            analysis.timeLeftMs === null
                ? {
                      text: 'no clock visible',
                      why:
                          'A pace needs the time left in the trial, and no countdown was found on this tab. ' +
                          'The game draws one while a trial is in progress — open the trial tab while it is running.',
                  }
                : !analysis.tierKnown
                  ? {
                        text: 'tier not known yet',
                        why:
                            'A pace walks up the tier ladder, and the In Progress card does not say which tier ' +
                            'this is. Open the Trials tab beside it once; the tier is on the card there.',
                    }
                  : !Number.isFinite(analysis.rate)
                    ? {
                          text: analysis.samples < 2 ? 'measuring…' : 'no movement yet',
                          why:
                              'A pace needs a measured rate, and a rate needs two readings taken while the tab ' +
                              'is open. Nothing arrives while it is shut.',
                      }
                    : { text: '—', why: 'Not enough of the tier is known to project one.' };

        rows.push(line('On pace for', missing.text, DIM, missing.why));
    }

    // One prediction, unless there are genuinely two things to say.
    //
    // "On pace for 4 tiers → T4" beside "Expected ~T3" is two bare numbers
    // disagreeing, and a reader cannot tell which to believe. They are the same
    // walk up the same derived ladder; the only thing that separates them is
    // whether the player's own success rate falling with each tier has been
    // measured yet. So: no measured slowdown, one row. A measured slowdown, two
    // rows that each say what they assume — and the second being lower is then
    // the point rather than a contradiction.
    const slowdown = Number.isFinite(forecast?.decline?.perTier) ? forecast.decline : null;
    // The count and the target are the same fact stated twice, so they are
    // derived from one number. They used to be computed separately — the count
    // from the tiers banked plus those the walk completed, the target from the
    // walk's last clear *or, when it completed none, the tier being fought* —
    // and at a tier boundary that reads "on pace for 4 tiers → T5", which is
    // two different claims in one sentence. A tier the walk enters and cannot
    // finish is not a tier, and must not move the target.
    const paceCaption = () => {
        const projected = analysis.pace.tiersCleared;
        const level = levelFromTier(projected);
        const tiers = `${projected} tier${projected === 1 ? '' : 's'}`;
        const target = projected ? ` → T${projected}${level ? ` (Lv.${level})` : ''}` : '';

        // A walk cut short by an unknown ladder is a floor, never a verdict: it
        // used to render "3 tiers → T3" for a walk that had merely run out of
        // ladder to climb, and the trial then cleared far past T3
        if (analysis.pace.limitedBy === 'unknown-next-tier') return `at least ${tiers}${target}`;
        // Nothing finished is nothing to point at
        if (!projected) return tiers;
        return `${tiers}${target}`;
    };

    if (analysis.pace && (!forecast || forecast.tier === null || slowdown)) {
        rows.push(
            line(
                slowdown ? 'On pace (flat)' : 'On pace for',
                paceCaption(),
                analysis.pace.limitedBy === 'ladder' ? GOOD : WARN,
                'The rate measured now, held flat for the rest of the hour. A tier only counts when it fits ' +
                    'whole.' +
                    (analysis.pace.limitedBy === 'unknown-next-tier'
                        ? '\nThe ladder past that tier is not known yet, so the walk stopped there — “at ' +
                          'least”, because the real pace may be higher.'
                        : '') +
                    (slowdown ? '\nThis one ignores the slowdown below, which is why it is the higher of the two.' : '')
            )
        );
    }

    if (forecast && forecast.tier !== null) {
        // Enrage is escalation, not an ending: the boss gains a stack a minute
        // to ten, each +10% accuracy and +10% damage, and then stops. A tier
        // that takes that long is dangerous rather than impossible, and what the
        // projection cannot model is the deaths it may cost.
        const margin = Number.isFinite(forecast.enragedFrom) ? ' · fully enraged' : '';
        const cleared = forecast.tiersCleared;
        rows.push(
            line(
                slowdown ? 'Expected (slowing)' : 'On pace for',
                slowdown
                    ? `~T${cleared}${margin}`
                    : `${cleared} tier${cleared === 1 ? '' : 's'}${cleared ? ` → T${cleared}` : ''}${margin}`,
                forecast.source === 'measured' ? GOOD : WARN,
                forecast.source === 'measured'
                    ? 'Walked from the work or health each tier actually needs — derived from the game\u2019s own ' +
                          'data and rules, not fitted — at the rate this party is measured to be producing.' +
                          (slowdown
                              ? `\nAssumes your success rate keeps falling about ${Math.abs(
                                    slowdown.perTier * 100
                                ).toFixed(1)} points a tier to its 5% floor, as measured across ` +
                                `${slowdown.observations} tiers. Past that point a tier is slow rather than ` +
                                'impossible.'
                              : '') +
                          (Number.isFinite(forecast.enragedFrom)
                              ? `\nA fight this long reaches full enrage from T${forecast.enragedFrom}: the boss ` +
                                'gains a stack a minute to ten, ending at +100% damage and +100% accuracy. Still ' +
                                'killable — but expect deaths to slow this beyond the projection.'
                              : '')
                    : 'Estimated from the loadouts captured so far' +
                          (forecast.coverage
                              ? ` (${forecast.coverage.known} of ${forecast.coverage.of} members)`
                              : '') +
                          ' — a rough shape rather than a measurement, until the party\u2019s own damage has been seen.'
            )
        );
    } else if (forecast?.reason) {
        rows.push(line('Expected', 'not projectable', DIM, `${forecast.reason}.`));
    }

    if (analysis.next) {
        const label = analysis.kind === 'combat' ? 'Next tier HP' : 'Next tier work';
        rows.push(
            line(
                `${label} (T${analysis.next.tier})`,
                num(analysis.next.total),
                DIM,
                (analysis.next.growthPerTier
                    ? `Fitted from the tiers seen this week (×${analysis.next.growthPerTier.toFixed(2)} per tier). `
                    : analysis.kind === 'combat'
                      ? 'Derived: boss health scales with the tier’s level, a rule the recorded tiers ' +
                        'reproduce exactly, anchored on the total this trial has actually shown. '
                      : 'Derived: each tier adds a tenth of the first tier’s work, which is what the pools ' +
                        'observed on a live trial do exactly, anchored on the total this trial has shown. ') +
                    `${participants} participant${participants === 1 ? '' : 's'} already add ` +
                    `+${Math.round(analysis.next.participantPenalty * 100)}% to it.`
            )
        );
    } else if (Number.isFinite(analysis.tier) && analysis.tier < TRIAL_MAX_TIER) {
        rows.push(line('Next tier', 'needs one tier’s total to anchor the ladder', DIM));
    }

    rows.push(bankedRow(analysis));

    if (analysis.kind === 'combat') rows.push(...renderTrialPlayers(breakdown));

    return rows.join('');
}

/**
 * Who in the party is producing the DPS the card is already showing.
 *
 * Drawn only under a combat card, and fed by the spectator stream: opening the
 * In Progress fight view subscribes this client to the trial's own battle ticks
 * (`guild-trial-damage.js`). So the empty state is an instruction rather than an
 * apology — "open the fight view", not "no trial fight seen here", which reads as
 * a fight that could have been seen and was not and was twice reported as a bug.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @returns {string[]} Rows of HTML, empty when there is nothing worth a row
 */
export function renderTrialPlayers(breakdown) {
    if (!breakdown) return [];

    if (!breakdown.measured) {
        // Four different nothings, and a player can act on three of them
        const watched = breakdown.source === 'spectated';
        // A fight is streaming and nothing has said which trial it is, so no
        // card may claim it. One click on the boss settles that
        const unidentified = watched && !breakdown.pool?.encounter;

        let value = 'open the fight view';
        if (breakdown.stale) value = 'last trial, not this one';
        else if (unidentified) value = 'click the boss to identify';
        else if (watched) value = 'watched, nothing attributed yet';

        let why =
            `${breakdown.reason}.\nOpen the In Progress fight view and this fills from the trial's own ` +
            'battle ticks. Until then the scoreboard estimates the split from the members\u2019 captured ' +
            'builds, and says so.';
        if (unidentified) {
            why =
                'A trial fight is being watched, but nothing has said which trial it is — the fight ' +
                'view\u2019s boss tile could not be read. Click the boss once and its figures attach to the ' +
                'right card. Until then they attach to none, rather than to every combat card that has no ' +
                'bar of its own.';
        } else if (watched) {
            why =
                'The fight is streaming but no damage tick has been attributed yet — the per-player split ' +
                'fills in as hits land on the boss. Damage taken, healing and mana come through the same ' +
                'ticks and are on the scoreboard.';
        }

        // A line rather than silence: an empty space under a combat card is
        // indistinguishable from the split having failed
        return [line('Per player', value, DIM, why)];
    }

    const rows = [
        `<div style="margin-top:4px; color:${ACCENT}; font-weight:600;">` +
            `Per player · ${breakdown.fights} fight${breakdown.fights === 1 ? '' : 's'}` +
            `${breakdown.source === 'spectated' ? ' · watched' : ''}</div>`,
    ];

    for (const player of breakdown.players) {
        const share = Number.isFinite(player.share) ? `${player.share.toFixed(0)}%` : '—';
        const dps = player.dps === null ? 'measuring…' : `${num(player.dps)} dmg/s`;
        const deaths = player.deaths > 0 ? ` · ${player.deaths}✝` : '';

        rows.push(
            playerRow(
                player.name,
                `${dps} · ${share}${deaths}`,
                player.deaths > 0 ? WARN : GOOD,
                `${formatWithSeparator(Math.round(player.damage))} damage across ` +
                    `${formatWithSeparator(player.hits)} hits.\n` +
                    `Hit rate ${player.accuracy === null ? '—' : `${(player.accuracy * 100).toFixed(1)}%`}, ` +
                    `crit rate ${player.critRate === null ? '—' : `${(player.critRate * 100).toFixed(1)}%`}, ` +
                    `${player.deaths} death${player.deaths === 1 ? '' : 's'}.`
            )
        );
    }

    return rows;
}

/**
 * One player's row: name left, figures right, always one line.
 *
 * Not {@link line}, on purpose. That helper stacks a long *label* into a
 * full-width caption, which is right for "Next tier work (T3)" and wrong for a
 * roster: "MillenniumTest" is fourteen characters, so its figures dropped onto
 * a second line while "Orven" beside it kept one, and the list read as a
 * ragged mix of one- and two-line entries. And the column can be genuinely
 * tiny — the fight-view injection lands in a 108px grid cell — so the row is a
 * size down from the block and the name ellipsizes as tightly as it must. A
 * cut name is acceptable here and nowhere else: the tooltip opens with the
 * full name, and the figures are what the row is for.
 *
 * @param {string} name - The player
 * @param {string} value - Their figures
 * @param {string} color - Value colour
 * @param {string} title - Tooltip; the full name is prepended, for when the row cuts it
 * @returns {string} HTML
 */
function playerRow(name, value, color, title) {
    const full = `${name} — ${title}`;
    return (
        `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:4px; ` +
        `font-size:10px;" title="${full.replace(/"/g, '&quot;')}">` +
        `<span style="color:${DIM}; flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; ` +
        `white-space:nowrap;">${name}</span>` +
        `<span style="color:${color}; font-weight:600; text-align:right; white-space:nowrap; ` +
        `flex:0 0 auto;">${value}</span></div>`
    );
}

/**
 * The one card a kind-wide footer can belong to, or nothing.
 *
 * The In Progress tab draws the player's own action stats once, in a footer,
 * with no statement of which card they are about. A bar answers it when there is
 * one; failing that the header's kind narrows it, and only a *single* match may
 * be taken — two skilling cards and a skilling header is an ambiguity, and
 * putting one trial's success rate on another's row is worse than losing it.
 *
 * @param {Array<Object>} tiles - Cards from `readTrialTiles`
 * @param {string|null} kind - From `readTrialStatus`
 * @returns {Object|null} The card, or null when it cannot be said
 */
export function soleTileOfKind(tiles, kind) {
    if (!kind) return tiles?.length === 1 ? tiles[0] : null;

    const matching = (tiles || []).filter((tile) => tile.kind === kind);
    return matching.length === 1 ? matching[0] : null;
}

/**
 * Do something to the page without losing the reader's place.
 *
 * Inserting an element into a scrolling container makes the browser re-lay the
 * content out, and a container whose content changes height while the user is
 * partway down it is routinely scrolled back to the top. The trials panel
 * redraws every five seconds and on every observer burst, so "routinely" here
 * means "every few seconds, forever", which is what was reported.
 *
 * Every scrollable ancestor is recorded rather than only the nearest, because
 * the game nests scrolling boxes and it is not always the same one that moves.
 *
 * @param {Element} node - Where the change is happening
 * @param {Function} change - The mutation
 * @returns {*} Whatever `change` returned
 */
export function withScrollKept(node, change) {
    const kept = [];
    for (let el = node; el; el = el.parentElement) {
        if (typeof el.scrollTop === 'number' && el.scrollTop > 0) kept.push([el, el.scrollTop]);
    }
    const documentTop =
        typeof document !== 'undefined'
            ? document.scrollingElement?.scrollTop || document.documentElement?.scrollTop
            : 0;

    try {
        return change();
    } finally {
        for (const [el, top] of kept) {
            if (el.scrollTop !== top) el.scrollTop = top;
        }
        if (documentTop && document.scrollingElement && document.scrollingElement.scrollTop !== documentTop) {
            document.scrollingElement.scrollTop = documentTop;
        }
    }
}

/**
 * Put a card's block somewhere it takes a row of its own.
 *
 * Third attempt, and the first two are why this is a function rather than a
 * style string. Appended *into* the card, it sat under the card's own footer,
 * because a card places its last rows against its bottom edge rather than after
 * whatever it contains. Inserted after the card with `grid-column: 1 / -1`, it
 * stayed one cell wide — 126px against a 525px section — and pushed into the
 * next section's heading. The devtools screenshots say why: the cards are grid
 * items, the section labels ("Combat Trial") are *flex* items of an outer box,
 * and `-1` resolves against the **explicit** grid, so on a container whose
 * columns are implicit `1 / -1` is a single cell.
 *
 * So the container is measured rather than assumed:
 *
 * - **A grid with a real column template.** Span every track it declares —
 *   `1 / span N` rather than `1 / -1`, because that works on implicit tracks too.
 * - **A grid with no template.** There is no row to span; the block goes after
 *   the whole grid, where it is a sibling of the next section label instead of
 *   a cell squeezed between cards.
 * - **A flex container.** `flex-basis: 100%` on a wrapping row is a line of its
 *   own; on a non-wrapping one it would squash the cards, so that goes after the
 *   container too.
 * - **Anything else** is ordinary flow, where a block-level div is already a row.
 *
 * When the block ends up away from its card it is given the trial's name, since
 * "Banked 3 tiers" under a stack of cards has to say which one.
 *
 * @param {Element} root - The trials root; nothing is placed outside it
 * @param {Element} card - The card being described
 * @param {Element} block - The block to place
 * @param {string} [name] - The trial's name, for when the block lands away from its card
 * @returns {string} How it was placed: `spanned`, `after-card`, `after-container`, or `refused`
 */
export function placeTrialBlock(root, card, block, name = '') {
    // Belt and braces over the anchor filter in `readTrialTiles`. The reported
    // failure drew this whole block inside the boss's stat popup, which is
    // headed with a trial name over a level and so reads as a card to every
    // filter that looks at the card. Placement is the last point at which "this
    // is not the guild panel" can still be said
    if (inFloatingDialog(card)) return 'refused';

    const container = card?.parentElement;
    if (!container || !root?.contains?.(container)) {
        card?.appendChild?.(block);
        return 'after-card';
    }

    const style = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
    const display = style?.display || '';

    const afterContainer = () => {
        const outer = container.parentElement;
        if (!outer || !root.contains(outer)) {
            card.insertAdjacentElement('afterend', block);
            return 'after-card';
        }
        block.style.width = '100%';
        block.style.flexBasis = '100%';
        if (name) block.insertAdjacentHTML('afterbegin', trialBlockHeading(name));
        container.insertAdjacentElement('afterend', block);
        return 'after-container';
    };

    if (display.includes('grid')) {
        const tracks = style?.gridTemplateColumns || '';
        const columns = tracks && tracks !== 'none' ? tracks.trim().split(/\s+/).length : 0;
        if (columns > 1) {
            // `span N` rather than `1 / -1`: the latter counts explicit tracks
            // only, and collapses to one cell when the game declares none
            block.style.gridColumn = `1 / span ${columns}`;
            block.style.width = '100%';
            card.insertAdjacentElement('afterend', block);
            return 'spanned';
        }
        return afterContainer();
    }

    if (display.includes('flex')) {
        const wraps = (style?.flexWrap || '').includes('wrap');
        if (!wraps) return afterContainer();
        block.style.flexBasis = '100%';
        block.style.width = '100%';
        card.insertAdjacentElement('afterend', block);
        return 'after-card';
    }

    block.style.width = '100%';
    card.insertAdjacentElement('afterend', block);
    return 'after-card';
}

/**
 * A heading naming the trial a detached block belongs to.
 * @param {string} name - Trial name
 * @returns {string} HTML
 */
function trialBlockHeading(name) {
    return `<div style="color:${ACCENT}; font-weight:600; margin-bottom:2px;">${name}</div>`;
}

class GuildTrials {
    constructor() {
        this.initialized = false;
        this.unregister = [];
        this.timers = createTimerRegistry();
        this.record = null;
        /** The name the record is currently keyed by; null means the `default` key */
        this.guildName = null;
        /** Guards the one-shot adoption below against a second render starting it again */
        this.adopting = false;
        /** When the sampler last ran, so a sampler that has stopped can be noticed */
        this.lastTickAt = 0;
        /** The sampler's interval id, kept so it can be re-armed */
        this.samplerId = null;
        /** Guild name seen on the socket, when the XP tracker is not the one who saw it */
        this.socketGuildName = null;
        /** The character whose record is in hand; a switch invalidates everything below it */
        this.characterId = null;
        /** True between a character switch and the arriving character's data landing */
        this.awaitingCharacter = false;
        /** Block key → the markup last drawn into it, so an unchanged pass touches nothing */
        this.blockHtml = new Map();
        /** Where the cycle was last seen to be: scheduled, live or completed */
        this.phase = null;
        /** The last combat forecast, for the per-player panel to echo */
        this.lastForecast = null;
        /**
         * Learned first-tier work per skill, `{crafting: {baseWork, …}}`.
         * Game-wide rather than per guild — the base is the ladder's, confirmed
         * across guilds — so a character switch does not drop it.
         */
        this.workBases = {};
        /** The spectated pool this render is working from, and its encounter */
        this.watchedPool = null;
        /** How strong a claim the card that owns the guild-report context has */
        this.contextRank = 0;
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('guildTrialsInfo', true)) return;

        // Whatever a previous life left behind is not this one's. The merge
        // below is for readings taken by a tick that beat the load, not for a
        // record from before a cleanup
        this.record = null;

        // Listeners and the sampler first, before anything is awaited.
        //
        // This ordering is the fix for a recording that produced two samples in
        // forty minutes of a live trial with the tab open. Everything below the
        // first `await` — which is to say the sampler — only exists if every
        // promise above it settles, and a rejected or slow one takes the
        // five-second reading with it while leaving the DOM observer (registered
        // first, at the time) drawing blocks. The panel therefore *looked* like
        // it was working: it drew, on whatever DOM churn or guild message
        // happened to arrive, and sampled at that cadence rather than its own.
        //
        // Nothing here needs the record, because `_render` tolerates not having
        // one yet: a tick before the load lands writes into a fresh record and
        // the load merges into it rather than replacing it.
        this._armSampler();

        // A character switch invalidates every cached answer this feature holds.
        // Registered here, above the awaits, for the same reason the sampler is:
        // a reset that only exists once storage has answered is a reset that can
        // be skipped entirely.
        this._onCharacterSwitch = (event) => this._forgetCharacter(event?.newId ?? null);
        dataManager.on?.('character_switching', this._onCharacterSwitch);
        this.unregister.push(() => dataManager.off?.('character_switching', this._onCharacterSwitch));

        // Any guild panel node at all, rather than a list of guesses at what the
        // two trial tabs are called. The In Progress tab's card carries neither
        // a tile summary nor a level, so there is no narrower class this could
        // wait for without being wrong about one of the two tabs again — and
        // `findTrialsRoot` costs two `querySelector`s to answer "not this tab".
        // Debounced, so React's render burst is one call rather than hundreds —
        // which is also why it cannot be the sampler: a bar that ticks every
        // second re-arms the debounce timer forever and the callback starves.
        this.unregister.push(
            domObserver.onClass('GuildTrials', 'GuildPanel_', () => this._onTab(findTrialsRoot()), {
                debounce: true,
                debounceDelay: 100,
            })
        );

        this._refresh = (data) => {
            this._noteGuildName(data);
            this._render(findTrialsRoot());
        };
        for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
            webSocketHook.on(type, this._refresh);
        }
        this.unregister.push(() => {
            for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
                webSocketHook.off(type, this._refresh);
            }
        });

        // Both listen to the socket rather than to the panel, so they are
        // started here rather than on the tab appearing: a trial fight and a
        // unit popup both happen while the guild page is shut. `_publishTrialNames`
        // arms the damage gate from last session's record, so a fight is
        // recognised without the tab having been opened this session.
        guildTrialDamage.initialize();
        guildTrialSkilling.initialize();
        guildTrialAlerts.initialize?.();
        guildTrialRecorder.initialize(this.guildName);
        guildMemberSkills.initialize(this.guildName).catch(() => {});
        // One bucket for every character in the tab is what poisoned a guild's
        // record in the first place; nothing writes to it now, so it goes
        purgeLegacyTrialRecord().catch(() => {});

        this.initialized = true;

        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        this.guildName = this._resolveGuildName();
        guildTrialRecorder.setGuildName(this.guildName);
        const stored = await loadTrialRecord(this.guildName, Date.now(), this.characterId, {
            guildId: this._guildId(),
        });
        this.record = mergeTrialRecords(stored, this.record);
        this._publishTrialNames();

        // Merged under whatever a tick learned while the read was in flight, so
        // a base observed seconds after startup is not thrown away by the load
        this.workBases = { ...(await loadWorkBases()), ...this.workBases };

        await guildLoadoutCapture.initialize();
    }

    /**
     * Start the five-second sampler, replacing any that is already running.
     *
     * Separate from {@link initialize} so it can be re-armed: the reading only
     * exists because something took it, and an interval that has been cleared —
     * by a cleanup that raced a re-initialisation, by a browser that throttled a
     * background tab into never rescheduling it — is indistinguishable on screen
     * from a trial nobody is running.
     */
    _armSampler() {
        if (this.samplerId) clearInterval(this.samplerId);
        this.samplerId = setInterval(() => this._tick(), SAMPLE_MS);
        this.timers.registerInterval(this.samplerId);
    }

    /** One sampler tick: read the tab if it is open, and note that the sampler is alive */
    _tick() {
        this.lastTickAt = Date.now();
        const el = findTrialsRoot();
        if (el?.isConnected) this._render(el);
    }

    /**
     * The tab appeared or changed.
     * @param {Element|null} el - The trials content element
     */
    _onTab(el) {
        // A tab event is also proof of life for the sampler: if ticks have
        // stopped while the panel is plainly being drawn, the interval is gone
        // and the readings with it, so it is started again
        if (this.initialized && this.lastTickAt && Date.now() - this.lastTickAt > SAMPLE_MS * 3) {
            this._armSampler();
        }
        this._render(el);
    }

    /**
     * Drop everything belonging to the character that is leaving.
     *
     * The reported bug, and it was every cache at once. Switching characters in
     * one tab left the previous guild's finished trial on the new guild's Trials
     * tab — "Guild Points banked 2,880" beside a header reading 0, "Banked 5
     * tiers" on a card reading "0 pts" — and the warning line went so far as to
     * judge the *old* record's 840 pts against the *new* guild's Builder's Hall
     * level, which is two guilds' data in one sentence.
     *
     * Nothing here is recoverable by reloading one thing: the record, the guild
     * name and its socket-seen fallback, the encounters pushed into the damage
     * gate, and the recorder's open session all belong to the character that is
     * leaving. They are dropped together, and the record for the arriving
     * character is read back once the socket says who they are.
     */
    _forgetCharacter(newId = null) {
        try {
            this.record = null;
            this.guildName = null;
            this.socketGuildName = null;
            this.characterId = newId;
            this.adopting = false;
            // The switch message arrives *before* the arriving character's own
            // data does, so for a moment every source of a guild name still
            // holds the departing one's. Adopting then would file the new
            // character's readings under the guild they just left — the leak,
            // one layer down. Nothing is adopted until the ids agree again.
            this.awaitingCharacter = true;

            // Nothing on screen belongs to the arriving character either, and it
            // comes off first: a later step failing must not leave the previous
            // guild's figures on a page that has already changed hands
            document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
            this.blockHtml.clear();
            guildTrialScoreboard.close?.();

            // The gate's "this week's combat trials" is the old guild's answer
            guildTrialDamage.setTrialNames?.([]);
            guildTrialDamage.reset?.();
            guildTrialRecorder.forget?.();
            guildTrialRecorder.setGuildName?.(null);
            guildTrialAlerts.reset?.();
            guildMemberSkills.forget?.();
            this.phase = null;

            // Re-read for whoever arrives. Not awaited on this path — the
            // character's own id lands on the same message that triggered this
            this._adoptArrivingCharacter(newId).catch(() => {});
        } catch (error) {
            console.error('[GuildTrials] Clearing the outgoing character failed:', error);
        }
    }

    /**
     * Read the arriving character's own record, once there is one to read.
     * @returns {Promise<void>}
     */
    async _adoptArrivingCharacter(characterId) {
        // Strictly the character's own record: the guild is not knowable yet, so
        // the character-scoped key is the only one that cannot be the last
        // guild's. `_adoptGuildName` merges it onto the guild's key later, once
        // a name has arrived that belongs to *this* character.
        guildTrialRecorder.setGuildName(null);
        const stored = await loadTrialRecord(null, Date.now(), characterId, { guildId: this._guildId() });

        // Another switch may have happened while the read was in flight
        if (this.characterId !== characterId) return;

        this.record = stored;
        this._publishTrialNames();
    }

    /**
     * The guild's name, from whichever source has it.
     *
     * Three, in order of how directly they saw it. The XP tracker is the one
     * that is *supposed* to know, and it is also the one that can be switched
     * off in settings or can simply never have received a `guild_updated` — in
     * which case it answers null for the whole session and every reading is
     * filed under the `default` key, which is what was reported. The character's
     * own init payload carries `guild.name` and is present from login; the
     * socket's own `guild_updated` carries it too and is captured here rather
     * than being asked for.
     *
     * @returns {string|null} The name, or null when nothing has seen one
     */
    _resolveGuildName() {
        // Mid-switch every source still answers with the departing character's
        // guild. The ids agreeing again is what says the arriving character's
        // own data has landed
        if (this.awaitingCharacter) {
            const current = dataManager.getCurrentCharacterId?.() ?? null;
            if (current === null || current !== this.characterId) return null;
            this.awaitingCharacter = false;
        }

        return (
            guildXPTracker.getOwnGuildName?.() || this.socketGuildName || dataManager.characterData?.guild?.name || null
        );
    }

    /**
     * Note a guild name off a guild message.
     * @param {Object} [data] - A `guild_updated`-shaped payload
     */
    _noteGuildName(data) {
        const name = data?.guild?.name;
        if (typeof name === 'string' && name.trim()) this.socketGuildName = name.trim();
    }

    /**
     * Move the record onto the real guild's key, once the guild is known.
     *
     * The key is resolved lazily rather than at startup because at startup it is
     * not knowable: `guildXPTracker` learns the guild name from socket traffic
     * that has not arrived when features initialise, so every session began by
     * writing its samples to `guildTrials_default` and never revisiting the
     * question. Two guilds' worth of an alt's browsing went into the same bucket,
     * and the correctly-keyed record from the last session was never read.
     *
     * Absorbing rather than replacing: whatever is stored under the real name is
     * merged with what this session has already collected under `default`, so no
     * reading is stranded in either direction. The `default` entry is left where
     * it is — it costs nothing, and deleting the only other copy of a record on
     * the strength of a name that has just arrived is not a trade worth making.
     *
     * @returns {Promise<void>}
     */
    async _adoptGuildName() {
        const name = this._resolveGuildName();
        if (!name || name === this.guildName || this.adopting) return;

        this.adopting = true;
        try {
            const stored = await loadTrialRecord(name, Date.now(), this.characterId, { guildId: this._guildId() });
            this.record = mergeTrialRecords(stored, this.record);
            this.guildName = name;
            guildTrialRecorder.setGuildName(name);
            guildMemberSkills.setGuildName(name).catch(() => {});
            await saveTrialRecord(name, this.record, this.characterId, { guildId: this._guildId() });
        } catch (error) {
            console.error('[GuildTrials] Moving the record onto the guild key failed:', error);
        } finally {
            this.adopting = false;
        }
    }

    /**
     * Take a reading and redraw.
     * @param {Element|null} root - The trials content element
     */
    _render(root) {
        try {
            if (!root?.isConnected) return;
            if (!config.getSetting('guildTrialsInfo', true)) return;

            const now = Date.now();
            const weekStart = trialWeekStart(now);
            if (!this.record || this.record.weekStart !== weekStart) {
                // A week's roll-over is a different ladder; the record for it
                // starts empty and stamped with whose it is
                this.record = emptyRecord(weekStart, { guildId: this._guildId(), guildName: this.guildName });
            }

            // Every card on either tab, bar or no bar. A Trials card carries the
            // tier, the points and the sign-ups; the In Progress card carries the
            // reading; `recordTileSample` takes a sample only from the one that
            // has something moving on it, and both write the identity of the same
            // trial under the same key.
            // Positive gate, before anything is read or written. The guild page
            // is one panel with several tabs and the root finder answers for the
            // whole of it, so "a guild panel exists" is not "a trial is on
            // screen" — which is how the payout block came to be drawn over the
            // Overview tab's notice board.
            if (!onTrialTab(root)) {
                this._reapBlocks(null, new Set());
                return;
            }

            const tiles = readTrialTiles(root);

            // Where the cycle is decides what the record below even means. Read
            // before anything is folded in, because a stale record must not be
            // sampled into and then archived — the sample would go with it.
            const status = readTrialStatus(root);
            this._healStaleRecord(status, tiles, now);
            // Any card actually running counts, whichever kind the header names
            const anyLive = tiles.some(
                (tile) => this._phaseFor(status, tile, this.record?.tiles?.[tileKey(tile)]) === 'live'
            );
            // The game stating that a trial has ended outranks a card that has not
            // been redrawn yet. `end_guild_battle` and `end_guild_skilling` are
            // the only signals this feature has ever had that are *certain*;
            // everything else is a phase inferred from a header or a badge
            const declaredOver = this._declaredOver(tiles);
            guildTrialRecorder.noteLifecycle?.(declaredOver ? 'completed' : anyLive ? 'live' : status.phase, now);
            // The player's own action stats live in the tab's footer rather than
            // on a card, so they are read once and attached to whichever trial
            // is the live one — the only card that can have produced them
            const personal = readPersonalStats(root);
            const live = tiles.find((tile) => tile.readings.length > 0) || null;
            // Whose footer this is. A bar identifies the card outright, but the
            // card does not always have one — between tiers, and once the hour
            // ends, the In Progress card is a name and nothing else — and the
            // stats were then attached to no card at all, which is how a whole
            // trial's Success Rate readings never reached `personalByTier`
            const owner = live || soleTileOfKind(tiles, status.kind);
            // The spectator stream's own reading of the pool, when somebody has
            // the fight view open. Same number as the DOM bar, to the unit, but
            // per tick and with the tier stated rather than inferred
            const watched = this._spectatedPool(now);
            // Held for `_contextRank`, which decides which card the guild report
            // is about — and is asked once per card rather than once per render
            this.watchedPool = watched;
            this.contextRank = 0;
            // Needed inside the sampling loop as well as the drawing one: the
            // work-ladder tier filing wants a participant count
            const counts = participantCounts();
            for (const tile of tiles) {
                const withPersonal = this._withSocketSkilling(
                    this._withSpectatedPool(tile === owner ? { ...tile, personal } : tile, watched),
                    now
                );
                // A running trial whose cards state nothing is on its first
                // tier, so its readings belong to T1 rather than to no tier at
                // all — which is what the growth fit needs them filed under
                const held = this.record.tiles?.[tileKey(tile)];
                const badge = Number.isFinite(withPersonal.tier) ? withPersonal.tier : held?.tier;
                // Whether the badge has anything banked behind it: an earned
                // badge counts tiers finished, so the pool on screen is one
                // past it; an unearned badge names the tier in progress itself
                const banked =
                    withPersonal.points > 0 ||
                    held?.points > 0 ||
                    Object.values(held?.pointsByTier || {}).some((points) => Number(points) > 0);

                // Which tier a live reading belongs to. The badge counts tiers
                // *finished*, so the pool on screen is the next one along; with
                // no badge yet, a running trial is on its first tier.
                const tilePhase = this._phaseFor(status, withPersonal, held);
                let readingTier = null;
                if (tilePhase === 'live' && withPersonal.readings.length) {
                    // The stream states the tier outright; failing that, the
                    // bar's own target identifies it once the skill's base work
                    // is known — the target moves the moment a tier clears,
                    // where a badge goes stale until the Trials tab is reopened
                    const ladderTier = this._workLadderTier(withPersonal, held, counts);
                    if (Number.isFinite(withPersonal.socketTier)) readingTier = withPersonal.socketTier;
                    else if (Number.isFinite(withPersonal.spectatedTier)) readingTier = withPersonal.spectatedTier;
                    else if (ladderTier !== null) readingTier = ladderTier;
                    else if (Number.isFinite(badge)) readingTier = badge + (banked ? 1 : 0);
                    else if (this._workBase(withPersonal) === null && !banked && !(held?.tiers || []).length) {
                        // Nothing has ever placed this trial on the ladder —
                        // only then may the first-tier rule file the reading.
                        // With a base or an observation in hand and no match
                        // above, filing T1 would contradict the ladder.
                        readingTier = FIRST_TIER;
                    }
                }

                // Which tier the footer's stats describe, stated rather than
                // left to fall out of the reading's tier. They only ever landed
                // on a *live* card with a bar, so a whole skilling trial's worth
                // of Success Rate readings — the input the success-decline model
                // is built from — went into the flat `personal` and never into
                // `personalByTier`, which stayed empty across two exports.
                //
                // A footer read while a tier is filling belongs to that tier; one
                // read after it clears, or on a completed card, belongs to the
                // tier the card has just banked.
                const personalTier =
                    // The socket states the tier its own figures describe
                    (Number.isFinite(withPersonal.socketTier) ? withPersonal.socketTier : null) ??
                    readingTier ??
                    (Number.isFinite(badge) ? Math.max(FIRST_TIER, badge) : null) ??
                    held?.tier ??
                    null;

                const sampled = { ...withPersonal };
                if (readingTier !== null) sampled.readingTier = readingTier;
                if (Number.isFinite(personalTier)) sampled.personalTier = personalTier;

                this.record = recordTileSample(this.record, sampled, now);
            }
            if (tiles.length) {
                saveTrialRecord(this.guildName, this.record, this.characterId, { guildId: this._guildId() });
            }

            // A live reading on a real trial card is evidence a trial is running,
            // and the panel is only allowed to *veto* it. Requiring the header to
            // say "In Progress" as well meant auto-record never armed: the
            // header is on the Trials tab and the readings are on the In
            // Progress one, so the two conditions were rarely true at once.
            //
            // What made that requirement necessary in the first place — a guild
            // XP bar read as a trial card on the Overview tab — is closed twice
            // over now, by `isTrialName` matching a card's whole name and by
            // `onTrialTab` refusing a tab that is legibly something else.
            const livePhase = live ? this._phaseFor(status, live, this.record?.tiles?.[tileKey(live)]) : null;
            if (live && livePhase !== 'scheduled' && livePhase !== 'completed') {
                guildTrialRecorder.noteActivity('tab-reading', now);
            }
            // A fresh tick off the spectator stream is the strongest evidence a
            // trial is running that this feature has ever had — the fight itself
            // is on the wire — and it arrives on the tab where the game draws no
            // bar for the tab-reading rule to find
            if (watched) guildTrialRecorder.noteActivity('trial-stream', now);

            this._noteLifecycle(status, tiles, now);

            // Which encounters count as a trial fight this week. Pushed rather
            // than pulled so the damage module never imports this one
            this._publishTrialNames();

            // Asked again on every render rather than once at startup: the guild
            // name arrives on socket traffic, which is usually later than this
            // feature's initialisation. Not awaited — the drawing below does not
            // depend on which key the record is stored under, and a render that
            // waited on storage would drop a frame of the tab every time.
            this._adoptGuildName().catch(() => {});

            // Nothing is removed up front. A redraw that tears its own output
            // out of the page and puts it back re-lays the panel out, and the
            // browser answers by putting the scroll back at the top — every five
            // seconds, which is what the reported "keeps scrolling to the top"
            // is. Blocks are matched by key and updated in place instead, and
            // only a block whose trial has gone is removed. See `_placeBlock`.
            const drawn = new Set();
            if (!tiles.length) {
                // No cards, but the archive still has last cycles' figures to
                // show — a trial tab between weeks is exactly when they are asked for
                if (this._renderHistory(root, now)) drawn.add('history');
                this._reapBlocks(root, drawn);
                return;
            }

            const timeLeftMs = this._timeLeftMs(root);
            const bonuses = this._payoutBonuses();

            for (const tile of tiles) {
                const record = this.record.tiles[tileKey(tile)];
                if (!record) continue;

                // The card's own "1/28 signed up" beats the socket count where
                // it exists: it is the number the game is showing the player,
                // and it needs no name-to-hrid match to be believed
                const hrid = matchTrialHrid(tile.name, Object.keys(counts));
                const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
                const tilePhase = this._phaseFor(status, tile, record);
                const analysis = analyseTrial(record, {
                    participants,
                    timeLeftMs,
                    buildersHallBonus: bonuses.buildersHall.bonus,
                    phase: tilePhase,
                    workBase: this._workBase(tile),
                });
                this._learnWorkBase(tile, record, analysis, participants, now);

                const key = `tile:${tileKey(tile)}`;
                drawn.add(key);
                this._placeBlock(root, key, {
                    html: renderTrialBlock(analysis, participants, undefined, {
                        participating: ownParticipation(tile.name),
                        phase: tilePhase,
                        startsInMs: status?.startsInMs ?? null,
                        forecast: this._forecast(tile, analysis, participants),
                    }),
                    // Wide enough that a label and a figure fit on one line, and
                    // capped so it cannot stretch a whole panel — the reported
                    // screenshot was this block one card wide and a mile tall
                    style:
                        'position:static; display:block; box-sizing:border-box; clear:both;' +
                        'min-width:min(260px, 100%); max-width:520px;' +
                        'margin:6px 0 8px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                        'border-radius:6px; font-size:11px; line-height:1.6;',
                    place: (block) => placeTrialBlock(root, tile.element, block, tile.name),
                });
            }

            // The payout is the *week's*, not this tab's. Summed from the record,
            // which keeps every trial's stated points whichever tab was open when
            // they were read — the two tabs were otherwise drawing the same
            // "Trial payout" title over different totals, because each summed
            // only the cards it could see.
            const trialsForPayout = this._payoutTrials(status, counts, timeLeftMs, bonuses);

            if (this._renderPayout(root, trialsForPayout, tiles[0]?.element || null, bonuses)) {
                drawn.add('payout');
            }
            if (this._renderHistory(root, now, bonuses)) drawn.add('history');
            this._reapBlocks(root, drawn);
        } catch (error) {
            console.error('[GuildTrials] Drawing the trial panel failed:', error);
        }
    }

    /**
     * Every trial of the week, as the payout block wants them.
     *
     * From the record rather than from the cards on screen. The In Progress tab
     * shows one running pool and the Trials tab shows all the setup cards, so a
     * payout summed from what is visible said two different things under the
     * same title depending on which tab the reader was on — "banked 2,714" on
     * one and "banked 472" on the other, at the same moment. The record holds
     * every tile's stated points regardless of which tab was open when they were
     * read, which is exactly the sum wanted.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Object} counts - Sign-ups per trial hrid
     * @param {number|null} timeLeftMs - Active time left
     * @param {Object} bonuses - From {@link _payoutBonuses}
     * @returns {Array<Object>} One entry per trial the record knows
     */
    _payoutTrials(status, counts, timeLeftMs, bonuses) {
        const trials = [];

        for (const record of Object.values(this.record?.tiles || {})) {
            if (!record?.name) continue;

            const hrid = matchTrialHrid(record.name, Object.keys(counts));
            const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
            const analysis = analyseTrial(record, {
                participants,
                timeLeftMs,
                buildersHallBonus: bonuses.buildersHall.bonus,
                phase: this._phaseFor(status, record),
                workBase: this._workBase(record),
            });

            trials.push({
                name: record.name,
                type: record.kind,
                banked: analysis.tiersClearedSoFar,
                projected: analysis.pace?.tiersCleared ?? analysis.tiersClearedSoFar,
                tierKnown: analysis.tierKnown,
                points: analysis.points,
                pointsByTier: analysis.pointsByTier,
            });
        }

        return trials;
    }

    /**
     * Where the cycle is *for one kind of trial*.
     *
     * A cycle runs the skilling hour and then the combat one, and the header
     * says which it is talking about — "Skilling Trial - In Progress". Applying
     * that phase to every card meant the Trial Chameleon card rendered live rows
     * during the skilling hour: "Rate: measuring…", "Banked: nothing yet — tier
     * 1 in progress", for a trial that had not started.
     *
     * A card of the kind the header names takes the header's phase. A card of
     * the other kind is waiting, unless it has evidence of its own — its own bar
     * moving is worth more than a header about its sibling.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Object} tile - The card
     * @returns {string|null} The phase this card is in
     */
    _phaseFor(status, tile, record = null) {
        // The card's own "Completed" badge outranks everything. It is the game
        // stating the outcome of *this* trial, where the header is about
        // whichever one is running now — so after the skilling hour a finished
        // Foraging card kept rendering "Fill rate 52 work/s / Tier clears in
        // 3m" under a header reading "Combat Trial - In Progress". A finished
        // trial shows results, and neither a live set nor a waiting one.
        if (tile?.completed || record?.completed) return 'completed';

        const phase = status?.phase || null;
        // No status header at all is the everyday state of the In Progress tab
        // — the header lives on the Trials tab — and treating it as no phase
        // starved everything downstream that asks "is this live": the
        // first-tier rule never fired, and a live pool's readings were filed
        // under the record's stale badge instead of the tier being fought. A
        // bar on a card that nothing has declared over is a trial running.
        if (!phase) return tile?.readings?.length ? 'live' : null;
        // A header that does not name a kind is the old, single-trial case
        if (!status.kind || status.kind === tile.kind) return phase;

        // The other kind, not yet finished. Its own readings are the only thing
        // that can say it is running while the header is about its sibling
        if (tile.readings?.length) return 'live';
        return 'scheduled';
    }

    /**
     * What tier this trial should reach, with where the number came from.
     *
     * @param {Object} tile - The card
     * @param {Object} analysis - From `analyseTrial`
     * @param {number} participants - Members signed up
     * @returns {Object|null} The forecast
     */
    _forecast(tile, analysis, participants) {
        try {
            const breakdown = guildTrialDamage.breakdown?.();
            // The card's own bar first: it covers everybody in the trial, where
            // the attributed figure covers only the fights this client was in
            const measuredDps =
                analysis.kind === 'combat' && Number.isFinite(analysis.rate)
                    ? analysis.rate * 1000
                    : (breakdown?.measured && breakdown.partyDps) || null;

            const forecast = forecastTrial({
                analysis,
                clientData: dataManager.getInitClientData?.() || null,
                name: tile.name,
                participants,
                loadouts: guildLoadoutCapture.seen?.() || [],
                measuredDps,
            });
            // Pushed to the per-player panel, which draws the same conclusion
            // beside the split rather than working it out a second time
            const rank = analysis.kind === 'combat' ? this._contextRank(tile, analysis) : 0;
            if (rank > 0 && rank >= this.contextRank) {
                this.contextRank = rank;
                this.lastForecast = forecast;
                guildTrialScoreboard.noteForecast?.(forecast);
                // What the guild-shareable report needs and cannot work out for
                // itself: which trial this is, what it banked, and how far into
                // the tier it was fighting the hour left it
                guildTrialScoreboard.noteContext?.({
                    trialName: tile.name,
                    tier: analysis.tier,
                    tiersCleared: analysis.tiersClearedSoFar,
                    // Who the estimated split has to account for. Nobody is
                    // dropped for having no captured build; they are listed
                    members: signedUpMembers(tile.name),
                    shortfall: {
                        remaining: analysis.remaining,
                        total: analysis.total,
                        unit: analysis.kind === 'combat' ? 'HP' : 'work',
                    },
                    // The archived cycles, already summarised, so the report's
                    // "Past weeks:" tail needs neither the record nor the store
                    pastWeeks: this._pastWeekSummaries(Date.now()),
                });
            }
            return forecast;
        } catch (error) {
            console.error('[GuildTrials] Forecasting the trial failed:', error);
            return null;
        }
    }

    /**
     * Throw away a record the page itself contradicts.
     *
     * The reported failure, after the storage keys were fixed: the poisoned copy
     * was already on disk and under the *new* guild's own key, so nothing about
     * provenance or keying could reach it. The page could, though — it was
     * saying "Scheduled", "0 pts" on every card and "1/22 signed up" while the
     * block above it claimed 2,880 points and five banked tiers.
     *
     * That contradiction is the signal. A cycle the game calls **scheduled**, on
     * a tab whose cards state nothing at all, cannot also be a cycle with tiers
     * banked in it — so whatever the record holds belongs to a finished cycle
     * and is archived. The same is done for a record whose provenance names
     * another guild, which is the case this can catch on its own.
     *
     * Deliberately not "delete anything that disagrees": a live trial routinely
     * has cards showing 0 pts before the first tier clears, which is why the
     * scheduled phase is required as well.
     *
     * @param {Object} status - From `readTrialStatus`
     * @param {Array<Object>} tiles - This pass's cards
     * @param {number} now - Clock
     */
    _healStaleRecord(status, tiles, now) {
        if (!this.record) return;

        const held = Object.values(this.record.tiles || {});
        if (!held.length) return;

        const provenance = recordProvenance(this.record, {
            guildId: this._guildId(),
            guildName: this.guildName,
        });
        if (provenance === 'foreign') {
            this.record = archiveCycle(this.record, FOREIGN_CYCLE_REASON, now);
            this.blockHtml.clear();
            return;
        }

        // The game says the next cycle has not started; the record says a cycle
        // is under way. The game is describing what is on screen
        const scheduled = status?.phase === 'scheduled';
        const cardsStateNothing =
            tiles.length > 0 && tiles.every((tile) => !tile.readings.length && !(tile.points > 0));
        const recordClaimsProgress = held.some(
            (tile) => tile.samples?.length || tile.tier || Object.keys(tile.pointsByTier || {}).length
        );

        if (scheduled && cardsStateNothing && recordClaimsProgress) {
            console.warn('[GuildTrials] Archiving a finished cycle: the panel says the next one is scheduled');
            this.record = archiveCycle(this.record, 'a new cycle is scheduled', now);
            this.blockHtml.clear();
            guildTrialDamage.reset?.();
            saveTrialRecord(this.guildName, this.record, this.characterId, { guildId: this._guildId() });
        }
    }

    /**
     * Tell the recorder and the alerts where the cycle is.
     * @param {Object} status - From `readTrialStatus`
     * @param {Array<Object>} tiles - This pass's cards
     * @param {number} now - Clock
     */
    _noteLifecycle(status, tiles, now) {
        const phase = status?.phase || null;
        if (phase && phase !== this.phase) this.phase = phase;

        guildTrialAlerts.noteTrialStatus?.({
            phase,
            startsInMs: status?.startsInMs ?? null,
            trials: tiles.map((tile) => tile.name),
            at: now,
        });
    }

    /** @returns {string|null} The guild's id, from whichever source has it */
    _guildId() {
        return guildXPTracker.getOwnGuildID?.() || dataManager.characterData?.guild?.id || null;
    }

    /**
     * Draw one block, without disturbing the page when it has not changed.
     *
     * The whole of the scroll fix. `innerHTML` is only assigned when the markup
     * actually differs, and an element that is already in the right place is
     * left exactly where it is — so the common case, a five-second sample that
     * moved a figure by a hundred points, touches one text node and nothing
     * else. A block that has to move is moved with the scroll position of every
     * scrollable ancestor recorded and put back, because inserting into a
     * scrolling container is the other half of the same bug.
     *
     * @param {Element} root - The trials root
     * @param {string} key - Stable identity for this block
     * @param {Object} spec - `{html, style, place, onBuild}`; `place` inserts a fresh block
     * @returns {Element} The block
     */
    _placeBlock(root, key, { html, style, place, onBuild }) {
        const existing = root.querySelector(`.${CSS_CLASS}[data-mwi-block="${key}"]`);

        // Compared against what this drew last time rather than against the
        // element's own `innerHTML`: a block that has had listeners attached to
        // appended children no longer reads back as the markup it was built
        // from, and would therefore look changed on every single pass
        const unchanged = this.blockHtml.get(key) === html;

        if (existing) {
            if (!unchanged) {
                existing.innerHTML = html;
                this.blockHtml.set(key, html);
                onBuild?.(existing);
            }
            if (existing.style.cssText !== style) existing.style.cssText = style;
            return existing;
        }

        const block = document.createElement('div');
        block.className = CSS_CLASS;
        block.dataset.mwiBlock = key;
        block.style.cssText = style;
        block.innerHTML = html;
        this.blockHtml.set(key, html);
        onBuild?.(block);

        withScrollKept(root, () => place(block));
        return block;
    }

    /**
     * Remove blocks whose trial is no longer on screen.
     * @param {Element} root - The trials root
     * @param {Set<string>} drawn - Keys drawn this pass
     */
    _reapBlocks(root, drawn) {
        // Every block on the page, not only those under the root being drawn
        // into. A tab switch changes which element the root finder answers with,
        // and a block left under the previous one would never be looked at
        // again — it would simply stay on screen, which is what was reported
        const scope = typeof document === 'undefined' ? root : document;
        if (!scope?.querySelectorAll) return;

        for (const block of scope.querySelectorAll(`.${CSS_CLASS}`)) {
            const key = block.dataset?.mwiBlock;
            // A block with no key is from an older build, or from a redraw that
            // failed halfway; either way it is not this pass's and goes
            if (key && drawn.has(key)) continue;
            if (key) this.blockHtml.delete(key);
            block.remove();
        }
    }

    /**
     * Active time left in the running trial, from any clock on the tab.
     *
     * The game draws a countdown; when it does, that is the authority. Falling
     * back to "a trial runs an hour, and it started when this script first saw
     * it" would be wrong for every player who opened the tab late, which is most
     * of them — so without a clock on screen there is no pace projection at all.
     *
     * The named status row is tried first and is no longer required: it is as
     * unverified as the tab container was, and it was the only source of a time
     * left, so a wrong guess about it took "On pace for" off the screen with
     * nothing said. {@link findTrialClockMs} looks for the clock instead.
     *
     * @param {Element} root - The trials content element
     * @returns {number|null} Milliseconds, or null when the tab shows no clock
     */
    _timeLeftMs(root) {
        const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
        const statusText = statusRow?.textContent || '';
        // The same refusals the clock finder applies, because the status row
        // earns none of them for free: the Trials tab's header is "Skilling
        // Trial - In Progress Thu 09:00 AM", and 09:00 parses as a nine-minute
        // countdown — which made the pace walk one tier further than the tile's
        // real 5m53s allowed, on that tab only. A bar reading ("15 / 60") is
        // refused for the same reason it is in `findTrialClockMs`.
        const fromStatus =
            statusText.includes('/') || NOT_A_CLOCK_RE.test(statusText) ? null : parseClockMs(statusText);
        if (fromStatus !== null) return Math.min(fromStatus, TRIAL_ACTIVE_MS);

        return findTrialClockMs(root, TRIAL_ACTIVE_MS);
    }

    /**
     * Both payout bonuses, from the best source that has one.
     *
     * The guild's own building levels first — they ride in on guild traffic as
     * `guildBuildingLevelMap`, the data manager captures them off any message
     * that carries one and persists them, and the confirmed rule is 2% per level
     * for both buildings. Failing that, the Builders Hall bonus can be recovered
     * from the cards themselves ({@link module:./guild-trials-math.inferBuildersHallBonus}),
     * because a card states Guild Points for a tier whose base the ladder knows
     * and the ratio between them is the bonus. Nothing fills in for an unknown
     * Treasury, and the block says so rather than quietly paying it as zero.
     *
     * @returns {{buildersHall: Object, treasury: Object}} Both, with their provenance
     */
    _payoutBonuses() {
        const bonuses = readPayoutBonuses();
        if (Number.isFinite(bonuses.buildersHall.bonus)) return bonuses;

        const inferred = inferBuildersHallBonus(
            Object.values(this.record?.tiles || {}).map((tile) => ({
                type: tile?.kind === 'combat' ? 'combat' : 'skilling',
                pointsByTier: tile?.pointsByTier,
            })),
            // The building's own step and ceiling, from the game's data where it
            // is loaded, so a rebalance moves this with it
            bonuses.buildersHall.rules
        );
        if (!inferred) return bonuses;

        return {
            ...bonuses,
            buildersHall: { ...bonuses.buildersHall, level: inferred.level, bonus: inferred.bonus, source: 'cards' },
        };
    }

    /**
     * The payout block: what is banked, and what the current pace would add.
     * @param {Element} root - The trials content element
     * @param {Array<{name: string, type: string, banked: number, projected: number}>} trials - This week's trials
     * @param {Element|null} [firstTile] - The topmost trial card, for placement when there is no status row
     * @param {Object} [payoutBonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {boolean} Whether a payout block is on screen
     */
    _renderPayout(root, trials, firstTile = null, payoutBonuses = null) {
        if (!trials.length) return false;

        const bonuses = payoutBonuses || this._payoutBonuses();
        const buildersHallBonus = bonuses.buildersHall.bonus;
        const treasuryBonus = bonuses.treasury.bonus;

        const banked = payoutProjection({
            trials: trials.map((trial) => ({
                ...trial,
                tiersCleared: trial.banked,
                // The card's own figure where there is one, in both units: the
                // Guild Points it states outright — four days of the guild's chat
                // announcements say the sum of exactly these is what is earned —
                // and the base points recovered from it, which is what the token
                // arithmetic runs on. `trialBankedBasePoints` decides, and says so.
                basePointsOverride: trial.points?.source === 'ladder' ? undefined : trial.points?.basePoints,
                guildPointsOverride: trial.points?.guildPoints ?? undefined,
            })),
            buildersHallBonus,
            treasuryBonus,
        });
        // The pace's figure is the banked one plus what the tiers it projects
        // would add, rather than a second ladder walk from scratch. Rebuilding
        // it from the ladder made "on pace" come out *below* "banked" whenever
        // the cards had stated more than the ladder derives, which reads as the
        // trial going backwards.
        const projected = payoutProjection({
            trials: trials.map((trial) => {
                const extraTiers = Math.max(0, (trial.projected ?? trial.banked) - trial.banked);
                const step = EXTRA_TIER_POINTS[trial.type] ?? 0;
                const fromCards = trial.points?.source !== 'ladder';
                const base = trial.points?.basePoints;
                const stated = trial.points?.guildPoints;
                return {
                    ...trial,
                    tiersCleared: trial.projected,
                    basePointsOverride: fromCards && Number.isFinite(base) ? base + extraTiers * step : undefined,
                    guildPointsOverride:
                        fromCards && Number.isFinite(stated)
                            ? stated + extraTiers * step * (1 + (buildersHallBonus || 0))
                            : undefined,
                };
            }),
            buildersHallBonus,
            treasuryBonus,
        });

        // Which of the three states the banked figure is in. They are three
        // different things and they all used to render as `0`, which is the one
        // reading that is never right.
        const anyTierKnown = trials.some((trial) => trial.tierKnown);
        // A card that states a points figure has already earned it — that is what
        // the chat announcement pays out — so it counts as banked even before
        // this script's own tier-on-screen inference says a tier has completed
        const anyBanked = trials.some(
            (trial) => trial.banked > 0 || Number.isFinite(trial.points?.quoted?.statedPoints)
        );

        const eligible = tokenPayoutLine(
            projected.eligibleTokens,
            'Half the total base points, paid to every member who joined before the week started.'
        );
        const participant = tokenPayoutLine(
            projected.participantTokens,
            'The eligible payout plus a further 50% of it for participating.'
        );

        const bankedRow = !anyTierKnown
            ? line(
                  'Guild Points banked',
                  'not known yet',
                  DIM,
                  'Banked points are counted from the tier on screen, and no card seen so far carries one — ' +
                      'the In Progress tab does not show a tier. Open the Trials tab once and this fills in. ' +
                      'It is unknown rather than zero.'
              )
            : !anyBanked
              ? line(
                    'Guild Points banked',
                    'nothing banked yet',
                    DIM,
                    'A trial pays for tiers it has finished. This appears after the first tier completes.'
                )
              : line('Guild Points banked', exact(banked.guildPoints), GOOD, this._pointsProvenance(trials));

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;">Trial payout</div>`,
            bankedRow,
            line('Guild Points on pace', exact(projected.guildPoints), ACCENT),
            line('Tokens, every eligible member', eligible.value, ACCENT, eligible.title),
            line('Tokens, if you took part', participant.value, GOOD, participant.title),
        ];

        // Not a mismatch at all: a total banked across a Builder's Hall upgrade.
        // Points bank live, tier by tier, at the bonus in force when each tier
        // clears — so a guild that levels its Hall mid-trial has a card that is a
        // *mixture* of two bonuses and divides cleanly by neither. Confirmed by
        // the guild it happened to; see `MAX_MID_TRIAL_UPGRADE_LEVELS`
        const upgraded = trials.find((trial) => trial.points?.interpretation === 'mid-trial-upgrade');
        if (upgraded?.points?.quoted) {
            const { tier, statedPoints } = upgraded.points.quoted;
            const derived = upgraded.points.ladder;
            rows.push(
                `<div style="color:${DIM}; margin-top:4px;">` +
                    `${upgraded.name} T${tier} states ${formatWithSeparator(statedPoints)} pts, which is between ` +
                    `the ladder at this guild’s current +${Math.round((buildersHallBonus || 0) * 100)}% and at a ` +
                    'level or two below it — consistent with a Builder’s Hall upgrade during the trial. Points ' +
                    'bank live, so each tier is paid at the bonus in effect when it cleared and the total is a ' +
                    `mixture of the two. The card is used exactly as stated${
                        Number.isFinite(derived) ? `; the ladder’s own base is ${formatWithSeparator(derived)}` : ''
                    }.</div>`
            );
        }

        // A genuine mismatch, which is now a much rarer thing to be. The warning
        // this replaces fired on every card of every week and blamed the ladder,
        // when what was actually happening is that a card states *Guild Points*
        // — the ladder's base figure with the Builders Hall bonus already on it.
        // With that understood the two agree exactly, and a disagreement left
        // over is worth reporting again.
        const disagreement = trials.find((trial) => trial.points?.interpretation === 'disagrees');
        if (disagreement?.points?.quoted) {
            const { tier, statedPoints } = disagreement.points.quoted;
            const hallLevel = bonuses.buildersHall.level;
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    `${disagreement.name} T${tier} states ${formatWithSeparator(statedPoints)} pts, which is ` +
                    `neither the running total nor the per-tier step once the Builders Hall bonus ` +
                    `(+${Math.round((buildersHallBonus || 0) * 100)}% at level ${hallLevel || '?'}) is taken off. ` +
                    'The card is used as stated; the tier ladder here needs checking.</div>'
            );
        }

        if (!Number.isFinite(buildersHallBonus) || !Number.isFinite(treasuryBonus)) {
            const missing = [];
            if (!Number.isFinite(buildersHallBonus)) missing.push('Builder’s Hall');
            if (!Number.isFinite(treasuryBonus)) missing.push('Treasury');
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    `No ${missing.join(' or ')} level seen, so the token figures leave ` +
                    `${missing.length === 1 ? 'that bonus' : 'those bonuses'} out — each level adds ` +
                    `${formatPercent(bonuses.treasury.rules?.bonusPerLevel)}. ` +
                    'Open the guild Buildings tab once and it will be picked up, or set it in Toolasha settings.' +
                    (Number.isFinite(buildersHallBonus)
                        ? ''
                        : ' The Guild Points row is still exact: it is what the cards themselves state.') +
                    '</div>'
            );
        }

        if (bonuses.buildersHall.source === 'cards') {
            rows.push(
                `<div style="color:${DIM}; margin-top:4px;">` +
                    `Builder’s Hall read as level ${bonuses.buildersHall.level} ` +
                    `(+${Math.round(buildersHallBonus * 100)}%) from the cards’ own points, ` +
                    'since no building level has arrived on guild traffic yet.</div>'
            );
        }

        // Built as markup rather than inserted straight away: `_placeBlock`
        // compares it with what is already on screen and leaves the page alone
        // when nothing moved, which is what keeps the scroll where the reader
        // put it. The buttons are appended after, since they carry listeners
        // that markup cannot
        this._placeBlock(root, 'payout', {
            html: rows.join('') + this._controlsHTML(),
            style:
                'margin:8px 0 4px; padding:8px 12px; background:rgba(0,0,0,0.25);' +
                'border-radius:6px; font-size:12px; line-height:1.7;',
            place: (block) => {
                // Under the game's own status row when there is one. Otherwise
                // directly above the first card, which is where it belongs and —
                // unlike the panel's own top edge — is somewhere the reader is
                // already looking when the root is a whole guild panel.
                const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
                if (statusRow) statusRow.insertAdjacentElement('afterend', block);
                else if (firstTile?.isConnected) firstTile.insertAdjacentElement('beforebegin', block);
                else root.insertAdjacentElement('afterbegin', block);
            },
            onBuild: (block) => this._bindControls(block),
        });

        // Kept while it is on screen: by the time the cycle reads "Completed"
        // the cards have been zeroed and there would be nothing left to report
        guildTrialAlerts.notePayout?.({
            guildPoints: banked.guildPoints,
            eligibleTokens: projected.eligibleTokens,
            participantTokens: projected.participantTokens,
        });

        return true;
    }

    /**
     * The week's archived cycles, as summaries the line printer takes.
     *
     * Newest first, because the question is "how did we do lately". The bonuses
     * passed along are the guild's current ones — the token figure derived from
     * them is marked as derived, and `summariseArchivedCycle` refuses to apply
     * them to a cycle archived off another guild's record at all.
     *
     * @param {number} [now] - Clock
     * @param {Object} [bonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {Array<Object>} One summary per archived cycle
     */
    _pastWeekSummaries(now = Date.now(), bonuses = null) {
        const history = Array.isArray(this.record?.history) ? this.record.history : [];
        if (!history.length) return [];

        const resolved = bonuses || this._payoutBonuses();
        return [...history].reverse().map((cycle) =>
            summariseArchivedCycle(cycle, {
                now,
                buildersHallBonus: resolved.buildersHall.bonus,
                treasuryBonus: resolved.treasury.bonus,
            })
        );
    }

    /**
     * The "Past weeks" block: one compact line per archived cycle.
     *
     * The archive exists because the figures were real when they were taken and
     * a player who wants last cycle's numbers has nowhere else to get them —
     * and until this block, nowhere to read them either. Drawn under everything
     * else on the tab, and not at all when there is no history: an empty header
     * would be a promise about data that does not exist.
     *
     * @param {Element} root - The trials content element
     * @param {number} [now] - Clock
     * @param {Object} [bonuses] - From {@link _payoutBonuses}; resolved here when omitted
     * @returns {boolean} Whether a history block is on screen
     */
    _renderHistory(root, now = Date.now(), bonuses = null) {
        const summaries = this._pastWeekSummaries(now, bonuses);
        if (!summaries.length) return false;

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;" ` +
                'title="The last few finished cycles, kept when the week rolled over. Newest first. ' +
                '&quot;—&quot; is a figure that never reached this client; a zero is a real result. ' +
                'Token figures are derived from today’s building bonuses, which is what the ~ marks.">' +
                'Past weeks</div>',
        ];
        for (const summary of summaries) {
            const title = summary.reason ? ` title="Archived: ${String(summary.reason).replace(/"/g, '&quot;')}"` : '';
            rows.push(`<div style="color:${DIM};"${title}>${pastWeekLine(summary)}</div>`);
        }

        this._placeBlock(root, 'history', {
            html: rows.join(''),
            style:
                'margin:8px 0 4px; padding:8px 12px; background:rgba(0,0,0,0.25);' +
                'border-radius:6px; font-size:12px; line-height:1.7;',
            place: (block) => root.insertAdjacentElement('beforeend', block),
        });
        return true;
    }

    /**
     * The recorder's controls, and the way to the scoreboard.
     *
     * On the payout block because that is the one part of this feature the
     * player is already looking at while a trial runs. The console helper still
     * works and is still the programmatic path — the button calls the same
     * builder rather than a second copy of it, so the two cannot drift.
     *
     * @returns {string} The buttons, as markup
     */
    _controlsHTML() {
        const recording = guildTrialRecorder.recording;
        const button = (action, label, color, title) =>
            `<button data-action="${action}" title="${title.replace(/"/g, '&quot;')}" ` +
            `style="flex:1 1 auto; cursor:pointer; padding:3px 8px; border-radius:4px; font-size:11px;` +
            `border:1px solid ${color}66; background:transparent; color:${color};">${label}</button>`;

        return (
            '<div data-mwi-controls="1" style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">' +
            button(
                'record',
                recording ? '■ Stop recording' : '● Record trial',
                recording ? WARN : GOOD,
                recording
                    ? 'Stop the session and write it down. The export keeps it either way.'
                    : 'Start a session now. One starts by itself when a trial fight or a live reading is seen, ' +
                          'unless that is switched off in settings.'
            ) +
            button('export', '⤓ Export', ACCENT, 'Download everything captured this week as one JSON file.') +
            button('scoreboard', 'Per-player', ACCENT, 'Damage and healing per player, ranked.') +
            '</div>'
        );
    }

    /**
     * Attach the controls' listeners.
     *
     * Separate from the markup because the markup is compared against the last
     * pass to decide whether the page needs touching at all — and a listener
     * cannot be compared. The recording state is *in* the markup, so pressing
     * Record changes the signature and this runs again with the new label.
     *
     * @param {Element} block - The payout block, freshly built
     */
    _bindControls(block) {
        const on = (action, handler) =>
            block.querySelector(`[data-action="${action}"]`)?.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                handler();
            });

        on('record', () => {
            if (guildTrialRecorder.recording) guildTrialRecorder.stop('button');
            else guildTrialRecorder.start('button');
            this._render(findTrialsRoot());
        });
        on('export', async () => {
            const bundle = await buildTrialExport({ guildName: this.guildName });
            downloadTrialExport(bundle);
        });
        on('scoreboard', () => guildTrialScoreboard.toggle());
    }

    /**
     * The pool reading the spectator stream is carrying, if it is fresh.
     *
     * A guild trial's boss health is the pool, and `guild_battle_updated` states
     * it to the unit on every tick while the In Progress fight view is open —
     * which is a better source than the DOM bar in three ways: it does not wait
     * for a redraw, it survives the card scrolling out of view, and it comes with
     * the tier attached instead of inferred from a badge.
     *
     * Only used while it is *fresh*. A stale pool would keep injecting the last
     * health the fight view showed as though it were still moving, which is a
     * rate of zero on a trial that is running fine.
     *
     * @param {number} now - Clock
     * @returns {Object|null} `{current, max, tier}` or null
     */
    _spectatedPool(now) {
        const pool = guildTrialDamage.breakdown?.()?.pool;
        if (!pool || !Number.isFinite(pool.current) || !Number.isFinite(pool.max)) return null;
        if (!Number.isFinite(pool.at) || now - pool.at > SPECTATED_POOL_FRESH_MS) return null;
        return pool;
    }

    /**
     * Whether the game has said, outright, that the trials on screen are over.
     *
     * `end_guild_battle` and `end_guild_skilling` are the only certain lifecycle
     * signals this feature has. Everything else is a phase inferred from a
     * header that may name the other kind, or from a badge that may not have
     * been redrawn — and a session left running past the end of a trial is a
     * recording full of an hour of nothing.
     *
     * Every trial on screen has to be over, not merely one of them: a guild runs
     * the two kinds one after the other, and the skilling half ending is not the
     * hour ending.
     *
     * @param {Array<Object>} tiles - This pass's cards
     * @returns {boolean} True when nothing on screen is still running
     */
    _declaredOver(tiles) {
        if (!tiles?.length) return false;

        const combatOver = Boolean(guildTrialDamage.breakdown?.()?.endedAt);
        return tiles.every((tile) =>
            tile.kind === 'combat' ? combatOver : Boolean(guildTrialSkilling.endedFor?.(tile.name))
        );
    }

    /**
     * Put the socket's own reading of a skilling trial on its card.
     *
     * `guild_skilling_updated` states the pool, the tier, the participants and
     * the player's own action figures — every one of which this feature has
     * otherwise been scraping off a tab that has to be open, and every one of
     * which has had its own bug. Where it has spoken it is preferred: it is the
     * game's own statement, it carries the tier rather than requiring a badge
     * plus an assumption, and its personal figures arrive already attached to
     * the tier they describe.
     *
     * The DOM stays underneath all of it. Whether these messages reach a client
     * that is not looking at the trial is not something the capture can answer,
     * so this is a bonus signal and never a replacement: no socket update, and
     * the card is exactly as well served as it was.
     *
     * @param {Object} tile - A card from `readTrialTiles`
     * @param {number} now - Clock
     * @returns {Object} The card, with whatever the socket could add
     */
    _withSocketSkilling(tile, now) {
        if (tile.kind !== 'skilling') return tile;

        const ended = guildTrialSkilling.endedFor?.(tile.name) || null;
        const update = guildTrialSkilling.forTrial?.(tile.name, now) || null;
        if (!update && !ended) return tile;

        const next = { ...tile };

        // The game says it is over, and says what it banked. `end_guild_skilling`
        // arrived with tier 9 while tier 10 was in progress, which is the game's
        // own confirmation that a stated tier counts what is finished
        if (ended) {
            next.completed = true;
            if (Number.isFinite(ended.tier)) next.tier = ended.tier;
        }

        if (!update) return next;

        // The pool, to the unit. A card the game is already drawing a bar on
        // keeps its own numbers, so the two sources cannot disagree on screen
        if (update.reading && !tile.readings?.length) next.readings = [{ ...update.reading }];
        if (Number.isFinite(update.tier)) {
            next.socketTier = update.tier;
            // The pool the tier was stated with. A stated tier is only good
            // for as long as this is the bar's target — the target changes the
            // moment a tier clears, and a `liveTier` kept past that point is
            // the previous tier's answer wearing this one's label
            next.socketTierTarget = Number.isFinite(update.reading?.max) ? update.reading.max : null;
        }

        // The per-tier personal figures, which is what the DOM footer was read
        // for — and these come with their tier attached rather than inferred
        if (Object.keys(update.personal || {}).length) {
            next.personal = { ...(tile.personal || {}), ...update.personal };
        }
        return next;
    }

    /**
     * The learned first-tier total for a tile's skill or encounter.
     *
     * Keyed by the trial as the card names it — `Crafting` and the socket's
     * `/guild_skilling/crafting` both lower-case to `crafting`, and a combat
     * card's `Trial Chameleon` keys as itself. For a skilling trial the figure
     * is the skill's first-tier work; for combat it is the encounter's
     * first-tier boss health (Trial Chameleon's 550,000).
     *
     * @param {{kind: string, name: string}} tile - A card or a tile record
     * @returns {number|null} The base total, or null when it has not been learned
     */
    _workBase(tile) {
        if (tile?.kind !== 'skilling' && tile?.kind !== 'combat') return null;
        const key = String(tile?.name || '')
            .trim()
            .toLowerCase();
        const base = this.workBases[key]?.baseWork ?? DEFAULT_WORK_BASES[key];
        return Number.isFinite(base) && base > 0 ? base : null;
    }

    /**
     * The tier a live skilling bar's own target identifies, if it does.
     *
     * The participant count is resolved the way the drawing loop resolves it —
     * the card's own sign-up figure first, the tracker's sign-up sheet
     * otherwise — because the work formula needs the same count the analysis
     * uses everywhere else. The base is the learned one where the store has
     * it, and otherwise backed out of this trial's own filed observations, the
     * same way `analyseTrial` resolves it — so a record that once filed a tier
     * correctly keeps filing later tiers correctly as they clear.
     *
     * @param {Object} tile - The card, with any socket reading already folded in
     * @param {Object|null} held - The tile's stored record
     * @param {Object} counts - Sign-ups per trial hrid, from `participantCounts`
     * @returns {number|null} The tier, or null when the target fits no tier
     */
    _workLadderTier(tile, held, counts) {
        const kind = tile?.kind === 'combat' ? 'combat' : tile?.kind === 'skilling' ? 'skilling' : null;
        if (!kind) return null;

        const hrid = matchTrialHrid(tile.name, Object.keys(counts || {}));
        const participants = tile.signups?.signed ?? held?.signups?.signed ?? (hrid ? counts[hrid] : 0);
        // Tier-1 observations are excluded for the same reason `analyseTrial`
        // excludes them: they may be the first-tier rule's own filings — and
        // the observation fallback is skilling-only there for the same reason
        // it is here: a combat record's observations mix both bars' ladders
        const stated = (held?.tiers || []).filter((observation) => Number(observation?.tier) >= 2);
        const baseWork =
            this._workBase(tile) ?? (kind === 'skilling' ? baseWorkFromObservations(stated, participants, kind) : null);
        if (!Number.isFinite(baseWork) || baseWork <= 0) return null;

        // A combat card's second bar is the tier's own level-scaled pool and
        // needs no participant count; the first bar (boss health, participant-
        // scaled) is the fallback anchor, as in `analyseTrial`
        const poolTarget = kind === 'combat' && Number.isFinite(tile.readings?.[1]?.max) ? tile.readings[1].max : null;
        const fromPool =
            poolTarget !== null ? tierFromWorkTarget({ target: poolTarget, baseWork, participants: 0, kind }) : null;
        return fromPool ?? tierFromWorkTarget({ target: tile.readings?.[0]?.max, baseWork, participants, kind });
    }

    /**
     * Learn a trial's first-tier total, the moment all three inputs line up.
     *
     * The tier, the bar's target and the participant count are each on screen
     * at different times, and only a moment that has all three can state the
     * base — `target / (shape(tier) × (1 + 0.01 × p))`, on either kind's
     * ladder. Once learned it identifies the tier from the bar alone — which
     * is what lets a mid-trial join on the In Progress tab know its tier
     * without ever opening the Trials tab. A skilling trial learns its skill's
     * base work; a combat trial learns its encounter's first-tier boss health.
     *
     * Guards, because a wrong base states wrong tiers with confidence:
     *
     * - Only a tier the game stated ('card', 'socket') teaches; the assumed and
     *   the derived rungs must never feed themselves.
     * - Only a *fresh* reading teaches. The record's last target survives tab
     *   switches, and a tier that cleared while the tab was shut would pair the
     *   old target with the new badge.
     * - A base already in hand that explains the current target at any whole
     *   tier is kept: relearning on a stale badge is how a constant drifts.
     *
     * @param {Object} tile - The card
     * @param {Object} record - Its stored record
     * @param {Object} analysis - From `analyseTrial`
     * @param {number} participants - The count the analysis used
     * @param {number} now - Clock
     */
    _learnWorkBase(tile, record, analysis, participants, now) {
        try {
            const kind = tile.kind === 'combat' ? 'combat' : tile.kind === 'skilling' ? 'skilling' : null;
            if (!kind) return;
            if (analysis.tierSource !== 'card' && analysis.tierSource !== 'socket') return;
            if (!Number.isFinite(analysis.tier)) return;

            const lastSample = record?.samples?.[record.samples.length - 1];
            if (!Number.isFinite(lastSample?.t) || now - lastSample.t > WORK_BASE_LEARN_FRESH_MS) return;

            // A combat card's second bar teaches with no participant count at
            // all — it is the tier's level-scaled pool. The first bar (or a
            // skilling bar) is participant-scaled and needs the count.
            const poolTarget = kind === 'combat' ? Number(lastSample?.readings?.[1]?.max) : NaN;
            const usingPool = Number.isFinite(poolTarget) && poolTarget > 0;
            const target = usingPool ? poolTarget : analysis.total;
            if (!Number.isFinite(target)) return;
            if (!usingPool && !(participants > 0)) return;
            const scaledBy = usingPool ? 0 : participants;

            const key = String(tile.name || '')
                .trim()
                .toLowerCase();
            const held = this.workBases[key]?.baseWork;
            if (
                Number.isFinite(held) &&
                tierFromWorkTarget({ target, baseWork: held, participants: scaledBy, kind }) !== null
            ) {
                return;
            }

            const baseWork = baseWorkFromObservations([{ tier: analysis.tier, total: target }], scaledBy, kind);
            if (!Number.isFinite(baseWork) || baseWork <= 0) return;

            this.workBases = {
                ...this.workBases,
                [key]: { baseWork, tier: analysis.tier, target: analysis.total, participants, learnedAt: now },
            };
            saveWorkBases(this.workBases).catch(() => {});
        } catch (error) {
            console.error('[GuildTrials] Learning a work base failed:', error);
        }
    }

    /**
     * Whether a card is the one the watched figures belong to.
     *
     * Ranked rather than decided, because the guild-report context is pushed
     * once per combat card and the last one used to win — which on a two-combat
     * week meant the alphabetically-later trial narrated somebody else's fight.
     * A watched identity outranks everything; failing that, the card with live
     * readings; failing that, the card that has actually banked something.
     *
     * @param {Object} tile - The card
     * @param {Object} analysis - From `analyseTrial`
     * @returns {number} 0 when it has no claim at all
     */
    _contextRank(tile, analysis) {
        const watched = this.watchedPool?.encounter || null;
        if (watched) return encounterOf(tile.name) === watched ? 3 : 0;
        if (tile.readings?.length) return 2;
        return analysis?.tiersClearedSoFar > 0 ? 1 : 0;
    }

    /**
     * Put the watched pool on the combat card that has no reading of its own.
     *
     * Additive only: a card the game is already drawing a bar on keeps its own
     * numbers, so the two sources can never disagree on screen. What this covers
     * is the Trials tab, where the combat card carries a level and no bar at all
     * and every projection therefore said "measuring…" for the whole hour.
     *
     * @param {Object} tile - A card from `readTrialTiles`
     * @param {Object|null} pool - From {@link _spectatedPool}
     * @returns {Object} The card, with the reading attached when it had none
     */
    _withSpectatedPool(tile, pool) {
        if (!pool || tile.kind !== 'combat' || tile.readings?.length) return tile;
        // The reading belongs to the encounter that was watched and to no other.
        // A week with two combat trials has two barless cards, and standing in
        // for both put a Chameleon fight's pool on the Hedgehog card — which
        // then reported it under Hedgehog's name, tier ladder and banked count
        if (!pool.encounter || encounterOf(tile.name) !== pool.encounter) return tile;

        return {
            ...tile,
            readings: [{ current: pool.current, max: pool.max }],
            spectatedTier: Number.isFinite(pool.tier) ? pool.tier : null,
            // The stream states the tier the same way the skilling socket does
            // (`new_battle.tier`), and it is persisted the same way — as
            // `liveTier`, paired with the boss health it was stated for, so it
            // expires the moment a cleared tier moves the bar's maximum on.
            // Without this a spectated combat trial's stated tier reached the
            // observation filing and never the analysis, and the card read
            // "tier not seen yet" through a fight whose tier was on the wire.
            ...(Number.isFinite(pool.tier)
                ? { socketTier: pool.tier, socketTierTarget: Number.isFinite(pool.max) ? pool.max : null }
                : {}),
        };
    }

    /**
     * Where the banked points figure came from, for the tooltip.
     * @param {Array<Object>} trials - This week's trials, as `_render` built them
     * @returns {string} A sentence
     */
    _pointsProvenance(trials) {
        const sources = new Set(trials.map((trial) => trial.points?.source).filter(Boolean));
        const cards =
            'Summed from the points each trial card states — the guild’s own end-of-trial announcement is ' +
            'the sum of exactly these figures, so this is the number that will be paid. They are Guild ' +
            'Points, with the Builder’s Hall bonus already in them; the token rows divide it back out.';

        if (sources.has('game') && sources.size === 1) return cards;
        if (sources.has('game') || sources.has('mixed')) {
            // Two things put a trial in `mixed`, and both are worth a sentence:
            // a card that was never on screen, and a card whose Guild Points are
            // exact but whose *base* had to come off the ladder because the
            // total was banked across a Builder's Hall upgrade
            const upgraded = trials.some((trial) => trial.points?.interpretation === 'mid-trial-upgrade');
            return (
                `${cards} Part of this total is derived from the tier ladder instead — for trials whose card ` +
                'was never on screen' +
                (upgraded
                    ? ', and for the base points behind a card banked across a Builder’s Hall upgrade, which ' +
                      'divides cleanly by neither bonus'
                    : '') +
                '.'
            );
        }
        return (
            'Derived from the tier ladder — 200 + 100 per extra tier for skilling, 400 + 200 for combat, ' +
            'times the Builder’s Hall bonus. Open the Trials tab and the game’s own “N pts” is used instead.'
        );
    }

    /** Tell the damage tracker which encounters this week's combat trials are */
    _publishTrialNames() {
        const names = Object.values(this.record?.tiles || {})
            .filter((tile) => tile?.kind === 'combat' && tile?.name)
            .map((tile) => tile.name);
        guildTrialDamage.setTrialNames(names);
    }

    cleanup() {
        for (const unregister of this.unregister) unregister();
        this.unregister = [];
        this.timers.clearAll();
        this.samplerId = null;
        this.lastTickAt = 0;
        guildTrialDamage.cleanup();
        guildTrialSkilling.cleanup();
        guildTrialRecorder.cleanup();
        guildTrialScoreboard.close();
        guildLoadoutCapture.cleanup();
        this.blockHtml.clear();
        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
        // In-memory only: the persisted copy stays, and the next initialize
        // reads it back
        this.workBases = {};
        this.initialized = false;
    }
}

const guildTrials = new GuildTrials();

export default {
    name: 'Guild Trials',
    initialize: () => guildTrials.initialize(),
    cleanup: () => guildTrials.cleanup(),
};

export { guildTrials };
