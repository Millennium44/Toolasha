/**
 * A talisman's game-side appearance: the icon and the 0-9 marker a player sets in the game's organizing UI, so two
 * talismans of one type can be told apart. Toolasha only reads them, never sets a marker.
 *
 * Both fields come off the character's own talisman records (`characterTalismans`, `talismans_updated`). A record
 * that does not carry them (another party member's, a sim player's stripped copy, an older server) draws nothing,
 * and 0 or a missing marker draws no badge, so one player's marker is never shown on another player's talisman.
 */

import { spriteUrl } from './overlay-format.js';
import { escapeHtml } from './html-escape.js';

/** Marker pill backgrounds, one per marker 1..9 (cycled beyond that) */
const MARKER_COLORS = [
    '#e57373',
    '#ffb74d',
    '#fff176',
    '#81c784',
    '#4db6ac',
    '#64b5f6',
    '#9575cd',
    '#f06292',
    '#a1887f',
];

/**
 * The appearance a record carries.
 * @param {Object|null|undefined} talisman - A talisman record
 * @returns {{iconHrid: string|null, marker: number}} marker is 0 when there is none
 */
export function talismanAppearance(talisman) {
    const iconHrid = typeof talisman?.iconHrid === 'string' && talisman.iconHrid ? talisman.iconHrid : null;
    const raw = Number(talisman?.marker);
    const marker = Number.isInteger(raw) && raw > 0 ? raw : 0;
    return { iconHrid, marker };
}

/**
 * The sprite sheet an icon hrid is drawn from. An item hrid is on the item sheet; anything else is tried on a
 * talisman sheet first, then the item sheet. Not verified against a live client.
 * @param {string} iconHrid
 * @returns {string} The sheet's URL without fragment, or '' when the game has not named one
 */
function sheetFor(iconHrid) {
    try {
        if (iconHrid.startsWith('/items/')) return spriteUrl('items');
        return spriteUrl('talismans') || spriteUrl('items');
    } catch {
        return '';
    }
}

/**
 * A short plain-text note for a record's marker, for tooltips that cannot hold markup.
 * @param {Object|null|undefined} talisman
 * @returns {string} e.g. "marker 3", or '' when it has none
 */
export function talismanMarkerNote(talisman) {
    const { marker } = talismanAppearance(talisman);
    return marker ? `marker ${marker}` : '';
}

/**
 * The icon and marker as inline markup, for the panels that build their rows as strings.
 * @param {Object|null|undefined} talisman - A talisman record
 * @param {Object} [options]
 * @param {number} [options.size] - Icon pixels
 * @returns {string} '' when the record carries neither (so a row never gains an empty gap)
 */
export function talismanBadgeHTML(talisman, { size = 16 } = {}) {
    const { iconHrid, marker } = talismanAppearance(talisman);
    let icon = '';
    if (iconHrid) {
        const sheet = sheetFor(iconHrid);
        if (sheet) {
            const href = `${sheet}#${iconHrid.split('/').pop()}`;
            icon = `<svg width="${size}" height="${size}" style="flex:0 0 auto; vertical-align:middle;" data-talisman-icon><use href="${escapeHtml(href)}"></use></svg>`;
        }
    }
    const badge = marker
        ? `<span data-talisman-marker="${marker}" title="Marker ${marker}" style="display:inline-block; min-width:12px; padding:0 3px; border-radius:7px; background:${MARKER_COLORS[(marker - 1) % MARKER_COLORS.length]}; color:#111; font-size:10px; font-weight:700; line-height:14px; text-align:center; vertical-align:middle;">${marker}</span>`
        : '';
    if (!icon && !badge) return '';
    return `<span data-talisman-badge style="display:inline-flex; align-items:center; gap:2px; vertical-align:middle; white-space:nowrap;">${icon}${badge}</span> `;
}
