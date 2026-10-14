/**
 * What a pile of tokens is worth, and what a token-priced item costs in coins.
 *
 * Two readings of one number: the best gold/token a currency's shop offers. The
 * token tooltip uses it to total the stack a player holds; the combat advisor
 * uses it to put a gold price on a labyrinth scroll, which is bought with
 * tokens and never sold for coins. Pure arithmetic, so both callers and the
 * tests share one definition.
 */

/** Labyrinth Tokens one combat scroll costs in the Labyrinth Shop. */
export const SCROLL_TOKEN_COST = 30;

/** How long one scroll's buff runs, in minutes. */
export const SCROLL_BUFF_MINUTES = 30;

/**
 * The value of every token a player holds, at the shop's best conversion.
 *
 * @param {number} amount - Tokens held
 * @param {{name: string, goldPerToken: number}|undefined} best - The best shop row (highest gold/token)
 * @returns {{total: number, perToken: number, name: string}|null} Null with nothing held or no priced row
 */
export function heldTokensWorth(amount, best) {
    if (!(amount > 0) || !(best?.goldPerToken > 0)) return null;
    // Floored per token first so the line agrees with the table's Gold/Token column
    return { total: amount * best.goldPerToken, perToken: Math.floor(best.goldPerToken), name: best.name };
}

/**
 * Price a token-bought scroll by what its tokens could have bought instead, and
 * net it against the profit it adds.
 *
 * The scroll's buff lasts `buffMinutes`; kept up continuously it is bought
 * `60 / buffMinutes` times an hour, so its cost and the sim's Profit/hr gain
 * are both put on a per-hour basis.
 *
 * @param {Object} input
 * @param {number} input.tokenValue - Best gold/token from the Labyrinth Shop
 * @param {number} input.profitGainPerHour - Gold/hr the scroll adds (sim, buff on minus off)
 * @param {number} [input.tokenCost=SCROLL_TOKEN_COST] - Tokens per scroll
 * @param {number} [input.buffMinutes=SCROLL_BUFF_MINUTES] - Minutes one scroll lasts
 * @returns {{costPerScroll: number, costPerHour: number, gainPerHour: number, netPerHour: number,
 *   worthIt: boolean}|null} Null when the token has no value
 */
export function priceScrollByTokens({
    tokenValue,
    profitGainPerHour,
    tokenCost = SCROLL_TOKEN_COST,
    buffMinutes = SCROLL_BUFF_MINUTES,
}) {
    if (!(tokenValue > 0) || !(tokenCost > 0) || !(buffMinutes > 0)) return null;

    const costPerScroll = tokenCost * tokenValue;
    const costPerHour = (costPerScroll * 60) / buffMinutes;
    const gainPerHour = Number.isFinite(profitGainPerHour) ? profitGainPerHour : 0;
    const netPerHour = gainPerHour - costPerHour;

    return {
        costPerScroll,
        costPerHour,
        gainPerHour,
        netPerHour,
        worthIt: netPerHour > 0,
    };
}
