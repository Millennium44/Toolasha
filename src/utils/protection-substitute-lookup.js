/**
 * Protection Substitute Lookup
 * Detects items that are real, data-backed substitutes for enhancement-protection consumables
 * (e.g. a dungeon-chest drop that can be sacrificed as protection instead of buying a Mirror of
 * Protection), and suggests a proxy sell price for them when they have no direct market price.
 */

import dataManager from '../core/data-manager.js';
import expectedValueCalculator from '../features/market/expected-value-calculator.js';

/**
 * Always a valid protection sacrifice for ANY equipment, per its own item description
 * ("functions as a copy of any equipment for enhancing protection"). It never appears in any
 * item's own protectionItemHrids list (that field only enumerates item-specific substitutes), so
 * the reverse lookup below cannot find it and it is special-cased here. Philosopher's Mirror is
 * deliberately excluded: it is a guaranteed-success item worth far more, not a "basic protection"
 * cost baseline.
 */
const UNIVERSAL_PROTECTION_ITEM_HRID = '/items/mirror_of_protection';

/**
 * @returns {Set<string>} Every hrid some item lists in its protectionItemHrids
 */
function getSubstituteHrids() {
    const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
    const hrids = new Set();
    for (const details of Object.values(itemDetailMap)) {
        for (const hrid of details.protectionItemHrids || []) {
            hrids.add(hrid);
        }
    }
    return hrids;
}

/**
 * @param {string} itemHrid
 * @returns {boolean} True if itemHrid appears in some other item's protectionItemHrids list,
 *      i.e. it is a real substitute for that item's enhancement protection.
 */
export function isProtectionSubstitute(itemHrid) {
    return getSubstituteHrids().has(itemHrid);
}

/**
 * Suggest a proxy sell price for an unpriceable item that is a real protection substitute,
 * based on the universal protection item's own current sell price - resolved the same way as
 * every other row in the EV table (pricing mode, custom overrides, Iron Cow valuation).
 * @param {string} itemHrid
 * @returns {{price: number, viaItemHrid: string}|null} null when itemHrid is not a known
 *      protection substitute, or the universal item itself has no price data.
 */
export function suggestProtectionSubstituteProxyPrice(itemHrid) {
    if (!isProtectionSubstitute(itemHrid)) return null;

    const priceInfo = expectedValueCalculator.getDropPriceInfo(UNIVERSAL_PROTECTION_ITEM_HRID);
    if (priceInfo.value === null) return null;

    return { price: priceInfo.value, viaItemHrid: UNIVERSAL_PROTECTION_ITEM_HRID };
}
