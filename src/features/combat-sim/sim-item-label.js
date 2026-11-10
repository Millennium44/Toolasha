/** Item and upgrade labels shared by the Lab and Combat simulators. Rendering only: stored names stay plain text. */
import dataManager from '../../core/data-manager.js';
import { simEntityIconHtml, simSkillHrid, simScrollItemHrid } from './sim-entity-label.js';

const ITEM_HRID = /^\/items\/[a-zA-Z0-9_]+$/;
const ABILITY_HRID = /^\/abilities\/[a-zA-Z0-9_]+$/;
const ROOM_HRID = /^\/house_rooms\/[a-zA-Z0-9_]+$/;

function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
}

/**
 * Decorative game artwork beside a label, or nothing for an empty/non-item slot.
 * The existing overlay helper supplies a spacer until the game's sprite sheet is available.
 * @param {string|null} hrid - Item identity, never a display-name lookup
 * @returns {string} HTML
 */
export function simItemIconHtml(hrid) {
    return ITEM_HRID.test(hrid || '') ? simEntityIconHtml(hrid) : '';
}

/**
 * An item name with its icon. Escapes labels, including fallback names from imported builds.
 * @param {string|null} hrid - Item identity
 * @param {string} name - Plain text; quantities and enhancement levels may be included
 * @returns {string} HTML
 */
export function simItemLabelHtml(hrid, name) {
    return simItemIconHtml(hrid) + escapeText(name);
}

/**
 * Add icons to the named pieces in an upgrade without changing its wording, levels or scope.
 * Only explicit candidate identities are considered. The arrow separates the given-up
 * and added pieces, so identically named items on opposite sides still get the right artwork.
 * @param {Object|null} candidate - Upgrade candidate with a plain-text description
 * @param {Object} [itemDetailMap] - Item definitions; defaults to the current game data
 * @returns {string} HTML
 */
export function simCandidateLabelHtml(candidate, itemDetailMap) {
    const description = String(candidate?.description || '');
    if (candidate?.type === 'combat_level') {
        return simEntityIconHtml(simSkillHrid(candidate.skillKey)) + escapeText(description);
    }
    if (candidate?.type === 'scroll') {
        return simEntityIconHtml(simScrollItemHrid(candidate.buffTypeHrid)) + escapeText(description);
    }
    if (candidate?.type === 'house' && candidate.roomHrid) {
        return simEntityIconHtml(candidate.roomHrid) + escapeText(description);
    }
    if (candidate?.type === 'guild_shrine') {
        return simEntityIconHtml(candidate.shrineHrid) + escapeText(description);
    }
    const rooms = candidate?.type === 'house' && Array.isArray(candidate.rooms) ? candidate.rooms : [];
    const from = [
        candidate?.currentHrid,
        ...rooms.map((room) => room.roomHrid),
        ...(candidate?.removedItems || []).map((item) => item.hrid),
        ...(candidate?.keptItems || []).map((item) => item.hrid),
    ];
    const to = [candidate?.upgradeHrid, ...Object.values(candidate?.addedSlots || {}).map((item) => item?.hrid)];
    const decorate = (text, ids) => {
        const byName = new Map();
        for (const hrid of new Set(
            ids.filter((id) => ITEM_HRID.test(id || '') || ABILITY_HRID.test(id || '') || ROOM_HRID.test(id || ''))
        )) {
            const name = ROOM_HRID.test(hrid)
                ? rooms.find((room) => room.roomHrid === hrid)?.roomName || hrid.split('/').pop()
                : ABILITY_HRID.test(hrid)
                  ? dataManager.getInitClientData?.()?.abilityDetailMap?.[hrid]?.name || hrid.split('/').pop()
                  : itemDetailMap?.[hrid]?.name || dataManager.getItemDetails?.(hrid)?.name || hrid.split('/').pop();
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push(hrid);
        }
        // Longest first prevents an unstarred name from stealing the prefix of its starred upgrade.
        const names = [...byName.keys()].sort((a, b) => b.length - a.length);
        let html = '';
        let plain = '';
        for (let index = 0; index < text.length;) {
            const name = names.find(
                (name) =>
                    text.startsWith(name, index) &&
                    !/[\p{L}\p{N}_]/u.test(text[index - 1] || '') &&
                    !/[\p{L}\p{N}_]/u.test(text[index + name.length] || '')
            );
            if (!name) {
                plain += text[index++];
                continue;
            }
            html += escapeText(plain) + byName.get(name).map(simEntityIconHtml).join('') + escapeText(name);
            plain = '';
            index += name.length;
        }
        return html + escapeText(plain);
    };
    // An order is a list of abilities, not a give-up/add split at its first arrow.
    if (candidate?.abilityOrder) return decorate(description, candidate.order || []);
    const arrow = description.indexOf('→');
    if (arrow < 0) return decorate(description, [...from, ...to]);
    return decorate(description.slice(0, arrow), from) + '→' + decorate(description.slice(arrow + 1), to);
}
