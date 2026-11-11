/**
 * The Results tab's "Casts per ability" block: how often each equipped ability of the shown player
 * actually fired, with the ones that never did called out.
 */
import { formatRatePerHour } from '../../utils/formatters.js';
import { collapseHeaderHtml } from './collapsible-sections.js';

const escapeHtml = (text) =>
    String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/**
 * Rows for one player's per-ability cast counts, busiest first, never-cast abilities last.
 * @param {Object<string, number>} abilityCasts - ability hrid to casts over the run
 * @param {number} hours - Simulated hours the counts cover
 * @param {Object} gameData - Game data payload (ability names)
 * @returns {Array<{hrid: string, name: string, casts: number, perHour: number}>}
 */
export function abilityCastRows(abilityCasts, hours, gameData) {
    const rows = Object.entries(abilityCasts || {}).map(([hrid, casts]) => ({
        hrid,
        name: gameData?.abilityDetailMap?.[hrid]?.name || String(hrid).split('/').pop().replace(/_/g, ' '),
        casts: Number(casts) || 0,
        perHour: hours > 0 ? (Number(casts) || 0) / hours : 0,
    }));
    return rows.sort((a, b) => b.casts - a.casts || a.name.localeCompare(b.name));
}

/**
 * @param {Object<string, number>} abilityCasts - ability hrid to casts over the run
 * @param {number} hours - Simulated hours the counts cover
 * @param {Object} gameData - Game data payload
 * @param {{rowStyle: string, labelStyle: string, valueStyle: string}} styles - The Overview rows' styles
 * @returns {string} HTML
 */
export function abilityCastsHtml(
    abilityCasts,
    hours,
    gameData,
    { rowStyle, labelStyle, valueStyle, collapsible = false }
) {
    const rows = abilityCastRows(abilityCasts, hours, gameData);
    if (rows.length === 0) return '';
    const hint =
        'Casts that went through, per hour of simulated time. An ability with no casts never fired: check its trigger.';
    // Minimizable: the heading and its rows share a parent of their own, so only the rows go
    let html = collapsible
        ? `<div data-ability-casts-block>` +
          collapseHeaderHtml({
              key: 'results-casts',
              title: `<span title="${hint}">Casts/hr by ability</span>`,
              style: `${rowStyle} ${labelStyle}`,
          })
        : `<div data-ability-casts style="${rowStyle}" title="${hint}">` +
          `<span style="${labelStyle}">Casts/hr by ability</span><span></span></div>`;
    for (const row of rows) {
        const never = row.casts === 0;
        html +=
            `<div data-ability-cast="${escapeHtml(row.hrid)}" style="${rowStyle} padding-left:10px;">` +
            `<span style="${never ? 'color:#ff6b6b;' : labelStyle}">${escapeHtml(row.name)}</span>` +
            (never
                ? `<span style="color:#ff6b6b; font-weight:600;">never cast</span>`
                : `<span style="${valueStyle}">${formatRatePerHour(row.perHour)}</span>`) +
            `</div>`;
    }
    return collapsible ? `${html}</div>` : html;
}
