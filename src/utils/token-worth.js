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
 * The value of every token a player holds, spent on whole shop purchases.
 *
 * A shop sells a row in whole units, so a stack is worth the purchases it can
 * actually make, not its size times the best row's per-token ratio: 999 tokens
 * against a 1,000-token row buy none of it. Whole purchases of the best row come
 * first; what is left goes greedily to the best row it can still afford, until
 * nothing is affordable. Tokens no row can buy are counted as unspent, at nothing.
 *
 * @param {number} amount - Tokens held
 * @param {Array<{name: string, cost: number, askPrice: number, goldPerToken: number}>} rows - Shop rows, best
 *   gold/token first; `askPrice` is the value of one whole purchase
 * @returns {{total: number, parts: Array<{name: string, purchases: number, tokens: number, value: number}>,
 *   unspent: number}|null} Null with nothing held or no priced row
 */
export function heldTokensWorth(amount, rows) {
    const priced = (rows || []).filter((row) => row?.cost > 0 && row?.askPrice > 0);
    if (!(amount > 0) || !priced.length) return null;

    const parts = [];
    let left = Math.floor(amount);
    let total = 0;
    for (const row of priced) {
        const purchases = Math.floor(left / row.cost);
        if (purchases < 1) continue;
        const tokens = purchases * row.cost;
        const value = purchases * row.askPrice;
        parts.push({ name: row.name, purchases, tokens, value });
        left -= tokens;
        total += value;
    }
    if (!parts.length) return null;
    return { total, parts, unspent: left };
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
