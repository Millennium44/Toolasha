/**
 * Pricing the Labyrinth combat scrolls in the upgrade advisor.
 *
 * A scroll is bought with 30 Labyrinth Tokens, never for coins, and runs for 30
 * minutes (`utils/combat-scroll-buffs.js`; the sim applies it for the whole
 * run, so it models the scroll kept up continuously). It is a recurring spend,
 * not a one-off purchase, so it is deliberately kept out of the purchase
 * ranking, whose cost, repay-time and budget columns all assume an outlay made
 * once. Instead its cost is the tokens' opportunity cost — what 30 tokens would
 * have bought at the shop's best conversion, the figure the token tooltip's
 * "Labyrinth Shop Value" table shows — set against the Profit/hr the scroll adds.
 */

import dataManager from '../../core/data-manager.js';
import { formatKMB } from '../../utils/formatters.js';
import { calculateLabyrinthTokenValueDetail } from '../../utils/token-valuation.js';
import { SCROLL_BUFF_MINUTES, SCROLL_TOKEN_COST, priceScrollByTokens } from '../../utils/token-worth.js';

/**
 * What one Labyrinth Token is worth right now, and the shop item that sets it.
 * Priced the way net worth and the dungeon tokens are, so the three agree.
 *
 * @returns {{value: number, itemHrid: string, itemName: string}|null} Null when nothing in the shop is priced
 */
export function scrollTokenRate() {
    const detail = calculateLabyrinthTokenValueDetail('profitCalc_pricingMode', 'expectedValue_respectPricingMode');
    if (!(detail?.value > 0)) return null;
    const name = dataManager.getInitClientData()?.itemDetailMap?.[detail.itemHrid]?.name;
    return {
        value: detail.value,
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

    return {
        ...priced,
        gainPerScroll,
        netPerScroll,
        // "30 tokens × 6.8K/token (Pathseeker Lodestone) = 204K per scroll"
        basis:
            `${SCROLL_TOKEN_COST} tokens × ${formatKMB(Math.floor(rate.value))}/token (${rate.itemName}) = ` +
            `${formatKMB(priced.costPerScroll)} per scroll`,
        verdict: priced.worthIt
            ? `Net ${signed(priced.netPerHour)}/hr over the tokens' value`
            : `Net loss ${signed(priced.netPerHour)}/hr: the same tokens buy more as ${rate.itemName}`,
        gainText: `${signed(gainPerScroll)} per ${SCROLL_BUFF_MINUTES} min`,
        netText: `${signed(netPerScroll)} per scroll`,
    };
}
