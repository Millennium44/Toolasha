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
 * Why "Last day XP/h" has no figure.
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
            if (data?.leaderboardCategory !== 'guild') {
                this._refreshLeaderboardIfVisible(data?.leaderboardCategory);
            }
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

        const allStats = [];
        for (const row of rows) {
            const name = row.children[1]?.textContent?.trim();
            const stats = name
                ? leaderboardXPTracker.getPlayerStats(name, resolvedCategory)
                : { lastXPH: 0, lastDayXPH: 0, samples: 0 };
            allStats.push({ name, ...stats });
        }

        const byLastXPH = allStats.slice().sort((a, b) => b.lastXPH - a.lastXPH);
        const byLastDayXPH = allStats.slice().sort((a, b) => b.lastDayXPH - a.lastDayXPH);
        for (let i = 0; i < byLastXPH.length; i++) byLastXPH[i].lastXPH_rank = i + 1;
        for (let i = 0; i < byLastDayXPH.length; i++) byLastDayXPH[i].lastDayXPH_rank = i + 1;

        const insertAfter = theadTr.children.length - 1;

        addColumn(tableEl, CSS_PREFIX, {
            name: 'Last XP/h',
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
            name: 'Last day XP/h',
            insertAfter: insertAfter + 1,
            data: allStats.map((s) => s.lastDayXPH),
            format: (v, i) =>
                !v || v <= 0
                    ? unratedDayCell(allStats[i])
                    : `${fNum(v)} ${rankBadge(allStats[i].lastDayXPH_rank)}` +
                      spanNote(allStats[i].daySpanMs, 'across the readings of the last 24h'),
            makeSortable: true,
            sortId: 'lastDayXPH',
            skipFirst: true,
            sortData: allStats.map((s) => s.lastDayXPH),
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
                tableEl.querySelectorAll(`th.${CSS_PREFIX}, td.${CSS_PREFIX}`).forEach((el) => el.remove());
                this._renderLeaderboard(tableEl, category);
            }
        }
    }

    disable() {
        for (const unregister of this.unregisterObservers) {
            unregister();
        }
        this.unregisterObservers = [];
        document.querySelectorAll(`.${CSS_PREFIX}`).forEach((el) => el.remove());
        this.initialized = false;
    }
}

const leaderboardXPDisplay = new LeaderboardXPDisplay();

export default {
    name: 'Leaderboard XP Display',
    initialize: () => leaderboardXPDisplay.initialize(),
    cleanup: () => leaderboardXPDisplay.disable(),
};
