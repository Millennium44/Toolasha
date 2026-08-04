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
 * **Payout bonuses may be unknown.** Guild Points scale with the Builders Hall
 * and token payouts with the Treasury; both levels arrive on guild traffic and
 * the bonus-per-level table has not been located in client data. When it cannot
 * be resolved the block shows base figures and says the Buildings tab will
 * refine them — the level is captured and persisted the moment it is seen.
 */

import config from '../../core/config.js';
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
    trialWeekStart,
} from './guild-trials-math.js';
import { classifyReadings, matchTrialHrid, parseClockMs, readTrialTiles } from './guild-trials-scrape.js';
import {
    loadTrialRecord,
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
 *   growthPerTier: number|null, next: Object|null, pace: Object|null, samples: number}} Analysis
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

    const base = {
        kind,
        tier,
        level: Number.isFinite(record?.level) ? record.level : null,
        tiersClearedSoFar: Number.isFinite(tier) ? Math.max(0, tier - 1) : 0,
        rate: null,
        remaining: null,
        total: null,
        etaMs: null,
        growthPerTier: estimateGrowthPerTier(observations),
        next: null,
        pace: null,
        samples: samples.length,
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
 * The block drawn under one trial tile.
 * @param {Object} analysis - From {@link analyseTrial}
 * @param {number} participants - Signed-up participants
 * @returns {string} HTML
 */
export function renderTrialBlock(analysis, participants) {
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

    rows.push(
        line(
            'Banked',
            `${analysis.tiersClearedSoFar} tier${analysis.tiersClearedSoFar === 1 ? '' : 's'}`,
            DIM,
            'A trial starts at tier 1 and climbs one at a time, so the tier on screen names what is already cleared.'
        )
    );

    return rows.join('');
}

class GuildTrials {
    constructor() {
        this.initialized = false;
        this.unregister = [];
        this.timers = createTimerRegistry();
        this.record = null;
        this.guildName = null;
    }

    async initialize() {
        if (this.initialized) return;
        if (!config.getSetting('guildTrialsInfo', true)) return;

        this.guildName = guildXPTracker.getOwnGuildName?.() || null;
        this.record = await loadTrialRecord(this.guildName);

        this.unregister.push(
            domObserver.onClass('GuildTrials', 'GuildPanel_trialsContent', (el) => this._onTab(el), {
                debounce: true,
                debounceDelay: 100,
            })
        );

        this._refresh = () => this._render(document.querySelector('[class*="GuildPanel_trialsContent"]'));
        for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
            webSocketHook.on(type, this._refresh);
        }
        this.unregister.push(() => {
            for (const type of ['guild_updated', 'guild_characters_updated', 'guild_trial_signup_updated']) {
                webSocketHook.off(type, this._refresh);
            }
        });

        this.timers.registerInterval(
            setInterval(() => {
                const el = document.querySelector('[class*="GuildPanel_trialsContent"]');
                if (el?.isConnected) this._render(el);
            }, SAMPLE_MS)
        );

        this.initialized = true;
    }

    /**
     * The tab appeared or changed.
     * @param {Element} el - The trials content element
     */
    _onTab(el) {
        this._render(el);
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

            const tiles = readTrialTiles(root);
            for (const tile of tiles) this.record = recordTileSample(this.record, tile, now);
            if (tiles.length) saveTrialRecord(this.guildName, this.record);

            root.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
            if (!tiles.length) return;

            const counts = participantCounts();
            const timeLeftMs = this._timeLeftMs(root);
            const trialsForPayout = [];

            for (const tile of tiles) {
                const record = this.record.tiles[tileKey(tile)];
                if (!record) continue;

                const hrid = matchTrialHrid(tile.name, Object.keys(counts));
                const participants = hrid ? counts[hrid] : 0;
                const analysis = analyseTrial(record, { participants, timeLeftMs });

                trialsForPayout.push({
                    name: tile.name,
                    type: tile.kind,
                    banked: analysis.tiersClearedSoFar,
                    projected: analysis.pace?.tiersCleared ?? analysis.tiersClearedSoFar,
                });

                const block = document.createElement('div');
                block.className = CSS_CLASS;
                block.style.cssText =
                    'margin:6px 0 2px; padding:6px 10px; background:rgba(0,0,0,0.25);' +
                    'border-radius:6px; font-size:11px; line-height:1.6;';
                block.innerHTML = renderTrialBlock(analysis, participants);
                tile.element.appendChild(block);
            }

            this._renderPayout(root, trialsForPayout);
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
     * @param {Element} root - The trials content element
     * @returns {number|null} Milliseconds, or null when the tab shows no clock
     */
    _timeLeftMs(root) {
        const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
        const fromStatus = parseClockMs(statusRow?.textContent || '');
        if (fromStatus !== null) return Math.min(fromStatus, TRIAL_ACTIVE_MS);

        const fromTab = parseClockMs(root.textContent || '');
        return fromTab === null ? null : Math.min(fromTab, TRIAL_ACTIVE_MS);
    }

    /**
     * The payout block: what is banked, and what the current pace would add.
     * @param {Element} root - The trials content element
     * @param {Array<{name: string, type: string, banked: number, projected: number}>} trials - This week's trials
     */
    _renderPayout(root, trials) {
        if (!trials.length) return;

        const bonuses = readPayoutBonuses();
        const buildersHallBonus = bonuses.buildersHall.bonus;
        const treasuryBonus = bonuses.treasury.bonus;

        const banked = payoutProjection({
            trials: trials.map((trial) => ({ ...trial, tiersCleared: trial.banked })),
            buildersHallBonus,
            treasuryBonus,
        });
        const projected = payoutProjection({
            trials: trials.map((trial) => ({ ...trial, tiersCleared: trial.projected })),
            buildersHallBonus,
            treasuryBonus,
        });

        const wrapper = document.createElement('div');
        wrapper.className = CSS_CLASS;
        wrapper.style.cssText =
            'margin:8px 0 4px; padding:8px 12px; background:rgba(0,0,0,0.25);' +
            'border-radius:6px; font-size:12px; line-height:1.7;';

        const rows = [
            `<div style="color:${ACCENT}; font-weight:700; margin-bottom:2px;">Trial payout</div>`,
            line('Guild Points banked', num(banked.guildPoints), GOOD),
            line('Guild Points on pace', num(projected.guildPoints), ACCENT),
            line(
                'Tokens, every eligible member',
                num(projected.eligibleTokens),
                ACCENT,
                'Half the total base points, paid to every member who joined before the week started.'
            ),
            line(
                'Tokens, if you took part',
                num(projected.participantTokens),
                GOOD,
                'The eligible payout plus a further 50% of it for participating.'
            ),
        ];

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

        const statusRow = root.querySelector('[class*="GuildPanel_eventStatusRow"]');
        if (statusRow) statusRow.insertAdjacentElement('afterend', wrapper);
        else root.insertAdjacentElement('afterbegin', wrapper);
    }

    cleanup() {
        for (const unregister of this.unregister) unregister();
        this.unregister = [];
        this.timers.clearAll();
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
