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

import { registerRow } from '../../utils/overlay-rows.js';
import { formatLargeNumber } from '../../utils/formatters.js';
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

/**
 * Lay a row out as label on the left, value on the right.
 * @param {HTMLElement} container - The row's container
 * @param {string} label - Left side
 * @param {string|HTMLElement} value - Right side
 */
function layout(container, label, value) {
    container.replaceChildren();
    Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

    const left = document.createElement('span');
    left.textContent = label;
    const right = value instanceof HTMLElement ? value : document.createElement('span');
    if (!(value instanceof HTMLElement)) right.textContent = value;
    right.style.whiteSpace = 'nowrap';

    container.appendChild(left);
    container.appendChild(right);
}

registerRow({
    key: 'combatRevenue',
    name: 'Combat Revenue',
    render: (container) => {
        const stats = currentStats();
        if (!stats) {
            container.replaceChildren();
            return;
        }

        // Income, what it cost to earn it, and what is left — the third number is
        // the only one worth acting on, and it is the one an income figure alone
        // quietly overstates
        const income = stats.dailyIncome.bid;
        const costs = stats.dailyConsumableCosts + stats.dailyKeyCosts;
        const profit = stats.dailyProfit.bid;

        const value = document.createElement('span');
        value.style.whiteSpace = 'nowrap';

        const earned = document.createElement('span');
        earned.textContent = formatLargeNumber(Math.round(income));
        earned.style.color = '#4ade80';

        const spent = document.createElement('span');
        spent.textContent = ` − ${formatLargeNumber(Math.round(costs))} = `;
        spent.style.color = '#f87171';

        const net = document.createElement('span');
        net.textContent = `${formatLargeNumber(Math.round(profit))}/day`;
        net.style.color = profit >= 0 ? '#4ade80' : '#f87171';

        value.appendChild(earned);
        value.appendChild(spent);
        value.appendChild(net);
        layout(container, 'Revenue', value);
    },
});

registerRow({
    key: 'experiencePerHour',
    name: 'Experience/hr',
    render: (container) => {
        const stats = currentStats();
        if (!stats?.expPerHour) {
            container.replaceChildren();
            return;
        }
        layout(container, 'Experience', `${formatLargeNumber(Math.round(stats.expPerHour))}/hr`);
    },
});

registerRow({
    key: 'deathsPerHour',
    name: 'Deaths/hr',
    render: (container) => {
        const stats = currentStats();
        if (!stats) {
            container.replaceChildren();
            return;
        }

        const value = document.createElement('span');
        value.textContent = `${stats.deathsPerHour.toFixed(1)}/hr`;
        // Zero deaths is the goal rather than a shortfall, so it is not coloured
        // as a problem
        value.style.color = stats.deathsPerHour > 0 ? '#f87171' : 'inherit';
        layout(container, 'Deaths', value);
    },
});
