/**
 * Untradable cape valuation (refined and enhanced)
 *
 * A cape has no market price, so what one is worth is what it cost to make: the base cape (the
 * `untradableCapeBaseValue` setting, via the shared enhancement input rule), the refinement
 * materials of a refined one, and the expected cost of enhancing it. Everything here goes through
 * the fork's existing enhancement path rather than a second calculation, evaluated on the
 * character's OWN bench (the `valuation` surface): nobody could sell the piece finished, so the
 * bench the player actually has is the only honest one.
 *
 * Callers consult the market first and come here only when it has nothing. The result says
 * whether the figure is a floor (`partial`), so a surface that can flag that does.
 */

import { isUntradableCape } from '../../utils/untradable-cape.js';
import { getUntradableCapeBaseCost } from '../../utils/untradable-cape-cost.js';
import { calculateEnhancementPath } from './tooltip-enhancement.js';
import { enhancementParamsFor } from './enhancement-params-source.js';

/**
 * Value of an untradable cape at an enhancement level.
 *
 * @param {string} itemHrid - Cape item HRID (base or refined)
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @param {Object} [options] - Pricing options
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side for the +0 figure
 * @returns {{value: number|null, partial: boolean}|null} null when the item is not an untradable
 *   cape. `value` is null when nothing could be priced (never 0 standing in for a value);
 *   `partial` is true when the figure is a floor: an input nothing prices, or a base cape the
 *   setting values at nothing.
 */
export function getUntradableCapeValue(itemHrid, enhancementLevel = 0, { context = 'profit', mode } = {}) {
    if (!isUntradableCape(itemHrid)) return null;

    if (!(enhancementLevel > 0)) return getUntradableCapeBaseCost(itemHrid, { context, mode });

    try {
        const path = calculateEnhancementPath(itemHrid, enhancementLevel, enhancementParamsFor('valuation', itemHrid), {
            priceContext: mode === 'ask' ? 'ask' : context,
        });
        const usable = Boolean(path?.optimalStrategy) && (!path.pricesPartial || path.pricesPartialOnlyByAssumedBase);
        const totalCost = path?.optimalStrategy?.totalCost;
        if (usable && totalCost > 0) {
            return {
                value: totalCost,
                partial: path.inputsPartial === true || path.pricesPartialOnlyByAssumedBase === true,
            };
        }
    } catch (error) {
        console.error('[UntradableCapeValue] Enhancement path failed for', itemHrid, enhancementLevel, error);
    }
    return { value: null, partial: true };
}
