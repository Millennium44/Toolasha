/**
 * The Per-player panel's DPS-over-time graph.
 *
 * `damage-tracker.js` keeps per-player totals for the run and no history. This
 * reads those totals every two seconds (`utils/dps-series.js` turns readings
 * into buckets) and draws the party line and one line per player in the
 * player's own colour, with boss fights shaded.
 *
 * ## What resets it
 *
 * The tracker stamps `startedAt` whenever it starts a run — a party or zone
 * change, the panel's Reset, a character switch — and a reading with a
 * different stamp starts a fresh series. The graph therefore always covers the
 * same run as the table under it.
 *
 * ## What a boss is
 *
 * KikiMeter's rule (ZhuLiMoon, MIT): a `new_battle` whose monsters include one
 * with an enrage timer longer than three minutes. Ordinary monsters enrage at
 * exactly 180 s and bosses later (Crystal Colossus: 600 s). Nothing else on
 * this client flags a boss battle: `combat-boss-eta.js` counts battles to the
 * zone's boss cycle, which says when one is due rather than whether this fight
 * is one.
 *
 * Runs only while the Per-player panel feature is on and the graph setting is
 * on; the panel starts and stops it.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import { damageBreakdown } from './damage-tracker.js';
import { BOARD_COLORS, boardNoteHTML } from '../../utils/damage-board.js';
import { dpsGraphSVG, graphButtonsHTML, PARTY_COLOR } from '../../utils/dps-graph-svg.js';
import { BUCKET_MS, newDpsSeries, noteTotals, seriesView } from '../../utils/dps-series.js';
import { playerColor, resolveRosterColors } from '../../utils/player-colors.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** An enrage timer longer than this (nanoseconds) marks a boss */
export const BOSS_ENRAGE_NS = 180_000_000_000;

/** The graph's views, in button order */
export const GRAPH_VIEWS = [
    { key: 'recent', label: '5 min' },
    { key: 'session', label: 'Session' },
    { key: 'hidden', label: 'Hide' },
];

let series = newDpsSeries();
let trackerStartedAt = null;
let boss = false;
let view = 'recent';
let onNewBattle = null;
const timers = createTimerRegistry();

/**
 * Whether a `new_battle` is a boss fight.
 * @param {Object} data - `new_battle` message
 * @returns {boolean}
 */
export function isBossBattle(data) {
    return Object.values(data?.monsters || {}).some((monster) => Number(monster?.enrageTimerDuration) > BOSS_ENRAGE_NS);
}

/**
 * Take one reading of the tracker's totals.
 * @param {number} [now] - Clock
 * @param {Object} [breakdown] - `damageBreakdown()`, injectable for tests
 */
export function sampleDamage(now = Date.now(), breakdown = damageBreakdown()) {
    const startedAt = breakdown?.startedAt ?? null;
    if (startedAt !== trackerStartedAt) {
        // A stamp that changed while sampling means the tracker began a new run
        // just now, so its totals start at zero with this series. The very
        // first reading has no such promise and is a baseline.
        series = newDpsSeries({ fromZero: trackerStartedAt !== null });
        trackerStartedAt = startedAt;
    }
    noteTotals(
        series,
        now,
        (breakdown?.players || []).map((player) => ({
            key: String(player.index ?? player.name),
            name: player.name,
            damage: player.damage,
        })),
        { boss }
    );
}

/** Start reading, if the graph is wanted. Idempotent */
export function startDpsSampler() {
    if (onNewBattle || config.getSetting('combatDpsGraph') !== true) return;
    series = newDpsSeries();
    trackerStartedAt = null;
    boss = false;

    onNewBattle = (data) => {
        try {
            boss = isBossBattle(data);
        } catch (error) {
            console.error('[DpsGraph] Reading a new battle failed:', error);
        }
    };
    webSocketHook.on('new_battle', onNewBattle);

    const sample = () => {
        try {
            sampleDamage();
        } catch (error) {
            console.error('[DpsGraph] Sampling damage failed:', error);
        }
    };
    sample();
    timers.registerInterval(setInterval(sample, BUCKET_MS), 'dpsGraph.sample');
}

/** Stop reading and forget the series */
export function stopDpsSampler() {
    if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
    onNewBattle = null;
    timers.clearAll();
    series = newDpsSeries();
    trackerStartedAt = null;
    boss = false;
}

/**
 * Minute ticks counting back from the newest point.
 * @param {number[]} xs - Point times (ms)
 * @returns {Array<{x: number, label: string}>}
 */
function minutesAgoTicks(xs) {
    const last = xs[xs.length - 1];
    const minutes = (last - xs[0]) / 60_000;
    const step = minutes <= 6 ? 1 : minutes <= 15 ? 2 : minutes <= 30 ? 5 : 10;
    const ticks = [{ x: last, label: 'now' }];
    for (let m = step; last - m * 60_000 >= xs[0]; m += step) ticks.push({ x: last - m * 60_000, label: `-${m}m` });
    return ticks;
}

/**
 * Boss stretches as x ranges.
 * @param {Array<Object>} points - From `seriesView`
 * @param {number} width - A point's width (ms)
 * @returns {Array<{from: number, to: number}>}
 */
export function bossBands(points, width) {
    const bands = [];
    for (const point of points) {
        if (!point.boss) continue;
        const last = bands[bands.length - 1];
        if (last && last.to >= point.t) last.to = point.t + width;
        else bands.push({ from: point.t, to: point.t + width });
    }
    return bands;
}

/**
 * The graph section for the Per-player panel's Damage tab.
 * @param {Object} [options] - For tests
 * @param {number} [options.now] - Clock
 * @returns {string} HTML, or '' with the setting off
 */
export function dpsGraphHTML({ now = Date.now() } = {}) {
    if (config.getSetting('combatDpsGraph') !== true) return '';
    const buttons = graphButtonsHTML(GRAPH_VIEWS, view, 'data-graph-view');
    if (view === 'hidden') return `<div data-dps-graph style="margin:4px 0;">${buttons}</div>`;

    const shown = seriesView(series, { now, window: view });
    if (!shown?.points.length || !shown.keys.length) {
        return (
            `<div data-dps-graph style="margin:4px 0 6px;">${buttons}` +
            boardNoteHTML('The graph fills in as the fight goes on, one point every two seconds.') +
            `</div>`
        );
    }

    const { points, keys, names, bucketMs } = shown;
    resolveRosterColors(keys.map((key) => names[key] || key));
    const xs = points.map((point) => point.t);
    const lines = keys.map((key) => ({
        values: points.map((point) => point.players[key]),
        color: playerColor(names[key] || key),
        label: names[key] || key,
    }));
    if (keys.length > 1) {
        lines.push({ values: points.map((point) => point.party), color: PARTY_COLOR, width: 1.8, label: 'Party' });
    }
    const bands = bossBands(points, bucketMs);

    const svg = dpsGraphSVG({ xs, lines, bands, xTicks: minutesAgoTicks(xs) });
    const legend =
        `<div style="color:${BOARD_COLORS.dim}; font-size:9px; line-height:1.4; margin-top:2px;">` +
        (keys.length > 1 ? 'White is the party; each player is drawn in their own colour. ' : '') +
        (bands.length ? 'Red shading is a boss fight. ' : '') +
        'A 16-second average, so a burst reads as a rise rather than a spike.</div>';
    return `<div data-dps-graph style="margin:4px 0 6px;">${buttons}${svg}${legend}</div>`;
}

/**
 * Wire the view buttons after a draw.
 * @param {HTMLElement} body - The board
 * @param {Function} redraw - Draw again
 */
export function wireDpsGraph(body, redraw) {
    body?.querySelectorAll?.('[data-graph-view]').forEach((button) => {
        button.addEventListener('click', () => {
            view = button.dataset.graphView;
            redraw();
        });
    });
}

/** Back to the opening state — for tests */
export function _resetDpsGraph() {
    stopDpsSampler();
    view = 'recent';
}
