/**
 * Loot log valuation of the currencies the marketplace has no order book for.
 *
 * Cowbells, the four dungeon tokens, labyrinth tokens and task tokens never
 * trade, so a market lookup prices them at nothing and a loot log that sums
 * item value leaves them out. This only routes to the valuations Toolasha
 * already uses elsewhere; it prices nothing itself:
 *
 * - cowbell: the bag's sell price after the bag's 18% tax, over 10
 * - dungeon tokens: `expectedValueCalculator.resolveSellSideValue`, taxed where it says so
 * - labyrinth tokens: the best labyrinth shop line's quote after market tax
 * - task tokens: the best Task Shop line (`calculateTaskTokenValue`)
 */

import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateLabyrinthTokenValueDetail, DUNGEON_TOKEN_HRIDS } from '../../utils/token-valuation.js';
import { calculateTaskTokenValue } from '../tasks/task-profit-calculator.js';
import { getItemPrice } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';

const LABYRINTH_TOKEN_HRID = '/items/labyrinth_token';
const TASK_TOKEN_HRID = '/items/task_token';
const COWBELL_HRID = '/items/cowbell';

/**
 * Whether an item is one of the non-market currencies this module values.
 * @param {string} baseHrid - Item HRID without an enhancement suffix
 * @returns {boolean} True for a currency valued here
 */
export function isNonMarketCurrency(baseHrid) {
    return (
        baseHrid === COWBELL_HRID ||
        DUNGEON_TOKEN_HRIDS.has(baseHrid) ||
        baseHrid === LABYRINTH_TOKEN_HRID ||
        baseHrid === TASK_TOKEN_HRID
    );
}

/**
 * Coins one unit of a non-market currency is worth, already net of any tax
 * (so callers must not tax it again).
 * @param {string} baseHrid - Item HRID without an enhancement suffix
 * @returns {number|null} Coins per unit; null when the item is not such a
 *   currency or nothing can price it yet (callers fall back to the market)
 */
export function resolveCurrencyValue(baseHrid) {
    if (!isNonMarketCurrency(baseHrid)) return null;

    let value = null;
    if (baseHrid === COWBELL_HRID) {
        // A tenth of the bag after the bag's own tax. Read directly rather than through the
        // expected-value chain, whose "include cowbells" toggle is about container EV, not loot
        const bag = getItemPrice(COWBELL_BAG_HRID, { context: 'profit', side: 'sell' });
        value = bag > 0 ? calculatePriceAfterTax(bag, COWBELL_BAG_TAX) / 10 : null;
    } else if (baseHrid === TASK_TOKEN_HRID) {
        // Task tokens price through the expected-value calculator, which only the tooltip EV
        // feature starts; the loot log must not depend on that display being on
        if (!expectedValueCalculator.isInitialized) expectedValueCalculator.initialize?.();
        value = calculateTaskTokenValue()?.tokenValue;
    } else if (baseHrid === LABYRINTH_TOKEN_HRID) {
        // The best shop reward's market quote: a sale of it pays the market tax
        const quote = calculateLabyrinthTokenValueDetail()?.value;
        value = quote > 0 ? calculatePriceAfterTax(quote) : null;
    } else {
        const resolved = expectedValueCalculator.resolveSellSideValue(baseHrid, 0);
        value = resolved?.needsTax && resolved.value > 0 ? calculatePriceAfterTax(resolved.value) : resolved?.value;
    }
    return value > 0 ? value : null;
}
