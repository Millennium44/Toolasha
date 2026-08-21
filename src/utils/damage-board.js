/**
 * A ranked per-player board, drawn once and used twice.
 *
 * The trial scoreboard (`guild-trial-scoreboard.js`) had the shape everybody
 * wanted — a headline rate, tabs, and a row per player carrying rank, name,
 * class, figure, rate and a share bar behind it — and it could only ever be
 * opened for a guild trial, because it reads the trial's own attribution
 * modules directly. A normal party fight has the same question and the same
 * numbers available (`damage-tracker.js`, `damage-taken-tracker.js`) and had
 * nowhere to show them.
 *
 * Rather than a second five-hundred-line panel that drifts from the first, the
 * parts that are about *drawing a ranked board* live here and both panels call
 * them. What stays with each panel is what is genuinely its own: where the rows
 * come from, and the paragraph of caveats that explains what the figures are —
 * which is the half a trial and a personal fight disagree about most.
 *
 * ## Why HTML strings rather than elements
 *
 * The trial panel builds its body as one string and assigns it, which is what
 * lets a redraw be a single write rather than a diff. Returning elements here
 * would have meant rewriting that panel's render loop to adopt a shared row —
 * a change to working code in service of new code, which is the trade this was
 * meant to avoid. Nothing user-supplied is interpolated: a name goes through
 * {@link escapeText}, every figure is a number this module formatted, and the
 * class tag arrives as markup its own module already made safe.
 */

import { formatKMB, formatWithSeparator } from './formatters.js';

/** The board's ink, matching what the trial panel already drew with */
export const BOARD_COLORS = {
    accent: '#8fd3ff',
    dim: '#9ca3af',
    good: '#4ade80',
    warn: '#f0a830',
};

/**
 * Rank a tab's rows and work out each one's share.
 *
 * Rows with nothing in them are dropped: a healer with no damage on the damage
 * tab is a zero-length bar and a rank nobody wanted. Pure — it takes numbers
 * and returns numbers, so the arithmetic is tested without a DOM.
 *
 * A row may state its own `perSecond`; when it does not, it is the row's value
 * over the elapsed seconds. The distinction matters because a tracker that
 * refuses to divide before it has enough seconds is saying something ("too
 * early for a rate") that recomputing here would silently overwrite.
 *
 * @param {Array<{name: string, value: number, perSecond?: number|null}>} raw - Unranked rows
 * @param {number} [seconds] - How long the measurement has been running
 * @returns {{rows: Array<Object>, total: number, perSecond: number|null, seconds: number}}
 */
export function rankRows(raw, seconds = 0) {
    const rows = (raw || []).filter((row) => Number(row?.value) > 0).sort((a, b) => Number(b.value) - Number(a.value));
    const total = rows.reduce((sum, row) => sum + Number(row.value), 0);

    return {
        rows: rows.map((row, position) => ({
            ...row,
            value: Number(row.value),
            rank: position + 1,
            perSecond: row.perSecond === undefined ? (seconds > 0 ? Number(row.value) / seconds : null) : row.perSecond,
            share: total > 0 ? (Number(row.value) / total) * 100 : null,
        })),
        total,
        perSecond: seconds > 0 ? total / seconds : null,
        seconds,
    };
}

/**
 * The board's headline: one big figure, what it is, and a total off to the side.
 *
 * `right` takes a number to format or a string to print as given — "3/5
 * builds" is not a quantity and would be wrong rounded. `prefix` is for the
 * tilde an estimate carries, which has to sit against the digits rather than
 * being folded into the label.
 *
 * @param {Object} head - What it says
 * @param {number|null} head.value - The big figure, or null for a dash
 * @param {string} head.label - What the figure is
 * @param {number|string|null} [head.right] - The secondary figure, right-aligned
 * @param {string} [head.prefix] - Sits against the big figure
 * @param {string} [head.color] - Ink for the big figure
 * @param {string} [head.rightColor] - Ink for the secondary figure
 * @returns {string} HTML
 */
export function boardHeadHTML({
    value,
    label,
    right = null,
    prefix = '',
    color = BOARD_COLORS.accent,
    rightColor,
} = {}) {
    const figure = value === null || value === undefined ? '—' : `${prefix}${formatKMB(Math.round(value))}`;
    const aside =
        right === null || right === undefined
            ? ''
            : `<span style="margin-left:auto; color:${rightColor || BOARD_COLORS.good}; font-weight:600;">` +
              `${typeof right === 'number' ? formatKMB(Math.round(right)) : escapeText(right)}</span>`;

    return (
        `<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:2px;">` +
        `<span style="font-size:20px; font-weight:700; color:${color};">${figure}</span>` +
        `<span style="color:${BOARD_COLORS.dim};">${escapeText(label)}</span>${aside}</div>`
    );
}

/**
 * The tab strip. Each button carries `data-tab`, which is what the caller binds.
 *
 * @param {Array<{key: string, label: string}>} tabs - In display order
 * @param {string} active - The key currently shown
 * @returns {string} HTML
 */
export function boardTabsHTML(tabs, active) {
    const { accent, dim } = BOARD_COLORS;
    return (
        `<div style="display:flex; gap:6px; margin:6px 0;">` +
        (tabs || [])
            .map((entry) => {
                const on = entry.key === active;
                return (
                    `<button data-tab="${escapeText(entry.key)}" style="flex:1; cursor:pointer; padding:3px 0;` +
                    `border:1px solid ${on ? accent : 'rgba(255,255,255,0.15)'};` +
                    `border-radius:4px; background:${on ? 'rgba(143,211,255,0.15)' : 'transparent'};` +
                    `color:${on ? accent : dim}; font-size:11px;">${escapeText(entry.label)}</button>`
                );
            })
            .join('') +
        `</div>`
    );
}

/**
 * One ranked row, with its share drawn as the bar behind it.
 *
 * Every optional field degrades to nothing rather than to a placeholder, which
 * is what lets one row serve two panels that know different amounts about a
 * player:
 *
 * - `value === null` means an **estimate** — there is no elapsed fight to have
 *   accumulated a total, so the rate is the whole figure and carries a tilde
 *   rather than being read as a measurement.
 * - `measured === false` marks a row folded in beside one the game streamed
 *   counters for. A table that does not say so is claiming both.
 * - `measuredValue` puts the plugin's own live figure next to an authoritative
 *   one, with the gap between them — both halves of the comparison, on screen.
 *
 * @param {Object} row - From {@link rankRows}
 * @param {Object} [options] - Drawing options
 * @param {string} [options.color] - Bar and figure ink
 * @param {string} [options.tagHTML] - A class marker to sit after the name
 * @returns {string} HTML
 */
export function boardRowHTML(row, { color = BOARD_COLORS.accent, tagHTML = '' } = {}) {
    const { dim } = BOARD_COLORS;
    const width = Math.max(2, Math.min(100, row?.share ?? 0));
    const rate = row?.perSecond === null || row?.perSecond === undefined ? '—' : formatKMB(Math.round(row.perSecond));

    const estimated = row?.value === null || row?.value === undefined;
    const figure = estimated ? `~${rate}/s` : formatKMB(Math.round(row.value));
    const label = estimated ? 'estimated' : row?.measured === false ? `${rate}/s · partial` : `${rate}/s`;

    let comparison = '';
    if (row?.measuredValue !== null && row?.measuredValue !== undefined) {
        const measured = formatKMB(Math.round(row.measuredValue));
        comparison =
            row.measuredDeltaPct === null || row.measuredDeltaPct === undefined
                ? ` · meas ${measured}`
                : ` · meas ${measured} · ${row.measuredDeltaPct >= 0 ? '+' : '−'}${Math.abs(row.measuredDeltaPct).toFixed(0)}%`;
    }

    return (
        `<div style="position:relative; margin:3px 0; padding:3px 6px; border-radius:3px;` +
        `background:linear-gradient(to right, ${color}44 ${width}%, rgba(255,255,255,0.04) ${width}%);">` +
        `<div style="display:flex; gap:6px; align-items:baseline;">` +
        `<span style="color:${dim}; width:14px;">${row?.rank ?? ''}</span>` +
        `<span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
        `${escapeText(row?.name || '')}</span>` +
        tagHTML +
        `<span style="margin-left:auto; color:${color}; font-weight:600;">${figure}</span>` +
        `</div>` +
        `<div style="display:flex; gap:6px; color:${dim}; font-size:10px;">` +
        `<span title="meas: what the plugin's own live stream measured for this player, and how far that ran from the game's reported figure">${label}${comparison}</span>` +
        `<span style="margin-left:auto;">${row?.share === null || row?.share === undefined ? '—' : `${row.share.toFixed(1)}%`}</span>` +
        `</div></div>`
    );
}

/**
 * A paragraph of explanation under the tabs, in one of three voices.
 *
 * @param {string} text - What to say
 * @param {Object} [options] - How to say it
 * @param {string} [options.color] - Ink
 * @param {boolean} [options.strong] - Whether this is the headline claim about the figures
 * @returns {string} HTML
 */
export function boardNoteHTML(text, { color = BOARD_COLORS.dim, strong = false } = {}) {
    if (!text) return '';
    return strong
        ? `<div style="color:${color}; font-size:11px; font-weight:600; line-height:1.5;">${text}</div>`
        : `<div style="color:${color}; font-size:10px; line-height:1.5; margin-bottom:6px;">${text}</div>`;
}

/**
 * A row of actions along the foot. Each carries `data-action`.
 *
 * @param {Array<{key: string, label: string, color?: string}>} actions - In display order
 * @returns {string} HTML
 */
export function boardButtonsHTML(actions) {
    return (
        `<div style="display:flex; gap:6px; margin-top:8px;">` +
        (actions || [])
            .map((action) => {
                const color = action.color || BOARD_COLORS.dim;
                return (
                    `<button data-action="${escapeText(action.key)}" style="flex:1; cursor:pointer; padding:4px 0;` +
                    ` border-radius:4px; border:1px solid ${color}66; background:transparent; color:${color};` +
                    ` font-size:11px;">${escapeText(action.label)}</button>`
                );
            })
            .join('') +
        `</div>`
    );
}

/**
 * The same board as plain text, for the clipboard.
 *
 * @param {string} heading - The first line
 * @param {Array<Object>} rows - From {@link rankRows}
 * @returns {string} One line per player, under the heading
 */
export function boardLines(heading, rows) {
    return [
        heading,
        ...(rows || []).map(
            (row) =>
                `${row.rank}. ${row.name} — ${formatWithSeparator(Math.round(row.value || 0))}` +
                (row.perSecond === null || row.perSecond === undefined
                    ? ''
                    : ` (${formatWithSeparator(Math.round(row.perSecond))}/s`) +
                (row.share === null || row.share === undefined ? ')' : `, ${row.share.toFixed(1)}%)`)
        ),
    ].join('\n');
}

/**
 * Markup-safe text. A player name is the one field here that comes off the wire.
 * @param {string} value - Anything
 * @returns {string}
 */
export function escapeText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
