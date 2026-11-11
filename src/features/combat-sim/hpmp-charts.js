/**
 * Small inline-SVG line charts for the Combat Sim results: the party's HP/MP in
 * the 30 s before a wipe, and each player's HP and MP across the whole run.
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

const yOf = (value) => {
    const plotH = H - PAD_T - PAD_B;
    return PAD_T + plotH * (1 - Math.min(100, Math.max(0, value)) / 100);
};

/**
 * Line width for the player at `rank` of `count`: the first is thickest and drawn
 * lowest, so a line sitting exactly under another still shows an edge.
 * @param {number} rank
 * @param {number} count
 * @returns {number}
 */
const widthOf = (rank, count) => Math.max(1, 2.6 - rank * Math.min(0.4, 1.6 / Math.max(1, count - 1)));

const minutesText = (m) => (m >= 120 ? `${Math.round(m / 60)}h` : `${Math.round(m)}m`);

/**
 * The faint band between each bucket's average and its lowest value, one shape per
 * unbroken stretch of buckets (a lone bucket is a vertical bar).
 * @param {Array<number|null>} avg
 * @param {Array<number|null>} low
 * @param {function(number): number} xOf
 * @param {string} color
 * @returns {string}
 */
function bandOf(avg, low, xOf, color) {
    let svg = '';
    let run = [];
    const flush = () => {
        if (run.length === 1) {
            const i = run[0];
            svg += `<line data-band x1="${xOf(i).toFixed(1)}" x2="${xOf(i).toFixed(1)}" y1="${yOf(avg[i]).toFixed(1)}" y2="${yOf(low[i]).toFixed(1)}" stroke="${color}" stroke-width="3" opacity="0.2"/>`;
        } else if (run.length > 1) {
            const top = run.map((i) => `${xOf(i).toFixed(1)} ${yOf(avg[i]).toFixed(1)}`);
            const bottom = run
                .slice()
                .reverse()
                .map((i) => `${xOf(i).toFixed(1)} ${yOf(Math.min(low[i], avg[i])).toFixed(1)}`);
            svg += `<polygon data-band points="${top.concat(bottom).join(' ')}" fill="${color}" opacity="0.16"/>`;
        }
        run = [];
    };
    avg.forEach((value, i) => {
        if (Number.isFinite(value) && Number.isFinite(low?.[i])) run.push(i);
        else flush();
    });
    flush();
    return svg;
}

/**
 * One whole-run chart: the listed kinds drawn for every shown player.
 * @param {Object} series - `simResult.hpMpSeries`
 * @param {Array<{key: string, minKey: string, dashed: boolean}>} kinds
 * @param {Array<number>} shown - player indices to draw
 * @param {Array<number>} all - every player index (sets the line widths)
 * @returns {{svg: string, empty: boolean}} `empty` when no player has a drawable point
 */
function runChartSvg(series, kinds, shown, all) {
    const lengths = kinds.flatMap((k) =>
        Array.isArray(series[k.key]) ? series[k.key].map((line) => (Array.isArray(line) ? line.length : 0)) : []
    );
    const points = Math.max(0, ...lengths);
    if (points < 1) return { svg: '', empty: true };
    const step = Number(series.stepSeconds) > 0 ? Number(series.stepSeconds) : 60;
    const totalMinutes = (points * step) / 60;
    const plotW = W - PAD_L - PAD_R;
    // A bucket is drawn at its midpoint; a single point sits in the middle
    const xOf = (i) => PAD_L + plotW * ((i + 0.5) / points);
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
    const skip = (kind, p) => kind.key === 'mp' && series.hasMp?.[p] === false;
    let drawn = 0;
    // Bands first (underneath), then lines from the first player (thickest, lowest) to the last
    for (const kind of kinds) {
        for (const p of shown) {
            if (skip(kind, p)) continue;
            svg += bandOf(series[kind.key]?.[p] || [], series[kind.minKey]?.[p] || [], xOf, colorOf(p));
        }
    }
    for (const p of shown) {
        const rank = all.indexOf(p);
        for (const kind of kinds) {
            if (skip(kind, p)) continue;
            const path = pathOf(series[kind.key]?.[p] || [], xOf);
            if (!path) continue;
            drawn++;
            const dash = kind.dashed ? ' stroke-dasharray="4 3"' : '';
            const width = (kind.dashed ? 0.85 : 1) * widthOf(rank, all.length);
            // The dark halo keeps a line readable where it crosses or sits on another
            svg += `<path data-halo d="${path}" fill="none" stroke="#0d0d0d" stroke-width="${(width + 1.4).toFixed(1)}" opacity="0.55"${dash}/>`;
            svg += `<path data-player="${escapeText(series.playerHrids[p])}" data-kind="${kind.key}" d="${path}" fill="none" stroke="${colorOf(p)}" stroke-width="${width.toFixed(1)}"${dash}/>`;
        }
    }
    return { svg, empty: drawn === 0 };
}

const NOTE_STYLE = `font-size:11px; color:${LABEL}; padding:14px 8px; background:#0d0d0d; border-radius:3px; text-align:center;`;

/**
 * @param {string} title
 * @param {string} label - aria-label
 * @param {string} body - inner SVG, or '' for the note
 * @param {string} note - the note text used when body is ''
 * @param {boolean} wide - single (overlay) chart
 * @returns {string}
 */
function chartBox(title, label, body, note, wide) {
    const flex = wide ? 'flex:1 1 320px; max-width:480px;' : 'flex:1 1 260px;';
    return (
        `<div data-hpmp-chart style="${flex} min-width:0;">` +
        `<div style="font-size:10px; color:${LABEL}; margin-bottom:2px;">${escapeText(title)}</div>` +
        (body
            ? `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeText(label)}" style="width:100%; height:auto; display:block; background:#0d0d0d; border-radius:3px;">${body}</svg>`
            : `<div data-hpmp-note style="${NOTE_STYLE}">${escapeText(note)}</div>`) +
        `</div>`
    );
}

/**
 * @param {Array<{name: string, color: string, hrid: string, off: boolean}>} entries
 * @returns {string} Clickable legend: a click hides or shows that player
 */
function toggleLegend(entries) {
    const items = entries
        .map(
            (e) =>
                `<button type="button" data-hpmp-toggle="${escapeText(e.hrid)}" aria-pressed="${e.off ? 'false' : 'true'}" title="Click to ${e.off ? 'show' : 'hide'} this player" style="display:inline-flex; align-items:center; gap:3px; margin:0 8px 2px 0; padding:0; background:none; border:0; color:${e.off ? '#666' : '#aaa'}; font:inherit; cursor:pointer;${e.off ? ' text-decoration:line-through;' : ''}"><span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${e.off ? '#444' : e.color};"></span>${escapeText(e.name)}</button>`
        )
        .join('');
    return `<div data-hpmp-legend style="display:flex; flex-wrap:wrap; font-size:10px; margin-top:4px;">${items}</div>`;
}

/**
 * Time under a share of the pool, per player, as one line ('' when no figure).
 * @param {string} attr - data attribute name
 * @param {string} label
 * @param {Array<number>} order - player indices
 * @param {Array<number|null>|undefined} shares
 * @param {Object} series
 * @param {function(string): string} playerName
 * @returns {string}
 */
function shareLine(attr, label, order, shares, series, playerName) {
    const parts = order
        .map((p) => {
            const share = shares?.[p];
            return Number.isFinite(share)
                ? `${escapeText(playerName(series.playerHrids[p]))} ${(share * 100).toFixed(share > 0 && share < 0.01 ? 1 : 0)}%`
                : null;
        })
        .filter(Boolean);
    return parts.length > 0
        ? `<div ${attr} style="font-size:10px; color:#aaa; margin-top:2px;">${label}: ${parts.join(', ')}</div>`
        : '';
}

/**
 * Every player's HP and MP across the whole run: two charts side by side (they
 * wrap under each other on a narrow screen), or one with HP solid and MP dashed.
 * Each bucket draws its average as a line and a faint band down to its lowest
 * value, so a moment at 0 shows even when the average reads 95 %.
 *
 * @param {Object|null|undefined} series - `simResult.hpMpSeries`; null on a run that recorded none
 * @param {function(string): string} playerName - hrid to display name
 * @param {Object} [options]
 * @param {boolean} [options.overlay] - One chart with both
 * @param {Iterable<string>} [options.hidden] - Player hrids switched off in the legend
 * @returns {string} HTML; a short note when the run has no series
 */
export function renderRunCharts(series, playerName, { overlay = false, hidden = [] } = {}) {
    const wrapStyle = 'margin:8px 0 4px; font-family:sans-serif;';
    const usable = series && Array.isArray(series.playerHrids) && series.playerHrids.length > 0;
    if (!usable) {
        return (
            `<div data-hpmp-run style="${wrapStyle}">` +
            `<div style="font-size:10px; color:${LABEL}; margin-bottom:2px;">HP and MP over the run</div>` +
            `<div data-hpmp-note style="${NOTE_STYLE}">Not recorded for this run.</div></div>`
        );
    }
    const off = new Set(hidden);
    const all = series.playerHrids.map((_, p) => p);
    const shown = all.filter((p) => !off.has(series.playerHrids[p]));
    const step = Number(series.stepSeconds) > 0 ? Number(series.stepSeconds) : 60;
    const avgText = `average per ${minutesText(step / 60)}, shaded down to the lowest`;
    const hpKind = { key: 'hp', minKey: 'hpMin', dashed: false };
    const mpKind = { key: 'mp', minKey: 'mpMin', dashed: overlay };
    const noneShown = shown.length === 0;

    let charts;
    if (overlay) {
        const both = runChartSvg(series, [hpKind, mpKind], shown, all);
        charts = chartBox(
            `HP (solid) and MP (dashed) over the run (${avgText})`,
            'HP and MP over the run',
            both.empty ? '' : both.svg,
            noneShown ? 'Every player is hidden.' : 'Not recorded for this run.',
            true
        );
    } else {
        const hp = runChartSvg(series, [hpKind], shown, all);
        const mp = runChartSvg(series, [mpKind], shown, all);
        const noMana = Array.isArray(series.hasMp) && series.hasMp.length > 0 && series.hasMp.every((v) => v === false);
        let mpNote = 'Not recorded for this run.';
        if (noneShown) mpNote = 'Every player is hidden.';
        else if (noMana) mpNote = 'No player has a mana pool.';
        charts =
            chartBox(
                `HP over the run (${avgText})`,
                'HP over the run',
                hp.empty ? '' : hp.svg,
                noneShown ? 'Every player is hidden.' : 'Not recorded for this run.',
                false
            ) + chartBox(`MP over the run (${avgText})`, 'MP over the run', mp.empty ? '' : mp.svg, mpNote, false);
    }
    const entries = all.map((p) => ({
        name: playerName(series.playerHrids[p]),
        color: colorOf(p),
        hrid: series.playerHrids[p],
        off: off.has(series.playerHrids[p]),
    }));
    const withMp = shown.filter((p) => series.hasMp?.[p] !== false);
    const hasStarts = Array.isArray(series.runStarts) && series.runStarts.length > 0 && series.runStarts.length <= 120;
    return (
        `<div data-hpmp-run style="${wrapStyle}">` +
        `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">` +
        `<span style="font-size:11px; color:#ccc;">HP and MP over the run</span>` +
        `<label style="font-size:11px; color:#aaa; cursor:pointer;"><input type="checkbox" data-hpmp-overlay${overlay ? ' checked' : ''}> Overlay</label>` +
        `</div>` +
        `<div style="display:flex; flex-wrap:wrap; gap:8px;">${charts}</div>` +
        toggleLegend(entries) +
        (hasStarts ? `<div style="font-size:10px; color:${LABEL};">ticks: dungeon run starts</div>` : '') +
        shareLine('data-hpmp-low-hp', 'Time under 25% HP', shown, series.lowHpShare, series, playerName) +
        shareLine('data-hpmp-low', 'Time under 10% MP', withMp, series.lowMpShare, series, playerName) +
        `</div>`
    );
}
