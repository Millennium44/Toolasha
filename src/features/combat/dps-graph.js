/**
 * The Per-player panel's DPS-over-time graph.
 *
 * `damage-tracker.js` keeps per-player totals for the run and no history. This
 * reads those totals every two seconds (`utils/dps-series.js` turns readings
 * into buckets) and draws the party line and one line per player in the
 * player's own color, with boss fights shaded.
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
 * A `new_battle` whose monsters include one listed in any zone's `bossSpawns`
 * (`dataManager.isBossMonster`). KikiMeter's enrage-timer rule (longer than
 * 180 s marks a boss) does not hold: on the test server Pirate Cove's ordinary
 * spawns enrage at 600 s and its elite spawns at 180 s, so it shaded every
 * wave. `combat-boss-eta.js` counts battles to the zone's boss cycle, which says
 * when one is due rather than whether this fight is one.
 *
 * Runs only while the Per-player panel feature is on and the graph setting is
 * on; the panel starts and stops it.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { damageBreakdown } from './damage-tracker.js';
import { BOARD_COLORS, boardNoteHTML } from '../../utils/damage-board.js';
import { dpsGraphSVG, graphButtonsHTML, PARTY_COLOR } from '../../utils/dps-graph-svg.js';
import { BUCKET_MS, newDpsSeries, noteTotals, seriesView } from '../../utils/dps-series.js';
import {
    createLiveSessionPersister,
    isRestorable,
    liveSessionKey,
    loadLiveSession,
} from '../../utils/live-session-persist.js';
import { playerColor, resolveRosterColors } from '../../utils/player-colors.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** The graph's views, in button order */
export const GRAPH_VIEWS = [
    { key: 'recent', label: '5 min' },
    { key: 'session', label: 'Session' },
    { key: 'hidden', label: 'Hide' },
];

let series = newDpsSeries();
/** The tracker run the series covers: its `sessionId`, or `startedAt` where it states none */
let trackerSessionId = null;
let boss = false;
let view = 'recent';
let onNewBattle = null;
const timers = createTimerRegistry();

/** Where the series is saved, and what its payload is called */
const LIVE_STORE = 'combatStats';
const LIVE_KIND = 'dpsGraph';

/** A saved series read back at start, waiting for the tracker's run to claim it */
let savedGraph = null;

/** Bumped when a read in flight stops being wanted */
let loadGeneration = 0;

/** True while the saved series is being read: until then the copy on disk is the better one */
let graphLoading = false;

const persister = createLiveSessionPersister({
    storeName: LIVE_STORE,
    kind: LIVE_KIND,
    label: 'DpsGraph',
    keyFor: () => liveSessionKey('Graph', dataManager.getCurrentCharacterId?.() ?? null),
    serialize: () => {
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (graphLoading || characterId === null || trackerSessionId === null || series.startAt === null) return null;
        return { characterId, sessionId: trackerSessionId, series };
    },
});

/**
 * Take the saved series back for the run it was drawn from.
 *
 * The totals are re-read as a baseline rather than kept: the damage done
 * between the save and now has no time attached, so the stretch the page was
 * shut draws as nothing measured instead of a spike on the first reading back.
 *
 * @param {*} sessionId - The tracker's run now
 * @param {Object} breakdown - `damageBreakdown()`
 * @param {number} now - Clock
 * @returns {boolean} Whether it was adopted
 */
function adoptSavedGraph(sessionId, breakdown, now) {
    const saved = savedGraph;
    if (!saved || sessionId === null || saved.sessionId !== sessionId) return false;
    savedGraph = null;
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    if (!isRestorable(saved, { kind: LIVE_KIND, characterId, now })) return false;
    const restored = saved.series;
    if (!restored || !Array.isArray(restored.buckets) || !Number.isFinite(restored.startAt)) return false;

    series = { ...newDpsSeries(), ...restored, totals: {}, names: { ...(restored.names || {}) } };
    for (const player of breakdown?.players || []) {
        series.totals[String(player.index ?? player.name)] = Number(player.damage) || 0;
    }
    return true;
}

/**
 * Read this character's saved series back.
 * @param {number} generation - `loadGeneration` when the read began
 * @param {string|number} characterId - Who was logged in when it began
 */
async function loadSavedGraph(generation, characterId) {
    const saved = await loadLiveSession(liveSessionKey('Graph', characterId), LIVE_STORE);
    if (generation !== loadGeneration) return;
    graphLoading = false;
    if (!saved) return;
    if (String(dataManager.getCurrentCharacterId?.() ?? '') !== String(characterId)) return;
    savedGraph = saved;
    // The tracker may already be on the saved run: it restored, or never stopped
    if (trackerSessionId !== null && saved.sessionId === trackerSessionId) {
        adoptSavedGraph(trackerSessionId, damageBreakdown(), Date.now());
    }
}

/**
 * Whether a `new_battle` is a boss fight.
 * @param {Object} data - `new_battle` message
 * @returns {boolean}
 */
export function isBossBattle(data) {
    return Object.values(data?.monsters || {}).some((monster) => dataManager.isBossMonster(monster?.hrid));
}

/**
 * Take one reading of the tracker's totals.
 * @param {number} [now] - Clock
 * @param {Object} [breakdown] - `damageBreakdown()`, injectable for tests
 */
export function sampleDamage(now = Date.now(), breakdown = damageBreakdown()) {
    const sessionId = breakdown?.sessionId ?? breakdown?.startedAt ?? null;
    if (sessionId !== trackerSessionId) {
        // A run that changed while sampling means the tracker began a new one
        // just now, so its totals start at zero with this series. The very
        // first reading has no such promise and is a baseline, and neither has
        // a run carried over a refresh: its totals were earned before this page.
        if (!adoptSavedGraph(sessionId, breakdown, now)) {
            series = newDpsSeries({ fromZero: trackerSessionId !== null && !breakdown?.restored });
        }
        trackerSessionId = sessionId;
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
    trackerSessionId = null;
    boss = false;
    savedGraph = null;

    persister.start();
    loadGeneration += 1;
    const characterId = dataManager.getCurrentCharacterId?.() ?? null;
    if (characterId !== null) {
        graphLoading = true;
        loadSavedGraph(loadGeneration, characterId);
    }

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
            persister.note();
        } catch (error) {
            console.error('[DpsGraph] Sampling damage failed:', error);
        }
    };
    sample();
    timers.registerInterval(setInterval(sample, BUCKET_MS), 'dpsGraph.sample');
}

/** Stop reading and forget the series */
export function stopDpsSampler() {
    // Written before the series is forgotten
    persister.stop();
    loadGeneration += 1;
    graphLoading = false;
    savedGraph = null;
    if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
    onNewBattle = null;
    timers.clearAll();
    series = newDpsSeries();
    trackerSessionId = null;
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
        (keys.length > 1 ? 'White is the party; each player is drawn in their own color. ' : '') +
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
