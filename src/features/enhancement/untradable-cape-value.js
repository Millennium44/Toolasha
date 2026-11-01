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

import marketAPI from '../../api/marketplace.js';
import dataManager from '../../core/data-manager.js';
import { pricingStamp } from '../../utils/enhancement-input-pricing.js';
import { isUntradableCape } from '../../utils/untradable-cape.js';
import { getUntradableCapeBaseCost } from '../../utils/untradable-cape-cost.js';
import { calculateEnhancementPath } from './tooltip-enhancement.js';
import { enhancementParamsFor } from './enhancement-params-source.js';

// The enhancement path is a full strategy sweep and its callers ask for it on every recalculation, so the
// answer is kept. What the answer reads besides the item, level and params (which are in the entry key) is
// the `epoch`: the order book (priceVersion), the pricing modes, cape setting, custom prices and the game's
// value map (pricingStamp) and the character. When any of them moves the whole table is dropped rather than
// left to grow a generation per price tick. (No Task Crystal token value is in this: no enhancement input is
// priced from a token.)
const _pathCache = new Map();
let _epoch = null;

/**
 * Drop every remembered cape value.
 */
export function clearUntradableCapeValueCache() {
    _pathCache.clear();
    _epoch = null;
}

/**
 * Everything outside the entry key that a cached path result depends on.
 * @returns {string}
 */
function currentEpoch() {
    return [
        marketAPI.priceVersion,
        marketAPI.liveSourced === true,
        pricingStamp(),
        dataManager.getCurrentCharacterId?.() ?? '',
    ].join('|');
}

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
        const params = enhancementParamsFor('valuation', itemHrid);
        const priceContext = mode === 'ask' ? 'ask' : context;
        const epoch = currentEpoch();
        if (epoch !== _epoch) {
            _pathCache.clear();
            _epoch = epoch;
        }
        const key = `${itemHrid}|${enhancementLevel}|${priceContext}|${JSON.stringify(params)}`;
        const held = _pathCache.get(key);
        if (held) return { ...held };

        const result = pathValue(calculateEnhancementPath(itemHrid, enhancementLevel, params, { priceContext }));
        _pathCache.set(key, result);
        return { ...result };
    } catch (error) {
        console.error('[UntradableCapeValue] Enhancement path failed for', itemHrid, enhancementLevel, error);
    }
    return { value: null, partial: true };
}

/**
 * The value a computed enhancement path stands for.
 * @param {Object|null} path - calculateEnhancementPath result
 * @returns {{value: number|null, partial: boolean}}
 */
function pathValue(path) {
    const usable = Boolean(path?.optimalStrategy) && (!path.pricesPartial || path.pricesPartialOnlyByAssumedBase);
    const totalCost = path?.optimalStrategy?.totalCost;
    if (usable && totalCost > 0) {
        return {
            value: totalCost,
            partial: path.inputsPartial === true || path.pricesPartialOnlyByAssumedBase === true,
        };
    }
    return { value: null, partial: true };
}
