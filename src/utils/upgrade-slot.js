/**
 * The upgrade slot of an action panel.
 *
 * A production recipe with an upgrade slot (a staff, a charm) draws its upgrade item from the
 * stack the slot currently shows: one item at one enhancement level. The slot's icon carries the
 * item in its sprite id, and the enhancement badge is present only on an enhanced copy ("+7"),
 * absent on +0. An empty slot shows a warning instead of an item. None of this depends on the
 * game language.
 */

import { getIconHref } from './game-lookups.js';

const SLOT_SELECTOR = '[class*="SkillActionDetail_upgradeItemSelectorInput"]';

/**
 * @param {Element|null|undefined} panel - An action panel
 * @returns {{present: boolean, itemHrid: string|null, level: number}} `present` is whether the
 *   panel has an upgrade slot at all; `itemHrid` is null when the slot is empty (or unreadable);
 *   `level` is the selected stack's enhancement level (0 when unenhanced)
 */
export function readUpgradeSlot(panel) {
    const slot = panel?.querySelector?.(SLOT_SELECTOR);
    if (!slot) return { present: false, itemHrid: null, level: 0 };

    // No icon at all is an empty slot; an icon this cannot read is an unreadable one, which
    // callers treat as no slot rather than as an empty one
    if (!slot.querySelector('svg use')) return { present: true, itemHrid: null, level: 0 };
    const href = getIconHref(slot, 'items_sprite');
    const tail = href?.split('#')[1];
    if (!tail) return { present: false, itemHrid: null, level: 0 };

    const badge = slot.querySelector('[class*="Item_enhancementLevel"]')?.textContent ?? '';
    const level = Number(/\+\s*(\d+)/.exec(badge)?.[1]) || 0;
    return { present: true, itemHrid: `/items/${tail}`, level };
}

/**
 * The enhancement level a panel's upgrade slot draws from, for stock counts.
 *
 * @param {Element|null|undefined} panel - An action panel
 * @param {string|undefined} upgradeItemHrid - The action's upgrade item
 * @returns {number|null} The selected stack's level; 0 when the action has no upgrade slot, the
 *   panel does not show one, or it names some other item (an unread slot leaves the +0 stack);
 *   `null` when the slot is empty and affords nothing
 */
export function upgradeLevelForPanel(panel, upgradeItemHrid) {
    if (!upgradeItemHrid) return 0;
    const slot = readUpgradeSlot(panel);
    if (slot.present && slot.itemHrid === null) return null;
    if (slot.present && slot.itemHrid === upgradeItemHrid) return slot.level;
    return 0;
}

export default { readUpgradeSlot, upgradeLevelForPanel };
