/**
 * Freeze a run's price quotes before its first simulation finishes.
 *
 * `calculateSimRevenue` fills its price cache lazily, as each result is valued, so an item first seen in a
 * candidate (an added coffee, a drop the baseline never rolled) was priced when that sim finished, after any
 * market refresh in a minutes-long run, and the move read as that candidate's effect. The upgrade advisor seeds
 * its cache up front (`seedSimPriceCache`); Verify, the trigger search and the Party search share this helper to
 * do the same for the caches they build.
 */

import { seedSimPriceCache } from './combat-sim-adapter.js';

/**
 * The food and drink hrids a list of player DTOs carries.
 * @param {Array<Object>} playerDTOs - Players in the sim
 * @returns {string[]} Consumable hrids (duplicates kept out)
 */
export function consumableHridsOf(playerDTOs) {
    const hrids = new Set();
    for (const dto of playerDTOs || []) {
        for (const item of [...(dto?.food || []), ...(dto?.drinks || [])]) {
            if (item?.hrid) hrids.add(item.hrid);
        }
    }
    return [...hrids];
}

/**
 * Fill a run's price cache now with every price the run can read.
 * @param {Map} priceCache - The run's cache (`calculateSimRevenue`'s `priceCache`)
 * @param {Object} gameData - Game data payload
 * @param {Object} options
 * @param {string} options.zoneHrid - Combat zone the run fights in
 * @param {Array<Object>} [options.playerDTOs] - Players in the sim: their food and drinks are priced
 * @param {Iterable<string>} [options.extraHrids] - Consumables a candidate adds to a player
 * @param {Object<string, number|null>} [options.saleTaxRates] - hrid → sale tax (see `triggerSaleTaxRates`); each
 *   distinct rate gets its own drop prices. Without it, the live character's tax is used
 * @returns {Map} The same cache
 */
export function seedRunPriceCache(
    priceCache,
    gameData,
    { zoneHrid, playerDTOs = [], extraHrids = [], saleTaxRates } = {}
) {
    if (!(priceCache instanceof Map) || !zoneHrid) return priceCache;
    const consumableHrids = [...consumableHridsOf(playerDTOs), ...extraHrids];
    const rates = new Set();
    if (saleTaxRates && typeof saleTaxRates === 'object') {
        for (const rate of Object.values(saleTaxRates)) rates.add(Number.isFinite(rate) ? rate : null);
    }
    // Anyone priced at the live tax (or no marker at all) reads the unsuffixed keys
    if (rates.size === 0) rates.add(null);
    for (const rate of rates) {
        seedSimPriceCache(priceCache, gameData, {
            zoneHrid,
            consumableHrids,
            ...(rate != null ? { saleTaxRate: rate } : {}),
        });
    }
    return priceCache;
}
