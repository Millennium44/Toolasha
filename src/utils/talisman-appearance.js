/**
 * A talisman's game-side appearance: the icon and the 0-9 marker a player sets in the game's organizing UI, so two
 * talismans of one type can be told apart. Toolasha only reads them, never sets a marker.
 *
 * Mirrors the game's own rules (read from its client, 2026-11-20):
 * - icon: the record's `iconHrid` when `talismanIconDetailMap` has it and it belongs to the record's type, else the
 *   type's `defaultIconHrid` (so "" , never chosen, still has an icon). An icon with a `skillHrid` is that skill's
 *   sprite on the skills sheet; the combat icon is `#combat` and every other one `#skills`, both on the misc sheet.
 * - marker: an integer from 1 to `talismanInfo.maxMarker`, else none.
 *
 * A record with no `talismanTypeHrid` (another party member's, a sim player's stripped copy) draws nothing, so one
 * player's marker is never shown on another player's talisman. A record with a type but no fields draws the type's
 * default icon, which reveals nothing about the local player.
 */

import dataManager from '../core/data-manager.js';
import { spriteUrl } from './overlay-format.js';
import { escapeHtml } from './html-escape.js';

const COMBAT_TYPE = '/talisman_types/combat';
const COMBAT_ICON = '/talisman_icons/combat';
const SKILLING_ICON = '/talisman_icons/skilling';
const DEFAULT_MAX_MARKER = 9;

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
 * @param {Object} [gameData] - init client data; read from the data manager by default
 * @returns {Object}
 */
function gameDataOf(gameData) {
    return gameData ?? dataManager.getInitClientData?.() ?? {};
}

/**
 * The marker a record shows, by the game's rule.
 * @param {Object|null|undefined} talisman
 * @param {Object} [gameData]
 * @returns {number} 0 when there is none
 */
function markerOf(talisman, gameData) {
    // A record that names no type is not a full game record (a party member's or sim copy): show nothing of it
    if (typeof talisman?.talismanTypeHrid !== 'string' || !talisman.talismanTypeHrid) return 0;
    const max = Number(gameDataOf(gameData).talismanInfo?.maxMarker) || DEFAULT_MAX_MARKER;
    const marker = talisman?.marker;
    return Number.isInteger(marker) && marker > 0 && marker <= max ? marker : 0;
}

/**
 * The icon hrid the game draws for a record: its own pick when valid for its type, else the type's default.
 * @param {Object|null|undefined} talisman
 * @param {Object} [gameData]
 * @returns {string|null} null when the record names no type
 */
export function talismanIconHrid(talisman, gameData) {
    const type = talisman?.talismanTypeHrid;
    if (typeof type !== 'string' || !type) return null;
    const data = gameDataOf(gameData);
    const chosen = talisman.iconHrid;
    const detail = typeof chosen === 'string' && chosen ? data.talismanIconDetailMap?.[chosen] : null;
    if (detail && detail.talismanTypeHrid === type) return chosen;
    return data.talismanTypeDetailMap?.[type]?.defaultIconHrid || (type === COMBAT_TYPE ? COMBAT_ICON : SKILLING_ICON);
}

/**
 * The sprite an icon hrid is drawn from.
 * @param {string} iconHrid
 * @param {Object} [gameData]
 * @returns {{sheet: string, id: string}} Sheet name and sprite id
 */
function spriteOf(iconHrid, gameData) {
    const skillHrid = gameDataOf(gameData).talismanIconDetailMap?.[iconHrid]?.skillHrid;
    if (skillHrid) return { sheet: 'skills', id: String(skillHrid).split('/').pop() };
    return { sheet: 'misc', id: iconHrid === COMBAT_ICON ? 'combat' : 'skills' };
}

/**
 * The appearance a record carries.
 * @param {Object|null|undefined} talisman - A talisman record
 * @param {Object} [gameData]
 * @returns {{iconHrid: string|null, marker: number}} marker is 0 when there is none
 */
export function talismanAppearance(talisman, gameData) {
    return { iconHrid: talismanIconHrid(talisman, gameData), marker: markerOf(talisman, gameData) };
}

/**
 * A short plain-text note for a record's marker, for tooltips that cannot hold markup.
 * @param {Object|null|undefined} talisman
 * @returns {string} e.g. "marker 3", or '' when it has none
 */
export function talismanMarkerNote(talisman) {
    const marker = markerOf(talisman);
    return marker ? `marker ${marker}` : '';
}

/**
 * The icon and marker as inline markup, for the panels that build their rows as strings.
 * @param {Object|null|undefined} talisman - A talisman record
 * @param {Object} [options]
 * @param {number} [options.size] - Icon pixels
 * @param {Object} [options.gameData] - init client data; read from the data manager by default
 * @returns {string} '' when there is nothing to draw (so a row never gains an empty gap)
 */
export function talismanBadgeHTML(talisman, { size = 16, gameData } = {}) {
    const data = gameDataOf(gameData);
    const iconHrid = talismanIconHrid(talisman, data);
    const marker = markerOf(talisman, data);
    let icon = '';
    if (iconHrid) {
        const { sheet, id } = spriteOf(iconHrid, data);
        let url = '';
        try {
            url = spriteUrl(sheet);
        } catch {
            url = '';
        }
        if (url) {
            icon = `<svg width="${size}" height="${size}" style="flex:0 0 auto; vertical-align:middle;" data-talisman-icon="${escapeHtml(iconHrid)}"><use href="${escapeHtml(`${url}#${id}`)}"></use></svg>`;
        }
    }
    const badge = marker
        ? `<span data-talisman-marker="${marker}" title="Marker ${marker}" style="display:inline-block; min-width:12px; padding:0 3px; border-radius:7px; background:${MARKER_COLORS[(marker - 1) % MARKER_COLORS.length]}; color:#111; font-size:10px; font-weight:700; line-height:14px; text-align:center; vertical-align:middle;">${marker}</span>`
        : '';
    if (!icon && !badge) return '';
    return `<span data-talisman-badge style="display:inline-flex; align-items:center; gap:2px; vertical-align:middle; white-space:nowrap;">${icon}${badge}</span> `;
}
