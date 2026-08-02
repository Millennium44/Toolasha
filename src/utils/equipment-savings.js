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
 * What the materials for one craft come to.
 *
 * An upgrade recipe has two halves the game keeps apart: the **inputs**, which
 * are consumed, and the **upgrade item**, which is the piece being upgraded. For
 * somebody who already owns the base piece — the usual reason to craft rather
 * than buy — only the inputs are a purchase, and the finished item's ask is
 * irrelevant. A Furious Spear you already hold becomes a Refined one for the
 * price of the shards.
 *
 * Any unpriced input makes the whole thing unpriced. A recipe totalled from the
 * ingredients it could price is a lower bound wearing a total's clothes, and
 * here it would report a cheaper craft than is possible.
 *
 * @param {Object} input - What it needs
 * @param {Array<{itemHrid: string, count: number}>} input.inputItems - The recipe
 * @param {Function} input.priceOf - `(itemHrid) => number|null`
 * @param {number} [input.outputCount] - How many one action makes
 * @param {boolean} [input.haveBase] - Whether the piece being upgraded is already owned
 * @param {number} [input.upgradeAsk] - What the piece being upgraded costs, if not
 * @returns {number|null} Coins for one finished item, or null when it cannot be priced
 */
export function craftCost({ inputItems, priceOf, outputCount = 1, haveBase = true, upgradeAsk = 0 }) {
    if (!inputItems?.length) return null;

    let total = 0;
    for (const input of inputItems) {
        const price = priceOf(input.itemHrid);
        if (!(price > 0)) return null;
        total += price * (input.count || 0);
    }

    // The base piece is only a cost if it has to be bought
    if (!haveBase) {
        if (!(upgradeAsk > 0)) return null;
        total += upgradeAsk;
    }

    const made = outputCount > 0 ? outputCount : 1;
    return total / made;
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

/**
 * The order a savings list reads best in.
 *
 * Nearest to done first, because that is the next thing that happens and the
 * only entry you might act on today. Insertion order says nothing at all, and
 * cost order buries the piece you are two days from behind one you are two
 * months from.
 *
 * Affordable ones lead — they are done, and a list that hides its finished
 * entries at the bottom makes you hunt for good news. Unpriced ones go last:
 * they have no progress to sort by, and putting them anywhere else implies one.
 *
 * @param {Array<Object>} targets - Costed targets
 * @returns {Array<Object>} A new array
 */
export function orderTargets(targets) {
    const rank = (target) => (target.cost === null ? 2 : target.affordable ? 0 : 1);

    return [...(targets || [])].filter(Boolean).sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (rank(a) === 2) return (a.name || '').localeCompare(b.name || '');
        // Within a band, the one furthest along leads
        return (b.fraction || 0) - (a.fraction || 0);
    });
}
