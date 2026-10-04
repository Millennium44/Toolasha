/**
 * Self-use alchemy valuations.
 *
 * Every other alchemy figure in the item tooltip is a seller's: outputs are
 * priced at the sell side minus the market tax, because the question there is
 * "is this worth doing to sell the result". A player filling the collection
 * log, or decomposing gear for materials they will craft with, never sells
 * the outputs — so the tax belongs on neither side, and each output is worth
 * what it would cost to buy instead (the user's pricing mode, buy side).
 *
 * Nothing here re-derives alchemy mechanics. Success rate, actions per hour
 * (efficiency included), catalyst and tea spend, coin cost, bulk multiplier
 * and the alchemy essence / artisan's crate bonus drops all come from an
 * `alchemyProfitCalculator.calculate{Decompose,Transmute}Profit` result. The
 * only thing re-read from game data is the base output list
 * (`alchemyDetail.decomposeItems` / `transmuteDropTable`), because the
 * calculator leaves an output out of `dropRevenues` when it has no SELL
 * price, and a self-use valuation prices the buy side.
 *
 * Alchemy consumes the input on every attempt, success or not — the
 * calculator charges the input per attempt and credits outputs times the
 * success rate. So a chain does not take "1 / successRate attempts" per step;
 * one top item reaches the next step with probability `successRate`, and every
 * later step's outputs, time and spend are weighted by that reach.
 *
 * Only reached from the tooltip bundle; pure apart from
 * `calculatePriceAfterTax`, which is the character-aware (Iron Cow untaxed)
 * tax every realized-sale figure goes through.
 */

import { calculatePriceAfterTax } from './profit-helpers.js';

/** Recursion cap for the decompose chain — the longest real gear line is well under this. */
export const CHAIN_MAX_DEPTH = 12;

const SECONDS_PER_HOUR = 3600;

/**
 * A usable price: a finite number at or above zero. `null`/`undefined`/NaN
 * mean unpriced, never free.
 * @param {*} value
 * @returns {number|null}
 */
function usablePrice(value) {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The cheaper of making and buying one unit, for an item you consume rather
 * than sell. Either side may be missing.
 * @param {{make?: number|null, buy?: number|null}} sides
 * @returns {number|null} Null when neither side is priced
 */
export function ownUseUnitCost({ make = null, buy = null } = {}) {
    const candidates = [make, buy].map(usablePrice).filter((v) => v !== null);
    return candidates.length > 0 ? Math.min(...candidates) : null;
}

/**
 * The per-hour economics an alchemy calculator result already carries.
 * @param {Object} result - From `calculateDecomposeProfit` / `calculateTransmuteProfit`
 * @returns {{actionsPerHour: number, bulk: number, successRate: number, overheadPerHour: number}|null}
 *   `overheadPerHour` is coin + catalyst + tea spend per hour; null when the
 *   result has no usable action rate.
 */
export function alchemyRunBasis(result) {
    const actionsPerHour = Number(result?.actionsPerHour);
    if (!Number.isFinite(actionsPerHour) || actionsPerHour <= 0) return null;
    const requirements = Array.isArray(result.requirementCosts) ? result.requirementCosts : [];
    const bulk = Number(requirements[0]?.count) > 0 ? Number(requirements[0].count) : 1;
    const coinPerAction = Number(requirements.find((r) => r?.itemHrid === '/items/coin')?.costPerAction) || 0;
    const successRate = Math.max(0, Math.min(1, Number(result.successRate) || 0));
    const overheadPerHour =
        coinPerAction * actionsPerHour +
        (Number(result.catalystCostPerHour) || 0) +
        (Number(result.totalTeaCostPerHour) || 0);
    return { actionsPerHour, bulk, successRate, overheadPerHour };
}

/**
 * The alchemy-wide bonus drops (Alchemy Essence, Artisan's Crate) in a
 * calculator result. They roll on every action regardless of the item, and
 * the calculator flags them `isEssence` / `isRare`; at enhancement level 0 no
 * base output carries either flag.
 * @param {Object} result
 * @returns {Array<Object>}
 */
function bonusDrops(result) {
    return (Array.isArray(result?.dropRevenues) ? result.dropRevenues : []).filter(
        (drop) => drop?.isRare || drop?.isEssence
    );
}

/**
 * What opening a container is worth to someone who keeps the contents: the
 * expected value of its drop table at the untaxed buy side. The calculator's
 * own crate figure (`expectedValueCalculator`) is a seller's — it takes the
 * market tax off every tradable content — so it cannot stand in here.
 *
 * A content that is itself a container is valued as opened, the same way; a
 * cycle contributes nothing. Unpriced contents are skipped, so the figure is a
 * lower bound, as the calculator's is.
 * @param {string} containerHrid
 * @param {Object} deps
 * @param {(hrid: string) => Array|null} deps.containerDrops - The container's drop table
 *   (`openableLootDropMap[hrid]`: `{itemHrid, dropRate, minCount, maxCount}`), null when not a container
 * @param {(hrid: string) => number|null} deps.priceOf - Untaxed buy-side price of a content
 * @param {Set<string>} [path] - Recursion guard
 * @returns {number|null} Null when it is not a container or nothing in it is priced
 */
export function untaxedContainerValue(containerHrid, { containerDrops, priceOf }, path = new Set()) {
    const table = containerDrops(containerHrid);
    if (!Array.isArray(table) || table.length === 0 || path.has(containerHrid)) return null;
    const inner = new Set([...path, containerHrid]);
    let total = 0;
    let priced = false;
    for (const drop of table) {
        const rate = Number(drop?.dropRate) || 0;
        const average = ((Number(drop?.minCount) || 0) + (Number(drop?.maxCount) || 0)) / 2;
        if (!(rate > 0 && average > 0)) continue;
        const unit =
            untaxedContainerValue(drop.itemHrid, { containerDrops, priceOf }, inner) ??
            usablePrice(priceOf(drop.itemHrid));
        if (unit === null) continue;
        total += rate * average * unit;
        priced = true;
    }
    return priced ? total : null;
}

/**
 * One bonus drop's unit value, untaxed. A crate is openable and usually has no
 * order book; then it is worth its contents at the buy side
 * ({@link untaxedContainerValue}). The calculator's own figure is the last
 * resort only — for a crate it is taxed.
 * @param {Object} drop - A bonus entry of `dropRevenues`
 * @param {(hrid: string) => number|null} priceOf
 * @param {((hrid: string) => number|null)|undefined} containerValue - Untaxed opened value
 * @returns {number|null}
 */
function bonusUnitPrice(drop, priceOf, containerValue) {
    const fallback = Number(drop.price) > 0 ? Number(drop.price) : null;
    return usablePrice(priceOf(drop.itemHrid)) ?? usablePrice(containerValue?.(drop.itemHrid)) ?? fallback;
}

/**
 * Value one bonus drop per hour, untaxed.
 * @returns {number|null} Value per hour, or null when unpriced
 */
function bonusValuePerHour(drop, priceOf, containerValue) {
    const units = Number(drop.dropsPerHour) || 0;
    if (units <= 0) return 0;
    const unit = bonusUnitPrice(drop, priceOf, containerValue);
    return unit === null ? null : units * unit;
}

/**
 * Decompose once, keeping everything it yields.
 *
 * Per hour:
 *   outputs  = Σ base output: count × bulk × successRate × actionsPerHour × buyPrice
 *            + Σ bonus drop: dropsPerHour × buyPrice (crate: its contents at the buy side, untaxed)
 *   cost     = ownUseCost × bulk × actionsPerHour + coin + catalyst + tea (per hour)
 *   net      = outputs − cost;  net per action = net / actionsPerHour
 *
 * @param {Object} result - `calculateDecomposeProfit(itemHrid)` (enhancement level 0)
 * @param {Object} itemDetails - The decomposed item's details (for `alchemyDetail.decomposeItems`)
 * @param {Object} opts
 * @param {number|null} opts.ownUseCost - One unit's own-use cost (cheaper of make or buy)
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price
 * @param {(hrid: string) => number|null} [opts.containerValue] - A crate's untaxed opened value
 * @returns {Object|null} `{netPerHour, netPerAction, outputValuePerHour, costPerHour,
 *   actionsPerHour, successRate, unpriced, partlyUnpriced}`, or null when the step cannot run
 */
export function selfUseDecompose(result, itemDetails, { ownUseCost, priceOf, containerValue }) {
    const basis = alchemyRunBasis(result);
    const outputs = itemDetails?.alchemyDetail?.decomposeItems;
    const cost = usablePrice(ownUseCost);
    if (!basis || !Array.isArray(outputs) || cost === null) return null;

    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    const unpriced = [];
    let outputValuePerHour = 0;
    for (const output of outputs) {
        const unit = usablePrice(priceOf(output.itemHrid));
        if (unit === null) {
            unpriced.push(output.itemHrid);
            continue;
        }
        outputValuePerHour += output.count * bulk * successRate * actionsPerHour * unit;
    }
    for (const drop of bonusDrops(result)) {
        const value = bonusValuePerHour(drop, priceOf, containerValue);
        if (value === null) unpriced.push(drop.itemHrid);
        else outputValuePerHour += value;
    }

    const costPerHour = cost * bulk * actionsPerHour + overheadPerHour;
    const netPerHour = outputValuePerHour - costPerHour;
    return {
        netPerHour,
        netPerAction: netPerHour / actionsPerHour,
        outputValuePerHour,
        costPerHour,
        actionsPerHour,
        successRate,
        unpriced,
        partlyUnpriced: unpriced.length > 0,
    };
}

/**
 * Decompose one item, then every piece of gear that yields, down to materials.
 *
 * Only terminal outputs are valued (untaxed, buy side); the gear in between is
 * consumed by the next step and never counted. Per ONE top item, with
 * `reach` the expected number of units arriving at a step (1 for the top,
 * then reach × count × successRate for each piece of gear it yields):
 *   terminal value = Σ reach × count × successRate × buyPrice   (base materials)
 *                  + Σ reach × dropsPerHour / unitsPerHour × buyPrice   (bonus drops)
 *   step seconds   = reach × 3600 / unitsPerHour,  unitsPerHour = actionsPerHour × bulk
 *   step spend     = reach × (coin + catalyst + tea per hour) / unitsPerHour
 *   net            = terminal value − ownUseCost(top) − Σ step spend
 *
 * A step whose calculator result is missing (no market data for that gear) is
 * not walked: the gear is still listed as collected, and the result is marked
 * partly unpriced with `net` null rather than a figure missing a branch.
 *
 * @param {string} topHrid
 * @param {Object} deps
 * @param {(hrid: string) => Object|null} deps.getDecompose - `calculateDecomposeProfit(hrid)`
 * @param {(hrid: string) => Object|null} deps.getItemDetails
 * @param {(hrid: string) => boolean} deps.isChainable - Gear that can itself be decomposed
 * @param {(hrid: string) => number|null} deps.priceOf - Untaxed buy-side price
 * @param {number|null} deps.ownUseCost - The top item's own-use cost
 * @param {(hrid: string) => number|null} [deps.containerValue] - A crate's untaxed opened value
 * @param {number} [deps.maxDepth=CHAIN_MAX_DEPTH]
 * @returns {Object|null} `{net, netPerHour, terminalValue, cost, ownUseCost, overheadCost, seconds,
 *   collected: [{itemHrid, expected}], steps, unpriced, partlyUnpriced, truncated}`, or null
 *   when the top item cannot be decomposed at all
 */
export function selfUseDecomposeChain(topHrid, deps) {
    const {
        getDecompose,
        getItemDetails,
        isChainable,
        priceOf,
        ownUseCost,
        containerValue,
        maxDepth = CHAIN_MAX_DEPTH,
    } = deps;
    const top = getDecompose(topHrid);
    if (!alchemyRunBasis(top) || !Array.isArray(getItemDetails(topHrid)?.alchemyDetail?.decomposeItems)) {
        return null;
    }

    let terminalValue = 0;
    let overheadCost = 0;
    let seconds = 0;
    let truncated = false;
    const unpriced = new Set();
    const collected = new Map();
    const steps = [];

    const valueTerminal = (hrid, expected) => {
        const unit = usablePrice(priceOf(hrid));
        if (unit === null) unpriced.add(hrid);
        else terminalValue += expected * unit;
    };

    const walk = (hrid, reach, depth, path) => {
        const result = depth === 0 ? top : getDecompose(hrid);
        const basis = alchemyRunBasis(result);
        const outputs = getItemDetails(hrid)?.alchemyDetail?.decomposeItems;
        if (!basis || !Array.isArray(outputs)) {
            unpriced.add(hrid);
            return;
        }
        const unitsPerHour = basis.actionsPerHour * basis.bulk;
        seconds += (reach * SECONDS_PER_HOUR) / unitsPerHour;
        overheadCost += (reach * basis.overheadPerHour) / unitsPerHour;
        steps.push({ itemHrid: hrid, reach, successRate: basis.successRate });

        for (const output of outputs) {
            // Outputs scale with bulk exactly as the input does, so per input unit it cancels
            const expected = reach * output.count * basis.successRate;
            if (!(expected > 0)) continue;
            const child = output.itemHrid;
            if (isChainable(child)) {
                collected.set(child, (collected.get(child) || 0) + expected);
                if (path.has(child) || depth + 1 > maxDepth) {
                    // A cycle or a runaway line: stop here and keep the piece
                    truncated = true;
                    valueTerminal(child, expected);
                    continue;
                }
                walk(child, expected, depth + 1, new Set([...path, child]));
            } else {
                valueTerminal(child, expected);
            }
        }
        for (const drop of bonusDrops(result)) {
            const units = Number(drop.dropsPerHour) || 0;
            if (units <= 0) continue;
            const unit = bonusUnitPrice(drop, priceOf, containerValue);
            if (unit === null) unpriced.add(drop.itemHrid);
            else terminalValue += ((reach * units) / unitsPerHour) * unit;
        }
    };

    walk(topHrid, 1, 0, new Set([topHrid]));

    const ownUse = usablePrice(ownUseCost);
    if (ownUse === null) unpriced.add(topHrid);
    const partlyUnpriced = unpriced.size > 0;
    const cost = (ownUse ?? 0) + overheadCost;
    const net = partlyUnpriced ? null : terminalValue - cost;
    return {
        net,
        netPerHour: net !== null && seconds > 0 ? (net * SECONDS_PER_HOUR) / seconds : null,
        terminalValue,
        cost,
        ownUseCost: ownUse,
        overheadCost,
        seconds,
        collected: [...collected].map(([itemHrid, expected]) => ({ itemHrid, expected })),
        steps,
        unpriced: [...unpriced],
        partlyUnpriced,
        truncated,
    };
}

/**
 * Transmute an item you already hold, and keep what comes out — versus
 * selling the item instead.
 *
 * The input's cost is what selling it would realize (sell-side price after the
 * character-aware tax); the outputs are worth what you would pay for them
 * (buy side, untaxed). A self-return gives the item back, so it is worth the
 * same as the input. Per hour:
 *   input    = calculatePriceAfterTax(sellPrice)
 *   outputs  = Σ non-self drop: avg(min,max) × bulk × dropRate × successRate × actionsPerHour × buyPrice
 *            + Σ self-return:   avg(min,max) × bulk × dropRate × successRate × actionsPerHour × input
 *            + Σ bonus drop:    dropsPerHour × buyPrice
 *   cost     = input × bulk × actionsPerHour + coin + catalyst + tea (per hour)
 *   net      = outputs − cost;  net per action = net / actionsPerHour
 *
 * @param {Object} result - `calculateTransmuteProfit(itemHrid)`
 * @param {Object} itemDetails - The transmuted item's details (for `transmuteDropTable`)
 * @param {Object} opts
 * @param {number|null} opts.sellPrice - The input's sell-side price, before tax
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price
 * @param {(hrid: string) => number|null} [opts.containerValue] - A crate's untaxed opened value
 * @returns {Object|null} `{netPerHour, netPerAction, inputValue, outputValuePerHour, costPerHour,
 *   actionsPerHour, successRate, unpriced, partlyUnpriced}`
 */
export function selfUseTransmuteHeld(result, itemDetails, { sellPrice, priceOf, containerValue }) {
    const basis = alchemyRunBasis(result);
    const table = itemDetails?.alchemyDetail?.transmuteDropTable;
    const sell = usablePrice(sellPrice);
    if (!basis || !Array.isArray(table) || sell === null) return null;

    const inputValue = calculatePriceAfterTax(sell);
    const selfHrid = result.itemHrid;
    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    const unpriced = [];
    let outputValuePerHour = 0;
    for (const drop of table) {
        const average = (Number(drop.minCount) + Number(drop.maxCount)) / 2;
        const units = average * bulk * (Number(drop.dropRate) || 0) * successRate * actionsPerHour;
        if (!(units > 0)) continue;
        const unit = drop.itemHrid === selfHrid ? inputValue : usablePrice(priceOf(drop.itemHrid));
        if (unit === null) {
            unpriced.push(drop.itemHrid);
            continue;
        }
        outputValuePerHour += units * unit;
    }
    for (const drop of bonusDrops(result)) {
        const value = bonusValuePerHour(drop, priceOf, containerValue);
        if (value === null) unpriced.push(drop.itemHrid);
        else outputValuePerHour += value;
    }

    const costPerHour = inputValue * bulk * actionsPerHour + overheadPerHour;
    const netPerHour = outputValuePerHour - costPerHour;
    return {
        netPerHour,
        netPerAction: netPerHour / actionsPerHour,
        inputValue,
        outputValuePerHour,
        costPerHour,
        actionsPerHour,
        successRate,
        unpriced,
        partlyUnpriced: unpriced.length > 0,
    };
}
