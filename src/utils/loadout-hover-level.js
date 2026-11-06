/**
 * The enhancement level of an equipment slot the pointer is over in the game's Loadouts panel.
 *
 * With a loadout's "Use highest enhancement level" option on, the game's item tooltip for a slot
 * names the item without a "+N" even though its Market Price line is the enhanced one, so the
 * name alone reads as +0. The panel already knows which loadout it shows and which item sits in
 * the slot, so the level is resolved the way every other loadout-aware feature resolves it
 * (`resolveEnhancementLevel`: the stored level when the loadout is pinned to exact levels,
 * otherwise the best copy owned).
 *
 * Returns null whenever any link in the chain is missing — the caller then keeps what the name says.
 */

import dataManager from '../core/data-manager.js';
import { parseWearable, highestOwnedEnhancements, resolveEnhancementLevel } from './loadout-equipment.js';

const SELECTED_LOADOUT_SELECTOR = '[class*="LoadoutsPanel_selectedLoadout"]';
const EQUIPMENT_SELECTOR = '[class*="LoadoutsPanel_equipment"]';
const METADATA_SELECTOR = '[class*="LoadoutsPanel_metadata"]';

/**
 * The item sprite hrid inside an element, read from `href` or `xlink:href`.
 * @param {Element} el
 * @returns {string|null}
 */
function spriteHrid(el) {
    for (const use of el.querySelectorAll('use')) {
        const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (!ref.includes('items_sprite')) continue;
        const fragment = ref.split('#')[1];
        if (fragment) return `/items/${fragment}`;
    }
    return null;
}

/**
 * The loadout name the panel shows: the first text after the icon in the metadata row.
 * @param {Element} selectedLoadout
 * @returns {string|null}
 */
function selectedLoadoutName(selectedLoadout) {
    const metadata = selectedLoadout.querySelector(METADATA_SELECTOR);
    if (!metadata) return null;
    let seenSvg = false;
    for (const child of metadata.childNodes) {
        if (child.nodeType === 1 && child.tagName.toLowerCase() === 'svg') {
            seenSvg = true;
        } else if (seenSvg && child.nodeType === 3) {
            const text = child.textContent.trim();
            if (text) return text;
        }
    }
    return null;
}

/**
 * Which item sits under the pointer in the selected loadout's equipment block.
 * @param {Element|null} target - The element the pointer last entered
 * @returns {{hrid: string, selectedLoadout: Element}|null}
 */
function hoveredSlot(target) {
    if (!target?.isConnected || typeof target.closest !== 'function') return null;
    const equipment = target.closest(EQUIPMENT_SELECTOR);
    if (!equipment) return null;
    const selectedLoadout = equipment.closest(SELECTED_LOADOUT_SELECTOR);
    if (!selectedLoadout) return null;
    // Walk up from the target to the first ancestor (inside the equipment block) that carries a sprite
    let el = target;
    while (el && el !== equipment) {
        const hrid = spriteHrid(el);
        if (hrid) return { hrid, selectedLoadout };
        el = el.parentElement;
    }
    return null;
}

/**
 * Resolve the level of the loadout slot under the pointer.
 *
 * Loadouts are told apart by the name the panel shows, and names are not unique, so every loadout
 * of that name that wears the item is consulted and the level is only returned when they all agree
 * (a slot cannot be told apart from its namesake's otherwise). The same goes for one item worn in
 * more than one slot of a loadout.
 *
 * @param {Element|null} hoverTarget - The element the pointer last entered
 * @param {string|null} tooltipHrid - The item the tooltip names, when it carries one
 * @returns {number|null} The resolved level, or null when it cannot be told
 */
export function resolveHoveredLoadoutLevel(hoverTarget, tooltipHrid) {
    const slot = hoveredSlot(hoverTarget);
    if (!slot) return null;
    // A tooltip for another item than the one under the pointer is a stale hover
    if (tooltipHrid && tooltipHrid !== slot.hrid) return null;

    const name = selectedLoadoutName(slot.selectedLoadout);
    if (!name) return null;
    const loadoutMap = dataManager.characterData?.characterLoadoutMap;
    if (!loadoutMap || typeof loadoutMap !== 'object') return null;

    const owned = highestOwnedEnhancements();
    const levels = new Set();
    for (const loadout of Object.values(loadoutMap)) {
        if (!loadout || loadout.name !== name) continue;
        for (const [locationHrid, hash] of Object.entries(loadout.wearableMap || {})) {
            const parsed = parseWearable(locationHrid, hash);
            if (!parsed || parsed.itemHrid !== slot.hrid) continue;
            levels.add(resolveEnhancementLevel(loadout, parsed, owned));
        }
    }
    return levels.size === 1 ? [...levels][0] : null;
}
