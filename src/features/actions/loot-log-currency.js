/**
 * Loot log valuation of the currencies the marketplace has no order book for.
 *
 * Cowbells, the four dungeon tokens, labyrinth tokens and task tokens never
 * trade, so a market lookup prices them at nothing and a loot log that sums
 * item value leaves them out. This only routes to the valuations Toolasha
 * already uses elsewhere; it prices nothing itself:
 *
 * - cowbell: the bag's sell price after the bag's 18% tax, over 10
 * - dungeon tokens: the best token-shop line's quote after market tax
 * - labyrinth tokens: the best labyrinth shop line's quote after market tax
 * - task tokens: the best Task Shop line (`calculateTaskTokenValue`)
 *
 * The loot log keeps ask and bid totals side by side, so every figure here is asked for one
 * side of the book. Task tokens are the exception: their valuation goes through the expected
 * value calculator, which exposes only the user's pricing mode, so both sides get that figure.
 */

import expectedValueCalculator from '../market/expected-value-calculator.js';
import {
    calculateDungeonTokenValue,
    calculateLabyrinthTokenValueDetail,
    DUNGEON_TOKEN_HRIDS,
} from '../../utils/token-valuation.js';
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

/** The one calculator start in flight, so a burst of valuations enqueues a single worker pass */
let evStartInFlight = false;

/**
 * Start the expected-value calculator if it is not running, at most once at a time. A loot log
 * redraw values many task-token rows before the calculator finishes; without this each one
 * enqueued another full pass and another completion event. The flag clears when the start
 * settles, so a start that failed (no data yet) can be retried by a later valuation.
 */
function startExpectedValueCalculator() {
    if (expectedValueCalculator.isInitialized || evStartInFlight) return;
    evStartInFlight = true;
    const clear = () => {
        evStartInFlight = false;
    };
    try {
        Promise.resolve(expectedValueCalculator.initialize?.()).then(clear, (error) => {
            console.error('[LootLogCurrency] Expected value start failed:', error);
            clear();
        });
    } catch (error) {
        console.error('[LootLogCurrency] Expected value start failed:', error);
        clear();
    }
}

/**
 * Coins one unit of a non-market currency is worth, already net of any tax
 * (so callers must not tax it again).
 * @param {string} baseHrid - Item HRID without an enhancement suffix
 * @param {'ask'|'bid'} [side] - Which side of the book to quote, matching the loot log column being filled
 * @returns {number|null} Coins per unit; null when the item is not such a
 *   currency or nothing can price it yet (callers fall back to the market)
 */
export function resolveCurrencyValue(baseHrid, side = 'ask') {
    if (!isNonMarketCurrency(baseHrid)) return null;

    const bookSide = side === 'bid' ? 'bid' : 'ask';
    let value = null;
    if (baseHrid === COWBELL_HRID) {
        // A tenth of the bag after the bag's own tax. Read directly rather than through the
        // expected-value chain, whose "include cowbells" toggle is about container EV, not loot
        const bag = getItemPrice(COWBELL_BAG_HRID, { mode: bookSide });
        value = bag > 0 ? calculatePriceAfterTax(bag, COWBELL_BAG_TAX) / 10 : null;
    } else if (baseHrid === TASK_TOKEN_HRID) {
        // Task tokens price through the expected-value calculator, which only the tooltip EV
        // feature starts; the loot log must not depend on that display being on. Its shop
        // valuation takes no side, so the ask and bid columns share the one figure
        startExpectedValueCalculator();
        value = calculateTaskTokenValue()?.tokenValue;
    } else if (baseHrid === LABYRINTH_TOKEN_HRID) {
        // The best shop reward's market quote: a sale of it pays the market tax
        const quote = calculateLabyrinthTokenValueDetail(undefined, undefined, bookSide)?.value;
        value = quote > 0 ? calculatePriceAfterTax(quote) : null;
    } else {
        // The token is worth its best shop item, and turning that into coins is a market sale that
        // pays the tax (the expected-value chain leaves it untaxed for its own purposes). Iron Cow
        // characters sell nothing on the market; calculatePriceAfterTax already waives it for them
        const quote = calculateDungeonTokenValue(baseHrid, undefined, undefined, bookSide);
        value = quote > 0 ? calculatePriceAfterTax(quote) : null;
    }
    return value > 0 ? value : null;
}
