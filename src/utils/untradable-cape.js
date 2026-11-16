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
import { getItemPrice, getItemPriceInfo } from './market-data.js';
import { getAlchemyOutputShopValue } from './alchemy-shop-value.js';
import { calculatePriceAfterTax } from './profit-helpers.js';

export const CAPE_BASE_VALUE_SETTING = 'untradableCapeBaseValue';
export const CAPE_BASE_VALUE_ZERO = 'zero';
export const CAPE_BASE_VALUE_MIRROR = 'mirror';
export const CAPE_BASE_VALUE_DECOMPOSE = 'decompose';

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
 * Whether a recipe's base cape is plainly free by the player's setting: a refined (★) cape upgraded from an
 * untradable cape, on the "nothing" setting. Then the bill is the refinement stones alone, a complete figure
 * (the 0 is the player's choice, not a missing price), so neither bill flags it partial. On the mirror
 * setting the base is one mirror price, and with no mirror price the bill is an unpriced floor. The one rule
 * both bills (the production bill and net worth's) share.
 * @param {string} outputHrid - The item the recipe makes
 * @param {string} upgradeItemHrid - The recipe's upgrade item
 * @returns {boolean} True for a refined cape on the "nothing" setting
 */
export function baseCapeIsPlainZero(outputHrid, upgradeItemHrid) {
    return (
        getCapeBaseValueMode() === CAPE_BASE_VALUE_ZERO &&
        isRefinedCape(outputHrid) &&
        isUntradableCape(upgradeItemHrid)
    );
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
 * The setting as one of its three values, for cache keys and branching. Anything unknown is 'zero'.
 * @returns {'zero'|'mirror'|'decompose'}
 */
export function getCapeBaseValueMode() {
    const value = config.getSettingValue(CAPE_BASE_VALUE_SETTING, CAPE_BASE_VALUE_ZERO);
    if (value === CAPE_BASE_VALUE_MIRROR || value === CAPE_BASE_VALUE_DECOMPOSE) return value;
    return CAPE_BASE_VALUE_ZERO;
}

/**
 * The cape setting as a cache-key fragment. On the decompose setting the value also depends on the Sell side
 * of the profit and net-worth pricing modes and the patient sell tick, none of which move an order book, so a
 * cache keyed on the mode alone would keep a stale figure after one of them changes.
 * @returns {string}
 */
export function getCapeBaseValueStamp() {
    const mode = getCapeBaseValueMode();
    if (mode !== CAPE_BASE_VALUE_DECOMPOSE) return mode;
    const setting = (key) => config.getSettingValue(key, '') ?? '';
    return [
        mode,
        setting('profitCalc_pricingMode'),
        setting('networth_pricingMode'),
        config.getSetting?.('profitCalc_patientTickSell') === true ? 'tickSell' : '',
    ].join(':');
}

/**
 * What decomposing one unrefined untradable cape yields, priced the way the decompose figures price their
 * outputs: each output at its sell price (a Labyrinth Token at its shop value), after the marketplace tax.
 * Only the base `decomposeItems` count: no success rate, catalyst or bonus drops, since this is the cape's
 * worth as a pile of outputs, not a session forecast.
 *
 * @param {string} itemHrid - The cape
 * @param {Object} [options]
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Ignored: outputs are always priced on the Sell side
 * @returns {{value: number, complete: boolean}} `complete` is false when the cape has no decompose
 *   recipe or any output (including another cape) has no firm price (unpriced or only a value-map estimate); the value is then not usable as a
 *   figure and {@link getCapeBaseValue} returns 0 for it, which readers already flag as a floor.
 */
export function getCapeDecomposeValue(itemHrid, { context = 'profit' } = {}) {
    const outputs = dataManager.getItemDetails?.(itemHrid)?.alchemyDetail?.decomposeItems;
    if (!Array.isArray(outputs) || outputs.length === 0) return { value: 0, complete: false };
    let value = 0;
    for (const output of outputs) {
        const count = Number(output.count) || 0;
        if (!output.itemHrid || output.itemHrid === itemHrid || isUntradableCape(output.itemHrid)) {
            return { value: 0, complete: false };
        }
        // Outputs are sold, so they follow the player's Sell setting whatever book side the caller passes for
        // the Mirror (an explicit mode overrides the side). An estimate from the official value map (an empty
        // book) is no firm price: it leaves the cape value unpriced, a floor the readers flag.
        const info = getItemPriceInfo(output.itemHrid, { context, side: 'sell' });
        const price = info?.estimated ? null : info?.price;
        if (price > 0) {
            value += calculatePriceAfterTax(price) * count;
            continue;
        }
        const shop = getAlchemyOutputShopValue(output.itemHrid);
        if (!(shop?.valuePerUnit > 0)) return { value: 0, complete: false };
        value += calculatePriceAfterTax(shop.valuePerUnit) * count;
    }
    return { value, complete: value > 0 };
}

/**
 * Value assumed for one unrefined, unenhanced cape.
 *
 * @param {Object} [options] - Pricing options for the Mirror of Protection stand-in
 * @param {'profit'|'networth'} [options.context='profit'] - Whose pricing mode to read
 * @param {'ask'|'bid'|'average'} [options.mode] - Force one book side
 * @param {string} [options.itemHrid] - The cape being valued; the decompose setting needs it (without it
 *   that setting yields 0, never a guess)
 * @returns {number} 0 on the "nothing" setting (or when the mirror is itself unpriced, or any decompose
 *   output is), else the Mirror of Protection's buy price or the cape's decompose value. The caller
 *   decides what a 0 means; it is never a quote.
 */
export function getCapeBaseValue({ context = 'profit', mode, itemHrid } = {}) {
    const baseMode = getCapeBaseValueMode();
    if (baseMode === CAPE_BASE_VALUE_DECOMPOSE) {
        if (!itemHrid) return 0;
        const decompose = getCapeDecomposeValue(unrefinedCapeOf(itemHrid), { context });
        return decompose.complete ? decompose.value : 0;
    }
    if (baseMode !== CAPE_BASE_VALUE_MIRROR) return 0;
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
    const baseMode = getCapeBaseValueMode();
    const mirror = baseMode === CAPE_BASE_VALUE_MIRROR;
    const decompose = baseMode === CAPE_BASE_VALUE_DECOMPOSE;
    const refined = isRefinedCape(entry.itemHrid);
    // Whose floor it is depends on the setting: nothing is the player's choice (so a refined cape is only a floor
    // for an input nothing prices), and a mirror setting is a floor when the mirror itself has no price
    let floor = '';
    if (entry.partial) {
        if (decompose)
            floor =
                ' An output of its decompose (or another input) has no firm price (none, or only an estimate), so this is a floor.';
        else if (mirror) floor = ' The Mirror of Protection or another input has no price, so this is a floor.';
        else if (refined) floor = ' An input has no price, so this is a floor.';
        else floor = ' The base cape counts as nothing, so this is a floor.';
    }
    // Your own enhancing cost is part of the figure only when the cape is enhanced
    const enhancing = entry.enhancementLevel > 0 ? ` (plus your own enhancing cost at +${entry.enhancementLevel})` : '';
    // A refined cape is its refinement stones plus its base cape as the setting values it (a Mirror of Protection, or nothing)
    const source = refined
        ? decompose
            ? `from its refinement stones plus the decompose value of the base cape${enhancing}`
            : mirror
              ? `from its refinement stones plus a Mirror of Protection for the base cape${enhancing}`
              : `from its refinement stones alone, the base cape counting as nothing${enhancing}`
        : decompose
          ? 'from what decomposing it yields (plus refinement and your own enhancing cost where it has them)'
          : 'from the untradable-cape setting (plus refinement and your own enhancing cost where it has them)';
    return `${name}${level}: not on the market; valued at ${formatValue(entry.value)} ${source}, never taxed.${floor}`;
}
