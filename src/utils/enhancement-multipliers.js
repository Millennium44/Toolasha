import dataManager from '../core/data-manager.js';
import { ENHANCEMENT_BONUSES } from './enhancement-steps.js';

/**
 * Enhancement Multiplier System
 *
 * Handles enhancement bonus calculations for equipment.
 * Different equipment slots have different multipliers:
 * - Accessories (neck/ring/earring), Back, Trinket, Charm: 5× multiplier
 * - All other slots (weapons, armor, pouch): 1× multiplier
 */

/**
 * Enhancement multiplier by equipment slot type
 */
export const ENHANCEMENT_MULTIPLIERS = {
    '/equipment_types/neck': 5,
    '/equipment_types/ring': 5,
    // The game's equipment type is plural; the singular is kept as an alias so any older
    // caller (or saved loadout) that still says "earring" keeps its 5× multiplier.
    '/equipment_types/earrings': 5,
    '/equipment_types/earring': 5,
    '/equipment_types/back': 5,
    '/equipment_types/trinket': 5,
    '/equipment_types/charm': 5,
    // All other slots: 1× (default)
};

export { ENHANCEMENT_BONUSES };

/**
 * What one whole base stat is in the game's table.
 *
 * `enhancementLevelTotalBonusMultiplierTable` is not a fraction. It counts steps of an item's
 * `noncombatEnhancementBonuses`, and the game adds `base + table[level] * bonus`, where that bonus is 2% of the
 * base times the slot multiplier. So +20 reads 50 and means 100%; +10 reads 14.5 and means 29%.
 */
const GAME_TABLE_STEPS_PER_WHOLE = 50;

/**
 * The total bonus fraction at an enhancement level: the game's own table when it is loaded and has the level,
 * else the table above. A patch that raises the cap or rebalances a level reaches every caller through this.
 * @param {number} enhancementLevel
 * @returns {number} Bonus fraction (0 for level 0 or an unknown level)
 */
export function enhancementBonusAt(enhancementLevel) {
    let fromGame;
    try {
        fromGame = dataManager.getInitClientData?.()?.enhancementLevelTotalBonusMultiplierTable?.[enhancementLevel];
    } catch {
        fromGame = undefined;
    }
    if (typeof fromGame === 'number' && Number.isFinite(fromGame) && fromGame >= 0) {
        return fromGame / GAME_TABLE_STEPS_PER_WHOLE;
    }
    return ENHANCEMENT_BONUSES[enhancementLevel] || 0;
}

/**
 * Get enhancement multiplier for an item
 * @param {Object} itemDetails - Item details from itemDetailMap
 * @param {number} enhancementLevel - Current enhancement level of item
 * @returns {number} Multiplier to apply to bonuses
 */
export function getEnhancementMultiplier(itemDetails, enhancementLevel) {
    if (enhancementLevel === 0) {
        return 1;
    }

    const equipmentType = itemDetails?.equipmentDetail?.type;
    const slotMultiplier = ENHANCEMENT_MULTIPLIERS[equipmentType] || 1;
    const enhancementBonus = enhancementBonusAt(enhancementLevel);

    return 1 + enhancementBonus * slotMultiplier;
}
