/**
 * A small line chart as an SVG string.
 *
 * Toolasha already draws charts with Chart.js (the dungeon tracker, networth
 * history), and it is not used here on purpose. Both boards that carry this
 * graph rebuild their body from one HTML string every few seconds; a Chart.js
 * instance lives on a canvas element and holds a resize observer and an
 * animation loop, so every rebuild would have to find, destroy and recreate it
 * — the leak `dungeon-tracker-ui-chart.js` spends its `dispose()` guarding
 * against. A string fits the boards' render model as it stands.
 *
 * Every colour is a hex this codebase produced (`player-colors.js`) and every
 * label goes through `escapeText`, so nothing off the wire reaches the markup.
 */

import { BOARD_COLORS, escapeText } from './damage-board.js';
import { formatKMB } from './formatters.js';

/** The ink boss stretches are shaded in, as KikiMeter draws them */
export const BOSS_COLOR = '#ff3f34';

/** The party line's ink: light and neutral, so no player's colour is mistaken for it */
export const PARTY_COLOR = '#e8ecf5';

/**
 * The graph's heading and view buttons.
 * @param {Array<{key: string, label: string}>} views - Buttons, in order
 * @param {string} active - The view showing
 * @param {string} attr - The data attribute each button carries its key in
 * @returns {string} HTML
 */
export function graphButtonsHTML(views, active, attr) {
    const { accent, dim } = BOARD_COLORS;
    return (
        `<div style="display:flex; gap:4px; justify-content:flex-end; margin-bottom:3px;">` +
        `<span style="margin-right:auto; color:${dim}; font-size:10px;">DPS over time</span>` +
        views
            .map((entry) => {
                const on = entry.key === active;
                const color = on ? accent : dim;
                return (
                    `<button ${attr}="${escapeText(entry.key)}" style="cursor:pointer; padding:0 5px;` +
                    ` border-radius:3px; font-size:9px; line-height:1.5; color:${color};` +
                    ` background:${on ? `${color}22` : 'transparent'};` +
                    ` border:1px solid ${on ? color : 'rgba(255,255,255,0.15)'};">${escapeText(entry.label)}</button>`
                );
            })
            .join('') +
        `</div>`
    );
}

/**
 * A round step for about `ticks` gridlines up to `max`.
 * @param {number} max - Largest value drawn
 * @param {number} [ticks] - Gridlines wanted
 * @returns {number}
 */
export function niceStep(max, ticks = 3) {
    if (!(max > 0)) return 1;
    const raw = max / ticks;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const fraction = raw / magnitude;
    const nice = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
    return nice * magnitude;
}

/**
 * The chart.
 *
 * @param {Object} chart - What to draw
 * @param {number[]} chart.xs - X per point, ascending
 * @param {Array<{values: number[], color: string, width?: number, label?: string}>} chart.lines - Drawn in
 *   order, so the last is on top
 * @param {Array<{from: number, to: number}>} [chart.bands] - X ranges shaded as boss fights
 * @param {Array<{x: number, label?: string}>} [chart.markers] - Vertical boundaries, labelled at the top
 * @param {Array<{x: number, label: string}>} [chart.xTicks] - Labels along the bottom
 * @param {number} [chart.width] - viewBox width
 * @param {number} [chart.height] - viewBox height
 * @returns {string} SVG markup, or '' with fewer than two points
 */
export function dpsGraphSVG({ xs, lines, bands = [], markers = [], xTicks = [], width = 300, height = 96 }) {
    if (!Array.isArray(xs) || xs.length < 2) return '';

    const pad = { left: 30, right: 4, top: 8, bottom: 12 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const x0 = xs[0];
    const span = xs[xs.length - 1] - x0 || 1;

    const max = Math.max(1, ...lines.flatMap((line) => line.values.filter(Number.isFinite)));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;

    const px = (x) => (pad.left + ((x - x0) / span) * plotWidth).toFixed(1);
    const py = (v) => (pad.top + plotHeight * (1 - Math.max(0, v) / top)).toFixed(1);
    const bottom = pad.top + plotHeight;

    const parts = [];

    for (const band of bands) {
        const left = Number(px(Math.max(x0, band.from)));
        const right = Number(px(Math.min(xs[xs.length - 1], band.to)));
        if (right <= left) continue;
        parts.push(
            `<rect data-band x="${left.toFixed(1)}" y="${pad.top}" width="${(right - left).toFixed(1)}" ` +
                `height="${plotHeight}" fill="${BOSS_COLOR}" fill-opacity="0.16"></rect>`
        );
    }

    for (let v = 0; v <= top + step / 2; v += step) {
        const y = py(v);
        parts.push(
            `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#ffffff" ` +
                `stroke-opacity="0.08" stroke-dasharray="3 3"></line>` +
                `<text x="${pad.left - 3}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end" font-size="8" ` +
                `fill="#9ca3af">${escapeText(formatKMB(Math.round(v)))}</text>`
        );
    }

    for (const marker of markers) {
        const x = px(marker.x);
        parts.push(
            `<line data-marker x1="${x}" y1="${pad.top}" x2="${x}" y2="${bottom}" stroke="#ffffff" ` +
                `stroke-opacity="0.35" stroke-dasharray="2 2"></line>` +
                (marker.label
                    ? `<text x="${x}" y="${pad.top - 1}" text-anchor="middle" font-size="7" fill="#e8ecf5">` +
                      `${escapeText(marker.label)}</text>`
                    : '')
        );
    }

    for (const tick of xTicks) {
        parts.push(
            `<text x="${px(tick.x)}" y="${height - 2}" text-anchor="middle" font-size="7" fill="#9ca3af">` +
                `${escapeText(tick.label)}</text>`
        );
    }

    for (const line of lines) {
        const coords = xs.map((x, i) => `${px(x)},${py(Number(line.values[i]) || 0)}`).join(' ');
        parts.push(
            `<polyline points="${coords}" fill="none" stroke="${escapeText(line.color)}" ` +
                `stroke-width="${line.width || 1.2}" stroke-linejoin="round" stroke-linecap="round">` +
                (line.label ? `<title>${escapeText(line.label)}</title>` : '') +
                `</polyline>`
        );
    }

    parts.push(
        `<path d="M${pad.left} ${pad.top} V${bottom} H${width - pad.right}" stroke="#ffffff" ` +
            `stroke-opacity="0.2" fill="none"></path>`
    );

    return (
        `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" ` +
        `style="display:block; background:rgba(0,0,0,0.25); border-radius:4px;">${parts.join('')}</svg>`
    );
}
