/** Item labels shared by the Lab and Combat simulators. Rendering only: stored names stay plain text. */
import dataManager from '../../core/data-manager.js';
import { itemIcon } from '../../utils/overlay-format.js';

const ITEM_HRID = /^\/items\/[a-zA-Z0-9_]+$/;

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
    if (!ITEM_HRID.test(hrid || '') || typeof document === 'undefined') return '';
    const icon = itemIcon(hrid, 18);
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('data-sim-item-icon', hrid);
    Object.assign(icon.style, { verticalAlign: 'middle', marginRight: '4px', height: '18px' });
    return icon.outerHTML;
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
 * Only the candidate's explicit item identities are considered. The arrow separates the given-up
 * and added pieces, so identically named items on opposite sides still get the right artwork.
 * @param {Object|null} candidate - Upgrade candidate with a plain-text description
 * @param {Object} [itemDetailMap] - Item definitions; defaults to the current game data
 * @returns {string} HTML
 */
export function simCandidateLabelHtml(candidate, itemDetailMap) {
    const description = String(candidate?.description || '');
    const from = [
        candidate?.currentHrid,
        ...(candidate?.removedItems || []).map((item) => item.hrid),
        ...(candidate?.keptItems || []).map((item) => item.hrid),
    ];
    const to = [candidate?.upgradeHrid, ...Object.values(candidate?.addedSlots || {}).map((item) => item?.hrid)];
    const decorate = (text, ids) => {
        const byName = new Map();
        for (const hrid of new Set(ids.filter((id) => ITEM_HRID.test(id || '')))) {
            const name =
                itemDetailMap?.[hrid]?.name || dataManager.getItemDetails?.(hrid)?.name || hrid.split('/').pop();
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
            html += escapeText(plain) + byName.get(name).map(simItemIconHtml).join('') + escapeText(name);
            plain = '';
            index += name.length;
        }
        return html + escapeText(plain);
    };
    const arrow = description.indexOf('→');
    if (arrow < 0) return decorate(description, [...from, ...to]);
    return decorate(description.slice(0, arrow), from) + '→' + decorate(description.slice(arrow + 1), to);
}
