/**
 * Shop Token Values: the numbers.
 *
 * What one token of a shop currency is worth in each entry of the shop that takes it, and which
 * entry is the best. Read from the same sources as the token tooltips and the spend planner (the
 * Dungeon shop's offers, the Labyrinth shop map), at the side of the book the token valuation uses,
 * and net of the market tax the planner nets: what selling the thing the token bought would pay.
 *
 * An untradable cape has no market price, so its entry takes the cape value (the untradable-cape
 * setting, refinement included). That figure is an assumption: it is flagged `assumed`, is never
 * taxed (a cape cannot be sold), and never wins "best".
 */

import dataManager from '../../core/data-manager.js';
import { getItemPrice } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { tokenPricingSide, DUNGEON_TOKEN_HRIDS } from '../../utils/token-valuation.js';
import { isUntradableCape } from '../../utils/untradable-cape.js';
import { getUntradableCapeBaseCost } from '../../utils/untradable-cape-cost.js';
import { dungeonShopOffers } from '../inventory/dungeon-shop-offers.js';

export const LABYRINTH_TOKEN_HRID = '/items/labyrinth_token';

/**
 * The currencies this feature badges: the four dungeon tokens and the labyrinth token.
 * @returns {string[]}
 */
export function badgedCurrencies() {
    return [...DUNGEON_TOKEN_HRIDS, LABYRINTH_TOKEN_HRID];
}

/**
 * The book side every badge reads: the one the token tooltips and the inventory badge use.
 * @returns {'ask'|'bid'}
 */
export function badgeSide() {
    return tokenPricingSide('profitCalc_pricingMode', 'expectedValue_respectPricingMode');
}

/**
 * One unit's price on the badge side, from the same source the token valuation reads: a custom
 * price counts, and the side is forced.
 * @param {string} itemHrid - Item HRID
 * @param {'ask'|'bid'} side - Book side
 * @returns {number|null} Price, or null when unquoted
 */
function unitPriceOf(itemHrid, side) {
    const price = getItemPrice(itemHrid, { mode: side });
    return price > 0 ? price : null;
}

/**
 * One shop line's value per token.
 *
 * @param {Object} line - The shop line
 * @param {string} line.itemHrid - What it sells
 * @param {number} line.cost - Tokens per purchase
 * @param {number} line.outputCount - Units per purchase
 * @param {number|null} unitPrice - Book price of one unit on the badge side, null when unquoted
 * @returns {{perToken: number, assumed: boolean, assumedValue: number, partial: boolean}|null} null
 *   when the item has no price and is not an untradable cape (nothing to say about it)
 */
function valueLine({ itemHrid, cost, outputCount }, unitPrice, side) {
    if (unitPrice > 0) {
        return {
            perToken: (calculatePriceAfterTax(unitPrice) * outputCount) / cost,
            assumed: false,
            assumedValue: 0,
            partial: false,
        };
    }
    if (!isUntradableCape(itemHrid)) return null;
    // A cape cannot be sold, so its assumed value is not taxed
    // The mirror stand-in is read on the badge's own side
    const cape = getUntradableCapeBaseCost(itemHrid, { mode: side });
    const assumedValue = cape?.value > 0 ? cape.value : 0;
    return {
        perToken: (assumedValue * outputCount) / cost,
        assumed: true,
        assumedValue,
        partial: cape ? cape.partial : true,
    };
}

/**
 * Every entry of the shop that takes a currency, valued.
 *
 * @param {string} currencyHrid - A dungeon token or the labyrinth token
 * @param {'ask'|'bid'} [side] - Book side; the badge side by default
 * @returns {Array<{itemHrid: string, currencyHrid: string, cost: number, outputCount: number,
 *   perToken: number, assumed: boolean, assumedValue: number, partial: boolean}>} In shop order;
 *   lines with nothing to say about them are left out
 */
export function shopLineValues(currencyHrid, side = badgeSide()) {
    const lines = [];
    if (currencyHrid === LABYRINTH_TOKEN_HRID) {
        const shopMap = dataManager.getInitClientData()?.labyrinthShopItemDetailMap;
        for (const line of Object.values(shopMap || {})) {
            const cost = line?.cost?.count || 0;
            if (!line?.itemHrid || !(cost > 0)) continue;
            lines.push({
                itemHrid: line.itemHrid,
                cost,
                outputCount: line.outputCount > 0 ? line.outputCount : 1,
                unitPrice: unitPriceOf(line.itemHrid, side),
            });
        }
    } else {
        for (const offer of dungeonShopOffers(currencyHrid, side)) {
            lines.push({
                itemHrid: offer.itemHrid,
                cost: offer.cost,
                outputCount: offer.outputCount,
                unitPrice: unitPriceOf(offer.itemHrid, side),
            });
        }
    }

    const values = [];
    for (const line of lines) {
        const value = valueLine(line, line.unitPrice, side);
        if (value)
            values.push({
                itemHrid: line.itemHrid,
                currencyHrid,
                cost: line.cost,
                outputCount: line.outputCount,
                ...value,
            });
    }
    return values;
}

/**
 * The best real entry of a currency: the highest value per token among priced lines. Computed over
 * every line of the shop, not the tiles on screen. An assumed (untradable cape) line never wins.
 *
 * @param {Array<{itemHrid: string, cost: number, perToken: number, assumed: boolean}>} lines - From {@link shopLineValues}
 * @returns {{itemHrid: string, cost: number}|null} null when no line is priced
 */
export function bestLine(lines) {
    let best = null;
    for (const line of lines) {
        if (line.assumed || !(line.perToken > 0)) continue;
        if (!best || line.perToken > best.perToken) best = line;
    }
    return best ? { itemHrid: best.itemHrid, cost: best.cost } : null;
}
