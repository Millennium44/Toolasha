/**
 * The game's own value for an item the high-enhancement cost rule would otherwise price.
 *
 * Shared by net worth and the inventory badges so both follow the same `networth_valueSource`
 * decision: badges and sort order must not disagree with the net worth total.
 */

import config from '../core/config.js';
import { ironCowBook } from './ironcow-valuation.js';
import { refreshMarketValues, marketValueFor } from './market-values.js';

/**
 * In officialValue mode the setting promises the game's number, so a published value wins at
 * every level, +13 and above included. Null in orderBook mode, for an Iron Cow character (whose
 * own valuation outranks it, as in resolveNetworthPrices), or when the game has no value.
 *
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Enhancement level
 * @returns {number|null} The official value, or null to use the existing chain
 */
export function officialValueOverride(itemHrid, enhancementLevel) {
    if ((config.getSettingValue('networth_valueSource') || 'orderBook') !== 'officialValue') return null;
    if (ironCowBook(itemHrid, enhancementLevel)) return null;
    refreshMarketValues();
    const official = marketValueFor(itemHrid, enhancementLevel);
    return official !== null && official > 0 ? official : null;
}
