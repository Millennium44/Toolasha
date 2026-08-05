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
 * the only inference here that is not measured, and it is exact for as long as
 * that rule holds.
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
 * **The game states what a tier is worth, and it wins.** The Trials tab's cards
 * carry a "600 pts" line. The tier ladder in `guild-trials-math.js` derives the
 * same figure from the in-game guide's prose, so the two can be checked against
 * each other — and where they disagree the card is believed and the block says
 * the ladder needs correcting.
 *
 * **A combat trial's DPS can be split per player.** The card's "Party DPS" is
 * measured off the boss bar and cannot say who is producing it. The fight itself
 * is an ordinary battle on the wire, so `guild-trial-damage.js` attributes it —
 * but only for fights this client is actually in, and only when the fight can be
 * shown to be the trial's.
 *
 * **Payout bonuses may be unknown.** Guild Points scale with the Builders Hall
 * and token payouts with the Treasury; both levels arrive on guild traffic and
 * the bonus-per-level table has not been located in client data. When it cannot
 * be resolved the block shows base figures and says the Buildings tab will
 * refine them — the level is captured and persisted the moment it is seen.
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
    TRIAL_ACTIVE_MS,
    TRIAL_MAX_TIER,
    estimateGrowthPerTier,
    etaMs,
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
 * @returns {{kind: string, tier: number|null, level: number|null, tiersClearedSoFar: number,
 *   rate: number|null, remaining: number|null, total: number|null, etaMs: number|null,
 *   growthPerTier: number|null, next: Object|null, pace: Object|null, samples: number,
 *   timeLeftMs: number|null}} Analysis
 */
export function analyseTrial(record, { participants = 0, timeLeftMs = null } = {}) {
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
    const tiersClearedSoFar = tierKnown ? Math.max(0, tier - 1) : 0;
    const pointsByTier = record?.pointsByTier && typeof record.pointsByTier === 'object' ? record.pointsByTier : {};

    const base = {
        kind,
        tier,
        tierKnown,
        // The card's own "600 pts", where it has been seen, against the ladder
        // this file's arithmetic is built on
        points: trialBankedBasePoints({ type: kind, bankedTiers: tiersClearedSoFar, pointsByTier }),
        pointsByTier,
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

    const series = samples
        .map((sample) => ({ t: sample?.t, value: sample?.readings?.[index]?.current }))
        .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.value));

    const latest = samples[samples.length - 1]?.readings?.[index] || null;
    const total = Number.isFinite(latest?.max) ? latest.max : null;
    const remaining = latest ? (direction === -1 ? latest.current : Math.max(0, latest.max - latest.current)) : null;

    const rate = ratePerMs(series, direction);
    const growthPerTier = base.growthPerTier;

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

    return { ...base, rate, remaining, total, etaMs: etaMs(remaining, rate), next, pace };
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
 * A number, or a dash.
 * @param {number|null} value - The number
 * @returns {string} Formatted
 */
function num(value) {
    return Number.isFinite(value) ? formatKMB(Math.round(value)) : '—';
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
    const gold = describeGuildTokenGold(tokens, 'ask');
    return {
        value: gold ? `${num(tokens)} (${gold.text})` : num(tokens),
        title: gold ? `${baseTitle} ${gold.title}` : baseTitle,
    };
}

/**
 * The block drawn under one trial tile.
 * @param {Object} analysis - From {@link analyseTrial}
 * @param {number} participants - Signed-up participants
 * @param {Object} [breakdown] - Per-player damage, from `guildTrialDamage.breakdown()`
 * @returns {string} HTML
 */
export function renderTrialBlock(analysis, participants, breakdown = guildTrialDamage.breakdown()) {
    const unit = analysis.kind === 'combat' ? 'dmg' : 'work';
    const rows = [];

    if (!Number.isFinite(analysis.rate)) {
        rows.push(line('Rate', analysis.samples < 2 ? 'measuring…' : 'no movement yet', DIM));
    } else {
        const perSecond = analysis.rate * 1000;
        rows.push(
            line(
                analysis.kind === 'combat' ? 'Party DPS' : 'Fill rate',
                `${num(perSecond)} ${unit}/s`,
                ACCENT,
                'Measured from the bar on this card, over its current tier only.'
            )
        );
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

    if (!analysis.pace) {
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
                `${analysis.tiersClearedSoFar} tier${analysis.tiersClearedSoFar === 1 ? '' : 's'}`,
                DIM,
                'A trial starts at tier 1 and climbs one at a time, so the tier on screen names what is ' +
                    'already cleared.'
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

            for (const tile of tiles) {
                const record = this.record.tiles[tileKey(tile)];
                if (!record) continue;

                // The card's own "1/28 signed up" beats the socket count where
                // it exists: it is the number the game is showing the player,
                // and it needs no name-to-hrid match to be believed
                const hrid = matchTrialHrid(tile.name, Object.keys(counts));
                const participants = record.signups?.signed ?? (hrid ? counts[hrid] : 0);
                const analysis = analyseTrial(record, { participants, timeLeftMs });

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
                // Its own block, in normal flow, and never inside the card.
                //
                // Appended *into* the card it described the game's own footer —
                // "Completed", "1/28 signed up" — sat on top of these lines, because
                // a card is a fixed-height box whose last rows are placed against
                // its bottom edge rather than stacked after whatever it contains.
                // Nothing this script can set on a child fixes that. Placed after
                // the card instead, it cannot overlap anything: `flex-basis` and
                // `grid-column` make it take a whole row of its own in the two
                // layouts a card list is ever built out of.
                block.style.cssText =
                    'position:static; display:block; width:100%; box-sizing:border-box; clear:both;' +
                    'flex-basis:100%; grid-column:1 / -1;' +
                    'margin:6px 0 8px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                    'border-radius:6px; font-size:11px; line-height:1.6;';
                block.innerHTML = renderTrialBlock(analysis, participants);
                // Inside the root either way: the redraw clears its own output by
                // querying the root, so a block placed outside it would stack
                const parent = tile.element.parentElement;
                if (parent && root.contains(parent)) tile.element.insertAdjacentElement('afterend', block);
                else tile.element.appendChild(block);
            }

            this._renderPayout(root, trialsForPayout, tiles[0]?.element || null);
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
     * The payout block: what is banked, and what the current pace would add.
     * @param {Element} root - The trials content element
     * @param {Array<{name: string, type: string, banked: number, projected: number}>} trials - This week's trials
     * @param {Element|null} [firstTile] - The topmost trial card, for placement when there is no status row
     */
    _renderPayout(root, trials, firstTile = null) {
        if (!trials.length) return;

        const bonuses = readPayoutBonuses();
        const buildersHallBonus = bonuses.buildersHall.bonus;
        const treasuryBonus = bonuses.treasury.bonus;

        const banked = payoutProjection({
            trials: trials.map((trial) => ({
                ...trial,
                tiersCleared: trial.banked,
                // The game's own figure where a card has stated one for the tier
                // that was banked; the ladder otherwise. `trialBankedBasePoints`
                // decides which, and says so.
                basePointsOverride: trial.points?.source === 'ladder' ? undefined : trial.points?.basePoints,
            })),
            buildersHallBonus,
            treasuryBonus,
        });
        const projected = payoutProjection({
            trials: trials.map((trial) => ({ ...trial, tiersCleared: trial.projected })),
            buildersHallBonus,
            treasuryBonus,
        });

        // Which of the three states the banked figure is in. They are three
        // different things and they all used to render as `0`, which is the one
        // reading that is never right.
        const anyTierKnown = trials.some((trial) => trial.tierKnown);
        const anyBanked = trials.some((trial) => trial.banked > 0);

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
              : line('Guild Points banked', num(banked.guildPoints), GOOD, this._pointsProvenance(trials));

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;">Trial payout</div>`,
            bankedRow,
            line('Guild Points on pace', num(projected.guildPoints), ACCENT),
            line('Tokens, every eligible member', eligible.value, ACCENT, eligible.title),
            line('Tokens, if you took part', participant.value, GOOD, participant.title),
        ];

        const disagreement = trials.find((trial) => trial.points?.interpretation === 'disagrees');
        if (disagreement?.points?.quoted) {
            const { tier, statedPoints } = disagreement.points.quoted;
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    `${disagreement.name} T${tier} says ${formatWithSeparator(statedPoints)} pts, which matches ` +
                    'neither the running total nor the per-tier step this script derives. The game’s number is ' +
                    'used where it covers a banked tier — the ladder here needs correcting.</div>'
            );
        }

        if (!banked.bonusesKnown) {
            const missing = [];
            if (!Number.isFinite(buildersHallBonus)) missing.push('Builders Hall');
            if (!Number.isFinite(treasuryBonus)) missing.push('Treasury');
            rows.push(
                `<div style="color:${WARN}; margin-top:4px;">` +
                    `Base figures — no ${missing.join(' or ')} bonus applied. ` +
                    'Open the guild Buildings tab once and it will be picked up, or set it in Toolasha settings.</div>'
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
        if (sources.has('game') && sources.size === 1) {
            return 'Taken from the points each trial card states, not from this script’s tier ladder.';
        }
        if (sources.has('game') || sources.has('mixed')) {
            return (
                'Part read from the points the trial cards state and part derived from the tier ladder, ' +
                'for tiers whose card was never on screen.'
            );
        }
        return (
            'Derived from the tier ladder — 200 + 100 per extra tier for skilling, 400 + 200 for combat. ' +
            'Open the Trials tab and the game’s own “N pts” is used instead.'
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
