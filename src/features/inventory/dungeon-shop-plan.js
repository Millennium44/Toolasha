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
 * @param {Object} input
 * @param {Array<{itemHrid: string, name: string, cost: number, netValue: number|null}>} input.offers -
 *   What the shop sells for this token; `netValue` is one unit's sale value after
 *   market tax, null when the item has no price
 * @param {number} input.tokens - Tokens held
 * @param {Object<string, {cap: number, measured: boolean}>} input.caps - Per-item cap, by hrid;
 *   an item with no entry is treated as unmeasured with a cap of 0
 * @returns {{rows: Array<Object>, spent: number, leftover: number, gold: number}}
 *   One row per offer, best gold/token first, each with `quantity`, `tokens`,
 *   `gold`, `goldPerToken`, `cap`, `measured` and `reason` — why the quantity is
 *   what it is (`volume`, `tokens`, `no-price`, `unprofitable`, `no-volume`, or
 *   `null` when neither bound was reached)
 */
export function planTokenSpend({ offers, tokens, caps }) {
    const held = Math.max(0, Math.floor(Number(tokens) || 0));
    const ranked = (offers || [])
        .filter((offer) => offer?.itemHrid && offer.cost > 0)
        .map((offer) => ({
            ...offer,
            goldPerToken: offer.netValue > 0 ? offer.netValue / offer.cost : 0,
        }))
        .sort((a, b) => b.goldPerToken - a.goldPerToken || a.cost - b.cost);

    let remaining = held;
    let gold = 0;
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

        const affordable = Math.floor(remaining / offer.cost);
        const quantity = Math.max(0, Math.min(affordable, capInfo.cap));
        row.quantity = quantity;
        row.tokens = quantity * offer.cost;
        row.gold = quantity * offer.netValue;
        row.reason = quantity >= capInfo.cap ? 'volume' : quantity >= affordable ? 'tokens' : null;
        remaining -= row.tokens;
        gold += row.gold;
        return row;
    });

    return { rows, spent: held - remaining, leftover: remaining, gold };
}

export default { DEFAULT_CAP_DAYS, DEFAULT_CAP_SHARE_PERCENT, volumeCap, planTokenSpend };
