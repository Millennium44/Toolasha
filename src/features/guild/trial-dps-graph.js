/**
 * The trial damage board's DPS-over-time graph.
 *
 * A trial runs an hour, and the recorder (`guild-trial-recorder.js`) already
 * keeps a reading of the cumulative per-player totals every fifteen seconds for
 * exactly this — its own note calls the snapshots "what make a rate over time".
 * This draws them: the party's rate between consecutive readings, and the
 * leading players' in their own colours, on the trial's watched clock
 * (`seconds`), so a stretch nobody was watching is not drawn as zero damage.
 *
 * ## Tier boundaries
 *
 * A snapshot keeps the fight count and not the tier. Each fight-count change is
 * marked; where the live breakdown was seen changing tier while the board was
 * open, the mark is labelled with the tier it changed to. A mark with no label
 * is a boundary this client did not see the tier of.
 *
 * KikiMeter (ZhuLiMoon, MIT) draws a whole-trial graph from its own 2-second
 * buckets; this one draws from the recorder instead, so it survives the board
 * being closed for most of the trial.
 */

import config from '../../core/config.js';
import { guildTrialRecorder } from './guild-trial-recorder.js';
import { BOARD_COLORS, boardNoteHTML } from '../../utils/damage-board.js';
import { dpsGraphSVG, graphButtonsHTML, PARTY_COLOR } from '../../utils/dps-graph-svg.js';
import { playerColor, resolveRosterColors } from '../../utils/player-colors.js';

/** Players drawn besides the party; a forty-name trial is unreadable as forty lines */
export const TOP_PLAYERS = 5;

/** A fight-count mark this close to a seen tier change is that change */
const SAME_BOUNDARY_SECONDS = 20;

export const TRIAL_GRAPH_VIEWS = [
    { key: 'shown', label: 'Show' },
    { key: 'hidden', label: 'Hide' },
];

let view = 'shown';

/** Tier changes seen on the live breakdown: `{seconds, tier}` */
let tierMarks = [];
let lastTier = null;
let lastSeconds = null;

/**
 * Note the breakdown's tier, so a boundary can be labelled.
 * @param {Object|null} breakdown - From `guildTrialDamage.breakdown()`
 */
export function noteTrialTier(breakdown) {
    const seconds = Number(breakdown?.seconds);
    if (!Number.isFinite(seconds)) return;
    // The watched clock going backwards is a new trial
    if (lastSeconds !== null && seconds < lastSeconds - 1) {
        tierMarks = [];
        lastTier = null;
    }
    lastSeconds = seconds;

    const tier = breakdown?.tier;
    if (!Number.isFinite(tier) || tier === lastTier) return;
    // The first tier seen is where watching began, not a boundary
    if (lastTier !== null) tierMarks.push({ seconds, tier });
    lastTier = tier;
    if (tierMarks.length > 50) tierMarks.shift();
}

/**
 * The recorder's readings as rates between consecutive readings.
 *
 * @param {Array<Object>} snapshots - `thinBreakdown` snapshots, oldest first
 * @param {Object|null} [breakdown] - The live breakdown, appended as the newest reading
 * @returns {{xs: number[], party: number[], players: Object<string, number[]>, totals: Object<string, number>,
 *   boundaries: number[]}} `xs` are watched seconds at the end of each interval
 */
export function trialRates(snapshots, breakdown = null) {
    const readings = [];
    for (const snapshot of snapshots || []) {
        const seconds = Number(snapshot?.seconds);
        if (!Number.isFinite(seconds)) continue;
        // A reading behind the one before it belongs to a trial that ended
        if (readings.length && seconds < readings[readings.length - 1].seconds) readings.length = 0;
        readings.push({ seconds, fights: snapshot.fights, players: snapshot.players || [] });
    }

    const liveSeconds = Number(breakdown?.seconds);
    if (Number.isFinite(liveSeconds) && breakdown?.players?.length) {
        const last = readings[readings.length - 1];
        if (last && liveSeconds < last.seconds) readings.length = 0;
        if (!readings.length || liveSeconds > readings[readings.length - 1].seconds + 1) {
            readings.push({ seconds: liveSeconds, fights: breakdown.fights, players: breakdown.players });
        }
    }

    const out = { xs: [], party: [], players: {}, totals: {}, boundaries: [] };
    const byName = (reading) => {
        const map = new Map();
        for (const row of reading.players) {
            if (row?.name) map.set(row.name, (map.get(row.name) || 0) + (Number(row.damage) || 0));
        }
        return map;
    };

    let previous = readings.length ? byName(readings[0]) : null;
    for (let i = 1; i < readings.length; i++) {
        const current = byName(readings[i]);
        const elapsed = readings[i].seconds - readings[i - 1].seconds;
        if (!(elapsed > 0)) {
            previous = current;
            continue;
        }

        const index = out.xs.length;
        out.xs.push(readings[i].seconds);
        let party = 0;
        for (const [name, damage] of current) {
            const delta = Math.max(0, damage - (previous.get(name) ?? damage));
            party += delta;
            if (!out.players[name]) out.players[name] = new Array(index).fill(0);
            out.players[name].push(delta / elapsed);
            out.totals[name] = damage;
        }
        for (const values of Object.values(out.players)) if (values.length === index) values.push(0);
        out.party.push(party / elapsed);
        if (readings[i].fights !== readings[i - 1].fights) out.boundaries.push(readings[i - 1].seconds);
        previous = current;
    }
    return out;
}

/**
 * The graph section for the trial board.
 * Called on every redraw of the board, whichever tab is showing, so a tier
 * change is noted even while the graph is not on screen.
 *
 * @param {Object|null} breakdown - From `guildTrialDamage.breakdown()`
 * @param {Object} [options] - Context
 * @param {boolean} [options.draw] - Whether the graph is wanted on this tab
 * @param {Object|null} [options.session] - The recorder's session; the live one by default
 * @returns {string} HTML, or '' when not drawn or the setting is off
 */
export function trialDpsGraphHTML(breakdown, { draw = true, session = guildTrialRecorder?.session } = {}) {
    noteTrialTier(breakdown);
    if (!draw || config.getSetting('combatDpsGraph') !== true) return '';

    const buttons = graphButtonsHTML(TRIAL_GRAPH_VIEWS, view, 'data-trial-graph-view');
    if (view === 'hidden') return `<div data-trial-graph style="margin:4px 0;">${buttons}</div>`;

    const rates = trialRates(session?.snapshots, breakdown);
    if (rates.xs.length < 2) {
        return (
            `<div data-trial-graph style="margin:4px 0 6px;">${buttons}` +
            boardNoteHTML(
                session
                    ? 'The graph draws from the trial recorder’s readings, one every fifteen seconds, and appears ' +
                          'once there are a few of them.'
                    : 'The graph draws from the trial recorder, which starts on its own when a trial is watched ' +
                          '(Guild Trials: record automatically) or from the Record button.'
            ) +
            `</div>`
        );
    }

    const ranked = Object.keys(rates.totals).sort((a, b) => rates.totals[b] - rates.totals[a]);
    const top = ranked.slice(0, TOP_PLAYERS);
    resolveRosterColors(ranked);
    const lines = top.map((name) => ({ values: rates.players[name], color: playerColor(name), label: name })).reverse();
    lines.push({ values: rates.party, color: PARTY_COLOR, width: 1.8, label: 'Party' });

    const labelled = tierMarks.map((mark) => ({ x: mark.seconds, label: `T${mark.tier}` }));
    const unlabelled = rates.boundaries
        .filter((seconds) => !tierMarks.some((mark) => Math.abs(mark.seconds - seconds) <= SAME_BOUNDARY_SECONDS))
        .map((seconds) => ({ x: seconds }));
    const first = rates.xs[0];
    const last = rates.xs[rates.xs.length - 1];
    const markers = [...labelled, ...unlabelled].filter((mark) => mark.x >= first && mark.x <= last);

    const minutes = (last - first) / 60;
    const step = minutes <= 6 ? 1 : minutes <= 15 ? 2 : minutes <= 30 ? 5 : 10;
    const xTicks = [];
    for (let m = Math.ceil(first / 60 / step) * step; m * 60 <= last; m += step) {
        xTicks.push({ x: m * 60, label: `${m}m` });
    }

    const svg = dpsGraphSVG({ xs: rates.xs, lines, markers, xTicks });
    const legend =
        `<div style="color:${BOARD_COLORS.dim}; font-size:9px; line-height:1.4; margin-top:2px;">` +
        `White is the party; the ${Math.min(TOP_PLAYERS, ranked.length)} leading players of ${ranked.length} ` +
        'are drawn in their own colours. One point per recorder reading, on the watched clock; dashed lines are ' +
        'wave or tier changes, labelled where the tier was seen.</div>';
    return `<div data-trial-graph style="margin:4px 0 6px;">${buttons}${svg}${legend}</div>`;
}

/**
 * Wire the view buttons after a draw.
 * @param {HTMLElement} body - The board
 * @param {Function} redraw - Draw again
 */
export function wireTrialDpsGraph(body, redraw) {
    body?.querySelectorAll?.('[data-trial-graph-view]').forEach((button) => {
        button.addEventListener('click', () => {
            view = button.dataset.trialGraphView;
            redraw();
        });
    });
}

/** Back to the opening state — for tests */
export function _resetTrialDpsGraph() {
    view = 'shown';
    tierMarks = [];
    lastTier = null;
    lastSeconds = null;
}
