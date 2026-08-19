/**
 * Leaderboard XP Display
 * Adds Last XP/h and Last day XP/h columns to the player Leaderboard panel.
 */

import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import { leaderboardXPTracker } from './leaderboard-xp-tracker.js';
import { fNum, rankBadge, addColumn, makeColumnSortable } from '../../utils/table-columns.js';

const CSS_PREFIX = 'mwi-leaderboard-xp';

/** A short "3m" / "2h" / "5d" for a span or an age */
function shortSpan(ms) {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${Math.max(m, 1)}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h`;
    return `${Math.round(h / 24)}d`;
}

const esc = (text) => String(text).replace(/"/g, '&quot;');

const HOW_READINGS_WORK =
    'A reading is taken each time you open this board, and the board itself moves every 20 minutes — ' +
    'so a rate needs this board opened twice, at least 20 minutes apart, with the player on it both times.';

/**
 * The span a rate was measured over, beside the figure — "3w" is not the same
 * fact as "20m", and without it the column could not tell the two apart.
 * @param {number} spanMs - The span
 * @param {string} what - What the span is between, for the tooltip
 * @returns {string} Markup, empty for no span
 */
function spanNote(spanMs, what) {
    if (!(spanMs > 0)) return '';
    const span = shortSpan(spanMs);
    return (
        ` <span style="opacity:0.55; font-size:0.85em;" title="${esc(`Measured ${what}, ${span} apart.`)}">` +
        `${span}</span>`
    );
}

/**
 * Why "Last XP/h" has no figure — a dim marker that explains itself on hover,
 * instead of a blank that looks like a broken column.
 * @param {Object} stats - From the tracker
 * @returns {string} Markup
 */
function unratedCell(stats) {
    if (!stats?.samples) {
        const title = esc(`No reading of this player on this board yet. ${HOW_READINGS_WORK}`);
        return `<span style="opacity:0.35;" title="${title}">·</span>`;
    }
    if (stats.samples === 1) {
        const age = stats.lastSeenAt ? shortSpan(Date.now() - stats.lastSeenAt) : '?';
        const title = esc(`One reading so far, ${age} ago. ${HOW_READINGS_WORK}`);
        return `<span style="opacity:0.35;" title="${title}">1 reading</span>`;
    }
    return `<span style="opacity:0.35;" title="${esc('XP unchanged between the last two readings.')}">0</span>`;
}

/**
 * What a board counts, read off its own value column header: "Experience" is
 * XP; "Guild Points", "Task Points", "Weekly Points" are Points; anything else
 * is taken as written ("Buildings", "Depth").
 * @param {Element} theadTr - The board's header row, before this module's columns
 * @returns {string} The unit, for "XP/h" / "Points/h"
 */
export function boardUnit(theadTr) {
    const native = Array.from(theadTr?.children || []).filter((th) => !th.classList.contains(CSS_PREFIX));
    const text = native[native.length - 1]?.textContent?.replace(/[△▽▲▼]/g, '').trim() || '';
    if (!text || /experience/i.test(text)) return 'XP';
    if (/points?$/i.test(text)) return 'Points';
    return text;
}

/**
 * Rank movement since the previous reading, appended to the game's Rank cell:
 * "▲2" for two places up, "▼1" for one down, nothing when unchanged or unknown.
 * @param {Element} rankCell - The row's first cell
 * @param {Object} stats - The row, with `rank` and `previousRank`
 */
function markRankDelta(rankCell, stats) {
    if (!rankCell) return;
    rankCell.querySelector(`.${CSS_PREFIX}-delta`)?.remove();
    const previous = stats?.previousRank;
    if (!previous || !Number.isFinite(stats.rank) || previous.rank === stats.rank) return;
    const up = previous.rank - stats.rank; // a smaller number is a better rank
    const span = document.createElement('span');
    span.className = `${CSS_PREFIX}-delta`;
    span.style.cssText = `margin-left:4px; font-size:0.8em; color:${up > 0 ? '#7fd6a3' : '#e07b7b'};`;
    span.textContent = `${up > 0 ? '▲' : '▼'}${Math.abs(up)}`;
    span.title = `Was #${previous.rank} at the previous reading, ${shortSpan(Date.now() - previous.at)} ago.`;
    rankCell.appendChild(span);
}

/**
 * The day figure: the measured 24h-window rate scaled to a day when there are
 * two readings within the day, else the last rate projected over a day and
 * marked as projected — a rate is a rate, but a measured day and a guess from
 * twenty minutes are not the same fact.
 * @param {Object} stats - From the tracker
 * @returns {{value: number, projected: boolean}}
 */
export function xpPerDay(stats) {
    if (stats?.lastDayXPH > 0 && stats.dayReadings >= 2) return { value: stats.lastDayXPH * 24, projected: false };
    if (stats?.lastXPH > 0) return { value: stats.lastXPH * 24, projected: true };
    return { value: 0, projected: false };
}

/**
 * How long until a row overtakes the one above it, at the two rows' rates.
 *
 * The gap closes at (mine − theirs) per hour. When the row above has no rate
 * yet it is taken as standing still and the answer is marked as a floor — it
 * is the soonest it could be, not the likely figure.
 * @param {Object} me - Row stats: `value`, `lastXPH`
 * @param {Object|null} above - The row one rank up, or null (top, or off the page)
 * @returns {{hours: number, floor: boolean, reason: string}} `hours` 0 when it is not happening
 */
export function timeToOvertake(me, above) {
    if (!above) return { hours: 0, floor: false, reason: me?.rank === 1 ? 'top' : 'unknown-above' };
    const gap = Number(above.value) - Number(me?.value);
    if (!(Number.isFinite(gap) && gap > 0)) return { hours: 0, floor: false, reason: 'no-gap' };
    const mine = Number(me?.lastXPH) || 0;
    if (!(mine > 0)) return { hours: 0, floor: false, reason: 'no-rate' };
    const theirs = Number(above.lastXPH) || 0;
    const closing = mine - theirs;
    if (!(closing > 0)) return { hours: 0, floor: false, reason: 'not-gaining' };
    return { hours: gap / closing, floor: !(theirs > 0), reason: 'ok' };
}

/**
 * The catch-up cell: a duration, a "≥" floor marker when the row above has no
 * rate, or a dim reason.
 * @param {{hours: number, floor: boolean, reason: string}} catchUp - From {@link timeToOvertake}
 * @param {Object} stats - The row
 * @returns {string} Markup
 */
function catchUpCell(catchUp, stats) {
    const dim = (text, title) => `<span style="opacity:0.35;" title="${esc(title)}">${text}</span>`;
    switch (catchUp.reason) {
        case 'ok': {
            const span = shortSpan(catchUp.hours * 3600000);
            const who = esc(String(stats.rank - 1));
            return catchUp.floor
                ? `≥${span} <span style="opacity:0.55; font-size:0.85em;" title="${esc(
                      `At this row's XP/h, if #${who} stands still — #${who} has no rate yet, so this is the soonest it could be.`
                  )}">floor</span>`
                : `<span title="${esc(`Overtakes #${who} at the current XP/h of both rows.`)}">${span}</span>`;
        }
        case 'top':
            return dim('—', 'Already first.');
        case 'unknown-above':
            return dim('—', 'The row one rank up is not on this page.');
        case 'no-gap':
            return dim('—', 'No gap to close — tied, or the value above could not be read.');
        case 'no-rate':
            return dim('—', 'No XP/h rate for this row yet.');
        case 'not-gaining':
            return dim('—', 'Not gaining on the row above at the current rates.');
        default:
            return '';
    }
}

/**
 * Why "XP/day" has no figure.
 * @param {Object} stats - From the tracker
 * @returns {string} Markup
 */
function unratedDayCell(stats) {
    if (!stats?.samples) return '';
    if (stats.dayReadings < 2) {
        const age = stats.lastSeenAt ? shortSpan(Date.now() - stats.lastSeenAt) : '?';
        const title = esc(`Needs two readings within the last 24h; the latest is ${age} old. ${HOW_READINGS_WORK}`);
        return `<span style="opacity:0.35;" title="${title}">—</span>`;
    }
    return `<span style="opacity:0.35;" title="${esc('XP unchanged across the last 24h of readings.')}">0</span>`;
}

class LeaderboardXPDisplay {
    constructor() {
        this.initialized = false;
        this.unregisterObservers = [];
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('leaderboardXPDisplay', true)) return;

        // Only process leaderboard tables that are NOT inside the Guild panel
        const unregLeaderboard = domObserver.onClass(
            'LeaderboardXPDisplay-Leaderboard',
            'LeaderboardPanel_leaderboardTable',
            (el) => {
                if (!el.closest('[class*="GuildPanel"]')) this._renderLeaderboard(el);
            }
        );
        this.unregisterObservers.push(unregLeaderboard);

        this._boundRefreshLeaderboard = (data) => {
            this._refreshLeaderboardIfVisible(data?.leaderboardCategory);
        };
        webSocketHook.on('leaderboard_updated', this._boundRefreshLeaderboard);
        this.unregisterObservers.push(() => webSocketHook.off('leaderboard_updated', this._boundRefreshLeaderboard));

        this.initialized = true;
    }

    _renderLeaderboard(tableEl, category) {
        if (tableEl.querySelector(`th.${CSS_PREFIX}`)) return;

        const resolvedCategory = category || leaderboardXPTracker.getLastLeaderboardCategory();

        const containerEl = tableEl.closest('[class*="LeaderboardPanel_content"]');
        if (containerEl) containerEl.style.maxWidth = '1000px';

        const tbodyEl = tableEl.querySelector('tbody');
        if (!tbodyEl) return;

        const rows = Array.from(tbodyEl.children);
        const theadTr = tableEl.querySelector('thead tr');
        if (!theadTr) return;

        // What the board counts, from its own last native column — "Experience"
        // is XP, "Guild Points" and "Task Points" are points, and the rate
        // columns should say so rather than calling everything XP
        const unit = boardUnit(theadTr);

        const allStats = [];
        for (const row of rows) {
            const name = row.children[1]?.textContent?.trim();
            const stats = name
                ? leaderboardXPTracker.getPlayerStats(name, resolvedCategory)
                : { lastXPH: 0, lastDayXPH: 0, samples: 0 };
            // The game's own rank and value for the row, for the catch-up column
            const rankText = row.children[0]?.textContent?.replace(/[^\d]/g, '') || '';
            allStats.push({
                name,
                ...stats,
                rank: rankText ? parseInt(rankText, 10) : null,
                value: leaderboardXPTracker.getLatestValue(name, resolvedCategory),
                perDay: xpPerDay(stats),
                previousRank: name ? leaderboardXPTracker.getPreviousRank(name, resolvedCategory) : null,
            });
        }

        // Rank movement since the previous reading, in the game's own Rank cell
        for (let i = 0; i < rows.length; i++) markRankDelta(rows[i].children[0], allStats[i]);

        const byLastXPH = allStats.slice().sort((a, b) => b.lastXPH - a.lastXPH);
        const byPerDay = allStats.slice().sort((a, b) => b.perDay.value - a.perDay.value);
        for (let i = 0; i < byLastXPH.length; i++) byLastXPH[i].lastXPH_rank = i + 1;
        for (let i = 0; i < byPerDay.length; i++) byPerDay[i].perDay_rank = i + 1;

        // Who each row is chasing: the row one rank above it, wherever it sits
        // on the page (the personal row is drawn first, out of order)
        const byRank = new Map();
        for (const s of allStats) if (s.rank !== null && !byRank.has(s.rank)) byRank.set(s.rank, s);
        const catchUps = allStats.map((s) => {
            const above = s.rank !== null && s.rank > 1 ? byRank.get(s.rank - 1) || null : null;
            return timeToOvertake(s, above);
        });

        const insertAfter = theadTr.children.length - 1;

        addColumn(tableEl, CSS_PREFIX, {
            name: `${unit}/h`,
            insertAfter,
            data: allStats.map((s) => s.lastXPH),
            format: (v, i) =>
                !v || v <= 0
                    ? unratedCell(allStats[i])
                    : `${fNum(v)} ${rankBadge(allStats[i].lastXPH_rank)}` +
                      spanNote(allStats[i].lastSpanMs, 'between the last two readings'),
            makeSortable: true,
            sortId: 'lastXPH',
            skipFirst: true,
            sortData: allStats.map((s) => s.lastXPH),
        });

        addColumn(tableEl, CSS_PREFIX, {
            name: `${unit}/day`,
            insertAfter: insertAfter + 1,
            data: allStats.map((s) => s.perDay.value),
            format: (v, i) => {
                const s = allStats[i];
                if (!v || v <= 0) return unratedDayCell(s);
                const figure = `${s.perDay.projected ? '~' : ''}${fNum(v)} ${rankBadge(s.perDay_rank)}`;
                return s.perDay.projected
                    ? figure +
                          ` <span style="opacity:0.55; font-size:0.85em;" title="${esc(
                              `Projected from the ${unit}/h rate — fewer than two readings within the last 24h. ` +
                                  'Open this board again tomorrow and it becomes a measured day.'
                          )}">proj.</span>`
                    : figure + spanNote(s.daySpanMs, 'across the readings of the last 24h, scaled to a day');
            },
            makeSortable: true,
            sortId: 'perDay',
            skipFirst: true,
            sortData: allStats.map((s) => s.perDay.value),
        });

        addColumn(tableEl, CSS_PREFIX, {
            name: 'Rank ↑ in',
            insertAfter: insertAfter + 2,
            data: catchUps.map((c) => c.hours),
            format: (v, i) => catchUpCell(catchUps[i], allStats[i]),
            makeSortable: true,
            sortId: 'catchUp',
            skipFirst: true,
            // Sooner first when sorted descending; never-catching rows sink
            sortData: catchUps.map((c) => (c.hours > 0 ? 1 / c.hours : 0)),
        });

        const rankHeader = Array.from(theadTr.children).find((el) => el.textContent.trim() === 'Rank');
        if (rankHeader && !rankHeader.querySelector('.mwi-col-sort-icon')) {
            makeColumnSortable(rankHeader, {
                sortId: 'rank',
                skipFirst: true,
                valueGetter: (trEl) => {
                    const text = trEl.children[0]?.textContent?.replace(/[^\d]/g, '');
                    return text ? parseInt(text, 10) : 0;
                },
            });
        }
    }

    _refreshLeaderboardIfVisible(category) {
        const allTables = document.querySelectorAll('[class*="LeaderboardPanel_leaderboardTable"]');
        for (const tableEl of allTables) {
            if (!tableEl.closest('[class*="GuildPanel"]')) {
                tableEl
                    .querySelectorAll(`th.${CSS_PREFIX}, td.${CSS_PREFIX}, .${CSS_PREFIX}-delta`)
                    .forEach((el) => el.remove());
                this._renderLeaderboard(tableEl, category);
            }
        }
    }

    disable() {
        for (const unregister of this.unregisterObservers) {
            unregister();
        }
        this.unregisterObservers = [];
        document.querySelectorAll(`.${CSS_PREFIX}, .${CSS_PREFIX}-delta`).forEach((el) => el.remove());
        this.initialized = false;
    }
}

const leaderboardXPDisplay = new LeaderboardXPDisplay();

export default {
    name: 'Leaderboard XP Display',
    initialize: () => leaderboardXPDisplay.initialize(),
    cleanup: () => leaderboardXPDisplay.disable(),
};
