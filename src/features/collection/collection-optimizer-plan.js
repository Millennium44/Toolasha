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
 *   cost = S at the ask (or its make cost) + the chain's coin/catalyst/tea spend.
 * - **Shop gear**: the same chain, with S bought from the in-game shop at its
 *   coin price.
 * - **Transmute**: buy S at the ask and transmute it, transmuting again every
 *   copy of S that comes back, so each bought S is 1 / (1 − r) attempts.
 * - **Gather**: run a gathering action, whole actions; nothing goes in but its
 *   teas.
 *
 * Every other output a route yields is sold: it is credited at the bid after
 * the market tax, and only as many units as the market takes in a week
 * (`sellable`); the rest is collected and worth nothing. The target itself is
 * collected, never sold.
 *
 * A source bought on the market (`route.purchase`) is priced for the quantity a
 * step buys, not at the top ask for any quantity: up the ask side of the order
 * book where one has been seen, and never past what the market trades in a week
 * ({@link buyCost}). A step that needs more than that is no option at all: past the visible book a unit
 * has no price, and the option is left out as partly unpriced.
 *
 * Nothing here reads the game: the panel builds the routes and hands them in,
 * so every function is pure and the tests drive it with plain objects.
 */

import { walkForQuantity } from '../../utils/order-book.js';
import { pointsFromCount, nextPointCount } from '../../utils/points-from-count.js';

/** The display name of each route */
export const ROUTE_LABELS = {
    craft: 'Craft',
    decompose: 'Decompose',
    craftDecompose: 'Craft + decompose',
    shop: 'Shop gear',
    transmute: 'Transmute',
    gather: 'Gather',
};

/**
 * The ranking orders. "Cheapest per point" is not one of them: net gold per
 * point is minus the cost per point, so the two orders are the same order
 * whatever the signs.
 */
export const SORT_MODES = {
    profit: 'Most profitable',
    fastest: 'Fastest',
};

/** The order the ranking starts in */
export const DEFAULT_SORT = 'profit';

/**
 * A sort mode, or the default for anything unknown.
 * @param {*} value
 * @returns {string}
 */
export function validSort(value) {
    return typeof value === 'string' && Object.hasOwn(SORT_MODES, value) ? value : DEFAULT_SORT;
}

/**
 * Order two options for a sort mode: most profitable is the lowest gold (cost)
 * per point first; fastest is the least time per point first, ties broken by
 * gold per point.
 * @param {string} sort
 * @returns {(a: Object, b: Object) => number}
 */
export function compareOptions(sort) {
    if (validSort(sort) === 'fastest') {
        return (a, b) => a.secondsPerPoint - b.secondsPerPoint || a.goldPerPoint - b.goldPerPoint;
    }
    return (a, b) => a.goldPerPoint - b.goldPerPoint;
}

/**
 * The alchemy-wide bonus drops. They roll on every alchemy action whatever the
 * item, so "decompose X to collect them" is never a real plan: they are never
 * a route's target, though what a route yields of them still counts toward its
 * points. A route can name more (`route.bonus`, from the calculator's
 * `isEssence` / `isRare` flags); these are the ones known today.
 */
export const ALCHEMY_BONUS_DROPS = new Set([
    '/items/alchemy_essence',
    '/items/small_artisans_crate',
    '/items/medium_artisans_crate',
    '/items/large_artisans_crate',
]);

/** The default cap on one step's time: an option slower than this is left out */
export const DEFAULT_MAX_STEP_SECONDS = 8 * 3600;

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
 * A craft route collects its own item. A source route (decompose, shop,
 * transmute, gather) collects every item in its `yields` — the gear in between
 * and the kept outputs.
 * @param {{craft?: Iterable<Object>, sources?: Iterable<Object>}} routes
 *   craft: `{route: 'craft', itemHrid, unitCost, unitSeconds}`;
 *   sources: `{route, sourceHrid, actionHrid?, cost, seconds, yields: Map, kept: Map, batch?: number,
 *   bonus?: Set}` — per unit of the route (one source item, or one gathering action): `yields` the
 *   expected units of each item collected, `kept` each sold output as `{perSource, unit}` (expected
 *   units and the realized price of one), `bonus` the yields that are bonus drops
 * @returns {Map<string, Array<Object>>}
 */
export function indexRoutes(routes) {
    const byItem = new Map();
    const add = (hrid, route) => {
        if (!byItem.has(hrid)) byItem.set(hrid, []);
        byItem.get(hrid).push(route);
    };
    for (const route of routes?.craft || []) {
        // A bonus drop with no price would count as worth nothing, as it would on a source route
        if (route?.itemHrid && Number.isFinite(route.unitCost) && !route.partlyUnpriced) add(route.itemHrid, route);
    }
    for (const route of routes?.sources || []) {
        if (!Number.isFinite(route?.cost) || !(route.yields instanceof Map)) continue;
        // A kept output with no price would count as worth nothing, under-crediting the route
        // against an exact one; such a route is left out rather than ranked as if exact
        if (route.partlyUnpriced) continue;
        for (const [hrid, expected] of route.yields) {
            // A bonus drop is credited as a by-product, never targeted
            if (ALCHEMY_BONUS_DROPS.has(hrid) || route.bonus?.has?.(hrid)) continue;
            if (expected > 0) add(hrid, route);
        }
    }
    return byItem;
}

/**
 * What buying `units` more of an item costs, after `already` have been bought.
 *
 * The ask side of the book, best first, where one has been seen: each level is
 * taken in turn, never below the current top ask (`ask`), since a book read
 * earlier cannot make buying cheaper than the quote today. Past the depth the
 * book shows, nothing says what the units cost, and they are not guessed at: a
 * buy larger than the visible depth is partly unpriced (`unpriced`), not
 * feasible, and `gold` is NaN. With no book, every unit is at the top ask.
 *
 * With no book, what can be bought at all is bounded by `weekly`, the units the
 * market trades in a week (the bound selling has, from the same measured
 * volume); a buy past it is not feasible. An unmeasured item has no weekly
 * bound. With a book, the visible depth is the bound.
 *
 * @param {number} units - Units this step buys
 * @param {Object} opts
 * @param {number} opts.ask - The top ask now
 * @param {Array<{price: number, quantity: number}>|null} [opts.listings] - Ask side, best first
 * @param {number} [opts.weekly=Infinity] - Units the market trades in a week
 * @param {number} [opts.already=0] - Units earlier steps bought
 * @returns {{gold: number, feasible: boolean, limit: number, fromBook: boolean, unpriced: boolean}} `gold` is NaN
 *   when not feasible; `limit` is the most that can be priced in all; `unpriced` is true when the buy runs
 *   past the visible book
 */
export function buyCost(units, { ask, listings = null, weekly = Infinity, already = 0 } = {}) {
    const top = Number(ask) > 0 ? Number(ask) : 0;
    const before = Math.max(0, Number(already) || 0);
    const total = before + Math.max(0, Number(units) || 0);
    const book = Array.isArray(listings)
        ? listings
              .filter((level) => Number(level?.price) > 0 && Number(level?.quantity) > 0)
              .map((level) => ({ price: Math.max(Number(level.price), top), quantity: Number(level.quantity) }))
        : [];
    const depth = book.reduce((sum, level) => sum + level.quantity, 0);
    const week = Number(weekly);
    const fromBook = book.length > 0;
    // With a book seen, nothing past its depth has a price; with none, the week's volume is the bound
    const limit = fromBook ? depth : Number.isNaN(week) ? Infinity : Math.max(0, week);
    if (total > limit + 1e-9) return { gold: NaN, feasible: false, limit, fromBook, unpriced: fromBook };
    const costOf = (quantity) => {
        if (!(quantity > 0)) return 0;
        if (!fromBook) return quantity * top;
        return walkForQuantity(book, quantity).gold;
    };
    return { gold: costOf(total) - costOf(before), feasible: true, limit, fromBook, unpriced: false };
}

/**
 * One route's option for one item's next rung.
 *
 * Craft: units = ⌈needed / (1 + the target's own bonus copies per unit)⌉ (whole actions); gold = units × unitCost − the bonus drops it rolls, sold (`route.kept`, per item
 * made, bounded by `sellable` like a source route's); time = units × unitSeconds.
 *
 * Source routes, with y_X the expected units of the target per unit of the route:
 *   units n  = ⌈needed / y_X⌉, rounded up to a multiple of `route.batch` (the bulk of one
 *              alchemy action, or the units one shop purchase delivers)
 *   sold Y   = min(n × perSource_Y, sellable(Y))  for every kept Y ≠ X
 *   gold     = n × cost − Σ_{Y≠X} sold Y × unit_Y
 *              (a bought source: its n units priced by `buyQuote` in place of n × its ask)
 *   time     = n × seconds
 *   points   = the target's step + Σ_{Y≠X} points the other yields cross
 *
 * Gold is what the step costs: negative when the sold outputs bring in more
 * than the route spends.
 *
 * @param {string} itemHrid - The target item
 * @param {Map<string, number>} counts - Current counts
 * @param {Object} route - A craft or source route
 * @param {Object} [opts]
 * @param {(hrid: string) => number} [opts.sellable] - Units of an item the market takes; unbounded when absent
 * @param {(purchase: {hrid: string, ask: number}, units: number) => {gold: number, feasible: boolean}} [opts.buyQuote]
 *   What buying a route's source costs ({@link buyCost}); every unit at the ask when absent
 * @returns {Object|null} `{itemHrid, route, sourceHrid, actionHrid, setup, from, to, needed, gain, collateral, points,
 *   gold, seconds, goldPerPoint, secondsPerPoint, units, credits: Map, sold: Map, bought: Map}` — `credits` is
 *   every count the option adds, `sold` the units of each output it sells, `bought` of each source it buys.
 *   Null when the step needs more of a bought source than the market offers
 */
export function evaluateOption(itemHrid, counts, route, { sellable, buyQuote } = {}) {
    const step = pointsStep(counts.get(itemHrid) || 0);
    if (!step || !route) return null;
    const base = { itemHrid, route: route.route, from: step.count, to: step.threshold, gain: step.gain };

    if (route.route === 'craft') {
        // Whole actions only, and every unit an action makes is collected. A bonus drop that is the target
        // itself (a crate that yields the item being made) adds copies to each unit made, as a source
        // route's yield of the target does
        const batch = Math.max(1, Number(route.batch) || 1);
        const bonusCopies = Math.max(0, Number(route.yields?.get(itemHrid)) || 0);
        const perUnit = 1 + bonusCopies;
        const units = Math.ceil(step.needed / perUnit / batch - 1e-9) * batch;
        const before = counts.get(itemHrid) || 0;
        const gain = pointsFromCount(before + units * perUnit) - pointsFromCount(before);
        const seconds = units * (Number(route.unitSeconds) || 0);
        const credits = new Map([[itemHrid, units * perUnit]]);
        // The bonus drops each completion rolls (a skill's essence, an Artisan's Crate): credited toward
        // their own collections, and sold as far as the market takes them
        let collateral = 0;
        for (const [hrid, expected] of route.yields || []) {
            if (hrid === itemHrid) continue;
            const added = units * expected;
            credits.set(hrid, (credits.get(hrid) || 0) + added);
            const have = counts.get(hrid) || 0;
            collateral += pointsFromCount(have + added) - pointsFromCount(have);
        }
        let revenue = 0;
        const sold = new Map();
        for (const [hrid, entry] of route.kept || []) {
            if (hrid === itemHrid) continue;
            const produced = units * (Number(entry?.perSource) || 0);
            const room = sellable ? Number(sellable(hrid)) : Infinity;
            const sellUnits = Math.min(produced, Number.isNaN(room) ? Infinity : Math.max(0, room));
            if (!(sellUnits > 0)) continue;
            sold.set(hrid, sellUnits);
            revenue += sellUnits * (Number(entry?.unit) || 0);
        }
        const gold = units * route.unitCost - revenue;
        const points = gain + collateral;
        return {
            ...base,
            sourceHrid: null,
            actionHrid: route.actionHrid ?? null,
            needed: step.needed,
            units,
            collateral,
            gain,
            points,
            gold,
            seconds,
            goldPerPoint: gold / points,
            secondsPerPoint: seconds / points,
            credits,
            sold,
            bought: new Map(),
        };
    }

    const perSource = route.yields.get(itemHrid) || 0;
    if (!(perSource > 0)) return null;
    // Whole actions (and whole shop bundles): the sources round up to a multiple of the batch, and
    // every one of them is charged and credited
    const batch = Math.max(1, Math.floor(Number(route.batch)) || 1);
    const units = Math.ceil(step.needed / perSource / batch - 1e-9) * batch;
    let collateral = 0;
    const credits = new Map();
    for (const [hrid, expected] of route.yields) {
        const added = units * expected;
        credits.set(hrid, added);
        if (hrid === itemHrid) continue;
        const before = counts.get(hrid) || 0;
        collateral += pointsFromCount(before + added) - pointsFromCount(before);
    }
    // The other outputs are sold, as far as the market takes them; the target is collected, not sold
    let revenue = 0;
    const sold = new Map();
    for (const [hrid, entry] of route.kept || []) {
        if (hrid === itemHrid) continue;
        const produced = units * (Number(entry?.perSource) || 0);
        const room = sellable ? Number(sellable(hrid)) : Infinity;
        const sellUnits = Math.min(produced, Number.isNaN(room) ? Infinity : Math.max(0, room));
        if (!(sellUnits > 0)) continue;
        sold.set(hrid, sellUnits);
        revenue += sellUnits * (Number(entry?.unit) || 0);
    }
    // A bought source at what that many actually cost, in place of the top ask the route was priced at
    let purchaseExtra = 0;
    const bought = new Map();
    const purchase = route.purchase;
    if (purchase?.hrid && Number(purchase.ask) > 0) {
        if (buyQuote) {
            const quote = buyQuote(purchase, units);
            if (quote && !quote.feasible) return null;
            if (quote && Number.isFinite(quote.gold)) purchaseExtra = quote.gold - units * purchase.ask;
        }
        bought.set(purchase.hrid, units);
    }
    const gold = units * route.cost - revenue + purchaseExtra;
    const seconds = units * (Number(route.seconds) || 0);
    // The whole batch counts: a yield of 18 takes an uncollected item past 1 and 10 at once
    const before = counts.get(itemHrid) || 0;
    const targetGain = pointsFromCount(before + units * perSource) - pointsFromCount(before);
    const points = targetGain + collateral;
    return {
        ...base,
        gain: targetGain,
        sourceHrid: route.sourceHrid ?? null,
        actionHrid: route.actionHrid ?? null,
        setup: route.setup ?? null,
        needed: step.needed,
        units,
        collateral,
        points,
        gold,
        seconds,
        goldPerPoint: gold / points,
        secondsPerPoint: seconds / points,
        credits,
        sold,
        bought,
    };
}

/**
 * Each item's best next rung, in the sort's order.
 * @param {Map<string, number>} counts
 * @param {Map<string, Array<Object>>} index - From {@link indexRoutes}
 * @param {Object} [opts]
 * @param {number} [opts.maxSeconds=Infinity] - Leave out any option slower than this
 * @param {(hrid: string) => number} [opts.sellable] - Units of an item the market takes
 * @param {Function} [opts.buyQuote] - What buying a source costs; see {@link evaluateOption}
 * @param {string} [opts.sort='profit'] - A {@link SORT_MODES} key: which route is best per item, and the order
 * @returns {Array<Object>} One option per item a route can collect within the time
 */
export function bestOptions(counts, index, { maxSeconds = Infinity, sellable, buyQuote, sort = DEFAULT_SORT } = {}) {
    const limit = Number(maxSeconds) > 0 ? Number(maxSeconds) : Infinity;
    const compare = compareOptions(sort);
    const options = [];
    for (const [itemHrid, routes] of index) {
        let best = null;
        for (const route of routes) {
            const option = evaluateOption(itemHrid, counts, route, { sellable, buyQuote });
            if (!option || !Number.isFinite(option.goldPerPoint)) continue;
            if (!(option.seconds <= limit)) continue;
            if (!best || compare(option, best) < 0) best = option;
        }
        if (best) options.push(best);
    }
    return options.sort(compare);
}

/**
 * The best list of rungs, in the sort's sense, found greedily to gain
 * `targetPoints`.
 *
 * Takes the first option in the sort's order, credits every count it adds (the
 * target and anything else the route collects), counts what it sells against
 * what the market takes, and looks again: the item's next rung is then on
 * offer at its new price. Stops at the target or after `maxSteps`.
 * @param {Map<string, number>} counts - Current counts (not modified)
 * @param {Map<string, Array<Object>>} index - From {@link indexRoutes}
 * @param {number} targetPoints - Points wanted
 * @param {Object} [opts]
 * @param {number} [opts.maxSteps=300]
 * @param {number} [opts.maxSeconds=Infinity] - Leave out any step slower than this
 * @param {(hrid: string) => number} [opts.sellable] - Units of an item the market takes over the whole plan
 * @param {(purchase: Object, units: number, already: number) => Object} [opts.buyQuote] - What buying a source
 *   costs after `already` units were bought by earlier steps ({@link buyCost})
 * @param {string} [opts.sort='profit'] - A {@link SORT_MODES} key
 * @returns {{steps: Array<Object>, points: number, gold: number, seconds: number, reached: boolean}}
 */
export function planTarget(
    counts,
    index,
    targetPoints,
    { maxSteps = 300, maxSeconds = Infinity, sellable, buyQuote, sort = DEFAULT_SORT } = {}
) {
    const working = new Map(counts);
    const start = totalCollectionPoints(working);
    const want = Math.max(0, Math.floor(Number(targetPoints) || 0));
    // What earlier steps sold leaves less room for later ones
    const soldSoFar = new Map();
    const room = sellable ? (hrid) => Number(sellable(hrid)) - (soldSoFar.get(hrid) || 0) : undefined;
    // And what they bought: a later step buys further up the book, against what is left of the week
    const boughtSoFar = new Map();
    const quote = buyQuote
        ? (purchase, units) => buyQuote(purchase, units, boughtSoFar.get(purchase.hrid) || 0)
        : undefined;
    const steps = [];
    let gold = 0;
    let seconds = 0;
    let gained = 0;
    while (gained < want && steps.length < maxSteps) {
        const [pick] = bestOptions(working, index, { maxSeconds, sellable: room, buyQuote: quote, sort });
        if (!pick) break;
        for (const [hrid, added] of pick.credits) working.set(hrid, (working.get(hrid) || 0) + added);
        for (const [hrid, units] of pick.sold) soldSoFar.set(hrid, (soldSoFar.get(hrid) || 0) + units);
        for (const [hrid, units] of pick.bought) boughtSoFar.set(hrid, (boughtSoFar.get(hrid) || 0) + units);
        gained = totalCollectionPoints(working) - start;
        gold += pick.gold;
        seconds += pick.seconds;
        steps.push(pick);
    }
    return { steps, points: gained, gold, seconds, reached: gained >= want };
}
