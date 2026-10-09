/**
 * Collection Points optimizer.
 *
 * A collapsible panel on Achievements → Collections that ranks the next
 * collection points: per item, the next rung of the points ladder and the best
 * route to it (craft, decompose chain, shop gear decomposed, transmute or
 * gather), by net gold per point or by time per point. A target box plans the
 * best list of rungs to gain "+N points".
 *
 * The counts are the game's own `collections_updated` message, which it sends
 * when the Collections tab is opened; the panel appears once it has arrived.
 * Buying an item on the market does not collect it, so no Buy route exists.
 *
 * The routes are priced once per opening (or on Recompute), off the tooltip
 * hover path, and kept for the session; ranking against the counts is cheap
 * and redone whenever the counts arrive again. The arithmetic is in
 * collection-optimizer-plan.js.
 *
 * Prices: a bought source up the ask side of its order book where one has been
 * seen (else at the top ask), and no more of it than the market trades in a
 * week; everything a route yields besides the target is sold, at the bid after
 * the market tax (no live bid: worth nothing), and only as many units as the
 * market takes in a week — the shared liquidity bound, from volumes already
 * measured.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import profitCalculator from '../market/profit-calculator.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { ownUseCompare } from '../market/tooltip-prices.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { capProfitRateCached, hasMeasuredVolume, prefetchLiquidity } from '../../utils/liquidity-cap.js';
import { LIQUIDITY_HORIZON_DAYS } from '../planner/market-liquidity.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { getShopCoinOnlyCost } from '../../utils/game-lookups.js';
import { canStartAction } from '../../utils/efficiency.js';
import { resolveActionContext } from '../../utils/action-context.js';
import { GATHERING_TYPES } from '../../utils/profit-constants.js';
import { getDrinkConcentration, parseTeaSkillLevelBonus } from '../../utils/tea-parser.js';
import { formatKMB, timeReadable } from '../../utils/formatters.js';
import { alchemyRunBasis, selfUseDecomposeChain, untaxedContainerValue } from '../../utils/self-use-alchemy.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { yieldToBrowser } from '../../utils/yield-to-browser.js';
import { estimatedListingAge } from '../../utils/bundle-bridge.js';
import {
    DEFAULT_MAX_STEP_SECONDS,
    DEFAULT_SORT,
    ROUTE_LABELS,
    SORT_MODES,
    bestOptions,
    buyCost,
    collectionAchievementTargets,
    collectionCounts,
    indexRoutes,
    nextAchievementTarget,
    planTarget,
    totalCollectionPoints,
    validSort,
} from './collection-optimizer-plan.js';

/** The setting that turns the panel on */
export const SETTING_KEY = 'collectionOptimizer';

/** The panel's root class */
const PANEL_CLASS = 'toolasha-collopt';

/** Where the max-time-per-step choice is kept, per character */
const MAX_STEP_KEY = 'collectionOptimizerMaxStepHours';
const MAX_STEP_STORE = 'collections';

/** Where the ranking order is kept, per character, beside the max time per step */
const SORT_KEY = 'collectionOptimizerSort';

/** The default max time per step, in hours */
const DEFAULT_MAX_STEP_HOURS = DEFAULT_MAX_STEP_SECONDS / 3600;

/**
 * A max-time-per-step value in hours: positive and finite, else the default.
 * @param {*} value
 * @returns {number}
 */
function validHours(value) {
    const hours = Number(value);
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MAX_STEP_HOURS;
}

/** Rows shown in the ranking */
const MAX_ROWS = 40;

/** Milliseconds of route pricing between yields to the browser */
const SLICE_MS = 12;

/** Coins: money, not an item to sell or collect */
const COIN_HRID = '/items/coin';

/** Items that are never a collection entry */
const SKIP_ITEMS = new Set([COIN_HRID]);

/**
 * What selling one unit of an output realizes: the live bid after the market
 * tax (an Iron Cow's own valuation, untaxed, since it never uses the market).
 *
 * A bid that is only a value-map estimate means nobody is bidding, so the unit
 * realizes nothing — except a container, which is then worth its contents
 * (null here sends the caller to the container's value).
 * @param {string} hrid
 * @param {(hrid: string) => boolean} isContainer
 * @returns {number|null} Null when the item has no price at all
 */
export function realizedSalePrice(hrid, isContainer = () => false) {
    const info = getItemPriceInfo(hrid, { mode: 'bid' });
    if (!info || info.price === null || info.price === undefined) return null;
    if (info.estimated) return isContainer(hrid) ? null : 0;
    return calculatePriceAfterTax(info.price);
}

/**
 * How many units of an item the market takes from one character in a week:
 * the shared liquidity bound ({@link capProfitRateCached}: a quarter of the
 * measured daily volume) over the planner's horizon. Only volumes already
 * measured count, so nothing here starts a lookup; an unmeasured item, the
 * liquidity cap switched off, or an Iron Cow (which sells to the vendor) is
 * unbounded.
 * @param {string} hrid
 * @returns {number}
 */
export function weeklySellable(hrid) {
    if (isIronCowCharacter()) return Infinity;
    // A rate far past any market: the throttle that comes back is then the absorbable rate over it
    const probe = 1e12;
    const bounded = capProfitRateCached({ goldPerHour: 1, sells: [{ itemHrid: hrid, unitsPerHour: probe }] });
    if (!bounded?.capped) return Infinity;
    return Math.max(0, Number(bounded.limit?.throttle) || 0) * probe * 24 * LIQUIDITY_HORIZON_DAYS;
}

/** How old a cached order book may be and still say what buying costs */
const BOOK_MAX_AGE_MS = 6 * 3600 * 1000;

/**
 * The ask side of an item's order book, from the listing tracker's cache of
 * books the player has opened in the marketplace (the one cache of whole books;
 * the guild credit advisor reads it the same way). Null when no book was seen
 * in the last {@link BOOK_MAX_AGE_MS}.
 * @param {string} hrid
 * @returns {Array<{price: number, quantity: number}>|null} Listings, best first
 */
function cachedAsks(hrid) {
    try {
        const side = estimatedListingAge()?.cachedBookSide?.(hrid, 0, true);
        if (!side || !(Date.now() - (Number(side.lastUpdated) || 0) <= BOOK_MAX_AGE_MS)) return null;
        return side.listings;
    } catch (error) {
        console.error('[CollectionOptimizer] Reading a cached order book failed:', error);
        return null;
    }
}

/**
 * What buying a quantity of a route's source costs ({@link buyCost}): up the
 * cached book from the route's ask, and no more than a week's traded volume
 * ({@link weeklySellable} — the same measured bound as selling, either way a
 * quarter of what trades).
 * @param {{hrid: string, ask: number}} purchase - The source and the ask the route was priced at
 * @param {number} units
 * @param {number} [already=0] - Units earlier steps of a plan bought
 * @returns {{gold: number, feasible: boolean, limit: number, fromBook: boolean}}
 */
export function buyQuote(purchase, units, already = 0) {
    return createBuyQuote()(purchase, units, already);
}

/**
 * {@link buyQuote} for one ranking or plan: each source's book and weekly volume
 * are read once, not once per option the ranking weighs.
 * @returns {(purchase: {hrid: string, ask: number}, units: number, already?: number) => Object}
 */
export function createBuyQuote() {
    const markets = new Map();
    return (purchase, units, already = 0) => {
        if (!markets.has(purchase.hrid)) {
            markets.set(purchase.hrid, {
                listings: cachedAsks(purchase.hrid),
                weekly: weeklySellable(purchase.hrid),
            });
        }
        return buyCost(units, { ask: purchase.ask, ...markets.get(purchase.hrid), already });
    };
}

/**
 * Transmuting a bought item S, and every copy of S that comes back, as a route.
 *
 * Everything alchemy-specific is the calculator's ({@link alchemyRunBasis}):
 * success rate, actions per hour, bulk, coin, catalyst and tea. The input is
 * consumed on every attempt, success or not, as the calculator charges it; the
 * drop table is read from the game data, as the self-use helpers do. Per S
 * transmuted, with r the expected copies of S back:
 *   drop Y    = avg(min, max) × dropRate × successRate
 *   attempts  = 1 / (1 − r) per S bought — the copies that come back are transmuted again,
 *               and each counts toward S's collection as it arrives
 *   yields Y  = drop Y × attempts  (S itself: r × attempts)
 *   cost      = ask(S) + attempts × (coin + catalyst + tea) per attempt
 *   seconds   = attempts × 3600 / (actionsPerHour × bulk)
 * Every drop but S is sold ({@link realizedSalePrice}), a crate nobody bids on as
 * its contents ({@link saleParts}); one with no price at all leaves the route
 * partly unpriced, and out of the ranking.
 *
 * @param {string} sourceHrid - S
 * @param {Object|null} result - `calculateTransmuteProfit(S)`
 * @param {Array<Object>|null} table - S's `alchemyDetail.transmuteDropTable`
 * @param {Object} opts
 * @param {number} opts.buy - What one S costs
 * @param {(hrid: string) => Array<{itemHrid: string, units: number, unit: number}>|null} opts.sell - What
 *   selling one unit of an output comes to, item by item ({@link saleParts})
 * @returns {Object|null} A source route, or null when the transmute cannot run
 */
export function transmuteRoute(sourceHrid, result, table, { buy, sell: sellParts }) {
    const basis = alchemyRunBasis(result);
    if (!basis || !Array.isArray(table) || !(buy > 0)) return null;
    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    // Outputs scale with bulk exactly as the input does, so per input unit it cancels
    const unitsPerHour = actionsPerHour * bulk;
    const perAttempt = new Map();
    for (const drop of table) {
        const average = ((Number(drop?.minCount) || 0) + (Number(drop?.maxCount) || 0)) / 2;
        const expected = average * (Number(drop?.dropRate) || 0) * successRate;
        if (drop?.itemHrid && expected > 0) {
            perAttempt.set(drop.itemHrid, (perAttempt.get(drop.itemHrid) || 0) + expected);
        }
    }
    const back = perAttempt.get(sourceHrid) || 0;
    if (!(back < 1)) return null;
    const attempts = 1 / (1 - back);

    const yields = new Map();
    const sink = saleSink();
    const bonus = new Set();
    let partlyUnpriced = false;
    const sell = (hrid, perSource, isBonus = false) => {
        if (!sink.add(sellParts(hrid), perSource, isBonus)) partlyUnpriced = true;
    };
    for (const [hrid, expected] of perAttempt) {
        if (SKIP_ITEMS.has(hrid)) continue;
        yields.set(hrid, expected * attempts);
        if (hrid !== sourceHrid) sell(hrid, expected * attempts);
    }
    // The alchemy-wide bonus drops each attempt rolls: credited and sold, never a target
    for (const drop of result?.dropRevenues || []) {
        if (!drop?.itemHrid || !(drop.isEssence || drop.isRare)) continue;
        const perSource = ((Number(drop.dropsPerHour) || 0) / unitsPerHour) * attempts;
        if (!(perSource > 0)) continue;
        yields.set(drop.itemHrid, (yields.get(drop.itemHrid) || 0) + perSource);
        bonus.add(drop.itemHrid);
        sell(drop.itemHrid, perSource, true);
    }
    if (yields.size === 0) return null;
    // A crate opened to sell its contents acquired them: they count toward their own collections
    creditOpened(sink, yields, bonus);
    const kept = sink.kept;
    return {
        route: 'transmute',
        sourceHrid,
        batch: bulk,
        // Coins a crate opened on the way pays back come off what the route costs
        cost: buy + (attempts * overheadPerHour) / unitsPerHour - sink.coins,
        purchase: { hrid: sourceHrid, ask: buy },
        seconds: (attempts * 3600) / unitsPerHour,
        yields,
        kept,
        bonus,
        partlyUnpriced,
    };
}

/**
 * Every catalyst/tea setup for transmuting S, each as its own route.
 *
 * The calculator's own pick (`calculateTransmuteProfit`) is the setup with the
 * best taxed profit per hour under the profit pricing mode, with every output
 * sold however much of it there is. The optimizer pays the ask, sells at the
 * bid within a week's volume and ranks by gold (or time) per point, so that
 * pick can be the wrong setup here. Each candidate the calculator weighs
 * (`calculateCandidateResults`) is offered instead, and the ranking chooses
 * among them per target item and per sort, with its own prices and caps — the
 * same comparison it already makes between routes. A setup that comes out the
 * same as another (no tea to drink, say) is offered once.
 * @param {string} sourceHrid - S
 * @param {Array<Object>} table - S's `alchemyDetail.transmuteDropTable`
 * @param {Object} opts - {@link transmuteRoute}'s
 * @returns {Array<Object>} Source routes, each carrying its `setup`
 */
export function transmuteSetups(sourceHrid, table, opts) {
    const listed = alchemyProfitCalculator.calculateCandidateResults?.('transmute', sourceHrid) ?? [];
    const candidates = listed.length > 0 ? listed : [alchemyProfitCalculator.calculateTransmuteProfit(sourceHrid)];
    const routes = [];
    const seen = new Set();
    for (const result of candidates) {
        const route = result ? transmuteRoute(sourceHrid, result, table, opts) : null;
        if (!route) continue;
        const key = `${route.cost}|${route.seconds}|${[...route.yields].join(';')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        route.setup = { catalystHrid: result.winningCatalystHrid ?? null, tea: Boolean(result.winningTeaUsed) };
        routes.push(route);
    }
    return routes;
}

/**
 * Running a gathering action as a route, one action at a time.
 *
 * Everything is the gathering calculator's (`calculateGatheringProfit`): its
 * drop table per hour (gathering quantity and efficiency in), the Processing
 * conversions, the essence and rare-find drops, and the tea spend. Per action,
 * with A = actions per hour (efficiency repeats are free, so an action's time
 * is 3600 / A):
 *   yields Y  = itemsPerHour_Y / A, less the raw units Processing turns into its
 *               processed item, which is credited instead (the planner's netting)
 *   bonus Y   = dropsPerHour_Y / A × efficiencyMultiplier
 *   cost      = drink spend per hour / A
 * Every drop but the target is sold ({@link realizedSalePrice}), a crate nobody
 * bids on as its contents ({@link saleParts}); a drop or tea with no price at all
 * leaves the route out of the ranking.
 *
 * @param {string} actionHrid
 * @param {Object|null} profit - `calculateGatheringProfit(actionHrid)`
 * @param {Object} opts
 * @param {(hrid: string) => Array<{itemHrid: string, units: number, unit: number}>|null} opts.sell - What
 *   selling one unit of an output comes to, item by item ({@link saleParts})
 * @returns {Object|null} A source route, or null when the action has no rate
 */
export function gatherRoute(actionHrid, profit, { sell }) {
    const perHour = Number(profit?.actionsPerHour);
    if (!(perHour > 0)) return null;
    const efficiency = Number(profit.efficiencyMultiplier) > 0 ? Number(profit.efficiencyMultiplier) : 1;
    const yields = new Map();
    const add = (hrid, units) => {
        if (!hrid || SKIP_ITEMS.has(hrid) || !Number.isFinite(units)) return;
        yields.set(hrid, (yields.get(hrid) || 0) + units);
    };
    for (const output of profit.baseOutputs || []) add(output?.itemHrid, (Number(output?.itemsPerHour) || 0) / perHour);
    for (const conversion of profit.processingConversions || []) {
        add(conversion?.rawItemHrid, -(Number(conversion?.rawConsumedPerHour) || 0) / perHour);
        add(conversion?.processedItemHrid, (Number(conversion?.conversionsPerHour) || 0) / perHour);
    }
    const bonus = new Set();
    for (const drop of profit.bonusRevenue?.bonusDrops || []) {
        if (!drop?.itemHrid) continue;
        add(drop.itemHrid, ((Number(drop.dropsPerHour) || 0) / perHour) * efficiency);
        bonus.add(drop.itemHrid);
    }
    for (const [hrid, units] of yields) if (!(units > 0)) yields.delete(hrid);
    if (yields.size === 0) return null;

    const sink = saleSink();
    let partlyUnpriced = (profit.drinkCosts || []).some((drink) => drink?.missingPrice);
    for (const [hrid, units] of yields) {
        if (!sink.add(sell(hrid), units, bonus.has(hrid))) partlyUnpriced = true;
    }
    // A crate opened to sell its contents acquired them: they count toward their own collections
    creditOpened(sink, yields, bonus);
    const kept = sink.kept;
    return {
        route: 'gather',
        sourceHrid: null,
        actionHrid,
        batch: 1,
        cost: (Number(profit.drinkCostPerHour) || 0) / perHour - sink.coins,
        seconds: 3600 / perHour,
        yields,
        kept,
        bonus,
        partlyUnpriced,
    };
}

/**
 * What selling one unit of an output comes to, item by item.
 *
 * An item with a sale price ({@link realizedSalePrice}) is sold as itself. A
 * container nobody bids on is opened and each content sold as itself, so every
 * content carries its own bid, tax and market-volume bound: the unopened
 * crate's volume says nothing about how much of its contents the market takes.
 * A content that is itself such a container is opened too.
 *
 * Opening acquires what comes out, and an item looted that way counts toward
 * its collection whether it is then sold or not: every content is marked
 * `acquired`, and a nested crate opened on the way is listed as acquired with
 * no sale (`unit: null`). Coins come out at face value (`unit: 1`): no tax, no
 * market to bound them, and not a collection entry, so never `acquired`.
 * @param {string} hrid
 * @param {Object} deps
 * @param {(hrid: string) => number|null} deps.saleOf - What selling one unit realizes; null when it has no price
 * @param {(hrid: string) => Array|null} deps.containerDrops - `openableLootDropMap[hrid]`
 * @param {Set<string>} [path] - Recursion guard
 * @returns {Array<{itemHrid: string, units: number, unit: number|null, acquired: boolean}>|null} Units of
 *   each item per unit of `hrid`, the price one sells for (null: not sold), and whether opening acquired
 *   it; null when any part has no price (or a crate opens into itself)
 */
export function saleParts(hrid, { saleOf, containerDrops }, path = new Set()) {
    const sale = saleOf(hrid);
    if (sale !== null && sale !== undefined) return [{ itemHrid: hrid, units: 1, unit: sale, acquired: false }];
    const table = containerDrops(hrid);
    if (!Array.isArray(table) || table.length === 0 || path.has(hrid)) return null;
    const inner = new Set([...path, hrid]);
    const parts = new Map();
    const add = (itemHrid, units, unit) => {
        const entry = parts.get(itemHrid) || { itemHrid, units: 0, unit, acquired: true };
        entry.units += units;
        parts.set(itemHrid, entry);
    };
    for (const drop of table) {
        const average = ((Number(drop?.minCount) || 0) + (Number(drop?.maxCount) || 0)) / 2;
        const expected = (Number(drop?.dropRate) || 0) * average;
        if (!drop?.itemHrid || !(expected > 0)) continue;
        if (drop.itemHrid === COIN_HRID) {
            const coins = parts.get(COIN_HRID) || { itemHrid: COIN_HRID, units: 0, unit: 1, acquired: false };
            coins.units += expected;
            parts.set(COIN_HRID, coins);
            continue;
        }
        const nested = saleParts(drop.itemHrid, { saleOf, containerDrops }, inner);
        if (!nested) return null;
        // A content opened in turn: it was acquired too, and is not sold
        if (!(nested.length === 1 && nested[0].itemHrid === drop.itemHrid)) add(drop.itemHrid, expected, null);
        for (const part of nested) {
            if (part.itemHrid === COIN_HRID) {
                const coins = parts.get(COIN_HRID) || { ...part, units: 0 };
                coins.units += expected * part.units;
                parts.set(COIN_HRID, coins);
            } else {
                add(part.itemHrid, expected * part.units, part.unit);
            }
        }
    }
    return parts.size > 0 ? [...parts.values()] : null;
}

/**
 * What a route's outputs come to as they are sold, and what opening crates on
 * the way acquires.
 *
 * `add` takes {@link saleParts} for `perSource` units of one output: what is
 * sold goes into `kept` (`{perSource, unit}`), what opening acquired into
 * `acquired` — or `bonusAcquired` for the contents of a bonus drop, which, like
 * the drop, are credited but never targeted. Coins opened are `coins`, gold
 * per source at face value.
 * @returns {{kept: Map, acquired: Map, bonusAcquired: Map, coins: number, add: Function}}
 */
function saleSink() {
    const kept = new Map();
    const acquired = new Map();
    const bonusAcquired = new Map();
    const sink = { kept, acquired, bonusAcquired, coins: 0 };
    /**
     * @param {Array<Object>|null} parts - From {@link saleParts}
     * @param {number} perSource - Units of the output per unit of the route
     * @param {boolean} [bonus=false] - The output is a bonus drop
     * @returns {boolean} False when the output has no price
     */
    const add = (parts, perSource, bonus = false) => {
        if (!parts) return false;
        for (const { itemHrid, units, unit, acquired: opened } of parts) {
            const added = perSource * units;
            if (!(added > 0)) continue;
            if (itemHrid === COIN_HRID) {
                sink.coins += added * unit;
                continue;
            }
            if (unit !== null && unit !== undefined) {
                kept.set(itemHrid, { perSource: (kept.get(itemHrid)?.perSource || 0) + added, unit });
            }
            if (opened) {
                const into = bonus ? bonusAcquired : acquired;
                into.set(itemHrid, (into.get(itemHrid) || 0) + added);
            }
        }
        return true;
    };
    sink.add = add;
    return sink;
}

/**
 * Credit what opening crates acquired to a route's yields. Contents of a
 * bonus drop join the route's bonus set unless the route yields them anyway.
 * @param {{acquired: Map, bonusAcquired: Map}} sink - From {@link saleSink}
 * @param {Map<string, number>} yields - Changed in place
 * @param {Set<string>} bonus - Changed in place
 */
function creditOpened(sink, yields, bonus) {
    for (const [hrid, units] of sink.acquired) yields.set(hrid, (yields.get(hrid) || 0) + units);
    for (const [hrid, units] of sink.bonusAcquired) {
        const regular = yields.has(hrid) && !bonus.has(hrid);
        yields.set(hrid, (yields.get(hrid) || 0) + units);
        if (!regular) bonus.add(hrid);
    }
}

/**
 * What a decompose chain's terminals come to as they are sold, per source.
 * @param {Iterable<{itemHrid: string, expected: number, value: number|null}>} terminals
 * @param {(hrid: string) => Array<Object>|null} sell - {@link saleParts}
 * @param {Set<string>} bonus - The chain's bonus drops
 * @returns {{kept: Map, acquired: Map, bonusAcquired: Map}} From {@link saleSink}
 */
function soldFromTerminals(terminals, sell, bonus) {
    const sink = saleSink();
    for (const { itemHrid, expected, value } of terminals) {
        // A terminal the chain could not price is already marked on the chain, and left out here
        if (value === null || value === undefined || !(expected > 0)) continue;
        sink.add(sell(itemHrid), expected, bonus.has(itemHrid));
    }
    return sink;
}

/**
 * Price every route the game data allows, for the current character's bench.
 *
 * Craft: per item with a production action, the own-use make cost
 * ({@link ownUseCompare}: materials and teas at the buy side per item made)
 * and 3600 / items made per hour.
 *
 * Decompose / shop: per item with decompose outputs, the full chain under each
 * catalyst/tea setup the calculator weighs (one route apiece, like transmute;
 * the ranking picks) with an input cost of 0
 * ({@link selfUseDecomposeChain}), its outputs valued at what selling them
 * realizes ({@link realizedSalePrice}), so one walk serves every way of getting
 * the item: bought at the ask, made at the bench, or bought at the shop.
 *
 * @param {Object} [opts]
 * @param {() => boolean} [opts.cancelled] - Stops the build when it turns true
 * @returns {Promise<{craft: Array<Object>, sources: Array<Object>}|null>} Null when cancelled
 */
export async function buildCollectionRoutes({ cancelled = () => false } = {}) {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const getItemDetails = (hrid) => itemDetailMap[hrid] || dataManager.getItemDetails?.(hrid) || null;
    // What a source can actually be bought for: the live ask (or the player's own price) — not a
    // patient bid, whatever the pricing mode, for a buy of hundreds — never the value-map estimate an
    // empty book falls back to, and nothing on an Iron Cow, which cannot use the market at all
    const ironCow = isIronCowCharacter();
    const buyableQuote = (hrid) => {
        if (ironCow) return null;
        const info = getItemPriceInfo(hrid, { mode: 'ask', side: 'buy', marketQuote: true });
        if (!info || info.estimated || !['book', 'custom'].includes(info.source)) return null;
        return info.price > 0 ? info.price : null;
    };

    const craft = [];
    /** Each item's recipes that survive {@link undominatedRecipes}: `{cost, seconds}` per item made */
    const makes = new Map();
    // Yield by elapsed time, not item count: scheduler.yield where the browser has it, which a
    // background tab does not stall the way it does a setTimeout(0) chain
    let sliceStart = performance.now();
    const pause = async () => {
        if (performance.now() - sliceStart <= SLICE_MS) return false;
        await yieldToBrowser();
        sliceStart = performance.now();
        return cancelled();
    };
    for (const hrid of Object.keys(itemDetailMap)) {
        if (SKIP_ITEMS.has(hrid) || !profitCalculator.findProductionAction?.(hrid)) continue;
        if (await pause()) return null;
        try {
            const preferred = await profitCalculator.calculateProfit(hrid);
            if (!preferred) continue;
            // The calculator picks the best-margin recipe without asking whether the character can
            // start it; a locked pick must not hide another recipe for the same item that is open.
            // An Action Level tea raises the requirement, which canStartAction counts
            const startable = (data) =>
                canStartAction({
                    requiredLevel: data.baseRequirement,
                    skillLevel: data.skillLevel,
                    teaSkillLevelBonus: data.teaSkillLevelBonus,
                    actionLevelBonus: data.actionLevelBonus,
                });
            const recipes = [preferred];
            for (const actionHrid of preferred.productionCandidates || []) {
                if (actionHrid === preferred.actionHrid) continue;
                const alternative = await profitCalculator.calculateProfit(hrid, { actionHrid });
                if (alternative) recipes.push(alternative);
            }
            const viable = [];
            for (const data of recipes) {
                if (!startable(data)) continue;
                const details = dataManager.getActionDetails?.(data.actionHrid) ?? null;
                const comparison = ownUseCompare(data, details);
                const perHour = Number(data.totalItemsPerHour);
                if (!comparison || !(perHour > 0) || !Number.isFinite(comparison.make)) continue;
                // One action makes a whole batch: 15 of an item made 15 at a time is one action, not
                // 1/15. Gourmet adds expected copies from the same inputs, counted as profitData counts
                const gourmet = Math.max(0, Number(data.gourmetBonus) || 0);
                const batch = Math.max(1, (Number(details?.outputItems?.[0]?.count) || 1) * (1 + gourmet));
                viable.push({ actionHrid: data.actionHrid, cost: comparison.make, seconds: 3600 / perHour, batch });
            }
            // Every recipe is its own route, so each sort weighs it on its own terms: the cheapest
            // and the fastest can be different recipes
            const kept = undominatedRecipes(viable);
            if (kept.length === 0) continue;
            makes.set(hrid, kept);
            for (const recipe of kept) {
                craft.push({
                    route: 'craft',
                    itemHrid: hrid,
                    actionHrid: recipe.actionHrid,
                    unitCost: recipe.cost,
                    unitSeconds: recipe.seconds,
                    batch: recipe.batch,
                });
            }
        } catch (error) {
            console.error('[CollectionOptimizer] Craft route failed for', hrid, error);
        }
    }
    if (cancelled()) return null;

    const decomposeResults = new Map();
    const getDecompose = (hrid) => {
        if (!decomposeResults.has(hrid)) {
            let result = null;
            try {
                result = alchemyProfitCalculator.calculateDecomposeProfit(hrid) ?? null;
            } catch (error) {
                console.error('[CollectionOptimizer] Decompose failed for', hrid, error);
            }
            decomposeResults.set(hrid, result);
        }
        return decomposeResults.get(hrid);
    };
    // Every catalyst/tea setup the calculator weighs for a decompose, not only its single pick: the
    // optimizer pays the ask and ranks by gold (or time) per point, so the best taxed profit per hour
    // can be the wrong setup here. Each setup is its own route (the way {@link transmuteSetups} offers
    // transmutes); the steps below the top item run under the same setup where the calculator lists it
    const candidateLists = new Map();
    const candidatesOf = (hrid) => {
        if (!candidateLists.has(hrid)) {
            let list = [];
            try {
                list = alchemyProfitCalculator.calculateCandidateResults?.('decompose', hrid) ?? [];
            } catch (error) {
                console.error('[CollectionOptimizer] Decompose setups failed for', hrid, error);
            }
            candidateLists.set(hrid, list);
        }
        return candidateLists.get(hrid);
    };
    const sameSetup = (a, b) =>
        (a?.winningCatalystHrid ?? null) === (b?.winningCatalystHrid ?? null) &&
        Boolean(a?.winningTeaUsed) === Boolean(b?.winningTeaUsed);
    const decomposeVariants = (topHrid) => {
        const listed = candidatesOf(topHrid);
        if (listed.length === 0) return [{ get: getDecompose, setup: null }];
        return listed.map((top) => ({
            get: (hrid) =>
                hrid === topHrid ? top : (candidatesOf(hrid).find((r) => sameSetup(r, top)) ?? getDecompose(hrid)),
            setup: { catalystHrid: top.winningCatalystHrid ?? null, tea: Boolean(top.winningTeaUsed) },
        }));
    };
    const isChainable = (hrid) => {
        const details = getItemDetails(hrid);
        return Boolean(details?.equipmentDetail && details.alchemyDetail?.decomposeItems?.length);
    };

    // Every output a route yields besides its target is sold. A crate nobody bids on is opened and
    // its contents sold
    const containerDrops = (h) => dataManager.getInitClientData?.()?.openableLootDropMap?.[h] ?? null;
    const isContainer = (h) => Array.isArray(containerDrops(h)) && containerDrops(h).length > 0;
    const salePrices = new Map();
    const saleOf = (hrid) => {
        // Coins are worth their face, untaxed
        if (hrid === COIN_HRID) return 1;
        if (!salePrices.has(hrid)) salePrices.set(hrid, realizedSalePrice(hrid, isContainer));
        return salePrices.get(hrid);
    };
    const sales = new Map();
    const sell = (hrid) => {
        if (!sales.has(hrid)) sales.set(hrid, saleParts(hrid, { saleOf, containerDrops }));
        return sales.get(hrid);
    };
    const crateValues = new Map();
    const containerValue = (hrid) => {
        if (!crateValues.has(hrid)) {
            crateValues.set(hrid, untaxedContainerValue(hrid, { containerDrops, priceOf: saleOf }));
        }
        return crateValues.get(hrid);
    };

    const sources = [];
    for (const [hrid, details] of Object.entries(itemDetailMap)) {
        if (!details?.alchemyDetail?.decomposeItems?.length) continue;
        if (await pause()) return null;
        const seenChains = new Set();
        for (const variant of decomposeVariants(hrid)) {
            const chain = selfUseDecomposeChain(hrid, {
                getDecompose: variant.get,
                getItemDetails,
                isChainable,
                priceOf: saleOf,
                ownUseCost: 0,
                containerValue,
            });
            if (!chain) continue;
            // A setup that comes out the same as another (no tea to drink, say) is offered once
            const fingerprint = [
                chain.seconds,
                chain.overheadCost,
                chain.partlyUnpriced,
                ...[...chain.collected, ...chain.terminals].map((t) => `${t.itemHrid}:${t.expected}:${t.value}`),
            ].join('|');
            if (seenChains.has(fingerprint)) continue;
            seenChains.add(fingerprint);

            // A piece cut short by a cycle is listed as gear and as kept; it is one piece
            const yields = new Map();
            for (const { itemHrid, expected } of [...chain.collected, ...chain.terminals]) {
                if (SKIP_ITEMS.has(itemHrid) || !(expected > 0)) continue;
                yields.set(itemHrid, Math.max(yields.get(itemHrid) || 0, expected));
            }
            if (yields.size === 0) continue;
            // The alchemy-wide bonus drops each step rolls: credited, never a target
            const bonus = new Set();
            for (const step of chain.steps) {
                for (const drop of variant.get(step.itemHrid)?.dropRevenues || []) {
                    if (drop?.itemHrid && (drop.isEssence || drop.isRare)) bonus.add(drop.itemHrid);
                }
            }
            const sold = soldFromTerminals(chain.terminals, sell, bonus);
            // A crate opened to sell its contents acquired them: they count toward their own collections
            creditOpened(sold, yields, bonus);
            const kept = sold.kept;
            // Coins a crate opened on the way pays back come off every way of running the chain
            const overheadCost = chain.overheadCost - sold.coins;
            // One alchemy action eats `bulkMultiplier` sources, whole
            const bulk = Math.max(1, Math.floor(Number(details.alchemyDetail.bulkMultiplier)) || 1);
            const shared = {
                sourceHrid: hrid,
                batch: bulk,
                seconds: chain.seconds,
                yields,
                kept,
                bonus,
                partlyUnpriced: chain.partlyUnpriced,
                ...(variant.setup ? { setup: variant.setup } : {}),
            };

            // Bought sources are not collected; a crafted one is, and its making takes time — two
            // routes, each priced and timed for how the source is actually got
            const buy = buyableQuote(hrid);
            if (buy > 0) {
                sources.push({
                    ...shared,
                    route: 'decompose',
                    cost: buy + overheadCost,
                    purchase: { hrid, ask: buy },
                });
            }
            for (const recipe of makes.get(hrid) || []) {
                if (!(recipe.cost > 0)) continue;
                const withSource = new Map(yields);
                withSource.set(hrid, (withSource.get(hrid) || 0) + 1);
                sources.push({
                    ...shared,
                    route: 'craftDecompose',
                    actionHrid: recipe.actionHrid,
                    // Whole craft actions feeding whole decompose actions: the smallest run that is both
                    batch: leastCommonMultiple(Math.max(1, Math.floor(recipe.batch) || 1), bulk),
                    yields: withSource,
                    cost: recipe.cost + overheadCost,
                    seconds: chain.seconds + recipe.seconds,
                });
            }
            // A bundle is bought whole and decomposed in whole actions: the smallest run that is both
            const offer = getShopCoinOnlyCost(hrid);
            if (offer?.coins > 0) {
                const units = Math.max(1, Math.floor(Number(offer.units)) || 1);
                sources.push({
                    ...shared,
                    route: 'shop',
                    batch: leastCommonMultiple(units, bulk),
                    cost: offer.coins / units + overheadCost,
                });
            }
        }
    }
    if (cancelled()) return null;

    // Transmute: buy S at the ask and transmute it until nothing of it is left
    for (const [hrid, details] of Object.entries(itemDetailMap)) {
        const table = details?.alchemyDetail?.transmuteDropTable;
        if (!Array.isArray(table) || !(Number(details.alchemyDetail.transmuteSuccessRate) > 0)) continue;
        if (SKIP_ITEMS.has(hrid)) continue;
        if (await pause()) return null;
        const buy = buyableQuote(hrid);
        if (!(buy > 0)) continue;
        try {
            sources.push(...transmuteSetups(hrid, table, { buy, sell }));
        } catch (error) {
            console.error('[CollectionOptimizer] Transmute route failed for', hrid, error);
        }
    }
    if (cancelled()) return null;

    // Gather: run a gathering action the character can start
    const actionDetailMap = dataManager.getInitClientData?.()?.actionDetailMap || {};
    const levels = new Map((dataManager.getSkills?.() || []).map((skill) => [skill.skillHrid, skill.level]));
    const canGather = (action) => {
        const requirement = action.levelRequirement;
        if (!requirement?.skillHrid) return true;
        // The context the gathering calculator prices the action under: the loadout snapshot's gear and
        // drinks, a slotted drink with no stock left dropped. Gathering has no Action Level tea; a
        // skill-level tea counts, as the game's own check does
        const { equipment, drinks } = resolveActionContext(action.type);
        return canStartAction({
            requiredLevel: requirement.level || 1,
            skillLevel: levels.get(requirement.skillHrid) ?? 1,
            teaSkillLevelBonus: parseTeaSkillLevelBonus(
                action.type,
                drinks,
                itemDetailMap,
                getDrinkConcentration(equipment, itemDetailMap)
            ),
        });
    };
    for (const [actionHrid, action] of Object.entries(actionDetailMap)) {
        if (!GATHERING_TYPES.includes(action?.type) || !Array.isArray(action.dropTable)) continue;
        if (!canGather(action)) continue;
        if (await pause()) return null;
        try {
            const route = gatherRoute(actionHrid, await calculateGatheringProfit(actionHrid), { sell });
            if (route) sources.push(route);
        } catch (error) {
            console.error('[CollectionOptimizer] Gather route failed for', actionHrid, error);
        }
    }
    if (cancelled()) return null;
    return { craft, sources };
}

/**
 * The recipes worth offering for one item: every one that no other recipe
 * beats on both cost and time per item. One that is no cheaper and no faster
 * than another (an exact copy included) is left out, since it can never be
 * either sort's pick; any trade-off between the two is kept.
 *
 * Only a recipe with the same output batch can dominate: an option is rounded
 * up to whole batches ({@link evaluateOption}), so a cheaper-per-item recipe
 * that makes 15 at a time still overshoots a rung that a 1-at-a-time recipe
 * meets exactly, and either can win a given rung.
 * @param {Array<{cost: number, seconds: number, batch?: number}>} recipes
 * @returns {Array<Object>} The survivors, in the order given
 */
export function undominatedRecipes(recipes) {
    const list = Array.isArray(recipes) ? recipes : [];
    return list.filter(
        (recipe, i) =>
            !list.some(
                (other, j) =>
                    j !== i &&
                    (other.batch ?? 1) === (recipe.batch ?? 1) &&
                    other.cost <= recipe.cost &&
                    other.seconds <= recipe.seconds &&
                    // Strictly better somewhere, or an exact copy listed earlier
                    (other.cost < recipe.cost || other.seconds < recipe.seconds || j < i)
            )
    );
}

/**
 * The smallest count that is a whole number of both sizes.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function leastCommonMultiple(a, b) {
    let x = a;
    let y = b;
    while (y) [x, y] = [y, x % y];
    return (a / x) * b;
}

/**
 * An item's display name.
 * @param {string} hrid
 * @returns {string}
 */
function itemName(hrid) {
    return (
        dataManager.getItemDetails?.(hrid)?.name ||
        String(hrid || '')
            .split('/')
            .pop()
    );
}

/**
 * Build an element with inline style and text.
 * @param {string} tag
 * @param {string} [style]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, style = '', text = '') {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text) node.textContent = text;
    return node;
}

/**
 * A count for display: whole numbers as they are, an expected fraction to one place.
 * @param {number} value
 * @returns {string}
 */
function formatCount(value) {
    if (Number.isInteger(value)) return formatKMB(value, 0) ?? '0';
    return formatKMB(value, 1) ?? '0';
}

/**
 * Gold a step makes, signed: "+" when it earns, "−" when it costs.
 * @param {number} gold - What the step costs (negative when it earns)
 * @returns {string}
 */
export function formatNet(gold) {
    const net = -Number(gold) || 0;
    const text = formatKMB(Math.abs(net)) ?? '0';
    if (net > 0) return `+${text}`;
    if (net < 0) return `−${text}`;
    return text;
}

/**
 * A route's description for a row: the route, and the source item it starts from.
 * @param {Object} option
 * @returns {string}
 */
function describeRoute(option) {
    const label = ROUTE_LABELS[option.route] || option.route;
    if (option.route === 'gather') {
        const zone = dataManager.getActionDetails?.(option.actionHrid)?.name || String(option.actionHrid || '');
        const actions = `${formatCount(option.units)} action${option.units === 1 ? '' : 's'}`;
        return `${label}: ${actions} at ${zone.split('/').pop()}`;
    }
    if (!option.sourceHrid) {
        if (!option.actionHrid) return label;
        const action = dataManager.getActionDetails?.(option.actionHrid)?.name || String(option.actionHrid);
        return `${label}: ${action.split('/').pop()}`;
    }
    const base = `${label}: ${option.units}× ${itemName(option.sourceHrid)}`;
    if (!option.setup) return base;
    const catalyst = option.setup.catalystHrid ? itemName(option.setup.catalystHrid) : 'no catalyst';
    return `${base} (${catalyst}, ${option.setup.tea ? 'teas' : 'no tea'})`;
}

class CollectionOptimizer {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.collectionsHandler = null;
        /** Priced routes, by character, kept for the session */
        this.routes = null;
        this.routesFor = null;
        this.index = null;
        this.building = null;
        this.generation = 0;
        this.collapsed = false;
        this.targetPoints = 10;
        this.maxStepHours = DEFAULT_MAX_STEP_HOURS;
        this.sort = DEFAULT_SORT;
        /** Items whose traded volume has been asked for this session */
        this.volumesAsked = new Set();
        this.volumesWarming = null;
        /** Items a lookup is under way for, so the ranking and the plan do not both ask */
        this.volumesInFlight = new Set();
        /** The plan on show, `{characterId}`: every redraw plans it again rather than dropping it */
        this.planShown = null;
    }

    /** The max time per step, in seconds */
    get maxSeconds() {
        return this.maxStepHours * 3600;
    }

    /**
     * Keep this character's max time per step.
     * @param {number} hours
     * @returns {Promise<void>}
     */
    async saveMaxStep(hours) {
        try {
            await writeScoped(MAX_STEP_KEY, hours, MAX_STEP_STORE);
        } catch (error) {
            console.error('[CollectionOptimizer] Saving max time per step failed:', error);
        }
    }

    /**
     * Keep this character's ranking order.
     * @param {string} sort
     * @returns {Promise<void>}
     */
    async saveSort(sort) {
        try {
            await writeScoped(SORT_KEY, sort, MAX_STEP_STORE);
        } catch (error) {
            console.error('[CollectionOptimizer] Saving the sort failed:', error);
        }
    }

    /**
     * Read this character's max time per step and ranking order, then redraw a mounted panel.
     * The character is captured before the read and checked after it, so a
     * switch landing in between never applies one character's choice to another.
     * @returns {Promise<void>}
     */
    async loadPrefs() {
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        const generation = this.generation;
        try {
            const stored = await readScoped(MAX_STEP_KEY, MAX_STEP_STORE, DEFAULT_MAX_STEP_HOURS);
            const sort = await readScoped(SORT_KEY, MAX_STEP_STORE, DEFAULT_SORT);
            if (generation !== this.generation) return;
            if ((dataManager.getCurrentCharacterId?.() ?? null) !== characterId) return;
            this.maxStepHours = validHours(stored);
            this.sort = validSort(sort);
            const root = document.querySelector(`.${PANEL_CLASS}`);
            if (root) this.render(root);
        } catch (error) {
            console.error('[CollectionOptimizer] Reading the panel settings failed:', error);
        }
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING_KEY)) return;
        this.isInitialized = true;
        this.generation++;

        const unregister = domObserver.onClass('CollectionOptimizer-panel', 'AchievementsPanel_controls', (node) => {
            const panel = node.closest?.('[class*="AchievementsPanel_collections"]');
            if (panel) this.mount(panel);
        });
        this.unregisterHandlers.push(unregister);

        this.collectionsHandler = () => {
            const panel = document.querySelector(`.${PANEL_CLASS}`)?.parentElement || this.findVisiblePanel();
            if (panel) this.mount(panel);
        };
        dataManager.on('collections_updated', this.collectionsHandler);

        const open = this.findVisiblePanel();
        if (open) this.mount(open);
        this.prefsLoaded = this.loadPrefs();
    }

    disable() {
        this.generation++;
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];
        if (this.collectionsHandler) {
            dataManager.off('collections_updated', this.collectionsHandler);
            this.collectionsHandler = null;
        }
        document.querySelectorAll(`.${PANEL_CLASS}`).forEach((node) => node.remove());
        this.routes = null;
        this.routesFor = null;
        this.index = null;
        this.building = null;
        this.maxStepHours = DEFAULT_MAX_STEP_HOURS;
        this.sort = DEFAULT_SORT;
        this.volumesAsked = new Set();
        this.volumesInFlight = new Set();
        this.volumesWarming = null;
        this.planShown = null;
        this.isInitialized = false;
    }

    /**
     * The Collections panel on screen, if any.
     * @returns {Element|null}
     */
    findVisiblePanel() {
        return document.querySelector('[class*="AchievementsPanel_collections"]');
    }

    /**
     * Put the panel into the Collections tab, once the game has sent the counts.
     * @param {Element} collectionsPanel - The `AchievementsPanel_collections` element
     */
    mount(collectionsPanel) {
        if (!this.isInitialized || !collectionsPanel) return;
        if (!dataManager.getCharacterCollections?.()) return;

        let root = collectionsPanel.querySelector(`:scope > .${PANEL_CLASS}`);
        if (!root) {
            root = el(
                'div',
                'margin:6px 0;padding:6px 8px;border:1px solid #444;border-radius:6px;background:rgba(0,0,0,0.25);font-size:12px;color:#ddd;'
            );
            root.className = PANEL_CLASS;
            const categories = collectionsPanel.querySelector('[class*="AchievementsPanel_categories"]');
            if (categories && categories.parentElement === collectionsPanel) {
                collectionsPanel.insertBefore(root, categories);
            } else {
                collectionsPanel.appendChild(root);
            }
        }
        this.render(root);
    }

    /**
     * Draw the panel: header, summary, target box and ranking. Prices the
     * routes first when none are in hand for this character.
     * @param {Element} root
     */
    render(root) {
        root.replaceChildren();
        const counts = collectionCounts(dataManager.getCharacterCollections?.());
        const total = totalCollectionPoints(counts);

        const header = el('div', 'display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:bold;');
        header.className = 'toolasha-collopt-header';
        header.appendChild(el('span', '', `${this.collapsed ? '▸' : '▾'} Collection Points Optimizer`));
        const targets = collectionAchievementTargets(dataManager.getInitClientData?.()?.achievementDetailMap);
        const next = nextAchievementTarget(targets, total);
        const summary = next ? `${total} points — next achievement at ${next.target}` : `${total} points`;
        header.appendChild(el('span', 'font-weight:normal;color:#aaa;', summary));
        if (!this.collapsed) header.appendChild(this.renderSortChoice());
        header.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            this.render(root);
        });
        root.appendChild(header);
        if (this.collapsed) return;

        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (!this.index || this.routesFor !== characterId) {
            root.appendChild(el('div', 'color:#aaa;margin-top:4px;', 'Pricing routes…'));
            this.ensureRoutes(root, characterId);
            return;
        }

        const body = el('div', 'margin-top:4px;');
        body.className = 'toolasha-collopt-body';
        root.appendChild(body);
        this.renderTargetBox(body, counts);
        this.renderRanking(body, counts);

        const footer = el('div', 'margin-top:4px;color:#888;');
        footer.appendChild(
            el(
                'span',
                '',
                'Buying on the market does not collect an item. Net gold: + earns, \u2212 costs, counting the ' +
                    'other outputs as sold at the bid after tax, as many as the market takes in a week. A bought ' +
                    'source is priced up its order book where you have opened it, and a step needing more of it ' +
                    'than the market trades in a week is left out. '
            )
        );
        const recompute = el('button', 'font-size:11px;margin-left:4px;', 'Recompute');
        recompute.className = 'toolasha-collopt-recompute';
        recompute.addEventListener('click', (event) => {
            event.stopPropagation();
            this.index = null;
            this.routes = null;
            this.render(root);
        });
        footer.appendChild(recompute);
        body.appendChild(footer);
    }

    /**
     * The ranking order: a select in the header, kept per character.
     * @returns {Element}
     */
    renderSortChoice() {
        const wrap = el('label', 'margin-left:auto;font-weight:normal;color:#aaa;', 'Sort ');
        const select = el('select', 'font-size:11px;background:#222;color:#eee;border:1px solid #444;');
        select.className = 'toolasha-collopt-sort';
        for (const [value, label] of Object.entries(SORT_MODES)) {
            const option = el('option', '', label);
            option.value = value;
            select.appendChild(option);
        }
        select.value = this.sort;
        // The header collapses on a click; choosing an order must not
        wrap.addEventListener('click', (event) => event.stopPropagation());
        select.addEventListener('change', () => {
            this.sort = validSort(select.value);
            this.saveSort(this.sort);
            const root = select.closest(`.${PANEL_CLASS}`);
            if (root) this.render(root);
        });
        wrap.appendChild(select);
        return wrap;
    }

    /**
     * Price the routes once, then redraw.
     * @param {Element} root
     * @param {*} characterId - The character the routes are priced for
     */
    ensureRoutes(root, characterId) {
        if (this.building) return;
        const generation = this.generation;
        const cancelled = () =>
            generation !== this.generation || (dataManager.getCurrentCharacterId?.() ?? null) !== characterId;
        this.building = (async () => {
            try {
                const routes = await buildCollectionRoutes({ cancelled });
                if (routes && !cancelled()) {
                    this.routes = routes;
                    this.routesFor = characterId;
                    this.index = indexRoutes(routes);
                }
            } catch (error) {
                console.error('[CollectionOptimizer] Pricing routes failed:', error);
            } finally {
                if (generation === this.generation) this.building = null;
            }
            if (generation !== this.generation) return;
            // A panel opened while this build ran found it pending and drew "Pricing routes…" for
            // itself: it is the panel to finish, not the (possibly gone) one that started the build.
            // A character switched mid-build left no routes; drawing the panel starts the new one.
            // A build that simply failed is left alone, or it would retry in a loop.
            const switched = (dataManager.getCurrentCharacterId?.() ?? null) !== characterId;
            if (!this.index && !switched) return;
            const target = root.isConnected ? root : document.querySelector(`.${PANEL_CLASS}`);
            if (target) this.render(target);
        })();
    }

    /**
     * The "+N points" box and its plan.
     * @param {Element} body
     * @param {Map<string, number>} counts
     */
    renderTargetBox(body, counts) {
        const row = el('div', 'display:flex;align-items:center;gap:6px;margin:4px 0;');
        row.appendChild(el('span', '', 'Plan +'));
        const input = el('input', 'width:60px;font-size:12px;background:#222;color:#eee;border:1px solid #444;');
        input.type = 'number';
        input.min = '1';
        input.value = String(this.targetPoints);
        input.className = 'toolasha-collopt-target';
        row.appendChild(input);
        row.appendChild(el('span', '', 'points'));
        const go = el('button', 'font-size:11px;', 'Plan');
        go.className = 'toolasha-collopt-plan';
        row.appendChild(go);

        // Anything slower than this per step is left out of the ranking and the plan
        row.appendChild(el('span', 'margin-left:10px;', 'Max time per step'));
        const maxStep = el('input', 'width:50px;font-size:12px;background:#222;color:#eee;border:1px solid #444;');
        maxStep.type = 'number';
        maxStep.min = '0.1';
        maxStep.step = '0.5';
        maxStep.value = String(this.maxStepHours);
        maxStep.className = 'toolasha-collopt-maxstep';
        row.appendChild(maxStep);
        row.appendChild(el('span', '', 'h'));
        maxStep.addEventListener('click', (event) => event.stopPropagation());
        maxStep.addEventListener('change', () => {
            this.maxStepHours = validHours(maxStep.value);
            this.saveMaxStep(this.maxStepHours);
            const root = maxStep.closest(`.${PANEL_CLASS}`);
            if (root) this.render(root);
        });
        body.appendChild(row);

        const result = el('div', '');
        result.className = 'toolasha-collopt-plan-result';
        body.appendChild(result);

        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        const run = () => {
            const wanted = Math.max(1, Math.floor(Number(input.value) || 0));
            this.targetPoints = wanted;
            this.planShown = { characterId };
            const plan = planTarget(counts, this.index, wanted, {
                maxSeconds: this.maxSeconds,
                sellable: weeklySellable,
                buyQuote: createBuyQuote(),
                sort: this.sort,
            });
            result.replaceChildren();
            const totals = `net ${formatNet(plan.gold)} gold, ${timeReadable(plan.seconds)}`;
            const head = plan.reached
                ? `+${plan.points} points: ${totals}`
                : `Only +${plan.points} points found: ${totals}`;
            result.appendChild(el('div', 'color:#9cf;', head));
            const list = el('ol', 'margin:2px 0 4px 18px;padding:0;');
            for (const step of plan.steps) {
                list.appendChild(
                    el(
                        'li',
                        '',
                        `${itemName(step.itemHrid)} → ${formatCount(step.to)} (+${step.points}) via ` +
                            `${describeRoute(step)}: ${formatNet(step.gold)}`
                    )
                );
            }
            result.appendChild(list);
            // Every item the plan buys or sells, not only the ranking's slice: an unmeasured one is
            // unbounded, and the plan is made again once the volumes land
            this.warmVolumes(plan.steps);
        };
        go.addEventListener('click', (event) => {
            event.stopPropagation();
            run();
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') run();
        });
        input.addEventListener('click', (event) => event.stopPropagation());

        // A redraw (volumes measured, a new sort, a new max time, the counts arriving again) keeps a
        // plan on show, planned again on what the panel now knows; another character's is dropped
        if (this.planShown && this.planShown.characterId !== characterId) this.planShown = null;
        if (this.planShown) run();
    }

    /**
     * The ranking: each item's cheapest next rung.
     * @param {Element} body
     * @param {Map<string, number>} counts
     */
    renderRanking(body, counts) {
        const options = bestOptions(counts, this.index, {
            maxSeconds: this.maxSeconds,
            sellable: weeklySellable,
            buyQuote: createBuyQuote(),
            sort: this.sort,
        });
        if (options.length === 0) {
            body.appendChild(
                el(
                    'div',
                    'color:#aaa;',
                    'No priced route within the max time per step — raise it, or market data may still be loading.'
                )
            );
            return;
        }
        const table = el('table', 'width:100%;border-collapse:collapse;font-size:11px;');
        table.className = 'toolasha-collopt-table';
        const head = el('tr', 'color:#aaa;text-align:left;');
        for (const label of ['Item', 'Count → next', 'Points', 'Route', 'Net gold', 'Time', 'Net/pt']) {
            head.appendChild(el('th', 'padding:1px 4px;font-weight:normal;', label));
        }
        table.appendChild(head);
        for (const option of options.slice(0, MAX_ROWS)) {
            const tr = el('tr', 'border-top:1px solid #333;');
            tr.className = 'toolasha-collopt-row';
            tr.dataset.item = option.itemHrid;
            tr.dataset.route = option.route;
            const points = option.collateral > 0 ? `+${option.gain} (+${option.collateral})` : `+${option.gain}`;
            const cells = [
                itemName(option.itemHrid),
                `${formatCount(option.from)} → ${formatCount(option.to)}`,
                points,
                describeRoute(option),
                formatNet(option.gold),
                timeReadable(option.seconds),
                formatNet(option.goldPerPoint),
            ];
            for (const text of cells) tr.appendChild(el('td', 'padding:1px 4px;', String(text ?? '')));
            table.appendChild(tr);
        }
        body.appendChild(table);
        this.warmVolumes(options.slice(0, MAX_ROWS));
    }

    /**
     * Measure the traded volume of what the given options sell and buy, and
     * redraw when one lands: a bound only applies to a volume already measured.
     * The lookup is the shared liquidity one, which asks the pooled history only
     * when the player has turned it on.
     *
     * `volumesAsked` holds only items with a confirmed measurement. An item whose
     * lookup failed or had no history to ask (the opt-in is off) is asked again
     * on the next draw, and so is one measured before the history setting or
     * source changed (the cache keys on both, so {@link hasMeasuredVolume} no
     * longer confirms it). A redraw follows only when something new was
     * measured, so an unavailable history cannot loop.
     * @param {Array<Object>} options - Ranking rows or plan steps
     */
    warmVolumes(options) {
        const fresh = [];
        const queued = new Set();
        for (const option of options || []) {
            for (const hrid of [...(option.sold?.keys?.() || []), ...(option.bought?.keys?.() || [])]) {
                if (queued.has(hrid) || this.volumesInFlight.has(hrid)) continue;
                if (this.volumesAsked.has(hrid)) {
                    if (hasMeasuredVolume(hrid)) continue;
                    this.volumesAsked.delete(hrid);
                }
                queued.add(hrid);
                fresh.push({ itemHrid: hrid });
            }
        }
        if (fresh.length === 0) return;
        const generation = this.generation;
        const inFlight = this.volumesInFlight;
        for (const { itemHrid } of fresh) inFlight.add(itemHrid);
        // One warm-up at a time: each prefetchLiquidity runs its own four-request pool, so the plan's
        // and the ranking's, started by the same draw, would double the bound on the pooled-history host
        const previous = this.volumesWarming;
        this.volumesWarming = (async () => {
            try {
                await previous;
            } catch {
                // That warm-up reports its own failure
            }
            try {
                await prefetchLiquidity(fresh);
            } catch (error) {
                console.error('[CollectionOptimizer] Measuring market volumes failed:', error);
            }
            for (const { itemHrid } of fresh) inFlight.delete(itemHrid);
            if (generation !== this.generation) return;
            let measured = 0;
            for (const { itemHrid } of fresh) {
                if (!hasMeasuredVolume(itemHrid)) continue;
                this.volumesAsked.add(itemHrid);
                measured++;
            }
            if (measured === 0 || this.collapsed) return;
            const root = document.querySelector(`.${PANEL_CLASS}`);
            if (root && this.index) this.render(root);
        })();
    }
}

const collectionOptimizer = new CollectionOptimizer();

export default collectionOptimizer;
