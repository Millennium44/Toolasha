/**
 * Value of one unenhanced untradable cape, through the shared enhancement input rule.
 *
 * The light half of the cape valuation (no enhancement path), usable from modules that must not
 * import the tooltip's dependency tree. Enhanced capes are valued by
 * features/enhancement/untradable-cape-value.js. Kept apart from untradable-cape.js because the
 * pricing rules import that file and this one imports the pricing rules.
 */

import { priceBase } from './enhancement-input-pricing.js';
import { isUntradableCape } from './untradable-cape.js';

/**
 * Value of one unenhanced untradable cape: the cape setting for an unrefined one; the refinement
 * bill plus that base for a refined one.
 *
 * @param {string} itemHrid - Cape item HRID (base or refined)
 * @param {Object} [options] - Pricing options
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @returns {{value: number|null, partial: boolean}|null} null when the item is not an untradable
 *   cape. `value` is null when nothing prices it (never 0 standing in for a value); `partial` is
 *   true when the figure is a floor (an input nothing prices, or a base the setting values at nothing)
 */
export function getUntradableCapeBaseCost(itemHrid, { context = 'profit', mode } = {}) {
    if (!isUntradableCape(itemHrid)) return null;
    const base = priceBase(itemHrid, { context, mode });
    return base.price > 0 ? { value: base.price, partial: Boolean(base.partial) } : { value: null, partial: true };
}
