import config from '../core/config.js';

/**
 * Whether net worth values items off the game's own market value instead of the order book.
 * @returns {boolean}
 */
export function isOfficialValueSource() {
    return (config.getSettingValue('networth_valueSource') || 'orderBook') === 'officialValue';
}

/**
 * The pricing side guild credits are read at for net worth: the net worth pricing mode, pinned to
 * ask when the value source is the game's own market value (credits are never priced from that
 * map, and the mode's help text promises it is ignored there). Shared by the shrine levels, held
 * guild tokens, held guild credits and the inventory badge totals so they always agree on what a
 * credit is worth.
 * @returns {string} 'ask' or 'bid'
 */
export function guildCreditPricingMode() {
    return isOfficialValueSource() ? 'ask' : config.getSettingValue('networth_pricingMode') || 'ask';
}
