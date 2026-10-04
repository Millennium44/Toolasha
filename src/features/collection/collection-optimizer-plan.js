/**
 * Collection Points optimizer — the arithmetic.
 *
 * The Collections log pays points on the same ladder as the Bestiary
 * ({@link pointsFromCount}): 1 at a count of 1, +2 at 10, +3 at 100 … An item
 * counts toward its collection only when you make, loot or alchemize it —
 * buying it on the market does not — so the routes priced here are:
 *
 * - **Craft**: make the units at your own bench. Cost per unit is the own-use
 *   "make" figure (materials and teas at the buy side, per item made);
 *   time per unit is 3600 / items made per hour. The materials are bought, so
 *   nothing below the crafted item is collected.
 * - **Decompose**: obtain a source item S (crafted or bought — buying S does
 *   not count S, but everything decomposing it yields does) and decompose it,
 *   and every piece of gear that yields, down to materials. Per S:
 *   cost = own-use cost of S + the chain's coin/catalyst/tea spend, less the
 *   untaxed value of the kept outputs other than the target.
 * - **Shop gear**: the same chain, with S bought from the in-game shop at its
 *   coin price.
 *
 * Nothing here reads the game: the panel builds the routes and hands them in,
 * so every function is pure and the tests drive it with plain objects.
 */

import { pointsFromCount, nextPointCount } from '../../utils/points-from-count.js';

/** The display name of each route */
export const ROUTE_LABELS = { craft: 'Craft', decompose: 'Decompose', shop: 'Shop gear' };

/** The counts past which the ladder stops paying */
const LADDER_CAP = 1e14;

/**
 * The Collections log as a count per item.
 * @param {Array<{itemHrid: string, count: number}>|null} rows - `collections_updated.collections`
 * @returns {Map<string, number>} An item never collected is absent (count 0)
 */
export function collectionCounts(rows) {
    const counts = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.itemHrid) continue;
        const count = Number(row.count);
        counts.set(row.itemHrid, Number.isFinite(count) && count > 0 ? count : 0);
    }
    return counts;
}

/**
 * Total collection points over a count map.
 * @param {Map<string, number>} counts
 * @returns {number}
 */
export function totalCollectionPoints(counts) {
    let total = 0;
    for (const count of counts.values()) total += pointsFromCount(count);
    return total;
}

/**
 * Where one item stands on the ladder, and what its next rung is worth.
 * @param {number} count - Current count (0 when never collected)
 * @returns {{count: number, points: number, threshold: number, needed: number, gain: number}|null}
 *   Null once the ladder has nothing left to pay
 */
export function pointsStep(count) {
    const current = Math.max(0, Number(count) || 0);
    const whole = Math.floor(current + 1e-9);
    if (whole >= LADDER_CAP) return null;
    const threshold = nextPointCount(whole);
    const points = pointsFromCount(whole);
    const gain = pointsFromCount(threshold) - points;
    if (!(gain > 0)) return null;
    return { count: current, points, threshold, needed: threshold - current, gain };
}

/**
 * The collection-points achievements, lowest target first.
 *
 * Read from `achievementDetailMap`: an entry whose hrid names collection
 * points (`/achievements/collection_points_100` beside the measured
 * `bestiary_points_100`) and carries a numeric `target`.
 * @param {Object|null} achievementDetailMap
 * @returns {Array<{hrid: string, name: string, target: number}>}
 */
export function collectionAchievementTargets(achievementDetailMap) {
    const targets = [];
    for (const [key, detail] of Object.entries(achievementDetailMap || {})) {
        const hrid = String(detail?.hrid || key);
        if (!/collection_points/i.test(hrid)) continue;
        const target = Number(detail?.target);
        if (!Number.isFinite(target) || target <= 0) continue;
        targets.push({ hrid, name: detail?.name || hrid.split('/').pop(), target });
    }
    return targets.sort((a, b) => a.target - b.target);
}

/**
 * The next achievement a total has not reached yet.
 * @param {Array<{target: number}>} targets - From {@link collectionAchievementTargets}
 * @param {number} total - Current collection points
 * @returns {Object|null}
 */
export function nextAchievementTarget(targets, total) {
    return (targets || []).find((t) => t.target > total) || null;
}

/**
 * Index routes by the item each can collect.
 *
 * A craft route collects its own item. A decompose or shop route collects
 * every item in its `yields` — the gear in between and the kept outputs.
 * @param {{craft?: Iterable<Object>, sources?: Iterable<Object>}} routes
 *   craft: `{route: 'craft', itemHrid, unitCost, unitSeconds}`;
 *   sources: `{route: 'decompose'|'shop', sourceHrid, cost, seconds, yields: Map, kept: Map}`
 * @returns {Map<string, Array<Object>>}
 */
export function indexRoutes(routes) {
    const byItem = new Map();
    const add = (hrid, route) => {
        if (!byItem.has(hrid)) byItem.set(hrid, []);
        byItem.get(hrid).push(route);
    };
    for (const route of routes?.craft || []) {
        if (route?.itemHrid && Number.isFinite(route.unitCost)) add(route.itemHrid, route);
    }
    for (const route of routes?.sources || []) {
        if (!Number.isFinite(route?.cost) || !(route.yields instanceof Map)) continue;
        for (const [hrid, expected] of route.yields) {
            if (expected > 0) add(hrid, route);
        }
    }
    return byItem;
}

/**
 * One route's option for one item's next rung.
 *
 * Craft: units = needed; gold = units × unitCost; time = units × unitSeconds.
 *
 * Decompose / shop, with y_X the expected units of the target per source item:
 *   sources n = ⌈needed / y_X⌉
 *   gold      = n × (cost − Σ_{Y≠X} kept value of Y)
 *   time      = n × chain seconds
 *   points    = the target's step + Σ_{Y≠X} points the other yields cross
 *
 * @param {string} itemHrid - The target item
 * @param {Map<string, number>} counts - Current counts
 * @param {Object} route - A craft or source route
 * @returns {Object|null} `{itemHrid, route, sourceHrid, from, to, needed, gain, collateral, points,
 *   gold, seconds, goldPerPoint, units, credits: Map}` — `credits` is every count the option adds
 */
export function evaluateOption(itemHrid, counts, route) {
    const step = pointsStep(counts.get(itemHrid) || 0);
    if (!step || !route) return null;
    const base = { itemHrid, route: route.route, from: step.count, to: step.threshold, gain: step.gain };

    if (route.route === 'craft') {
        const units = Math.ceil(step.needed - 1e-9);
        const gold = units * route.unitCost;
        const credits = new Map([[itemHrid, units]]);
        return {
            ...base,
            sourceHrid: null,
            needed: step.needed,
            units,
            collateral: 0,
            points: step.gain,
            gold,
            seconds: units * (Number(route.unitSeconds) || 0),
            goldPerPoint: gold / step.gain,
            credits,
        };
    }

    const perSource = route.yields.get(itemHrid) || 0;
    if (!(perSource > 0)) return null;
    const units = Math.ceil(step.needed / perSource - 1e-9);
    let keptOthers = 0;
    let collateral = 0;
    const credits = new Map();
    for (const [hrid, expected] of route.yields) {
        const added = units * expected;
        credits.set(hrid, added);
        if (hrid === itemHrid) continue;
        keptOthers += Number(route.kept?.get(hrid)) || 0;
        const before = counts.get(hrid) || 0;
        collateral += pointsFromCount(before + added) - pointsFromCount(before);
    }
    const gold = units * (route.cost - keptOthers);
    const points = step.gain + collateral;
    return {
        ...base,
        sourceHrid: route.sourceHrid,
        needed: step.needed,
        units,
        collateral,
        points,
        gold,
        seconds: units * (Number(route.seconds) || 0),
        goldPerPoint: gold / points,
        credits,
    };
}

/**
 * Each item's cheapest next rung, cheapest gold per point first.
 * @param {Map<string, number>} counts
 * @param {Map<string, Array<Object>>} index - From {@link indexRoutes}
 * @returns {Array<Object>} One option per item a route can collect
 */
export function bestOptions(counts, index) {
    const options = [];
    for (const [itemHrid, routes] of index) {
        let best = null;
        for (const route of routes) {
            const option = evaluateOption(itemHrid, counts, route);
            if (!option || !Number.isFinite(option.goldPerPoint)) continue;
            if (!best || option.goldPerPoint < best.goldPerPoint) best = option;
        }
        if (best) options.push(best);
    }
    return options.sort((a, b) => a.goldPerPoint - b.goldPerPoint);
}

/**
 * The cheapest list of rungs found greedily to gain `targetPoints`.
 *
 * Takes the lowest gold-per-point option, credits every count it adds (the
 * target and anything else the route collects), and looks again: the item's
 * next rung is then on offer at its new price. Stops at the target or after
 * `maxSteps`.
 * @param {Map<string, number>} counts - Current counts (not modified)
 * @param {Map<string, Array<Object>>} index - From {@link indexRoutes}
 * @param {number} targetPoints - Points wanted
 * @param {Object} [opts]
 * @param {number} [opts.maxSteps=300]
 * @returns {{steps: Array<Object>, points: number, gold: number, seconds: number, reached: boolean}}
 */
export function planTarget(counts, index, targetPoints, { maxSteps = 300 } = {}) {
    const working = new Map(counts);
    const start = totalCollectionPoints(working);
    const want = Math.max(0, Math.floor(Number(targetPoints) || 0));
    const steps = [];
    let gold = 0;
    let seconds = 0;
    let gained = 0;
    while (gained < want && steps.length < maxSteps) {
        const [pick] = bestOptions(working, index);
        if (!pick) break;
        for (const [hrid, added] of pick.credits) working.set(hrid, (working.get(hrid) || 0) + added);
        gained = totalCollectionPoints(working) - start;
        gold += pick.gold;
        seconds += pick.seconds;
        steps.push(pick);
    }
    return { steps, points: gained, gold, seconds, reached: gained >= want };
}
