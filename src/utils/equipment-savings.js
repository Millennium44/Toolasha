/**
 * Equipment savings
 *
 * How far you are from affording the piece you want, and when you will be.
 *
 * ## The cost is not the price
 *
 * An upgrade costs the asking price of the thing you want **minus what the piece
 * it replaces is worth**, because you sell the old one. Reading the ask alone
 * overstates every upgrade by the value of the gear you are already wearing,
 * which for a late-game slot is most of the price.
 *
 * That is only true if you actually sell it. Somebody keeping the old piece for
 * a second loadout is paying the full ask, so the trade-in is a mode rather than
 * an assumption — `noSell` turns it off.
 *
 * ## Unpriced is not free
 *
 * A target nobody is selling has no cost, not a cost of nothing. Treating it as
 * zero would report it as already affordable, which is the most misleading thing
 * this could possibly say. Those come back null and are counted separately in a
 * total, so a total is never quietly a lower bound.
 *
 * The model is EWatch's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/**
 * What one upgrade actually costs.
 *
 * @param {Object} input - What it needs
 * @param {number|null} input.targetAsk - The asking price of the piece you want
 * @param {number} [input.equippedBid] - What the piece it replaces would fetch
 * @param {boolean} [input.noSell] - Keeping the old piece, so no trade-in
 * @returns {number|null} Coins needed, or null when the target has no price
 */
export function upgradeCost({ targetAsk, equippedBid = 0, noSell = false }) {
    if (!(targetAsk > 0)) return null;
    if (noSell) return targetAsk;

    // Never negative: an upgrade cheaper than what you are wearing costs
    // nothing, and a negative cost would make a progress bar meaningless
    return Math.max(0, targetAsk - (Number(equippedBid) || 0));
}

/**
 * How far along the saving is.
 *
 * @param {number|null} cost - From `upgradeCost`
 * @param {number} coins - What you have
 * @returns {{fraction: number|null, affordable: boolean, needed: number|null}}
 *   `fraction` is capped at 1 — a bar cannot say more than full — while `needed`
 *   is what is actually left, which is the figure worth reading
 */
export function savingsProgress(cost, coins) {
    if (cost === null) return { fraction: null, affordable: false, needed: null };

    const held = Number(coins) || 0;
    // Nothing to save for is already there, rather than a division by zero
    if (cost <= 0) return { fraction: 1, affordable: true, needed: 0 };

    return {
        fraction: Math.min(1, held / cost),
        affordable: held >= cost,
        needed: Math.max(0, cost - held),
    };
}

/**
 * How long the rest of it takes at what you are earning.
 *
 * @param {number|null} needed - Coins still to find
 * @param {number} perDay - Income per day
 * @returns {number|null} Seconds, or null when it cannot be said
 */
export function timeToAffordSeconds(needed, perDay) {
    if (needed === null || !(needed > 0)) return 0;
    // Not infinity: no income is not "never", it is nothing to divide by. A
    // figure would be a claim about the future that this cannot make.
    if (!(perDay > 0)) return null;

    return (needed / perDay) * 86400;
}

/**
 * The whole shopping list at once.
 *
 * @param {Array<{cost: number|null}>} watches - Priced watches
 * @returns {{cost: number, unpriced: number}} `unpriced` is how many targets it
 *   could not include, which is the difference between a total and a lower bound
 *   presented as one
 */
export function totalSavings(watches) {
    let cost = 0;
    let unpriced = 0;

    for (const watch of watches || []) {
        if (!watch) continue;
        if (watch.cost === null) unpriced++;
        else cost += watch.cost;
    }
    return { cost, unpriced };
}
