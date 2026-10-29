/**
 * Untradable capes: what is one worth when nothing prices it?
 *
 * Skilling capes, the Chimerical Quiver, the Enchanted Cloak and the Sinister Cape (and their
 * refined versions) are never listed on the market, so no price lookup answers for them.
 * Where the fork already has a figure (the refinement bill of a refined cape, the enhancement
 * path of an enhanced one) that figure stands. This module owns only the one thing nothing else
 * can supply: what the unrefined +0 cape itself is assumed to be worth, from the
 * `untradableCapeBaseValue` setting — nothing, or the price of a Mirror of Protection, which
 * functions as a copy of any equipment.
 *
 * Deliberately import-light (config, data-manager, market-data) so the pricing rules can use it
 * without creating a cycle. The enhanced-cape valuation that needs the enhancement path lives in
 * features/enhancement/untradable-cape-value.js.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { getItemPrice } from './market-data.js';

export const CAPE_BASE_VALUE_SETTING = 'untradableCapeBaseValue';
export const CAPE_BASE_VALUE_ZERO = 'zero';
export const CAPE_BASE_VALUE_MIRROR = 'mirror';

const MIRROR_OF_PROTECTION_HRID = '/items/mirror_of_protection';
const BACK_SLOT = '/equipment_types/back';
const REFINED_SUFFIX = '_refined';

/**
 * Whether an item is a cape-like back piece that nobody can sell.
 *
 * Read from item data, not the name: an equipment piece in the back slot whose `isTradable`
 * is not `true` (the game leaves the field off untradable gear, as `isSelfEnhancedItem` already
 * relies on). This covers the skilling capes, the Chimerical Quiver and the Enchanted Cloak
 * without listing them. An item the data does not know is not a cape.
 *
 * @param {string} itemHrid - Item HRID
 * @returns {boolean} True for an untradable back piece
 */
export function isUntradableCape(itemHrid) {
    if (typeof itemHrid !== 'string' || !itemHrid) return false;
    const details =
        dataManager.getItemDetails?.(itemHrid) ?? dataManager.getInitClientData?.()?.itemDetailMap?.[itemHrid];
    if (!details || details.equipmentDetail?.type !== BACK_SLOT) return false;
    return details.isTradable !== true;
}

/**
 * @param {string} itemHrid - Item HRID
 * @returns {boolean} True for the refined (★) version of an item
 */
export function isRefinedCape(itemHrid) {
    return typeof itemHrid === 'string' && itemHrid.endsWith(REFINED_SUFFIX);
}

/**
 * The unrefined cape behind a refined one.
 * @param {string} itemHrid - Item HRID
 * @returns {string} The hrid without its refined suffix (unchanged when not refined)
 */
export function unrefinedCapeOf(itemHrid) {
    return isRefinedCape(itemHrid) ? itemHrid.slice(0, -REFINED_SUFFIX.length) : itemHrid;
}

/**
 * The setting as one of its two values, for cache keys and branching.
 * @returns {'zero'|'mirror'}
 */
export function getCapeBaseValueMode() {
    return config.getSettingValue(CAPE_BASE_VALUE_SETTING, CAPE_BASE_VALUE_ZERO) === CAPE_BASE_VALUE_MIRROR
        ? CAPE_BASE_VALUE_MIRROR
        : CAPE_BASE_VALUE_ZERO;
}

/**
 * Value assumed for one unrefined, unenhanced cape.
 *
 * @param {Object} [options] - Pricing options for the Mirror of Protection stand-in
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @returns {number} 0 on the "nothing" setting (or when the mirror is itself unpriced), else the
 *   Mirror of Protection's buy price. The caller decides what a 0 means; it is never a quote.
 */
export function getCapeBaseValue({ context = 'profit', mode } = {}) {
    if (getCapeBaseValueMode() !== CAPE_BASE_VALUE_MIRROR) return 0;
    const price = getItemPrice(MIRROR_OF_PROTECTION_HRID, { context, side: 'buy', ...(mode ? { mode } : {}) });
    return price > 0 ? price : 0;
}

/**
 * One line saying where an untradable cape's figure came from, for a surface that shows it.
 * @param {{enhancementLevel?: number, value: number, partial?: boolean}} entry - An assumed cape
 * @param {string} name - Display name
 * @param {function(number): string} formatValue - Number formatter
 * @returns {string}
 */
export function describeAssumedCape(entry, name, formatValue) {
    const level = entry.enhancementLevel > 0 ? ` +${entry.enhancementLevel}` : '';
    const floor = entry.partial ? ' The base cape counts as nothing, so this is a floor.' : '';
    return `${name}${level}: not on the market; valued at ${formatValue(entry.value)} from the untradable-cape setting (plus refinement and your own enhancing cost where it has them), never taxed.${floor}`;
}
