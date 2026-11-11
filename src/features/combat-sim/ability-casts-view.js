/**
 * The Results tab's "Casts per ability" block: how often each equipped ability of the shown player
 * actually fired, with the ones that never did called out.
 */
import { formatRatePerHour } from '../../utils/formatters.js';

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
export function abilityCastsHtml(abilityCasts, hours, gameData, { rowStyle, labelStyle, valueStyle }) {
    const rows = abilityCastRows(abilityCasts, hours, gameData);
    if (rows.length === 0) return '';
    let html =
        `<div data-ability-casts style="${rowStyle}" title="Casts that went through, per hour of simulated time. ` +
        `An ability with no casts never fired: check its trigger.">` +
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
    return html;
}
