/**
 * What an alchemy session's inputs and catalysts cost WHEN they were spent.
 *
 * ## Why this exists
 *
 * A session's outputs are priced the moment they arrive (`priceEach`,
 * `totalValue`), but its input and catalysts used to be priced when somebody
 * LOOKED at it, against the market of that moment. The same session's Net then
 * drifted with the market, and an old session could turn from a profit into a
 * loss without anything having happened to it.
 *
 * Each recorded message now prices what it consumed, with the same pricing the
 * viewers use (`priceInputWithRefinementFallback`, side buy, the pricing mode,
 * the Iron Cow rule), and adds it to `session.costs`. Per message, not once at
 * the start: prices move during a long run.
 *
 * ## Shape (one optional field on the existing session record)
 *
 * ```
 * session.costs = {
 *     input: { cost, units, unpricedUnits, bases: { [basis]: units } },
 *     catalysts: { [hrid]: { cost, count, unpricedCount } },
 * }
 * ```
 *
 * `units` and `count` are what the saved `cost` covers; `unpricedUnits` and
 * `unpricedCount` are consumption the market could not price at the time. Those
 * are NEVER folded into `cost` as 0: a reader reports them as unpriced, the way
 * a read-time price that could not be found always was.
 *
 * ## Coverage, not a flag
 *
 * A reader compares what was covered with what the session consumed
 * (`netConsumed`, the catalyst count). Anything uncovered is priced at today's
 * market and reported as such. That one rule handles a session recorded before
 * this existed (nothing covered), one begun on an older build and resumed on a
 * newer one (the front part uncovered), and a merge of a recorded part with an
 * unrecorded one, without any of them needing a case of its own.
 *
 * A saved cost stands. A setting changed later (the base-cape rule, the pricing
 * mode) does not restate it, and the basis recorded with it names what it was
 * costed under.
 *
 * ## Size
 *
 * A fixed handful of numbers plus one entry per catalyst hrid and at most
 * `MAX_BASES` basis labels, whatever the length of the session.
 */

import { getItemPrice, getItemPriceInfo } from '../../utils/market-data.js';
import { priceInputWithRefinementFallback } from '../../utils/refined-item-cost.js';
import { getUntradableCapeValue } from '../enhancement/untradable-cape-value.js';
import { addBasis } from './alchemy-cost-record.js';

export {
    resolveInputCost,
    resolveCatalystCost,
    mergeCosts,
    pickCosts,
    validateCosts,
    MIXED_BASIS,
} from './alchemy-cost-record.js';

/**
 * Price one unit of an input at today's market.
 *
 * The one pricing path for the trackers (at the moment of the message) and the
 * viewers (for whatever a session did not save), so the two cannot disagree on
 * how an input is costed.
 *
 * @param {string} inputItemHrid - The consumed item
 * @param {number} [enhancementLevel] - Its enhancement level (coinify and decompose)
 * @returns {{price: number, basis: string|null, unpriced: boolean}} Unit price and its basis
 */
export function priceInputNow(inputItemHrid, enhancementLevel) {
    const inputPriceInfo = getItemPriceInfo(inputItemHrid, {
        enhancementLevel,
        context: 'profit',
        side: 'buy',
    });
    const marketPrice = inputPriceInfo.price > 0 ? inputPriceInfo.price : 0;
    return priceInputWithRefinementFallback(inputItemHrid, marketPrice, {
        enhancementLevel,
        marketSource: inputPriceInfo.source,
        capeValue: getUntradableCapeValue,
    });
}

/**
 * Price one unit of a catalyst at today's market.
 * @param {string} catalystHrid
 * @returns {number|null} The buy-side price, or null when the market has none
 */
export function priceCatalystNow(catalystHrid) {
    const price = getItemPrice(catalystHrid, { context: 'profit', side: 'buy' });
    return price > 0 ? price : null;
}

/**
 * Record what one message's consumed input cost, on the session.
 *
 * Synchronous and never throws: a pricing failure is recorded as unpriced for
 * this message (a failed lookup is not a free input), and the attempt counting
 * around it is untouched.
 *
 * @param {Object} session - The active session, mutated
 * @param {Object} options
 * @param {string} options.inputItemHrid - The consumed item
 * @param {number} [options.enhancementLevel] - Its enhancement level
 * @param {number} options.units - Net units consumed by this message
 * @returns {void}
 */
export function recordInputCost(session, { inputItemHrid, enhancementLevel, units }) {
    if (!session || !(units > 0)) return;

    let priced;
    try {
        priced = priceInputNow(inputItemHrid, enhancementLevel);
    } catch (error) {
        console.error('[AlchemyCost] Could not price the consumed input:', error);
        priced = { price: 0, basis: null, unpriced: true };
    }

    if (!session.costs) session.costs = {};
    if (!session.costs.input) session.costs.input = { cost: 0, units: 0, unpricedUnits: 0, bases: {} };
    const input = session.costs.input;

    // No price and no fallback: the consumption is real and its cost is not
    // known, which is not the same as nothing
    if (priced.basis === null || priced.unpriced) {
        input.unpricedUnits += units;
        return;
    }

    // A priced zero (the base-cape-counts-as-nothing setting) is the player's
    // rule, not a missing price, and is saved as the 0 it is
    input.cost += priced.price * units;
    input.units += units;
    addBasis(input.bases, priced.basis, units);
}

/**
 * Record what one message's consumed catalysts cost, on the session.
 *
 * @param {Object} session - The active session, mutated
 * @param {string|null} catalystHrid - The catalyst in the slot
 * @param {number} count - How many this message consumed
 * @returns {void}
 */
export function recordCatalystCost(session, catalystHrid, count) {
    if (!session || !catalystHrid || !(count > 0)) return;

    let price = null;
    try {
        price = priceCatalystNow(catalystHrid);
    } catch (error) {
        console.error('[AlchemyCost] Could not price the consumed catalyst:', error);
    }

    if (!session.costs) session.costs = {};
    if (!session.costs.catalysts) session.costs.catalysts = {};
    const entry = (session.costs.catalysts[catalystHrid] ||= { cost: 0, count: 0, unpricedCount: 0 });

    if (price === null) {
        entry.unpricedCount += count;
        return;
    }
    entry.cost += price * count;
    entry.count += count;
}

export default { priceInputNow, priceCatalystNow, recordInputCost, recordCatalystCost };
