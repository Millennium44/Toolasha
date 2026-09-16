/**
 * Saving a finished Per-player session, from outside the trackers.
 *
 * `damage-tracker.js` wipes its tally the moment a run ends — a party or zone
 * change, the DPs panel's Reset, a character switch — and says nothing before
 * it does. So this reads the trackers on a timer, holding the latest reading,
 * and treats a changed `startedAt` (the stamp the tracker re-stamps on every
 * reset, which is also how `dps-graph.js` notices a new run) or a changed
 * character as the end of the run the held reading belongs to. That reading
 * is what gets saved: at most one sampling interval short of the true end.
 *
 * ## What a saved session holds
 *
 * Everything the Per-player panel draws, as it stood: `damageBreakdown()` (per
 * player damage, kills, class, per-ability and per-enemy rows, the team total
 * and unattributed part, healing done), `takenBreakdown()` (taken and healed,
 * with the per-monster split), the Rotation tab's audit, and a DPS-over-time
 * series this module keeps itself from the same readings (the graph module's
 * series is its own and is not read from here).
 *
 * ## Whose session
 *
 * Each reading records the character logged in when it was taken, and a
 * session is filed under that character — never under whoever is logged in
 * when the save lands, which after a character switch is somebody else.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { damageBreakdown } from './damage-tracker.js';
import { takenBreakdown } from './damage-taken-tracker.js';
import { rotationAudit } from './rotation-tracker.js';
import { bossBands, isBossBattle } from './dps-graph.js';
import { currentCharacterId, historyEnabled, saveHistoryEntry } from './meter-history.js';
import { runningCombatAction } from '../../utils/combat-actions.js';
import { BOARD_COLORS, boardNoteHTML } from '../../utils/damage-board.js';
import { dpsGraphSVG, graphButtonsHTML, PARTY_COLOR } from '../../utils/dps-graph-svg.js';
import { BUCKET_MS, newDpsSeries, noteTotals, seriesView } from '../../utils/dps-series.js';
import { playerColor, resolveRosterColors } from '../../utils/player-colors.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** How often the trackers are read; one graph bucket, so the series is as fine as the live graph's */
export const HISTORY_SAMPLE_MS = BUCKET_MS;

/** The rotation audit is heavier and changes slowly, so it is read less often */
export const AUDIT_SAMPLE_MS = 10_000;

/** Seconds of fighting a session needs before it is worth a place in the list */
export const MIN_ARCHIVE_SECONDS = 30;

/** The saved graph's buttons */
export const SAVED_GRAPH_VIEWS = [
    { key: 'shown', label: 'Show' },
    { key: 'hidden', label: 'Hide' },
];

/** The latest reading: `{at, characterId, startedAt, dealt, taken, audit, zone}` */
let last = null;
let series = newDpsSeries();
let audit = null;
let lastAuditAt = 0;
let boss = false;
let zone = null;
let onNewBattle = null;
let savedGraphView = 'shown';
const timers = createTimerRegistry();

/**
 * The zone the party is fighting in, as the game names it.
 * @returns {string|null}
 */
function currentZoneName() {
    const action = runningCombatAction(dataManager.getCurrentActions?.() || []);
    const detail = action ? dataManager.getActionDetails?.(action.actionHrid) : null;
    if (!detail?.name) return null;
    const tier = Number(action.difficultyTier);
    return tier > 0 ? `${detail.name} T${tier}` : detail.name;
}

/**
 * The graph points a series draws over its whole length.
 * @param {Object} from - A series from `newDpsSeries`
 * @param {number} at - When its last reading was taken
 * @returns {{bucketMs: number, keys: string[], names: Object, points: Array<Object>}|null}
 */
export function graphFromSeries(from, at) {
    const view = seriesView(from, { now: at + (from?.bucketMs || BUCKET_MS), window: 'session' });
    if (!view?.points?.length || !view.keys.length) return null;
    return { bucketMs: view.bucketMs, keys: view.keys, names: view.names, points: view.points };
}

/**
 * A saved session's body, or null when the session is too slight to keep.
 *
 * Pure. Kept when it had {@link MIN_ARCHIVE_SECONDS} of fighting and anything
 * measured at all — damage, healing or damage taken.
 *
 * @param {Object} sample - A reading: `{at, dealt, taken, audit, zone}`
 * @param {Object|null} [graph] - From {@link graphFromSeries}
 * @returns {Object|null}
 */
export function buildCombatEntry(sample, graph = null) {
    const dealt = sample?.dealt || {};
    const taken = sample?.taken || {};
    const seconds = Number(dealt.seconds) || 0;
    const rows = dealt.players || [];
    const teamDamage = Number(dealt.team?.damage) || rows.reduce((sum, row) => sum + (Number(row.damage) || 0), 0);
    const healing = Number(dealt.healing?.total) || 0;
    const takenTotal = (taken.players || []).reduce((sum, row) => sum + (Number(row.damage) || 0), 0);
    if (seconds < MIN_ARCHIVE_SECONDS || !(teamDamage > 0 || healing > 0 || takenTotal > 0)) return null;

    const names = [
        ...new Set(
            [...rows, ...(dealt.healing?.players || []), ...(taken.players || [])]
                .map((row) => row?.name)
                .filter(Boolean)
        ),
    ];
    const at = Number(sample.at) || Date.now();
    const startedAt = Number(dealt.startedAt) || at - seconds * 1000;
    const kills = rows.reduce((sum, row) => sum + (Number(row.kills) || 0), 0) + (Number(dealt.unownedKills) || 0);

    return {
        version: 1,
        type: 'combat',
        id: `combat_${startedAt}`,
        startedAt,
        endedAt: at,
        seconds,
        basis: 'stream',
        summary: {
            label: sample.zone || 'Combat',
            detail: names.length
                ? names.slice(0, 5).join(', ') + (names.length > 5 ? ` +${names.length - 5}` : '')
                : null,
            total: teamDamage,
            perSecond: seconds > 0 ? teamDamage / seconds : null,
            players: names.length,
            kills,
        },
        dealt,
        taken,
        audit: sample.audit || null,
        graph,
    };
}

/**
 * Save a reading as a finished session, if it is one worth keeping.
 * @param {Object} sample - The reading
 * @param {Object|null} graph - Its graph
 * @returns {Promise<Object|null>} The summary filed
 */
async function archive(sample, graph) {
    try {
        if (!historyEnabled()) return null;
        const entry = buildCombatEntry(sample, graph);
        if (!entry) return null;
        return await saveHistoryEntry(entry, sample.characterId);
    } catch (error) {
        console.error('[CombatHistory] Saving a finished session failed:', error);
        return null;
    }
}

/** The rotation audit, or null when it cannot be read */
function readAudit() {
    try {
        return rotationAudit() || null;
    } catch (error) {
        console.error('[CombatHistory] Reading the rotation audit failed:', error);
        return null;
    }
}

/**
 * Take one reading, and save the previous run if this one belongs to another.
 *
 * @param {number} [now] - Clock
 * @param {Object} [inputs] - Injectable for tests
 * @param {Object} [inputs.dealt] - `damageBreakdown()`
 * @param {Object} [inputs.taken] - `takenBreakdown()`
 * @param {Object} [inputs.audit] - `rotationAudit()`
 * @param {string} [inputs.characterId] - Who is logged in
 * @returns {Promise<Object|null>|null} The save of a finished run when one ended, else null
 */
export function sampleCombatHistory(now = Date.now(), inputs = {}) {
    const dealt = inputs.dealt ?? damageBreakdown();
    const taken = inputs.taken ?? takenBreakdown();
    const characterId = inputs.characterId ?? currentCharacterId();
    const startedAt = dealt?.startedAt ?? null;

    let saving = null;
    const ended = last !== null && (last.startedAt !== startedAt || last.characterId !== characterId);
    if (ended) {
        saving = archive(last, graphFromSeries(series, last.at));
        // The tracker's totals began at zero with this run, unless the change
        // was a character switch, whose first reading has no such promise
        series = newDpsSeries({ fromZero: last.characterId === characterId });
        audit = null;
        lastAuditAt = 0;
    } else if (last === null) {
        series = newDpsSeries();
    }

    noteTotals(
        series,
        now,
        (dealt?.players || []).map((player) => ({
            key: String(player.index ?? player.name),
            name: player.name,
            damage: player.damage,
        })),
        { boss }
    );

    if (inputs.audit !== undefined) audit = inputs.audit;
    else if (audit === null || now - lastAuditAt >= AUDIT_SAMPLE_MS) {
        audit = readAudit();
        lastAuditAt = now;
    }

    last = { at: now, characterId, startedAt, dealt, taken, audit, zone };
    return saving;
}

/** Start reading the trackers. Idempotent */
export function startCombatHistory() {
    if (onNewBattle) return;
    last = null;
    series = newDpsSeries();
    audit = null;
    lastAuditAt = 0;
    boss = false;
    zone = null;

    onNewBattle = (data) => {
        try {
            boss = isBossBattle(data);
            zone = currentZoneName();
        } catch (error) {
            console.error('[CombatHistory] Reading a new battle failed:', error);
        }
    };
    webSocketHook.on('new_battle', onNewBattle);

    timers.registerInterval(
        setInterval(() => {
            try {
                if (historyEnabled()) sampleCombatHistory();
            } catch (error) {
                console.error('[CombatHistory] Reading the trackers failed:', error);
            }
        }, HISTORY_SAMPLE_MS),
        'combatHistory.sample'
    );
}

/**
 * Stop reading, and save the run in hand.
 *
 * The last reading is saved as it was, not re-read: this runs inside a
 * character switch, where a fresh read would pair the old run's totals with
 * the arriving character. A run that is still going (the feature switched off
 * and on) is saved again later under the same id and replaces this copy.
 *
 * @returns {Promise<Object|null>} The save, for tests
 */
export function stopCombatHistory() {
    if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
    onNewBattle = null;
    timers.clearAll();

    const finished = last;
    const graph = finished ? graphFromSeries(series, finished.at) : null;
    last = null;
    series = newDpsSeries();
    audit = null;
    lastAuditAt = 0;
    boss = false;
    zone = null;
    return finished ? archive(finished, graph) : Promise.resolve(null);
}

/**
 * A saved session's DPS graph, drawn the way the live one is.
 *
 * @param {Object|null} graph - From {@link graphFromSeries}, as saved
 * @returns {string} HTML, or '' with the graph setting off
 */
export function savedCombatGraphHTML(graph) {
    if (config.getSetting('combatDpsGraph') !== true) return '';
    const buttons = graphButtonsHTML(SAVED_GRAPH_VIEWS, savedGraphView, 'data-saved-graph-view');
    if (savedGraphView === 'hidden') return `<div data-dps-graph style="margin:4px 0;">${buttons}</div>`;

    const points = Array.isArray(graph?.points) ? graph.points : [];
    const keys = Array.isArray(graph?.keys) ? graph.keys : [];
    if (points.length < 2 || !keys.length) {
        return (
            `<div data-dps-graph style="margin:4px 0 6px;">${buttons}` +
            boardNoteHTML('No graph was kept for this session — it needs the DPS graph on while the session runs.') +
            `</div>`
        );
    }

    const names = graph.names || {};
    const bucketMs = Number(graph.bucketMs) || BUCKET_MS;
    resolveRosterColors(keys.map((key) => names[key] || key));
    const xs = points.map((point) => Number(point.t) || 0);
    const lines = keys.map((key) => ({
        values: points.map((point) => Number(point.players?.[key]) || 0),
        color: playerColor(names[key] || key),
        label: names[key] || key,
    }));
    if (keys.length > 1) {
        lines.push({
            values: points.map((point) => Number(point.party) || 0),
            color: PARTY_COLOR,
            width: 1.8,
            label: 'Party',
        });
    }
    const bands = bossBands(points, bucketMs);

    const minutes = (xs[xs.length - 1] - xs[0]) / 60_000;
    const step = minutes <= 6 ? 1 : minutes <= 15 ? 2 : minutes <= 30 ? 5 : 10;
    const xTicks = [];
    for (let m = Math.ceil(xs[0] / 60_000 / step) * step; m * 60_000 <= xs[xs.length - 1]; m += step) {
        xTicks.push({ x: m * 60_000, label: `${m}m` });
    }

    const svg = dpsGraphSVG({ xs, lines, bands, xTicks });
    const legend =
        `<div style="color:${BOARD_COLORS.dim}; font-size:9px; line-height:1.4; margin-top:2px;">` +
        'The whole session, from its start. ' +
        (keys.length > 1 ? 'White is the party; each player is drawn in their own color. ' : '') +
        (bands.length ? 'Red shading is a boss fight. ' : '') +
        'A 16-second average.</div>';
    return `<div data-dps-graph style="margin:4px 0 6px;">${buttons}${svg}${legend}</div>`;
}

/**
 * Wire the saved graph's buttons after a draw.
 * @param {HTMLElement} body - The board
 * @param {Function} redraw - Draw again
 */
export function wireSavedCombatGraph(body, redraw) {
    body?.querySelectorAll?.('[data-saved-graph-view]').forEach((button) => {
        button.addEventListener('click', () => {
            savedGraphView = button.dataset.savedGraphView;
            redraw();
        });
    });
}

/** Back to the opening state — for tests */
export function _resetCombatHistory() {
    if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
    onNewBattle = null;
    timers.clearAll();
    last = null;
    series = newDpsSeries();
    audit = null;
    lastAuditAt = 0;
    boss = false;
    zone = null;
    savedGraphView = 'shown';
}
