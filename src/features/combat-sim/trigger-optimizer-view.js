/**
 * Trigger Optimizer: the options that live in the "Triggers" chip, and the
 * results box. Pure string builders, so the panel stays a thin wire-up and the
 * markup can be tested without one.
 */

import { formatKMB } from '../../utils/formatters.js';
import { PRECISIONS, DEFAULT_PRECISION, describeRow } from './trigger-tuning.js';

const ACCENT = '#4a9eff';
const BTN_STYLE =
    'background:rgba(74, 158, 255, 0.2); border:1px solid rgba(74, 158, 255, 0.4); color:#4a9eff; ' +
    'padding:3px 10px; border-radius:4px; font-size:11px; font-weight:600; cursor:pointer; font-family:inherit;';
const SELECT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:2px 4px; font-size:11px;';

/**
 * Escape text for HTML.
 * @param {*} text
 * @returns {string}
 */
export function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * The scope and precision selectors shown inside the chip while it is checked.
 * @returns {string} HTML
 */
export function triggerChipOptionsHtml() {
    const precisionOptions = Object.values(PRECISIONS)
        .map(
            (p) => `<option value="${p.key}"${p.key === DEFAULT_PRECISION ? ' selected' : ''}>${esc(p.label)}</option>`
        )
        .join('');
    return `
        <span data-mode-options="triggers" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <select class="toolasha-select" id="mwi-csim-trigger-scope" style="${SELECT_STYLE}"
                title="Just me tunes only the selected player's triggers and judges them on that player's results. Whole party tunes every member's triggers and judges the party total.">
                <option value="me" selected>Just me</option>
                <option value="party">Whole party</option>
            </select>
            <select class="toolasha-select" id="mwi-csim-trigger-precision" style="${SELECT_STYLE}"
                title="How long each candidate value is simulated. Quick is a rough pass; Precise tightens the error bars and takes several times longer.">
                ${precisionOptions}
            </select>
        </span>`;
}

const sign = (v, text) => (v < 0 ? text : `+${text}`);
const fmtScore = (v) => sign(v, v.toFixed(1));
const fmtRate = (v) => sign(v, formatKMB(Math.round(v)));
const fmtDeaths = (v) => sign(v, v.toFixed(3));
const fmtSe = (v) => (Number.isFinite(v) ? v.toFixed(1) : '?');

function deltaCells(c) {
    return (
        `ΔEXP/h ${esc(fmtRate(c.deltaXp))} · Δprofit/h ${esc(fmtRate(c.deltaProfit))} · ` +
        `Δdeaths/h ${esc(fmtDeaths(c.deltaDeaths))}`
    );
}

/**
 * The results box: changes grouped by player, sorted by impact, with the
 * all-together line at the bottom and the Apply / Copy buttons.
 * @param {Object|null} result - From `runTriggerOptimization`
 * @param {Object} gameData - Game data payload (display names)
 * @param {Object} [options] - `{ canApply }`
 * @returns {string} HTML
 */
export function renderTriggerResultsHtml(result, gameData, { canApply = true } = {}) {
    const head = `<div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:4px;">Trigger tuning</div>`;
    const wrap = (inner) =>
        `<div id="mwi-csim-trigger-results" style="border:1px solid #2a2a4a; border-radius:6px; padding:8px 10px; margin:8px 0;">${head}${inner}</div>`;

    if (!result) return wrap('<div style="color:#888; font-size:12px;">Stopped before the baseline finished.</div>');
    if (result.noTunables) {
        return wrap(
            '<div style="color:#888; font-size:12px;">Nothing to tune: none of the ' +
                `${result.scope === 'party' ? "party's" : "player's"} ability or food triggers compare an HP or MP ` +
                'reading to a number.</div>'
        );
    }

    const changes = result.changes || [];
    const players = new Map();
    for (const c of changes) {
        if (!players.has(c.playerHrid)) players.set(c.playerHrid, { name: c.playerName, rows: [] });
        players.get(c.playerHrid).rows.push(c);
    }
    const showNames = players.size > 1 || result.scope === 'party';

    let body = '';
    if (result.reliable === false) {
        body +=
            '<div style="color:#ff9800; font-size:12px; font-weight:600;">No reliable improvement found.</div>' +
            '<div style="color:#aaa; font-size:12px; margin-top:2px;">Some values looked better in single runs, ' +
            'but the combination did not beat your current triggers on fresh seeds by a clear margin, so none ' +
            'are recommended.</div>';
    } else if (changes.length === 0) {
        body += '<div style="color:#e0e0e0; font-size:12px;">No change beat the current thresholds by a clear margin.';
        body += ' Your triggers are already about as good as this search can tell.</div>';
    }
    for (const { name, rows } of players.values()) {
        if (showNames)
            body += `<div style="color:#aaa; font-size:12px; font-weight:600; margin-top:6px;">${esc(name)}</div>`;
        for (const c of rows) {
            const row = describeRow(c, gameData, c.to);
            body +=
                `<div style="font-size:12px; margin:3px 0 3px 8px;">` +
                `<span style="color:#e0e0e0;">${esc(c.itemName)}</span> — ${esc(row)} ` +
                `<span style="color:#888;">(was ${esc(c.from)})</span><br>` +
                `<span style="color:#4caf50;">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span>` +
                ` <span style="color:#888;">· ${deltaCells(c)}</span></div>`;
        }
    }

    if (result.combined) {
        const c = result.combined;
        const good = c.deltaScore > 0 && result.reliable !== false;
        body +=
            `<div style="font-size:12px; margin-top:8px; padding-top:6px; border-top:1px solid #2a2a4a;">` +
            `<b>All changes together</b> (fresh seeds, ${c.seeds} runs): ` +
            `<span style="color:${good ? '#4caf50' : '#ff9800'};">Δscore ${esc(fmtScore(c.deltaScore))} ± ${esc(fmtSe(c.se))}</span>` +
            ` <span style="color:#888;">· ${deltaCells(c)}</span></div>`;
    } else if (changes.length > 0) {
        body +=
            '<div style="font-size:11px; color:#ff9800; margin-top:8px;">Stopped before the all-together check ' +
            'ran; each figure above is from the step that accepted it.</div>';
    }

    const unchanged = result.unchanged || [];
    if (unchanged.length > 0) {
        body +=
            `<div style="font-size:11px; color:#666; margin-top:6px;">Kept as is: ` +
            `${esc([...new Set(unchanged.map((t) => t.itemName))].join(', '))}.</div>`;
    }

    body +=
        `<div style="font-size:11px; color:#666; margin-top:6px;">` +
        `Score is the average of the EXP/h, profit/h, DPS and encounters/h changes, less 10 points per extra ` +
        `death per hour. A change is kept only when it clears a 95% test on seeds that did not pick it, and gains at least half a point. ` +
        `${esc(result.simCount)} sims${result.stopped ? ' (stopped early, showing what was accepted)' : ''}. ` +
        `The userscript never changes triggers in the game; enter these by hand.</div>`;

    if (changes.length > 0) {
        body +=
            `<div style="display:flex; gap:8px; margin-top:8px;">` +
            `<button id="mwi-csim-trigger-apply" style="${BTN_STYLE}"${canApply ? '' : ' disabled'} ` +
            `title="Writes the new values into this simulator's trigger editor so the next Simulate uses them. Nothing is sent to the game.">Apply to sim editor</button>` +
            `<button id="mwi-csim-trigger-copy" style="${BTN_STYLE}" title="Copies one line per change, to enter in the game yourself">Copy as text</button>` +
            `</div>`;
    }
    return wrap(body);
}
