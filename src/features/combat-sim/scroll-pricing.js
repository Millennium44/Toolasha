/**
 * Pricing the Labyrinth combat scrolls in the upgrade advisor.
 *
 * A scroll is bought with 30 Labyrinth Tokens, never for coins, and runs for 30
 * minutes (`utils/combat-scroll-buffs.js`; the sim applies it for the whole
 * run, so it models the scroll kept up continuously). It is a recurring spend,
 * not a one-off purchase, so it is deliberately kept out of the purchase
 * ranking, whose cost, repay-time and budget columns all assume an outlay made
 * once. Instead its cost is the tokens' opportunity cost — what 30 tokens would
 * have bought at the shop's best conversion, valued after sale tax at a patient
 * tick (`calculateLabyrinthTokenValueDetail`, the figure the "Labyrinth Shop
 * Value" table is built from) — set against the Profit/hr the scroll adds. The
 * token tooltip's headline figure is the raw ask, so it reads higher than this
 * by about the sale tax.
 */

import dataManager from '../../core/data-manager.js';
import { COWBELL_BAG_HRID, COWBELL_BAG_TAX, MARKET_TAX } from '../../utils/profit-constants.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { formatKMB } from '../../utils/formatters.js';
import { calculateLabyrinthTokenValueDetail } from '../../utils/token-valuation.js';
import { SCROLL_BUFF_MINUTES, SCROLL_TOKEN_COST, priceScrollByTokens } from '../../utils/token-worth.js';

/**
 * What one Labyrinth Token is worth right now after sale tax, and the shop item that sets it.
 * Priced the way net worth and the dungeon tokens are, so the three agree.
 *
 * @returns {{value: number, itemHrid: string, itemName: string}|null} Null when nothing in the shop is priced
 */
export function scrollTokenRate() {
    const detail = calculateLabyrinthTokenValueDetail('profitCalc_pricingMode', null);
    if (!(detail?.value > 0)) return null;
    const name = dataManager.getInitClientData()?.itemDetailMap?.[detail.itemHrid]?.name;
    // The sim's Profit/hr is net of the sale tax (`taxedDropValue` in the adapter), so the token's
    // worth is what its best item sells for after tax too; calculatePriceAfterTax keeps the Iron Cow
    // exemption. The shop's rewards are market-valued, so none of them is an already-net EV figure.
    const taxRate = detail.itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX;
    return {
        value: calculatePriceAfterTax(detail.value, taxRate),
        itemHrid: detail.itemHrid,
        itemName: name || detail.itemHrid.split('/').pop().replace(/_/g, ' '),
    };
}

/**
 * Signed coins: "+1.2M" or "−340K".
 * @param {number} value - Coins
 * @returns {string}
 */
function signed(value) {
    return `${value < 0 ? '−' : '+'}${formatKMB(Math.abs(value))}`;
}

/**
 * Price one scroll row against its tokens.
 *
 * `profitGainPerHour` is the sim's Profit/hr with the buff on minus off. A row
 * that measures the loss of dropping a scroll already carried has the sign
 * flipped, so every row reads as "what carrying this scroll adds".
 *
 * @param {Object} row - An upgrade result of type 'scroll'
 * @param {{value: number, itemName: string}} rate - From {@link scrollTokenRate}
 * @param {Object} [baseline] - Baseline metrics, used when the row has no economics
 * @returns {Object|null} Pricing and the strings that explain it, null without a token value
 */
export function priceScrollRow(row, rate, baseline) {
    const measured =
        row?.economics?.profitGainPerHour ?? (row?.metrics?.profitPerHour ?? 0) - (baseline?.profitPerHour ?? 0);
    const gain = row?.candidate?.measuresLoss ? -measured : measured;

    const priced = priceScrollByTokens({ tokenValue: rate?.value, profitGainPerHour: gain });
    if (!priced) return null;

    const scrollsPerHour = 60 / SCROLL_BUFF_MINUTES;
    const gainPerScroll = priced.gainPerHour / scrollsPerHour;
    const netPerScroll = gainPerScroll - priced.costPerScroll;
    const breakEven = priced.netPerHour === 0;

    return {
        ...priced,
        gainPerScroll,
        netPerScroll,
        // "30 tokens × 6.8K/token (Pathseeker Lodestone) = 204K per scroll"
        basis:
            `${SCROLL_TOKEN_COST} tokens × ${formatKMB(Math.floor(rate.value))}/token (${rate.itemName}, after tax) = ` +
            `${formatKMB(priced.costPerScroll)} per scroll`,
        // Exactly zero is neutral: not a win, but "−0 loss" would be a lie
        breakEven,
        verdict: breakEven
            ? `Break-even: the scroll adds exactly what the tokens are worth`
            : priced.worthIt
              ? `Net ${signed(priced.netPerHour)}/hr over the tokens' value`
              : `Net loss ${signed(priced.netPerHour)}/hr: the same tokens buy more as ${rate.itemName}`,
        // The table's Net / hr cell
        netHourText: breakEven
            ? '0'
            : `${priced.worthIt ? '+' : '−'}${formatKMB(Math.abs(priced.netPerHour))}${priced.worthIt ? '' : ' loss'}`,
        gainText: `${signed(gainPerScroll)} per ${SCROLL_BUFF_MINUTES} min`,
        // The table's Gain column, per hour so it lines up with Net / hr beside it
        gainHourText: `${signed(priced.gainPerHour)}/hr`,
        netText: `${signed(netPerScroll)} per scroll`,
    };
}

/** The improvement step the Score's cost columns are quoted per, in percent. */
const SCROLL_STEP_PCT = 0.01;

/**
 * Gold per hour of tokens spent per 0.01% of one metric: the recurring-cost
 * counterpart of the gear table's Gold/0.01% and the levels table's Hours/0.01%.
 * Lower is better. A delta that is not a clear gain (zero, negative, unknown, or
 * inside the run's error) has no figure, returned as Infinity so it never scores.
 *
 * @param {number} costPerHour - Token cost of keeping the scroll up, gold per hour
 * @param {number} pctDelta - What carrying the scroll adds, in percent (2 = 2%)
 * @param {boolean} [significant=true] - Whether the delta cleared the run's error
 * @returns {number} Gold per hour per 0.01%, or Infinity
 */
export function scrollGoldPerStep(costPerHour, pctDelta, significant = true) {
    if (!significant || !(costPerHour > 0) || !Number.isFinite(pctDelta) || pctDelta <= 0) return Infinity;
    return costPerHour / (pctDelta / SCROLL_STEP_PCT);
}
