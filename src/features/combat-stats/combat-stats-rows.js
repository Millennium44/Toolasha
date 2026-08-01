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
import { formatLargeNumber, timeReadable } from '../../utils/formatters.js';
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
    defaultSize: { width: 280, height: 40 },
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
    defaultSize: { width: 180, height: 30 },
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
    defaultSize: { width: 130, height: 30 },
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
        if (!(duration > 0)) {
            container.replaceChildren();
            return;
        }

        // battleId counts the battle in progress, which has paid out nothing yet
        const battles = Math.max(0, (data.battleId || 1) - 1);
        const eph = (3600 * battles) / duration;

        const value = document.createElement('span');
        value.style.whiteSpace = 'nowrap';
        value.textContent = `${eph.toFixed(1)} EPH`;
        value.style.color = '#9ec4ff';

        layout(container, clock(duration), value);
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
        if (!stats) {
            container.replaceChildren();
            return;
        }

        const banked = stats.income.bid - stats.consumableCosts - stats.keyCosts;
        const value = document.createElement('span');
        value.style.whiteSpace = 'nowrap';

        const total = document.createElement('span');
        total.textContent = formatLargeNumber(Math.round(banked));
        total.style.color = banked >= 0 ? '#4ade80' : '#f87171';

        const rate = document.createElement('span');
        rate.textContent = ` · ${formatLargeNumber(Math.round(stats.dailyProfit.bid))}/day`;
        rate.style.color = 'rgba(232, 236, 245, 0.6)';

        value.append(total, rate);
        layout(container, 'Profit', value);
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
        if (!stats || !running.length) {
            container.replaceChildren();
            return;
        }

        const soonest = running.reduce((worst, entry) =>
            entry.timeToZeroSeconds < worst.timeToZeroSeconds ? entry : worst
        );

        container.replaceChildren();
        Object.assign(container.style, { display: 'flex', flexDirection: 'column', lineHeight: '1.35' });

        const first = document.createElement('div');
        Object.assign(first.style, { display: 'flex', justifyContent: 'space-between', gap: '8px' });
        const name = document.createElement('span');
        name.textContent = soonest.itemName;
        name.style.overflow = 'hidden';
        name.style.textOverflow = 'ellipsis';
        name.style.whiteSpace = 'nowrap';

        const left = document.createElement('span');
        left.textContent = `${timeReadable(soonest.timeToZeroSeconds)} · ${formatLargeNumber(soonest.inventoryAmount)}`;
        left.style.whiteSpace = 'nowrap';
        // Under an hour is the point at which it is worth acting on now
        left.style.color = soonest.timeToZeroSeconds < 3600 ? '#f87171' : '#4ade80';
        first.append(name, left);

        const second = document.createElement('div');
        Object.assign(second.style, {
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
            color: 'rgba(232, 236, 245, 0.6)',
        });
        const label = document.createElement('span');
        label.textContent = 'Cost/day';
        const cost = document.createElement('span');
        cost.textContent = formatLargeNumber(Math.round(stats.dailyConsumableCosts));
        second.append(label, cost);

        container.append(first, second);
    },
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
        container.replaceChildren();

        const actions = dataManager.getCurrentActions?.() || [];
        const current = actions.find((action) => !action.isDone);

        const value = document.createElement('span');
        value.style.fontWeight = 'bold';
        value.style.whiteSpace = 'nowrap';

        if (!current) {
            value.textContent = 'Idle';
            value.style.color = '#f87171';
        } else if (current.actionHrid?.startsWith('/actions/combat/')) {
            value.textContent = 'In Combat';
            value.style.color = '#4ade80';
        } else {
            // Not idle and not fighting: the queue is busy with something else,
            // which is not a problem but is not combat either
            value.textContent = 'Skilling';
            value.style.color = '#9ec4ff';
        }

        container.appendChild(value);
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
