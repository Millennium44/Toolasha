/** Decorative game artwork for simulator labels. Never infer identity from a display name. */
import { spriteIcon } from '../../utils/overlay-format.js';
import dataManager from '../../core/data-manager.js';
import { SCROLL_BUFF_ITEMS } from '../../utils/scroll-buff-values.js';

const ENTITIES = [
    { pattern: /^\/items\/[a-zA-Z0-9_]+$/, sheet: 'items', type: 'item' },
    { pattern: /^\/abilities\/[a-zA-Z0-9_]+$/, sheet: 'abilities', type: 'ability' },
    { pattern: /^\/skills\/[a-zA-Z0-9_]+$/, sheet: 'skills', type: 'skill' },
    { pattern: /^\/monsters\/[a-zA-Z0-9_]+$/, sheet: 'combat_monsters', type: 'monster' },
    // These mappings match the native game's icon helpers; sprite hashes still come only from the DOM.
    {
        pattern: /^\/actions\/combat\/[a-zA-Z0-9_]+$/,
        type: 'zone',
        resolve: (hrid) => {
            const action = dataManager.getInitClientData?.()?.actionDetailMap?.[hrid];
            if (!action) return null;
            // Match the native action tile: single-spawn targets draw their monster, not an
            // actions-sheet fragment guessed from the action's (possibly different) name.
            const spawns = action.combatZoneInfo?.fightInfo?.randomSpawnInfo?.spawns;
            if (spawns?.length === 1) {
                const monsterHrid = spawns[0]?.combatMonsterHrid;
                return /^\/monsters\/[a-zA-Z0-9_]+$/.test(monsterHrid || '')
                    ? { sheet: 'combat_monsters', id: monsterHrid }
                    : null;
            }
            return { sheet: 'actions', id: hrid };
        },
    },
    {
        pattern: /^\/house_rooms\/[a-zA-Z0-9_]+$/,
        sheet: 'misc',
        type: 'house',
        spriteId: (hrid) => `house_${hrid.split('/').pop()}`,
    },
    {
        pattern: /^\/guild_shrines\/[a-zA-Z0-9_]+$/,
        sheet: 'misc',
        type: 'shrine',
        spriteId: (hrid) => `guild_shrine_${hrid.split('/').pop()}`,
    },
];

function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
}

/**
 * Draw only supported game identities using the sheet already discovered in the page.
 * Missing sheets reserve the same space. Open simulator panels hydrate these spacers when the game draws the sheet.
 * @param {string|null} hrid - Explicit game identity
 * @returns {string} Decorative SVG/spacer HTML, or an empty string for unsupported identities
 */
export function simEntityIconHtml(hrid) {
    // The native abilityIconMap has no Promote entry; its helper returns no icon.
    // Keep this monster-only ability readable instead of inventing a blank SVG fragment.
    if (hrid === '/abilities/promote') return '';
    const entity = ENTITIES.find(({ pattern }) => pattern.test(hrid || ''));
    if (!entity || typeof document === 'undefined') return '';
    const asset = entity.resolve
        ? entity.resolve(hrid)
        : { sheet: entity.sheet, id: entity.spriteId ? entity.spriteId(hrid) : hrid };
    if (!asset?.id) return '';
    const icon = spriteIcon(asset.id, 18, asset.sheet);
    if (icon.tagName.toLowerCase() === 'span') icon.setAttribute('data-sim-icon-pending', asset.sheet);
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    if (entity.type === 'item') icon.setAttribute('data-sim-item-icon', hrid);
    else {
        icon.setAttribute('data-sim-entity-icon', hrid);
        icon.setAttribute('data-sim-entity-type', entity.type);
    }
    Object.assign(icon.style, { verticalAlign: 'middle', marginRight: '4px', height: '18px' });
    return icon.outerHTML;
}

/**
 * Keep the supplied plain-text name, including translations, tiers and levels, next to the artwork.
 * @param {string|null} hrid - Explicit game identity
 * @param {string} name - Plain text
 * @returns {string} Escaped display-only HTML
 */
export function simEntityLabelHtml(hrid, name) {
    return simEntityIconHtml(hrid) + escapeText(name);
}

/**
 * Translate an editor's known level field to its game skill identity, never a display-name guess.
 * @param {string} key - DTO level field
 * @returns {string|null} Skill HRID
 */
export function simSkillHrid(key) {
    const match =
        /^(stamina|intelligence|attack|melee|defense|ranged|magic|woodcutting|foraging|milking|cooking|brewing|cheesesmithing|crafting|tailoring|alchemy|enhancing)Level$/.exec(
            key || ''
        );
    return match ? `/skills/${match[1]}` : null;
}

const SCROLL_ITEMS = {
    ...SCROLL_BUFF_ITEMS,
    '/buff_types/damage': 'seal_of_damage',
    '/buff_types/attack_speed': 'seal_of_attack_speed',
    '/buff_types/cast_speed': 'seal_of_cast_speed',
    '/buff_types/critical_rate': 'seal_of_critical_rate',
    '/buff_types/combat_drop_quantity': 'seal_of_combat_drop',
};

/**
 * Scrolls kept their seal item IDs when their displayed names changed to Scroll.
 * @param {string} buffTypeHrid - Scroll buff type
 * @returns {string|null} Actual scroll item, or null when unknown
 */
export function simScrollItemHrid(buffTypeHrid) {
    const item = Object.hasOwn(SCROLL_ITEMS, buffTypeHrid || '') ? SCROLL_ITEMS[buffTypeHrid] : null;
    return item ? `/items/${item}` : null;
}
