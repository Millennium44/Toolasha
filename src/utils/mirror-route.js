/**
 * The Philosopher's Mirror route, as arithmetic.
 *
 * A mirror attempt always succeeds and costs one mirror plus one copy of the item's base item at one
 * level below the item being enhanced (game client `getPhilosophersMirrorCost`; for a refined item
 * the base is the unrefined one, its `baseItemHrids[0]`). So a +L is made from a +(L-1) and a
 * +(L-2) copy and a mirror, and the game only runs a mirror on an item at +2 or above, which makes
 * +3 the first level it can reach. Each copy is itself the cheapest way to hold that level, mirrored
 * or not, so the saving compounds up the ladder.
 *
 * Shared by the enhancement panel's mirror column and the upgrade advisor so the two cannot drift.
 */

/** Philosopher's Mirror item hrid */
export const MIRROR_ITEM_HRID = '/items/philosophers_mirror';

/** The first level a mirror can make: it needs a +2 item to run on */
export const MIRROR_FIRST_LEVEL = 3;

/**
 * Cheapest way to hold each level when a mirror is allowed.
 *
 * @param {Array<number|null>} ordinary - `ordinary[L]`: what holding a +L costs without a mirror, its
 *   base item included. Null or non-finite means no ordinary route is known for that level
 * @param {number} mirrorPrice - What one Philosopher's Mirror costs
 * @param {number} [blessedChance=0] - Chance a mirror success is +2 (Blessed Tea). A +2 skips the
 *   next step of the chain, so the step into level n is only run when the chain stands on n-1: the
 *   same model as `applyMirrorOptimization`, `cost[n] = cost[n-1] + landing[n-1] * (cost[n-2] +
 *   mirrorPrice)`. 0 reduces to the plain `cost[n-1] + cost[n-2] + mirrorPrice`
 * @returns {{best: number[], mirrorTotals: Array<number|undefined>, landing: number[], mirrorCounts: number[],
 *   mirrorTotalCounts: Array<number|undefined>}} `best[L]` is the cheaper of the
 *   ordinary route and the mirror route (Infinity when neither exists). `mirrorTotals[L]` is the
 *   mirror route's all-in total for L >= {@link MIRROR_FIRST_LEVEL}, Infinity when a copy it needs has
 *   no route. `landing[L]` is the chance the chain lands exactly on level L (1 for a level the mirror
 *   does not build, and everywhere when `blessedChance` is 0). `mirrorCounts[L]` is how many mirrors
 *   holding `best[L]` spends, counting the ones its built copies use (expected, under Blessed Tea), and
 *   `mirrorTotalCounts[L]` the same for the mirror route at L
 */
export function cheapestWithMirror(ordinary, mirrorPrice, blessedChance = 0) {
    const best = [];
    const mirrorTotals = [];
    const priced = (value) => (Number.isFinite(value) ? value : Infinity);
    const b = blessedChance > 0 ? Math.min(1, blessedChance) : 0;
    // Chance the chain lands exactly on each level, and which levels the mirror builds
    const landing = [];
    const usedMirror = [];
    const mirrorCounts = [];
    const mirrorTotalCounts = [];
    for (let level = 0; level < ordinary.length; level++) {
        const direct = priced(ordinary[level]);
        best[level] = direct;
        landing[level] = 1;
        usedMirror[level] = false;
        mirrorCounts[level] = 0;
        if (level >= MIRROR_FIRST_LEVEL) {
            // A step that can never be reached (landing 0) costs nothing, whatever its inputs
            const step = landing[level - 1] > 0 ? landing[level - 1] * (best[level - 2] + mirrorPrice) : 0;
            const total = best[level - 1] + step;
            mirrorTotals[level] = total;
            // This step's mirror, plus the ones its two copies were built with
            const stepCount = landing[level - 1] > 0 ? landing[level - 1] * (mirrorCounts[level - 2] + 1) : 0;
            mirrorTotalCounts[level] = mirrorCounts[level - 1] + stepCount;
            if (total < direct) {
                best[level] = total;
                usedMirror[level] = true;
                mirrorCounts[level] = mirrorTotalCounts[level];
                landing[level] = (1 - b) * landing[level - 1] + (usedMirror[level - 1] ? b * landing[level - 2] : 0);
            }
        }
    }
    return { best, mirrorTotals, landing, mirrorCounts, mirrorTotalCounts };
}

/**
 * Whole mirrors to have on hand for a route that spends `count` of them on average (a Blessed Tea
 * chain spends a fraction of a step's mirror): rounded up, at least one.
 * @param {number|undefined} count - Expected mirrors the route spends
 * @returns {number}
 */
export function mirrorsToBuy(count) {
    return Math.max(1, Math.ceil((Number(count) || 0) - 1e-9));
}
