/**
 * Combat Stats overlay rows
 *
 * The figures the Combat Statistics popup already computes, on the overlay so
 * they can be watched during a run rather than opened after one.
 *
 * Nothing is calculated here that was not calculated already — `calculatePlayerStats`
 * is the same function the popup calls, given the same data. This module picks
 * the current player out of it and decides how three numbers should read.
 *
 * ## Why the cache
 *
 * The overlay redraws every second, and `calculatePlayerStats` prices every item
 * in the loot map to do it. A run with a long loot list would repeat that
 * pricing sixty times a minute for figures that move slowly. The result is held
 * briefly instead, which keeps `render` to a property read — what the overlay
 * asks of a row.
 */

import dataManager from '../../core/data-manager.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber, formatWithSeparator } from '../../utils/formatters.js';
import { row, rows, blank, shortDuration, ROW_COLORS } from '../../utils/overlay-format.js';
import combatStatsDataCollector from './combat-stats-data-collector.js';
import { calculatePlayerStats } from './combat-stats-calculator.js';

/** Long enough that a busy loot map is not repriced every tick */
const CACHE_MS = 4000;

let cached = null;
let cachedAt = 0;

/**
 * The current player's stats, recomputed at most every few seconds.
 *
 * Returns null until a combat run has produced data — a row with nothing behind
 * it draws nothing rather than a row of zeroes, which would read as a real
 * measurement of a run that is going badly.
 *
 * @returns {Object|null} From `calculatePlayerStats`, or null
 */
function currentStats() {
    const now = Date.now();
    if (cached && now - cachedAt < CACHE_MS) return cached;

    const data = combatStatsDataCollector.getLatestData();
    const player = data?.players?.find((entry) => entry.isCurrentPlayer);
    if (!player) return null;

    // Live data can time its own duration; a stored snapshot cannot, because its
    // start time may belong to a run that ended hours ago
    let duration = data.durationSeconds || null;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) duration = elapsed;
    }

    cached = calculatePlayerStats(player, duration);
    cachedAt = now;
    return cached;
}

registerRow({
    key: 'combatRevenue',
    name: 'Combat Revenue',
    defaultSize: { width: 280, height: 40 },
    render: (container) => {
        const stats = currentStats();
        if (!stats) return blank(container);

        // Income, what it cost to earn it, and what is left — the third number is
        // the only one worth acting on, and it is the one an income figure alone
        // quietly overstates
        const income = stats.dailyIncome.bid;
        const costs = stats.dailyConsumableCosts + stats.dailyKeyCosts;
        const profit = stats.dailyProfit.bid;

        row(container, [
            { text: formatLargeNumber(Math.round(income)), color: ROW_COLORS.good },
            { text: '−', color: ROW_COLORS.dim },
            { text: formatLargeNumber(Math.round(costs)), color: ROW_COLORS.bad },
            { text: '=', color: ROW_COLORS.dim },
            {
                text: `${formatLargeNumber(Math.round(profit))}/day`,
                color: profit >= 0 ? ROW_COLORS.gold : ROW_COLORS.bad,
                bold: true,
            },
        ]);
    },
});

registerRow({
    key: 'experiencePerHour',
    name: 'Experience/hr',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const stats = currentStats();
        if (!stats?.expPerHour) return blank(container);

        // Separators rather than K/M here: experience per hour is compared with
        // itself between runs, and 260,572 against 261K is the comparison
        row(container, [
            { text: `${formatWithSeparator(Math.round(stats.expPerHour))} exp/hr`, color: ROW_COLORS.good },
        ]);
    },
});

registerRow({
    key: 'deathsPerHour',
    name: 'Deaths/hr',
    defaultSize: { width: 130, height: 30 },
    render: (container) => {
        const stats = currentStats();
        if (!stats) return blank(container);

        // Zero deaths is the goal rather than a shortfall, so it is not coloured
        // as a problem
        row(container, [
            {
                text: `${stats.deathsPerHour.toFixed(1)} deaths/hr`,
                color: stats.deathsPerHour > 0 ? ROW_COLORS.bad : ROW_COLORS.dim,
            },
        ]);
    },
});

/**
 * The session clock and how fast encounters are coming.
 *
 * Encounters per hour is the rate everything else in the panel is divided by, so
 * it is the first thing to look at when a figure has drifted: income per hour
 * falling while EPH holds means prices moved, and both falling together means
 * the fights got slower.
 */
registerRow({
    key: 'battleTimer',
    name: 'Session Timer / EPH',
    defaultSize: { width: 200, height: 30 },
    render: (container) => {
        const data = combatStatsDataCollector.getLatestData();
        const duration = sessionSeconds(data);
        if (!(duration > 0)) return blank(container);

        // battleId counts the battle in progress, which has paid out nothing yet
        const battles = Math.max(0, (data.battleId || 1) - 1);
        const eph = (3600 * battles) / duration;

        row(container, [
            { text: clock(duration) },
            { text: '|', color: ROW_COLORS.dim },
            { text: `${eph.toFixed(2)} EPH`, color: ROW_COLORS.accent },
        ]);
    },
});

/**
 * What the run has actually banked, and what that comes to per day.
 *
 * Combat Revenue answers the daily rate; this answers "so far". The two disagree
 * whenever the run started badly or has just had a rare, and the disagreement is
 * the useful part — a daily projection off twenty minutes is a guess.
 */
registerRow({
    key: 'totalProfit',
    name: 'Total Profit',
    defaultSize: { width: 220, height: 30 },
    render: (container) => {
        const stats = currentStats();
        if (!stats) return blank(container);

        // Both cost figures are {ask, bid} rather than numbers; subtracting the
        // objects gave NaN
        const banked = stats.income.bid - (stats.consumableCosts?.bid || 0) - (stats.keyCosts?.bid || 0);

        row(container, [
            { text: stats.name || 'You', color: ROW_COLORS.gold, bold: true, ellipsis: true },
            { text: '🪙' },
            { text: formatLargeNumber(Math.round(banked)), color: banked >= 0 ? ROW_COLORS.good : ROW_COLORS.bad },
            { text: `${formatLargeNumber(Math.round(stats.dailyProfit.bid))}/day`, color: ROW_COLORS.dim, push: true },
        ]);
    },
});

/**
 * Which consumable runs out first, and what the lot costs per day.
 *
 * The soonest one is the only one that matters: it is what ends the run whether
 * you are watching or not. Naming it is the difference between "top up before
 * bed" and coming back to four idle hours.
 */
registerRow({
    key: 'consumables',
    name: 'Consumables',
    defaultSize: { width: 220, height: 40 },
    render: (container) => {
        const stats = currentStats();
        const breakdown = stats?.consumableBreakdown || [];
        const running = breakdown.filter((entry) => Number.isFinite(entry.timeToZeroSeconds));
        if (!stats || !running.length) return blank(container);

        const soonest = running.reduce((worst, entry) =>
            entry.timeToZeroSeconds < worst.timeToZeroSeconds ? entry : worst
        );

        rows(container, [
            [
                { text: soonest.itemName, ellipsis: true },
                {
                    text: shortDuration(soonest.timeToZeroSeconds),
                    // Under an hour is the point at which it is worth acting now
                    color: soonest.timeToZeroSeconds < 3600 ? ROW_COLORS.bad : ROW_COLORS.good,
                    push: true,
                },
                { text: `· ${formatLargeNumber(soonest.inventoryAmount)}`, color: ROW_COLORS.dim },
            ],
            [
                { text: 'Cost/day', color: ROW_COLORS.dim },
                { text: formatLargeNumber(Math.round(stats.dailyConsumableCosts)), color: ROW_COLORS.bad, push: true },
            ],
        ]);
    },
    // Looked up at click time, not imported: the panel lives in the UI bundle,
    // which loads after this one
    onOpen: () => window.Toolasha?.UI?.consumablesPanel?.toggle(),
});

/**
 * Whether the character is fighting, doing something else, or idle.
 *
 * Read from the action list rather than from combat data, because that is the
 * question being asked: combat data says what the last run did, and stays
 * saying it long after the run stopped.
 */
registerRow({
    key: 'combatStatus',
    name: 'Combat Status',
    defaultSize: { width: 160, height: 30 },
    render: (container) => {
        const actions = dataManager.getCurrentActions?.() || [];
        const current = actions.find((action) => !action.isDone);

        let text = 'Idle';
        let color = ROW_COLORS.bad;
        if (current?.actionHrid?.startsWith('/actions/combat/')) {
            text = 'In Combat';
            color = ROW_COLORS.good;
        } else if (current) {
            // Not idle and not fighting: the queue is busy with something else,
            // which is not a problem but is not combat either
            text = 'Skilling';
            color = ROW_COLORS.accent;
        }

        row(container, [{ text, color, bold: true }]);
    },
});

/**
 * How long the current run has been going.
 *
 * Live data can time itself from its start; a stored snapshot cannot, because
 * its start belongs to a run that may have ended hours ago.
 *
 * @param {Object|null} data - From the collector
 * @returns {number} Seconds, or 0 when unknown
 */
function sessionSeconds(data) {
    if (!data) return 0;
    if (data.combatStartTime) {
        const elapsed = Date.now() / 1000 - new Date(data.combatStartTime).getTime() / 1000;
        if (elapsed > 0) return elapsed;
    }
    return data.durationSeconds || 0;
}

/**
 * Seconds as a running clock.
 *
 * `timeReadable` rounds to whole units, which is right for "five days" and wrong
 * for a timer you watch — a session clock that sits on "2 hours" for an hour
 * reads as a stopped clock.
 *
 * @param {number} seconds - Elapsed
 * @returns {string} `H:MM:SS`
 */
function clock(seconds) {
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
