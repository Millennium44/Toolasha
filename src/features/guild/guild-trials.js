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
 * **Tier growth is fitted.** Projecting the tier after the current one needs the
 * curve the totals grow along, which is likewise not in client data. It is
 * fitted from the tiers this trial has actually shown — so it appears only once
 * a second tier has been seen, and says so until then.
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
    combatDamageRate,
    estimateGrowthPerTier,
    etaMs,
    inferBuildersHallBonus,
    levelFromTier,
    nextTierPreview,
    payoutProjection,
    projectPace,
    projectTierTotal,
    ratePerMs,
    trialBankedBasePoints,
    trialWeekStart,
} from './guild-trials-math.js';
import guildTrialDamage from './guild-trial-damage.js';
import guildLoadoutCapture from './guild-loadout-capture.js';
import { describeGuildTokenGold } from './guild-token-value.js';
import {
    classifyReadings,
    findTrialClockMs,
    findTrialsRoot,
    matchTrialHrid,
    parseClockMs,
    readTrialTiles,
} from './guild-trials-scrape.js';
import {
    loadTrialRecord,
    mergeTrialRecords,
    readPayoutBonuses,
    recordTileSample,
    saveTrialRecord,
    tileKey,
} from './guild-trials-store.js';

/** Class every injected element carries, so cleanup is one query */
const CSS_CLASS = 'mwi-trial-info';

/** How often a reading is taken while the tab is open */
const SAMPLE_MS = 5000;

const ACCENT = '#8fd3ff';
const DIM = '#9ca3af';
const GOOD = '#4ade80';
const WARN = '#f0a830';

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
 * @returns {{kind: string, tier: number|null, level: number|null, tiersClearedSoFar: number,
 *   rate: number|null, rateNote: string|null, remaining: number|null, total: number|null,
 *   etaMs: number|null, growthPerTier: number|null, next: Object|null, pace: Object|null,
 *   samples: number, timeLeftMs: number|null}} Analysis
 */
export function analyseTrial(record, { participants = 0, timeLeftMs = null, buildersHallBonus = null } = {}) {
    const samples = Array.isArray(record?.samples) ? record.samples : [];
    const kind = record?.kind === 'combat' ? 'combat' : 'skilling';
    const tier = Number.isFinite(record?.tier) ? record.tier : null;
    const observations = Array.isArray(record?.tiers) ? record.tiers : [];

    const history = samples.map((sample) => sample?.readings || []);
    const { bossIndex, poolIndex } = classifyReadings(history, kind);
    const index = kind === 'combat' ? bossIndex : poolIndex;
    const direction = kind === 'combat' ? -1 : 1;

    // Everything downstream of the tier — what is banked, what the payout is
    // worth, whether a pace can be walked — is unavailable rather than zero when
    // the tier has not been seen. The In Progress card carries no tier at all,
    // so a player who only ever opens that tab is in this state permanently, and
    // reporting it as "0 banked" is what made a live trial's payout read as
    // nothing at all.
    const tierKnown = Number.isFinite(tier);

    // How many tiers the badge on the card stands for, which is not the same
    // question in the two states a card can be in:
    //
    // - **Finished.** The completed Trial Chameleon card read "Lv.120, 960 pts,
    //   T3", and 960 is the ladder's *three*-tier total with the Builder's Hall
    //   bonus on it. So on a finished card the badge is the tiers earned, and
    //   this is exact rather than inferred — the arithmetic checks itself.
    // - **Running.** The badge is the tier being fought, and the tiers earned
    //   are one fewer. That is still an inference: a trial starts at tier 1 and
    //   climbs one at a time, so a card showing T7 has banked six. Nothing has
    //   confirmed it mid-trial, and the block says "in progress" beside it.
    //
    // Guessing the finished rule for a running card would claim a tier the party
    // is still fighting, which is the direction that overstates a payout.
    const completed = Boolean(record?.completed);
    const tiersClearedSoFar = tierKnown ? Math.max(0, completed ? tier : tier - 1) : 0;
    const pointsByTier = record?.pointsByTier && typeof record.pointsByTier === 'object' ? record.pointsByTier : {};

    const base = {
        kind,
        tier,
        tierKnown,
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

    const latest = samples[samples.length - 1]?.readings?.[index] || null;
    const total = Number.isFinite(latest?.max) ? latest.max : null;
    const remaining = latest ? (direction === -1 ? latest.current : Math.max(0, latest.max - latest.current)) : null;

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

    const next = Number.isFinite(tier) ? nextTierPreview({ observations, currentTier: tier, participants }) : null;

    const pace =
        Number.isFinite(tier) && Number.isFinite(remaining) && Number.isFinite(timeLeftMs)
            ? projectPace({
                  currentTier: tier,
                  remainingInTier: remaining,
                  rate,
                  timeLeftMs,
                  totalForTier: (candidate) => projectTierTotal({ observations, tier: candidate, growthPerTier }),
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
 * @returns {boolean|null} In it, not in it, or not knowable
 */
export function ownParticipation(trialName, { tracker = guildXPTracker, characterId } = {}) {
    const id = characterId ?? dataManager.getCurrentCharacterId?.() ?? null;
    if (id === null || id === undefined) return null;

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
 * A row of label and value.
 * @param {string} label - Left side
 * @param {string} value - Right side
 * @param {string} [color] - Value colour
 * @param {string} [title] - Tooltip
 * @returns {string} HTML
 */
function line(label, value, color = '#e8ecf5', title = '') {
    const tip = title ? ` title="${title.replace(/"/g, '&quot;')}"` : '';
    return (
        `<div style="display:flex; justify-content:space-between; gap:12px;"${tip}>` +
        `<span style="color:${DIM};">${label}</span>` +
        `<span style="color:${color}; font-weight:600;">${value}</span></div>`
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
 * The block drawn under one trial tile.
 * @param {Object} analysis - From {@link analyseTrial}
 * @param {number} participants - Signed-up participants
 * @param {Object} [breakdown] - Per-player damage, from `guildTrialDamage.breakdown()`
 * @param {Object} [options] - Context
 * @param {boolean|null} [options.participating] - Whether this character is in this trial
 * @returns {string} HTML
 */
export function renderTrialBlock(
    analysis,
    participants,
    breakdown = guildTrialDamage.breakdown(),
    { participating = null } = {}
) {
    const unit = analysis.kind === 'combat' ? 'dmg' : 'work';
    const rows = [];

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
                `${num(perSecond)} ${unit}/s`,
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
                        `${num(attributed)} ${unit}/s`,
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

    if (analysis.pace) {
        const projected = analysis.pace.tiersCleared;
        const finalTier = analysis.pace.finalTier ?? analysis.tier;
        const level = levelFromTier(finalTier);
        const caption =
            analysis.pace.limitedBy === 'unknown-next-tier'
                ? `${projected} tier${projected === 1 ? '' : 's'} (next tier's size unknown)`
                : `${projected} tier${projected === 1 ? '' : 's'} → T${finalTier}${level ? ` (Lv.${level})` : ''}`;
        rows.push(
            line(
                'On pace for',
                caption,
                analysis.pace.limitedBy === 'ladder' ? GOOD : WARN,
                'Current rate held flat for the rest of the hour. A tier only counts when it fits whole.'
            )
        );
    }

    if (analysis.next) {
        const label = analysis.kind === 'combat' ? 'Next tier HP' : 'Next tier work';
        rows.push(
            line(
                `${label} (T${analysis.next.tier})`,
                num(analysis.next.total),
                DIM,
                `Fitted from the tiers seen this week (×${analysis.next.growthPerTier.toFixed(2)} per tier). ` +
                    `${participants} participant${participants === 1 ? '' : 's'} already add ` +
                    `+${Math.round(analysis.next.participantPenalty * 100)}% to it.`
            )
        );
    } else if (Number.isFinite(analysis.tier) && analysis.tier < TRIAL_MAX_TIER) {
        rows.push(line('Next tier', 'needs a second tier to fit the curve', DIM));
    }

    if (!analysis.tierKnown) {
        rows.push(
            line(
                'Banked',
                'tier not seen yet',
                DIM,
                'Tiers cleared are read off the tier on screen, and the In Progress card carries no tier. ' +
                    'Open the Trials tab beside it once — the tier is on the card there, and everything banked ' +
                    'follows from it. Nothing is lost meanwhile; this is what is not yet known, not zero.'
            )
        );
    } else if (analysis.tiersClearedSoFar === 0) {
        rows.push(
            line(
                'Banked',
                `nothing yet — tier ${analysis.tier} in progress`,
                DIM,
                'A trial starts at tier 1, so nothing is banked until the first tier completes.'
            )
        );
    } else {
        rows.push(
            line(
                'Banked',
                `${analysis.tiersClearedSoFar} tier${analysis.tiersClearedSoFar === 1 ? '' : 's'}` +
                    (analysis.completed ? ' · finished' : ''),
                DIM,
                analysis.completed
                    ? 'This trial is over, so the tier on the card is the tier it reached — and the points ' +
                          'it states are the ladder’s total for exactly that many tiers, which is what makes ' +
                          'this figure exact rather than inferred.'
                    : 'While a trial runs, the tier on screen is the one being fought, so what is banked is ' +
                          'one fewer. That is an inference — it holds as long as a trial starts at tier 1 and ' +
                          'climbs one at a time — and it settles when the card says the trial is complete.'
            )
        );
    }

    if (analysis.kind === 'combat') rows.push(...renderTrialPlayers(breakdown));

    return rows.join('');
}

/**
 * Who in the party is producing the DPS the card is already showing.
 *
 * Drawn only under a combat card, and only from fights this client was actually
 * in — see `guild-trial-damage.js` for how a trial fight is told from any other,
 * and why measuring nothing is the right answer when it cannot be.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @returns {string[]} Rows of HTML, empty when there is nothing worth a row
 */
export function renderTrialPlayers(breakdown) {
    if (!breakdown) return [];

    if (!breakdown.measured) {
        // A line rather than silence: an empty space under a combat card is
        // indistinguishable from the split having failed, and the reason is
        // usually actionable ("you are not in this fight")
        return [
            line(
                'Per player',
                breakdown.stale ? 'last trial, not this one' : 'no trial fight seen here',
                DIM,
                `${breakdown.reason}.\nOnly fights this client takes part in can be split — ` +
                    'a trial you did not sign up for sends no battle traffic to you.'
            ),
        ];
    }

    const rows = [
        `<div style="margin-top:4px; color:${ACCENT}; font-weight:600;">` +
            `Per player · ${breakdown.fights} fight${breakdown.fights === 1 ? '' : 's'}</div>`,
    ];

    for (const player of breakdown.players) {
        const share = Number.isFinite(player.share) ? `${player.share.toFixed(0)}%` : '—';
        const dps = player.dps === null ? 'measuring…' : `${num(player.dps)} dmg/s`;
        const deaths = player.deaths > 0 ? ` · ${player.deaths}✝` : '';

        rows.push(
            line(
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
 * @returns {string} How it was placed: `spanned`, `after-card` or `after-container`
 */
export function placeTrialBlock(root, card, block, name = '') {
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

        this.initialized = true;

        this.guildName = this._resolveGuildName();
        const stored = await loadTrialRecord(this.guildName);
        this.record = mergeTrialRecords(stored, this.record);
        this._publishTrialNames();

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
            const stored = await loadTrialRecord(name);
            this.record = mergeTrialRecords(stored, this.record);
            this.guildName = name;
            await saveTrialRecord(name, this.record);
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
                this.record = { weekStart, tiles: {} };
            }

            // Every card on either tab, bar or no bar. A Trials card carries the
            // tier, the points and the sign-ups; the In Progress card carries the
            // reading; `recordTileSample` takes a sample only from the one that
            // has something moving on it, and both write the identity of the same
            // trial under the same key.
            const tiles = readTrialTiles(root);
            for (const tile of tiles) this.record = recordTileSample(this.record, tile, now);
            if (tiles.length) saveTrialRecord(this.guildName, this.record);

            // Which encounters count as a trial fight this week. Pushed rather
            // than pulled so the damage module never imports this one
            this._publishTrialNames();

            // Asked again on every render rather than once at startup: the guild
            // name arrives on socket traffic, which is usually later than this
            // feature's initialisation. Not awaited — the drawing below does not
            // depend on which key the record is stored under, and a render that
            // waited on storage would drop a frame of the tab every time.
            this._adoptGuildName().catch(() => {});

            root.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
            if (!tiles.length) return;

            const counts = participantCounts();
            const timeLeftMs = this._timeLeftMs(root);
            const trialsForPayout = [];
            const bonuses = this._payoutBonuses();

            for (const tile of tiles) {
                const record = this.record.tiles[tileKey(tile)];
                if (!record) continue;

                // The card's own "1/28 signed up" beats the socket count where
                // it exists: it is the number the game is showing the player,
                // and it needs no name-to-hrid match to be believed
                const hrid = matchTrialHrid(tile.name, Object.keys(counts));
                const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
                const analysis = analyseTrial(record, {
                    participants,
                    timeLeftMs,
                    buildersHallBonus: bonuses.buildersHall.bonus,
                });

                trialsForPayout.push({
                    name: tile.name,
                    type: tile.kind,
                    banked: analysis.tiersClearedSoFar,
                    projected: analysis.pace?.tiersCleared ?? analysis.tiersClearedSoFar,
                    tierKnown: analysis.tierKnown,
                    points: analysis.points,
                    pointsByTier: analysis.pointsByTier,
                });

                const block = document.createElement('div');
                block.className = CSS_CLASS;
                block.style.cssText =
                    'position:static; display:block; box-sizing:border-box; clear:both;' +
                    'margin:6px 0 8px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                    'border-radius:6px; font-size:11px; line-height:1.6;';
                block.innerHTML = renderTrialBlock(analysis, participants, undefined, {
                    participating: ownParticipation(tile.name),
                });
                placeTrialBlock(root, tile.element, block, tile.name);
            }

            this._renderPayout(root, trialsForPayout, tiles[0]?.element || null, bonuses);
        } catch (error) {
            console.error('[GuildTrials] Drawing the trial panel failed:', error);
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
        const fromStatus = parseClockMs(statusRow?.textContent || '');
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
     */
    _renderPayout(root, trials, firstTile = null, payoutBonuses = null) {
        if (!trials.length) return;

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

        const wrapper = document.createElement('div');
        wrapper.className = CSS_CLASS;
        wrapper.style.cssText =
            'margin:8px 0 4px; padding:8px 12px; background:rgba(0,0,0,0.25);' +
            'border-radius:6px; font-size:12px; line-height:1.7;';

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

        wrapper.innerHTML = rows.join('');

        // Under the game's own status row when there is one. Otherwise directly
        // above the first card, which is where it belongs and — unlike the
        // panel's own top edge — is somewhere the reader is already looking when
        // the root being drawn into is a whole guild panel.
        const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
        if (statusRow) statusRow.insertAdjacentElement('afterend', wrapper);
        else if (firstTile?.isConnected) firstTile.insertAdjacentElement('beforebegin', wrapper);
        else root.insertAdjacentElement('afterbegin', wrapper);
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
            return (
                `${cards} Part of this total is derived from the tier ladder instead, for trials whose card ` +
                'was never on screen.'
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
        guildLoadoutCapture.cleanup();
        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
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
