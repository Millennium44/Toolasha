/**
 * Leaderboard XP Display
 * Adds Last XP/h and Last day XP/h columns to the player Leaderboard panel.
 */

import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import { leaderboardXPTracker, isLevelBoard, isWeeklyBoard } from './leaderboard-xp-tracker.js';
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
 * The week figure: the 7-day-window rate scaled to a week when two readings
 * sit more than a day apart within it; else the day figure projected over a
 * week and marked.
 * @param {Object} stats - From the tracker
 * @returns {{value: number, projected: boolean}}
 */
export function xpPerWeek(stats) {
    const day = 24 * 60 * 60 * 1000;
    if (stats?.lastWeekXPH > 0 && stats.weekReadings >= 2 && stats.weekSpanMs > day) {
        return { value: stats.lastWeekXPH * 24 * 7, projected: false };
    }
    const perDay = xpPerDay(stats);
    return perDay.value > 0 ? { value: perDay.value * 7, projected: true } : { value: 0, projected: false };
}

/**
 * How far down a level board a row may sit and still hold a rate rank.
 * @type {number}
 */
export const LEVEL_RATE_RANK_CUTOFF = 100;

const INELIGIBLE_TITLE =
    `Only the top ${LEVEL_RATE_RANK_CUTOFF} of this board are ranked on levels gained — a lower level costs far ` +
    'less XP, so players further down gain levels faster and would win a levels-per-day ranking outright. ' +
    'The rate is still measured, it just does not take a place.';

/**
 * Whether a row may hold a rate rank on this board.
 *
 * On XP-style boards everyone tracked may: XP per hour is comparable between
 * any two players. On a level board it is not — each level costs more XP than
 * the last, so a rank-1199 player out-gains the whole top of the board on
 * levels per day. There, only the top {@link LEVEL_RATE_RANK_CUTOFF} by level
 * are ranked against each other; the row's own board rank is the test.
 * @param {string} category - `leaderboardCategory`
 * @param {number|null} rank - The row's rank on the board, as the game gives it
 * @returns {boolean}
 */
export function rateRankEligible(category, rank) {
    if (!isLevelBoard(category)) return true;
    return Number.isFinite(rank) && rank >= 1 && rank <= LEVEL_RATE_RANK_CUTOFF;
}

/**
 * Number every row's rates against the rows eligible to be ranked, and mark
 * each row with whether it is one of them.
 *
 * The ineligible rows are left without a rank rather than ranked and hidden:
 * they must not displace an eligible row's place either.
 * @param {Array<Object>} allStats - The page's rows, each with `rank`, `lastXPH`, `perDay`, `perWeek`
 * @param {string} category - `leaderboardCategory`
 * @returns {Array<Object>} The same array, marked
 */
export function assignRateRanks(allStats, category) {
    const pool = [];
    for (const s of allStats) {
        s.rateRankEligible = rateRankEligible(category, s.rank);
        s.lastXPH_rank = null;
        s.perDay_rank = null;
        s.perWeek_rank = null;
        if (s.rateRankEligible) pool.push(s);
    }
    const rankBy = (valueOf, field) => {
        pool.slice()
            .sort((a, b) => valueOf(b) - valueOf(a))
            .forEach((s, i) => {
                s[field] = i + 1;
            });
    };
    rankBy((s) => Number(s.lastXPH) || 0, 'lastXPH_rank');
    rankBy((s) => Number(s.perDay?.value) || 0, 'perDay_rank');
    rankBy((s) => Number(s.perWeek?.value) || 0, 'perWeek_rank');
    return allStats;
}

/**
 * The medal or place beside a rate — or a dim dash for a row that measures a
 * rate but is not ranked on it.
 * @param {Object} stats - The row, marked by {@link assignRateRanks}
 * @param {number|null} rank - The row's place in that rate's ranking
 * @returns {string} Markup
 */
function rateRankMark(stats, rank) {
    if (stats?.rateRankEligible === false || !Number.isFinite(rank)) {
        return `<span style="opacity:0.35;" title="${esc(INELIGIBLE_TITLE)}">—</span>`;
    }
    return rankBadge(rank);
}

/**
 * Why the week column has no figure.
 * @param {Object} stats - From the tracker
 * @returns {string} Markup
 */
function unratedWeekCell(stats) {
    if (!stats?.samples) return '';
    if (stats.samples === 1) {
        return `<span style="opacity:0.35;" title="${esc(`Needs a second reading. ${HOW_READINGS_WORK}`)}">—</span>`;
    }
    return `<span style="opacity:0.35;" title="${esc('Unchanged across the readings of the last week.')}">0</span>`;
}

/**
 * How long until a row overtakes the one above it, at the two rows' rates.
 *
 * The gap closes at (mine − theirs) per hour. When the row above has no rate
 * yet it is taken as standing still and the answer is marked as a floor — it
 * is the soonest it could be, not the likely figure.
 * A row that is not eligible to be ranked on its rate (see
 * {@link rateRankEligible}) gets no forecast either — projecting a level board
 * overtake from a rate that is only fast because the levels are cheap would be
 * the same falsehood the ranking avoids.
 * @param {Object} me - Row stats: `value`, `lastXPH`, `rateRankEligible`
 * @param {Object|null} above - The row one rank up, or null (top, or off the page)
 * @returns {{hours: number, floor: boolean, reason: string}} `hours` 0 when it is not happening
 */
export function timeToOvertake(me, above) {
    if (me?.rateRankEligible === false) return { hours: 0, floor: false, reason: 'unranked' };
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
        case 'unranked':
            return dim('—', INELIGIBLE_TITLE);
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
        const unit = isLevelBoard(resolvedCategory) ? 'Lv' : boardUnit(theadTr);
        // Level and weekly boards read in days and weeks; everything else in
        // hours and days — a level a week is a rate, a level an hour is noise
        const slow = isLevelBoard(resolvedCategory) || isWeeklyBoard(resolvedCategory);

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
                perWeek: xpPerWeek(stats),
                previousRank: name ? leaderboardXPTracker.getPreviousRank(name, resolvedCategory) : null,
            });
        }
        // On a slow board the per-hour rate used for catch-up is the day rate,
        // which is the most recent figure a level board can honestly give
        if (slow) for (const s of allStats) s.lastXPH = s.perDay.value / 24;

        // Rank movement since the previous reading, in the game's own Rank cell
        for (let i = 0; i < rows.length; i++) markRankDelta(rows[i].children[0], allStats[i]);

        // Ranked among the rows eligible to be ranked — everyone on an XP
        // board, only the top of a level board
        assignRateRanks(allStats, resolvedCategory);

        // Who each row is chasing: the row one rank above it, wherever it sits
        // on the page (the personal row is drawn first, out of order). Only
        // eligible rows are chased, for the same reason they are ranked.
        const byRank = new Map();
        for (const s of allStats) {
            if (s.rank !== null && s.rateRankEligible && !byRank.has(s.rank)) byRank.set(s.rank, s);
        }
        const catchUps = allStats.map((s) => {
            const above = s.rank !== null && s.rank > 1 ? byRank.get(s.rank - 1) || null : null;
            return timeToOvertake(s, above);
        });

        const insertAfter = theadTr.children.length - 1;

        // Rates to one decimal where a whole number would hide them (levels)
        const fRate = (v) => (slow && v < 100 ? (Math.round(v * 10) / 10).toLocaleString() : fNum(v));

        const dayColumn = (position) =>
            addColumn(tableEl, CSS_PREFIX, {
                name: `${unit}/day`,
                insertAfter: position,
                data: allStats.map((s) => s.perDay.value),
                format: (v, i) => {
                    const s = allStats[i];
                    // The first rate column carries the explanation of an empty row
                    if (!v || v <= 0) return slow ? unratedCell(s) : unratedDayCell(s);
                    const figure = `${s.perDay.projected ? '~' : ''}${fRate(v)} ${rateRankMark(s, s.perDay_rank)}`;
                    return s.perDay.projected
                        ? figure +
                              ` <span style="opacity:0.55; font-size:0.85em;" title="${esc(
                                  'Projected from the rate between the last two readings — fewer than two readings ' +
                                      'within the last 24h. Open this board again tomorrow and it becomes a measured day.'
                              )}">proj.</span>`
                        : figure + spanNote(s.daySpanMs, 'across the readings of the last 24h, scaled to a day');
                },
                makeSortable: true,
                sortId: 'perDay',
                skipFirst: true,
                sortData: allStats.map((s) => s.perDay.value),
            });

        if (slow) {
            dayColumn(insertAfter);
            addColumn(tableEl, CSS_PREFIX, {
                name: `${unit}/week`,
                insertAfter: insertAfter + 1,
                data: allStats.map((s) => s.perWeek.value),
                format: (v, i) => {
                    const s = allStats[i];
                    if (!v || v <= 0) return unratedWeekCell(s);
                    const figure = `${s.perWeek.projected ? '~' : ''}${fRate(v)} ${rateRankMark(s, s.perWeek_rank)}`;
                    return s.perWeek.projected
                        ? figure +
                              ` <span style="opacity:0.55; font-size:0.85em;" title="${esc(
                                  'Projected from the readings of the last 24h — no two readings span more than a day yet.'
                              )}">proj.</span>`
                        : figure + spanNote(s.weekSpanMs, 'across the readings of the last 7 days, scaled to a week');
                },
                makeSortable: true,
                sortId: 'perWeek',
                skipFirst: true,
                sortData: allStats.map((s) => s.perWeek.value),
            });
        } else {
            addColumn(tableEl, CSS_PREFIX, {
                name: `${unit}/h`,
                insertAfter,
                data: allStats.map((s) => s.lastXPH),
                format: (v, i) =>
                    !v || v <= 0
                        ? unratedCell(allStats[i])
                        : `${fNum(v)} ${rateRankMark(allStats[i], allStats[i].lastXPH_rank)}` +
                          spanNote(allStats[i].lastSpanMs, 'between the last two readings'),
                makeSortable: true,
                sortId: 'lastXPH',
                skipFirst: true,
                sortData: allStats.map((s) => s.lastXPH),
            });
            dayColumn(insertAfter + 1);
        }

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
    cleanup: () => {
        try {
            return leaderboardXPDisplay.disable();
        } catch (error) {
            console.error('[Leaderboard XP Display] Disable failed part-way:', error);
        } finally {
            leaderboardXPDisplay.initialized = false;
        }
    },
};
