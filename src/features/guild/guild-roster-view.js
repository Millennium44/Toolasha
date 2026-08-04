/**
 * Guild roster
 *
 * Who is actually carrying the guild, and who has stopped.
 *
 * The game shows each member's total guild XP, which is a career figure: it
 * ranks whoever joined first, not whoever contributed this week, and a member
 * who quit a month ago still sits near the top of it. The tracker has been
 * recording per-member XP over time for its XP/h columns, and that same series
 * answers the questions the total cannot — what share of the last week's XP each
 * member produced, and whose rate has collapsed since yesterday.
 *
 * ## Shares are of what was actually observed
 *
 * A share is one member's XP gain over a window divided by the whole roster's
 * gain over the same window. Members with fewer than two samples in the window
 * contribute nothing to either side rather than counting as zero — the
 * difference between "earned nothing" and "was not being watched" is the whole
 * point of the gone-quiet flag below, and folding the second into the first
 * would make every newly tracked member look idle.
 *
 * ## Gone quiet is a comparison, not a threshold
 *
 * "Idle" cannot be a fixed XP/h, because a strong member coasting still outpaces
 * a weak one going flat out. The flag is each member against *themselves*: a
 * day rate that has collapsed against their own week rate. That catches the
 * member who stopped playing on Tuesday and leaves the steady one alone.
 *
 * The arithmetic below is pure and exported for tests; the tracker is asked for
 * its samples through its read API rather than reaching into storage.
 */

import config from '../../core/config.js';
import { formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { guildXPTracker } from './guild-xp-tracker.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const WINDOW_7D = 7 * DAY;
export const WINDOW_30D = 30 * DAY;

/** A day rate this far below the week rate reads as having stopped */
export const QUIET_RATIO = 0.25;

/** Below this the week rate is too small for its collapse to mean anything */
export const QUIET_MIN_WEEK_RATE = 1;

const ACCENT = '#c0b0ff';

/**
 * XP gained inside a window, and how much of the window the samples cover.
 *
 * Both matter: a delta over twenty minutes and a delta over six days are not
 * comparable, and a caller that only sees the delta cannot tell them apart.
 *
 * @param {Array<{t: number, xp: number}>} series - Samples, oldest first
 * @param {number} windowMs - How far back to look
 * @param {number} [now] - Clock
 * @returns {{delta: number, spanMs: number}|null} Null when fewer than two samples land in the window
 */
export function seriesDelta(series, windowMs, now = Date.now()) {
    if (!Array.isArray(series) || series.length < 2) return null;
    const cutoff = now - windowMs;
    const inWindow = series.filter((sample) => sample && sample.t >= cutoff);
    if (inWindow.length < 2) return null;

    const first = inWindow[0];
    const last = inWindow[inWindow.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs <= 0) return null;

    return { delta: Math.max(0, last.xp - first.xp), spanMs };
}

/**
 * XP per hour across a window.
 * @param {Array<{t: number, xp: number}>} series - Samples, oldest first
 * @param {number} windowMs - How far back to look
 * @param {number} [now] - Clock
 * @returns {number|null} XP/hr, or null when the window holds no measurable span
 */
export function ratePerHour(series, windowMs, now = Date.now()) {
    const measured = seriesDelta(series, windowMs, now);
    if (!measured) return null;
    return (measured.delta / measured.spanMs) * HOUR;
}

/**
 * Has this member stopped?
 * @param {number|null} dayRate - Their XP/hr over the last day
 * @param {number|null} weekRate - Their XP/hr over the last week
 * @returns {boolean} True when the day rate has collapsed against their own week
 */
export function isGoneQuiet(dayRate, weekRate) {
    if (!Number.isFinite(weekRate) || weekRate < QUIET_MIN_WEEK_RATE) return false;
    // No day measurement at all is the loudest version of this signal
    const day = Number.isFinite(dayRate) ? dayRate : 0;
    return day < weekRate * QUIET_RATIO;
}

/**
 * Turn deltas into percentage shares of the roster's total.
 * @param {Array<{delta: number|null}>} entries - Anything with a delta
 * @returns {number[]} Share per entry, 0-100; all zero when nothing was earned
 */
export function contributionShares(entries) {
    const total = (entries || []).reduce((sum, entry) => sum + (Number.isFinite(entry?.delta) ? entry.delta : 0), 0);
    if (total <= 0) return (entries || []).map(() => 0);
    return (entries || []).map((entry) => ((Number.isFinite(entry?.delta) ? entry.delta : 0) / total) * 100);
}

/**
 * Where a guild's XP lands after a stretch at its current rate.
 * @param {number} currentXP - XP now
 * @param {number|null} xpPerHour - Current rate
 * @param {number} hours - How far ahead
 * @returns {number|null} Projected XP, or null without a rate
 */
export function projectGuildXP(currentXP, xpPerHour, hours) {
    if (!Number.isFinite(currentXP) || !Number.isFinite(xpPerHour) || xpPerHour <= 0) return null;
    return currentXP + xpPerHour * hours;
}

/**
 * The roster, ranked by what each member did this week.
 *
 * @param {Object} input - Everything this needs, so it can be tested without the tracker
 * @param {Object<string, Array<{t: number, xp: number}>>} input.series - characterID → samples
 * @param {Object<string, {name: string}>} input.meta - characterID → metadata
 * @param {number} [input.now] - Clock
 * @returns {Array<Object>} One row per member, best 7-day share first
 */
export function buildRoster({ series, meta = {}, now = Date.now() }) {
    const ids = Object.keys(series || {});

    const rows = ids.map((characterID) => {
        const samples = series[characterID] || [];
        const week = seriesDelta(samples, WINDOW_7D, now);
        const month = seriesDelta(samples, WINDOW_30D, now);
        const dayRate = ratePerHour(samples, DAY, now);
        const weekRate = ratePerHour(samples, WINDOW_7D, now);

        return {
            characterID,
            name: meta[characterID]?.name || `#${characterID}`,
            samples: samples.length,
            delta: week ? week.delta : null,
            delta7d: week ? week.delta : null,
            delta30d: month ? month.delta : null,
            spanMs: week ? week.spanMs : 0,
            dayRate,
            weekRate,
            quiet: isGoneQuiet(dayRate, weekRate),
            totalXP: samples.length ? samples[samples.length - 1].xp : null,
        };
    });

    const shares7d = contributionShares(rows);
    const shares30d = contributionShares(rows.map((r) => ({ delta: r.delta30d })));
    rows.forEach((memberRow, index) => {
        memberRow.share7d = shares7d[index];
        memberRow.share30d = shares30d[index];
    });

    return rows.sort((a, b) => (b.share7d ?? 0) - (a.share7d ?? 0) || (b.totalXP ?? 0) - (a.totalXP ?? 0));
}

/**
 * The roster as the panel and the tile both need it, read from the tracker.
 * @returns {{guildName: string|null, rows: Array<Object>, level: Object|null, guildRate: number|null}|null}
 */
export function rosterSnapshot() {
    const guildName = guildXPTracker.getOwnGuildName();
    const series = guildXPTracker.getAllMemberSeries();
    const meta = {};
    for (const member of guildXPTracker.getMemberList()) meta[member.characterID] = member;

    const guildSeries = guildName ? guildXPTracker.getGuildSeries(guildName) : [];

    return {
        guildName,
        rows: buildRoster({ series, meta }),
        level: guildName ? guildXPTracker.getGuildLevelProgress(guildName) : null,
        guildRate: ratePerHour(guildSeries, WINDOW_7D),
        guildDayRate: ratePerHour(guildSeries, DAY),
    };
}

/**
 * A percentage, or a dash.
 * @param {number|null} value - 0-100
 * @returns {string}
 */
function percent(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}%` : '—';
}

/**
 * XP, or a dash.
 * @param {number|null} value - XP
 * @returns {string}
 */
function xp(value) {
    return Number.isFinite(value) ? formatKMB(Math.round(value)) : '—';
}

export const guildRosterPanel = createPanel({
    id: 'guildRoster',
    title: 'Guild Roster',
    size: { width: 430, height: 470 },
    accent: ACCENT,
    draw: (body) => {
        const snapshot = rosterSnapshot();
        if (!snapshot?.guildName) {
            body.appendChild(panelNote('No guild data yet.'));
            body.appendChild(panelNote('Open the Guild tab once so the tracker has something to record.'));
            return;
        }

        const { guildName, rows, level, guildRate, guildDayRate } = snapshot;

        const guild = panelCard(body, guildName, ACCENT);
        if (level) {
            guild.appendChild(panelLine('Level', String(level.level), ROW_COLORS.gold));
            guild.appendChild(panelLine('Guild XP', xp(level.currentXP), ROW_COLORS.dim));
            if (level.xpToNext !== null) {
                guild.appendChild(panelLine('To next level', xp(level.xpToNext), ROW_COLORS.dim));
            }
        }
        guild.appendChild(panelLine('XP/h (week)', xp(guildRate), ROW_COLORS.dim));
        guild.appendChild(panelLine('XP/h (day)', xp(guildDayRate), ROW_COLORS.dim));

        const rate = Number.isFinite(guildRate) && guildRate > 0 ? guildRate : guildDayRate;
        const in7d = projectGuildXP(level?.currentXP ?? NaN, rate, 7 * 24);
        const in30d = projectGuildXP(level?.currentXP ?? NaN, rate, 30 * 24);
        if (in7d !== null) {
            guild.appendChild(
                panelLine(
                    'Projected in 7d',
                    xp(in7d),
                    ROW_COLORS.good,
                    'Current rate held flat — a projection, not a promise.'
                )
            );
            guild.appendChild(panelLine('Projected in 30d', xp(in30d), ROW_COLORS.good));
        }

        const quiet = rows.filter((member) => member.quiet);
        if (quiet.length) {
            const card = panelCard(body, `Gone quiet (${quiet.length})`, ROW_COLORS.bad);
            for (const member of quiet) {
                card.appendChild(
                    panelLine(
                        member.name,
                        `${xp(member.dayRate)}/h today vs ${xp(member.weekRate)}/h this week`,
                        ROW_COLORS.bad
                    )
                );
            }
        }

        const contributing = rows.filter((member) => Number.isFinite(member.delta7d) && member.delta7d > 0);
        const card = panelCard(body, `Contribution (${contributing.length} of ${rows.length} measured)`, ACCENT);
        if (!contributing.length) {
            card.appendChild(panelNote('No member has two samples in the last week yet.'));
        }
        for (const member of contributing) {
            card.appendChild(
                panelLine(
                    `${member.name}${member.quiet ? ' ·' : ''}`,
                    `${percent(member.share7d)} 7d · ${percent(member.share30d)} 30d · ${xp(member.delta7d)} XP`,
                    member.quiet ? ROW_COLORS.bad : ROW_COLORS.gold,
                    `${member.samples} samples recorded.\nShares are of the XP actually observed, not of career totals.`
                )
            );
        }
    },
});

/**
 * Register the overlay tile. Called from `initialize` so a switched-off feature
 * leaves no tile and no command palette entry behind.
 */
export function registerGuildRosterRow() {
    registerRow({
        key: 'guildRoster',
        name: 'Guild Roster',
        empty: 'No guild data',
        defaultVisible: false,
        defaultSize: { width: 230, height: 30 },
        render: (container) => {
            const snapshot = rosterSnapshot();
            const top = snapshot?.rows?.find((member) => Number.isFinite(member.share7d) && member.share7d > 0);
            if (!top) return blank(container);

            const quiet = snapshot.rows.filter((member) => member.quiet).length;
            row(container, [
                { text: top.name, color: ROW_COLORS.dim, ellipsis: true },
                { text: percent(top.share7d), color: ROW_COLORS.gold },
                { text: quiet ? `${quiet} quiet` : 'all active', color: quiet ? ROW_COLORS.bad : ROW_COLORS.good },
            ]);
            container.title =
                `${top.name} produced ${percent(top.share7d)} of the guild XP observed this week.` +
                (quiet ? `\n${quiet} member(s) have gone quiet against their own weekly rate.` : '') +
                '\nDouble-click for the whole roster.';
        },
        onOpen: () => guildRosterPanel.toggle(),
    });
}

export default {
    name: 'Guild Roster',
    initialize: () => {
        if (!config.getSetting('guildRoster', true)) return;
        registerGuildRosterRow();
    },
    cleanup: () => guildRosterPanel.hide({ remember: false }),
};
