/**
 * Small inline-SVG line charts for the Combat Sim results: the party's HP/MP in
 * the 30 s before a wipe, and each player's MP across the whole run.
 *
 * No chart library: Chart.js is not loaded in every build, and these are a few
 * polylines. Pure string builders; every player name is escaped here.
 */

const PALETTE = ['#7ec87e', '#93c5fd', '#f0b429', '#c4b5fd', '#ff9a9a', '#5eead4', '#fda4af', '#a3e635'];
const AXIS = '#444';
const LABEL = '#888';

const W = 320;
const H = 120;
const PAD_L = 28;
const PAD_R = 6;
const PAD_T = 6;
const PAD_B = 16;

const escapeText = (value) =>
    String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colorOf = (index) => PALETTE[index % PALETTE.length];

/**
 * A path through the points, lifting the pen at gaps (null/non-finite values).
 * @param {Array<number|null>} values - y values in percent
 * @param {function(number): number} xOf - Index to x
 * @returns {string} SVG path data, '' when no point is drawable
 */
function pathOf(values, xOf) {
    const plotH = H - PAD_T - PAD_B;
    let d = '';
    let pen = false;
    values.forEach((value, i) => {
        if (!Number.isFinite(value)) {
            pen = false;
            return;
        }
        const clamped = Math.min(100, Math.max(0, value));
        const y = PAD_T + plotH * (1 - clamped / 100);
        d += `${pen ? 'L' : 'M'}${xOf(i).toFixed(1)} ${y.toFixed(1)}`;
        pen = true;
    });
    return d;
}

/**
 * The frame: y gridlines at 0/50/100 % and the caller's x tick labels.
 * @param {Array<{x: number, text: string}>} xTicks
 * @returns {string}
 */
function frame(xTicks) {
    const plotH = H - PAD_T - PAD_B;
    let svg = '';
    for (const pct of [0, 50, 100]) {
        const y = PAD_T + plotH * (1 - pct / 100);
        svg += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="${AXIS}" stroke-width="${pct === 0 ? 1 : 0.5}"${pct === 50 ? ' stroke-dasharray="2 3"' : ''}/>`;
        svg += `<text x="${PAD_L - 3}" y="${y + 3}" fill="${LABEL}" font-size="8" text-anchor="end">${pct}%</text>`;
    }
    for (const tick of xTicks) {
        svg += `<text x="${tick.x.toFixed(1)}" y="${H - 4}" fill="${LABEL}" font-size="8" text-anchor="middle">${escapeText(tick.text)}</text>`;
    }
    return svg;
}

/**
 * @param {Array<{name: string, color: string}>} entries
 * @param {string} [extra] - Trailing legend text (line styles)
 * @returns {string}
 */
function legend(entries, extra = '') {
    const items = entries
        .map(
            (e) =>
                `<span style="display:inline-flex; align-items:center; gap:3px; margin-right:8px;"><span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${e.color};"></span>${escapeText(e.name)}</span>`
        )
        .join('');
    return `<div data-hpmp-legend style="display:flex; flex-wrap:wrap; font-size:10px; color:#aaa; margin-top:2px;">${items}${extra ? `<span style="color:${LABEL};">${extra}</span>` : ''}</div>`;
}

/**
 * HP (solid) and MP (dashed) per player over the 30 s before a wipe.
 * @param {Object|null|undefined} hpMp - `wipeEvents[n].hpMp`; absent on older results
 * @param {function(string): string} playerName - hrid to display name
 * @returns {string} HTML, or '' when the event carries no usable samples
 */
export function renderPreWipeChart(hpMp, playerName) {
    if (
        !hpMp ||
        !Array.isArray(hpMp.playerHrids) ||
        !Array.isArray(hpMp.secondsBefore) ||
        hpMp.secondsBefore.length < 2 ||
        !Array.isArray(hpMp.hp)
    ) {
        return '';
    }
    const window = Math.max(30, ...hpMp.secondsBefore.filter(Number.isFinite));
    const plotW = W - PAD_L - PAD_R;
    // Time runs left to right: the oldest sample on the left, the wipe on the right
    const xOf = (i) => PAD_L + plotW * (1 - hpMp.secondsBefore[i] / window);
    let svg = frame([
        { x: PAD_L, text: `-${Math.round(window)}s` },
        { x: PAD_L + plotW / 2, text: `-${Math.round(window / 2)}s` },
        { x: PAD_L + plotW, text: 'wipe' },
    ]);
    const entries = [];
    hpMp.playerHrids.forEach((hrid, p) => {
        const color = colorOf(p);
        entries.push({ name: playerName(hrid), color });
        const hpPath = pathOf(hpMp.hp[p] || [], xOf);
        if (hpPath) svg += `<path d="${hpPath}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
        const mpPath = pathOf(hpMp.mp?.[p] || [], xOf);
        if (mpPath) {
            svg += `<path d="${mpPath}" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 2" opacity="0.85"/>`;
        }
    });
    return (
        `<div data-hpmp-prewipe style="margin:0 0 8px; font-family:sans-serif;">` +
        `<div style="font-size:10px; color:${LABEL}; margin-bottom:2px;">HP and MP, the last ${Math.round(window)} seconds before the wipe</div>` +
        `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="HP and MP before the wipe" style="width:100%; max-width:480px; height:auto; display:block; background:#0d0d0d; border-radius:3px;">${svg}</svg>` +
        legend(entries, 'solid: HP · dashed: MP') +
        `</div>`
    );
}

/**
 * Each player's MP across the whole run, with the share of time under 10 % MP.
 * @param {Object|null|undefined} series - `simResult.hpMpSeries`
 * @param {function(string): string} playerName - hrid to display name
 * @returns {string} HTML, or '' when there is nothing to draw
 */
export function renderRunMpChart(series, playerName) {
    if (!series || !Array.isArray(series.playerHrids) || !Array.isArray(series.mp) || series.playerHrids.length === 0) {
        return '';
    }
    const points = Math.max(0, ...series.mp.map((line) => (Array.isArray(line) ? line.length : 0)));
    if (points < 1) return '';
    const withMp = series.playerHrids.map((_, p) => p).filter((p) => series.hasMp?.[p] !== false);
    const step = Number(series.stepSeconds) > 0 ? Number(series.stepSeconds) : 60;
    const totalMinutes = (points * step) / 60;
    const plotW = W - PAD_L - PAD_R;
    // A bucket is drawn at its midpoint; a single point sits in the middle
    const xOf = (i) => PAD_L + plotW * ((i + 0.5) / points);
    const minutesText = (m) => (m >= 120 ? `${Math.round(m / 60)}h` : `${Math.round(m)}m`);
    let svg = frame([
        { x: PAD_L, text: '0' },
        { x: PAD_L + plotW / 2, text: minutesText(totalMinutes / 2) },
        { x: PAD_L + plotW, text: minutesText(totalMinutes) },
    ]);
    // Dungeon run starts, as faint ticks along the floor (skipped when too dense to read)
    const starts = Array.isArray(series.runStarts) ? series.runStarts : [];
    if (starts.length > 0 && starts.length <= 120) {
        const floor = H - PAD_B;
        for (const t of starts) {
            const x = PAD_L + plotW * Math.min(1, t / (points * step));
            svg += `<line data-run-start x1="${x.toFixed(1)}" y1="${floor}" x2="${x.toFixed(1)}" y2="${floor - 4}" stroke="${LABEL}" stroke-width="0.6"/>`;
        }
    }
    const entries = [];
    for (const p of withMp) {
        const color = colorOf(p);
        entries.push({ name: playerName(series.playerHrids[p]), color });
        const path = pathOf(series.mp[p] || [], xOf);
        if (path) svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="1.4"/>`;
    }
    if (entries.length === 0) return '';

    const shares = withMp
        .map((p) => {
            const share = series.lowMpShare?.[p];
            return Number.isFinite(share)
                ? `${escapeText(playerName(series.playerHrids[p]))} ${(share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0)}%`
                : null;
        })
        .filter(Boolean);
    const startNote = starts.length > 0 && starts.length <= 120 ? ' · ticks: dungeon run starts' : '';
    return (
        `<div data-hpmp-run style="margin:8px 0 4px; font-family:sans-serif;">` +
        `<div style="font-size:10px; color:${LABEL}; margin-bottom:2px;">MP over the run (average per ${minutesText(step / 60)} of simulated time)</div>` +
        `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="MP over the run" style="width:100%; max-width:480px; height:auto; display:block; background:#0d0d0d; border-radius:3px;">${svg}</svg>` +
        legend(entries, startNote.replace(/^ · /, '')) +
        (shares.length > 0
            ? `<div data-hpmp-low style="font-size:10px; color:#aaa; margin-top:2px;">Time under 10% MP: ${shares.join(', ')}</div>`
            : '') +
        `</div>`
    );
}
