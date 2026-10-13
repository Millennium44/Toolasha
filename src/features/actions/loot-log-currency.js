/**
 * Loot log valuation of the currencies the marketplace has no order book for.
 *
 * Cowbells, the four dungeon tokens, labyrinth tokens and task tokens never
 * trade, so a market lookup prices them at nothing and a loot log that sums
 * item value leaves them out. This only routes to the valuations Toolasha
 * already uses elsewhere; it prices nothing itself:
 *
 * - coin, cowbell (bag / 10 after the bag's tax) and dungeon tokens:
 *   `expectedValueCalculator.resolveSellSideValue`, the drop-valuation chain
 * - labyrinth tokens: the best labyrinth shop line, at the profit pricing mode
 * - task tokens: the best Task Shop line (`calculateTaskTokenValue`)
 */

import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateLabyrinthTokenValueDetail, DUNGEON_TOKEN_HRIDS } from '../../utils/token-valuation.js';
import { calculateTaskTokenValue } from '../tasks/task-profit-calculator.js';

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
    if (baseHrid === TASK_TOKEN_HRID) {
        value = calculateTaskTokenValue()?.tokenValue;
    } else if (baseHrid === LABYRINTH_TOKEN_HRID) {
        value = calculateLabyrinthTokenValueDetail()?.value;
    } else {
        value = expectedValueCalculator.resolveSellSideValue(baseHrid, 0)?.value;
    }
    return value > 0 ? value : null;
}
