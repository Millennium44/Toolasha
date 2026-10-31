/**
 * Enhancement-cost rules shared by net worth and the inventory badges.
 *
 * Both read and write the same networth-cache entries under the same keys, so both must decide the
 * bench, whether a path is usable, whether its figure is a floor and whether it may be cached the
 * same way; otherwise one surface can read a figure the other computed under different rules.
 */

import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { enhancementParamsFor } from '../enhancement/enhancement-params-source.js';
import { isUntradableCape } from '../../utils/untradable-cape.js';

/**
 * The enhancing bench an item's enhancement cost is computed on. An untradable cape is valued on the
 * character's own bench (the same 'valuation' bench alchemy uses), since nobody could enhance one for
 * the player; everything else takes the simulator's params, as before.
 * @param {string} itemHrid - Item HRID
 * @returns {Object} Enhancement parameters
 */
export function benchParamsFor(itemHrid) {
    return isUntradableCape(itemHrid) ? enhancementParamsFor('valuation', itemHrid) : getEnhancingParams();
}

/**
 * Whether an enhancement path can stand as an item's value. An unpriced input makes it a partial
 * bill rather than a price; the one exception is an untradable cape whose base is the cape
 * setting's assumed value, where the path is the cost of the run and says so through its flag.
 * @param {Object|null} path - Result of calculateEnhancementPath
 * @returns {boolean}
 */
export function usablePath(path) {
    return Boolean(path?.optimalStrategy) && (!path.pricesPartial || path.pricesPartialOnlyByAssumedBase === true);
}

/**
 * Whether a usable path's figure is a floor: a selected input is a partial bill, or the base was an
 * assumed value of nothing.
 * @param {Object} path - A path accepted by {@link usablePath}
 * @returns {boolean}
 */
export function pathPartial(path) {
    return path.inputsPartial === true || path.pricesPartialOnlyByAssumedBase === true;
}

/**
 * Whether an item's enhancement cost may be stored in the shared cache. The cache key sees the
 * simulator bench only; an untradable cape is costed on the character's own bench, so it never is.
 * @param {string} itemHrid - Item HRID
 * @returns {boolean}
 */
export function isCacheableEnhancementCost(itemHrid) {
    return !isUntradableCape(itemHrid);
}
