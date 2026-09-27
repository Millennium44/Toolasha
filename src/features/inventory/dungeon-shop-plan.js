/**
 * How to spend a stack of dungeon tokens: the arithmetic, with no DOM and no
 * network, so it can be tested on its own.
 *
 * Greedy by net gold per token, highest first, in whole items, each item held
 * to what the market could absorb from you in the chosen window. Greedy is not
 * the integer-knapsack optimum — at the boundary a cheaper, slightly worse item
 * can sometimes use tokens a dearer one strands — but the shop's items cost the
 * same few round numbers and the 1-token essence soaks up any remainder, so the
 * gap is at most one item's margin.
 */

/** Opening window, in days, for the volume cap */
export const DEFAULT_CAP_DAYS = 3;

/** Opening share of an item's traded volume one seller is assumed to take, in percent */
export const DEFAULT_CAP_SHARE_PERCENT = 25;

/**
 * Opening hold threshold: an item only gets tokens if its gold/token is at least this
 * percent of the best purchasable item's gold/token. 0 disables the threshold.
 */
export const DEFAULT_HOLD_PERCENT = 80;

/**
 * How many of an item the market could take from you.
 *
 * @param {{unitsPerDay: number, known: boolean}|null} volume - The pooled-history measurement;
 *   `known: false` (or null) is "nothing could be measured", not a measured zero
 * @param {Object} options
 * @param {number} options.days - Window in days
 * @param {number} options.sharePercent - Share of the traded volume, in percent
 * @param {boolean} [options.includeUnmeasured=false] - Leave unmeasured items uncapped instead of at 0
 * @returns {{cap: number, measured: boolean, unitsPerDay: number|null}} `cap` is a whole
 *   number of items, or Infinity for an unmeasured item the user chose to include
 */
export function volumeCap(volume, { days, sharePercent, includeUnmeasured = false }) {
    if (!volume?.known) {
        return { cap: includeUnmeasured ? Number.POSITIVE_INFINITY : 0, measured: false, unitsPerDay: null };
    }
    const perDay = Math.max(0, Number(volume.unitsPerDay) || 0);
    const window = Math.max(0, Number(days) || 0);
    const share = Math.max(0, Number(sharePercent) || 0) / 100;
    return { cap: Math.floor(perDay * window * share + 1e-9), measured: true, unitsPerDay: perDay };
}

/**
 * Allocate tokens across the shop's items.
 *
 * Once the best items hit their volume caps, a plain greedy pass dumps the rest
 * into whatever is next in line — often a far worse item, at prices that will
 * recover as volume trades. `holdPercent` keeps those leftovers uncommitted
 * instead: an item only receives tokens if its gold/token is at least
 * `holdPercent`% of the best purchasable item's gold/token. Tokens an
 * otherwise-purchasable item would have taken, but didn't because of the
 * threshold, are reported separately as `held` ("held for next run"), distinct
 * from `leftover` (tokens nothing at all could absorb).
 *
 * @param {Object} input
 * @param {Array<{itemHrid: string, name: string, cost: number, outputCount?: number, netValue: number|null}>}
 *   input.offers - What the shop sells for this token, per purchase: `cost` tokens buys `outputCount` units
 *   (default 1), worth `netValue` after market tax in all, null when the item has no price
 * @param {number} input.tokens - Tokens held
 * @param {Object<string, {cap: number, measured: boolean}>} input.caps - Per-item cap, by hrid;
 *   an item with no entry is treated as unmeasured with a cap of 0
 * @param {number} [input.holdPercent=0] - The hold threshold, in percent of the best purchasable
 *   item's gold/token; 0 disables it (every purchasable item is spent on, as before)
 * @returns {{rows: Array<Object>, spent: number, held: number, leftover: number, gold: number}}
 *   One row per offer, best gold/token first, each with `quantity`, `tokens`,
 *   `gold`, `goldPerToken`, `cap`, `measured` and `reason` — why the quantity is
 *   what it is (`volume`, `tokens`, `no-price`, `unprofitable`, `no-volume`,
 *   `below-threshold`, or `null` when neither bound was reached). `held` is
 *   tokens withheld by the threshold; `leftover` is tokens nothing could buy
 *   even without it.
 */
export function planTokenSpend({ offers, tokens, caps, holdPercent = 0 }) {
    const startingTokens = Math.max(0, Math.floor(Number(tokens) || 0));
    const ranked = (offers || [])
        .filter((offer) => offer?.itemHrid && offer.cost > 0)
        .map((offer) => ({
            ...offer,
            goldPerToken: offer.netValue > 0 ? offer.netValue / offer.cost : 0,
        }))
        .sort((a, b) => b.goldPerToken - a.goldPerToken || a.cost - b.cost);

    const purchaseCapOf = (offer, capInfo) => {
        // `cap` counts units sold; a purchase that yields several units uses up that many
        const perPurchase = offer.outputCount > 0 ? offer.outputCount : 1;
        return Math.floor(capInfo.cap / perPurchase);
    };

    // The bar: the highest gold/token among items with a price that the plan could
    // buy at least one of — capped-and-affordable, or uncapped/unmeasured-but-included.
    // Ranked is already sorted best-first, so the first one that qualifies is it.
    let bestGoldPerToken = 0;
    for (const offer of ranked) {
        if (!(offer.netValue > 0)) continue;
        const capInfo = caps?.[offer.itemHrid] || { cap: 0, measured: false };
        if (!capInfo.measured && !(capInfo.cap > 0)) continue;
        if (!(purchaseCapOf(offer, capInfo) >= 1)) continue;
        if (offer.cost > startingTokens) continue;
        bestGoldPerToken = offer.goldPerToken;
        break;
    }
    const bar = bestGoldPerToken * (Math.max(0, Number(holdPercent) || 0) / 100);

    let remaining = startingTokens;
    let gold = 0;
    let held = 0;
    // Lazily seeded with `remaining` the first time a row falls below the bar; every
    // later below-bar row (goldPerToken only ever falls, since rows are sorted) draws
    // from this same pool, so the reported `held` total is not overcounted.
    let holdPool = null;
    const rows = ranked.map((offer) => {
        const capInfo = caps?.[offer.itemHrid] || { cap: 0, measured: false };
        const row = {
            itemHrid: offer.itemHrid,
            name: offer.name,
            cost: offer.cost,
            netValue: offer.netValue,
            goldPerToken: offer.goldPerToken,
            cap: capInfo.cap,
            measured: capInfo.measured,
            unitsPerDay: capInfo.unitsPerDay ?? null,
            quantity: 0,
            tokens: 0,
            gold: 0,
            reason: null,
        };

        if (!(offer.netValue > 0)) {
            row.reason = offer.netValue === null || offer.netValue === undefined ? 'no-price' : 'unprofitable';
            return row;
        }
        if (!capInfo.measured && !(capInfo.cap > 0)) {
            row.reason = 'no-volume';
            return row;
        }

        const purchaseCap = purchaseCapOf(offer, capInfo);

        if (bar > 0 && offer.goldPerToken < bar) {
            // Below the bar: not spent on for real, but report what it would have
            // taken, so the tokens read as held rather than vanishing from the total
            if (holdPool === null) holdPool = remaining;
            const affordable = Math.floor(holdPool / offer.cost);
            const quantity = Math.max(0, Math.min(affordable, purchaseCap));
            holdPool -= quantity * offer.cost;
            held += quantity * offer.cost;
            row.reason = 'below-threshold';
            return row;
        }

        const affordable = Math.floor(remaining / offer.cost);
        const quantity = Math.max(0, Math.min(affordable, purchaseCap));
        row.quantity = quantity;
        row.tokens = quantity * offer.cost;
        row.gold = quantity * offer.netValue;
        row.reason = quantity >= purchaseCap ? 'volume' : quantity >= affordable ? 'tokens' : null;
        remaining -= row.tokens;
        gold += row.gold;
        return row;
    });

    return { rows, spent: startingTokens - remaining, held, leftover: remaining - held, gold };
}

export default { DEFAULT_CAP_DAYS, DEFAULT_CAP_SHARE_PERCENT, DEFAULT_HOLD_PERCENT, volumeCap, planTokenSpend };
