/**
 * Self-use alchemy valuations.
 *
 * Every other alchemy figure in the item tooltip is a seller's: outputs are
 * priced at the sell side minus the market tax, because the question there is
 * "is this worth doing to sell the result". A player filling the collection
 * log, or decomposing gear for materials they will craft with, keeps some
 * outputs — and a kept output is worth what it would cost to buy instead (the
 * user's pricing mode, buy side, no tax).
 *
 * Which outputs are kept is the caller's `isWanted` (the tooltip's per-character
 * keep list). A kept output is valued at `priceOf` / `containerValue` (untaxed
 * buy side); every other output at `sellOf` / `sellContainerValue` (what selling
 * it realizes, after tax). Without `isWanted` every output is kept — the
 * collection optimizer relies on that, passing its own sale prices as `priceOf`.
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

/** Coins: worth their face value, never on the market */
const COIN_HRID = '/items/coin';

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
 * Pick the catalyst/tea candidate that is best for keeping the outputs.
 *
 * The calculator's own pick maximizes the seller's figure (outputs at the sell
 * side, taxed). A catalyst that only pays off at buy-side prices — or one that
 * only pays off on the seller's terms — then leaves the self-use line on the
 * wrong setup, so each line scores every candidate on its own objective.
 * @param {Array<Object>} candidates - Calculator results, one per catalyst/tea candidate
 * @param {(result: Object) => Object|null} evaluate - The self-use valuation of one result
 * @param {string} objective - The evaluation field to maximize (e.g. `netPerHour`)
 * @param {Object} [options]
 * @param {boolean} [options.rankPartial=false] - Let a partly unpriced candidate beat a complete one on
 *   score, instead of serving only as a fallback. Only right where a missing price can only lower the
 *   score (a cost that is an upper bound). Partial candidates are always ranked against each other.
 * @returns {{result: Object, evaluation: Object}|null} The best candidate, null when none evaluates
 */
export function bestSelfUseCandidate(candidates, evaluate, objective, options = {}) {
    let best = null;
    let bestScore = -Infinity;
    let firstPartial = null;
    let partialScore = -Infinity;
    for (const result of Array.isArray(candidates) ? candidates : []) {
        if (!result) continue;
        const evaluation = evaluate(result);
        if (evaluation?.partlyUnpriced) {
            const partial = Number(evaluation?.[objective]);
            // Among partial candidates the one with the best finite figure is the fallback, so a chain
            // whose bonus crate is only partly priced shows its best lower bound, not an arbitrary setup
            if (!firstPartial || (Number.isFinite(partial) && partial > partialScore)) {
                firstPartial = { result, evaluation, optimized: false };
                partialScore = Number.isFinite(partial) ? partial : -Infinity;
            }
            continue;
        }
        const score = Number(evaluation?.[objective]);
        if (!Number.isFinite(score) || score <= bestScore) continue;
        best = { result, evaluation, optimized: true };
        bestScore = score;
    }
    if (options.rankPartial && firstPartial && partialScore > bestScore) return firstPartial;
    return best ?? firstPartial;
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
 * The price sources one output is valued from: the keeper's (untaxed buy side)
 * when it is wanted, the seller's (after tax) when it is not.
 * @param {string} hrid
 * @param {Object} opts
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price
 * @param {Function} [opts.containerValue] - A crate's untaxed opened value
 * @param {(hrid: string) => boolean} [opts.isWanted] - Kept outputs; absent means every output is kept
 * @param {(hrid: string) => number|null} [opts.sellOf] - What selling one unit realizes, after tax
 * @param {Function} [opts.sellContainerValue] - A crate's opened value with its contents sold after tax
 * @returns {{priceOf: (hrid: string) => number|null, containerValue: Function|undefined, kept: boolean,
 *   marked: boolean}} `marked` is true only for an output a keep list names (never for the
 *   keep-everything default)
 */
export function outputPricing(hrid, { priceOf, containerValue, isWanted, sellOf, sellContainerValue }) {
    if (typeof isWanted !== 'function') return { priceOf, containerValue, kept: true, marked: false };
    if (isWanted(hrid)) return { priceOf, containerValue, kept: true, marked: true };
    return { priceOf: sellOf ?? (() => null), containerValue: sellContainerValue, kept: false, marked: false };
}

/**
 * What opening a container is worth to someone who keeps the contents: the
 * expected value of its drop table at the untaxed buy side. The calculator's
 * own crate figure (`expectedValueCalculator`) is a seller's — it takes the
 * market tax off every tradable content — so it cannot stand in here.
 *
 * A content that is itself a container is valued as opened, the same way; a
 * cycle contributes nothing. Unpriced contents are skipped, so the known
 * subtotal is a lower bound and `partlyUnpriced` carries that fact to callers.
 *
 * The walk itself takes no side: handed an after-tax sale price as `priceOf`,
 * it values a crate whose contents are sold (an unwanted crate, the collection
 * optimizer's sale figure).
 * @param {string} containerHrid
 * @param {Object} deps
 * @param {(hrid: string) => Array|null} deps.containerDrops - The container's drop table
 *   (`openableLootDropMap[hrid]`: `{itemHrid, dropRate, minCount, maxCount}`), null when not a container
 * @param {(hrid: string) => number|null} deps.priceOf - Untaxed buy-side price of a content
 * @param {Set<string>} [path] - Recursion guard
 * @returns {{value: number|null, partlyUnpriced: boolean}|null} Null when it is not a container
 */
export function untaxedContainerValue(containerHrid, { containerDrops, priceOf }, path = new Set()) {
    const table = containerDrops(containerHrid);
    if (!Array.isArray(table) || table.length === 0 || path.has(containerHrid)) return null;
    const inner = new Set([...path, containerHrid]);
    let total = 0;
    let priced = false;
    let partlyUnpriced = false;
    for (const drop of table) {
        const rate = Number(drop?.dropRate) || 0;
        const average = ((Number(drop?.minCount) || 0) + (Number(drop?.maxCount) || 0)) / 2;
        if (!(rate > 0 && average > 0)) continue;
        const nested = untaxedContainerValue(drop.itemHrid, { containerDrops, priceOf }, inner);
        const market = usablePrice(priceOf(drop.itemHrid));
        const unit = nested?.value !== null && nested?.value !== undefined ? nested.value : market;
        const itemPartlyUnpriced =
            nested?.value !== null && nested?.value !== undefined && Boolean(nested.partlyUnpriced);
        if (unit === null) {
            partlyUnpriced = true;
            continue;
        }
        total += rate * average * unit;
        priced = true;
        partlyUnpriced ||= itemPartlyUnpriced;
    }
    return { value: priced ? total : null, partlyUnpriced };
}

/**
 * One bonus drop's unit value, untaxed. A crate is openable and usually has no
 * order book; then it is worth its contents at the buy side
 * ({@link untaxedContainerValue}). The calculator stores seller-side values
 * in `drop.price`, so this helper never uses that field for a kept bonus.
 * @param {Object} drop - A bonus entry of `dropRevenues`
 * @param {(hrid: string) => number|null} priceOf
 * @param {((hrid: string) => number|null)|undefined} containerValue - Untaxed opened value
 * @returns {{value: number|null, partlyUnpriced: boolean}}
 */
function bonusUnitPrice(drop, priceOf, containerValue) {
    const market = usablePrice(priceOf(drop.itemHrid));
    if (market !== null) return { value: market, partlyUnpriced: false };
    const resolved = containerValue?.(drop.itemHrid);
    if (resolved && typeof resolved === 'object') {
        return { value: usablePrice(resolved.value), partlyUnpriced: Boolean(resolved.partlyUnpriced) };
    }
    return { value: usablePrice(resolved), partlyUnpriced: false };
}

/**
 * Value one bonus drop per hour, untaxed.
 * @returns {{value: number|null, partlyUnpriced: boolean}} Value per hour and whether it is a lower bound
 */
function bonusValuePerHour(drop, priceOf, containerValue) {
    const units = Number(drop.dropsPerHour) || 0;
    if (units <= 0) return { value: 0, partlyUnpriced: false };
    const unit = bonusUnitPrice(drop, priceOf, containerValue);
    return { value: unit.value === null ? null : units * unit.value, partlyUnpriced: unit.partlyUnpriced };
}

/**
 * Decompose once, keeping the wanted outputs and selling the rest.
 *
 * Per hour, with `unit` the buy side for a wanted output and its after-tax sale otherwise
 * ({@link outputPricing}):
 *   outputs  = Σ base output: count × bulk × successRate × actionsPerHour × unit
 *            + Σ bonus drop: dropsPerHour × unit (crate: its contents, kept or sold the same way)
 *   cost     = ownUseCost × bulk × actionsPerHour + coin + catalyst + tea (per hour)
 *   net      = outputs − cost;  net per action = net / actionsPerHour
 *
 * @param {Object} result - `calculateDecomposeProfit(itemHrid)` (enhancement level 0)
 * @param {Object} itemDetails - The decomposed item's details (for `alchemyDetail.decomposeItems`)
 * @param {Object} opts
 * @param {number|null} opts.ownUseCost - One unit's own-use cost (cheaper of make or buy)
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price
 * @param {(hrid: string) => number|{value: number|null, partlyUnpriced?: boolean}|null} [opts.containerValue]
 *   A crate's untaxed opened value
 * @param {(hrid: string) => boolean} [opts.isWanted] - Kept outputs ({@link outputPricing})
 * @param {(hrid: string) => number|null} [opts.sellOf] - After-tax sale of an unwanted output
 * @param {Function} [opts.sellContainerValue] - An unwanted crate's opened value, contents sold after tax
 * @returns {Object|null} `{netPerHour, netPerAction, outputValuePerHour, costPerHour,
 *   actionsPerHour, successRate, unpriced, partlyUnpriced, kept}`, or null when the step cannot run;
 *   `kept` lists the outputs the keep list names
 */
export function selfUseDecompose(result, itemDetails, opts) {
    const { ownUseCost } = opts;
    const basis = alchemyRunBasis(result);
    const outputs = itemDetails?.alchemyDetail?.decomposeItems;
    const cost = usablePrice(ownUseCost);
    if (!basis || !Array.isArray(outputs) || cost === null) return null;

    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    const unpriced = [];
    const kept = new Set();
    let partlyUnpriced = false;
    let outputValuePerHour = 0;
    for (const output of outputs) {
        const pricing = outputPricing(output.itemHrid, opts);
        if (pricing.marked) kept.add(output.itemHrid);
        const unit = usablePrice(pricing.priceOf(output.itemHrid));
        if (unit === null) {
            unpriced.push(output.itemHrid);
            continue;
        }
        outputValuePerHour += output.count * bulk * successRate * actionsPerHour * unit;
    }
    for (const drop of bonusDrops(result)) {
        const pricing = outputPricing(drop.itemHrid, opts);
        if (pricing.marked) kept.add(drop.itemHrid);
        const value = bonusValuePerHour(drop, pricing.priceOf, pricing.containerValue);
        if (value.value === null) unpriced.push(drop.itemHrid);
        else outputValuePerHour += value.value;
        if (value.partlyUnpriced && value.value !== null) unpriced.push(drop.itemHrid);
        partlyUnpriced ||= value.partlyUnpriced;
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
        partlyUnpriced: unpriced.length > 0 || partlyUnpriced,
        kept: [...kept],
    };
}

/**
 * Decompose one item, then every piece of gear that yields, down to materials.
 *
 * Only terminal outputs are valued — a wanted one at the untaxed buy side, any
 * other at its after-tax sale ({@link outputPricing}); the gear in between is
 * consumed by the next step and never counted, marked or not. Per ONE top item, with
 * `reach` the expected number of units arriving at a step (1 for the top,
 * then reach × count × successRate for each piece of gear it yields):
 *   terminal value = Σ reach × count × successRate × unit   (base materials)
 *                  + Σ reach × dropsPerHour / unitsPerHour × unit   (bonus drops)
 *   step seconds   = reach × 3600 / unitsPerHour,  unitsPerHour = actionsPerHour × bulk
 *   step spend     = reach × (coin + catalyst + tea per hour) / unitsPerHour
 *   net            = terminal value − ownUseCost(top) − Σ step spend
 *
 * A step whose calculator result is missing (no market data for that gear) is
 * not walked: the gear is still listed as collected, and the result is marked
 * partly unpriced with `net` null rather than a figure missing a branch.
 * A bonus crate with only SOME contents unpriced is different: it is valued at its
 * priced part (a lower bound), listed in `partialItems`, and `net` stays a figure
 * with `partial` true.
 *
 * @param {string} topHrid
 * @param {Object} deps
 * @param {(hrid: string) => Object|null} deps.getDecompose - `calculateDecomposeProfit(hrid)`
 * @param {(hrid: string) => Object|null} deps.getItemDetails
 * @param {(hrid: string) => boolean} deps.isChainable - Gear that can itself be decomposed
 * @param {(hrid: string) => number|null} deps.priceOf - Untaxed buy-side price
 * @param {number|null} deps.ownUseCost - The top item's own-use cost
 * @param {(hrid: string) => number|{value: number|null, partlyUnpriced?: boolean}|null} [deps.containerValue]
 *   A crate's untaxed opened value
 * @param {(hrid: string) => boolean} [deps.isWanted] - Kept terminals ({@link outputPricing})
 * @param {(hrid: string) => number|null} [deps.sellOf] - After-tax sale of an unwanted terminal
 * @param {Function} [deps.sellContainerValue] - An unwanted crate's opened value, contents sold after tax
 * @param {number} [deps.maxDepth=CHAIN_MAX_DEPTH]
 * @returns {Object|null} `{net, netPerHour, terminalValue, cost, ownUseCost, overheadCost, seconds,
 *   collected: [{itemHrid, expected}], terminals: [{itemHrid, expected, value}], steps, unpriced,
 *   partial, partialItems, partlyUnpriced, truncated, kept}`, or null
 *   when the top item cannot be decomposed at all
 */
export function selfUseDecomposeChain(topHrid, deps) {
    const { getDecompose, getItemDetails, isChainable, ownUseCost, maxDepth = CHAIN_MAX_DEPTH } = deps;
    const top = getDecompose(topHrid);
    if (!alchemyRunBasis(top) || !Array.isArray(getItemDetails(topHrid)?.alchemyDetail?.decomposeItems)) {
        return null;
    }

    let terminalValue = 0;
    let overheadCost = 0;
    let seconds = 0;
    let truncated = false;
    const unpriced = new Set();
    const partialItems = new Set();
    const kept = new Set();
    const collected = new Map();
    const steps = [];

    // Every kept output per top item, with its value where priced: what a
    // collector credits beyond the gear in between (`collected`)
    const terminals = new Map();
    const keepTerminal = (hrid, expected, value) => {
        const entry = terminals.get(hrid) || { itemHrid: hrid, expected: 0, value: 0 };
        entry.expected += expected;
        entry.value = entry.value === null || value === null ? null : entry.value + value;
        terminals.set(hrid, entry);
    };
    const pricingFor = (hrid) => {
        const pricing = outputPricing(hrid, deps);
        if (pricing.marked) kept.add(hrid);
        return pricing;
    };
    const valueTerminal = (hrid, expected) => {
        const unit = usablePrice(pricingFor(hrid).priceOf(hrid));
        if (unit === null) unpriced.add(hrid);
        else terminalValue += expected * unit;
        keepTerminal(hrid, expected, unit === null ? null : expected * unit);
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
            const pricing = pricingFor(drop.itemHrid);
            const unit = bonusUnitPrice(drop, pricing.priceOf, pricing.containerValue);
            const expected = (reach * units) / unitsPerHour;
            if (unit.value === null) unpriced.add(drop.itemHrid);
            else terminalValue += expected * unit.value;
            // A crate with some contents unpriced is worth at least what is priced: a lower bound
            if (unit.value !== null && unit.partlyUnpriced) partialItems.add(drop.itemHrid);
            keepTerminal(drop.itemHrid, expected, unit.value === null ? null : expected * unit.value);
        }
    };

    walk(topHrid, 1, 0, new Set([topHrid]));

    const ownUse = usablePrice(ownUseCost);
    if (ownUse === null) unpriced.add(topHrid);
    const partial = partialItems.size > 0;
    // `partlyUnpriced` stays "this figure is a lower bound or missing"; only a bonus or
    // output with no price at all (`unpriced`) withholds the net
    const partlyUnpriced = unpriced.size > 0 || partial;
    const cost = (ownUse ?? 0) + overheadCost;
    const net = unpriced.size > 0 ? null : terminalValue - cost;
    return {
        net,
        netPerHour: net !== null && seconds > 0 ? (net * SECONDS_PER_HOUR) / seconds : null,
        terminalValue,
        cost,
        ownUseCost: ownUse,
        overheadCost,
        seconds,
        collected: [...collected].map(([itemHrid, expected]) => ({ itemHrid, expected })),
        terminals: [...terminals.values()],
        steps,
        unpriced: [...unpriced],
        partial,
        partialItems: [...partialItems],
        partlyUnpriced,
        truncated,
        kept: [...kept],
    };
}

/**
 * One step of {@link selfUseDecomposeChain}, per unit arriving at it: the walk's own
 * arithmetic for a single step at reach 1, with the gear it yields handed back as
 * children instead of walked. Summing these down a tree, each child weighted by its
 * `multiplier` times its parent's reach, gives the walk's `net + ownUseCost` and
 * `seconds`, so a caller can score setups per step without walking the chain.
 * @param {Object} result - The step's decompose calculator result
 * @param {Array|null} outputs - The decomposed gear's `alchemyDetail.decomposeItems`
 * @param {Object} deps - As {@link selfUseDecomposeChain}: `isChainable`, `priceOf`,
 *   `containerValue`, and the optional keep-list fields
 * @returns {{net: number, seconds: number, children: Array<{hrid: string, multiplier: number}>,
 *   partial: boolean, partialItems: string[]}|null}
 *   `net` is terminal value less the step's coin/catalyst/tea spend; null when the step cannot
 *   run or any terminal or bonus drop of its own has no price at all. A bonus crate with only some
 *   contents unpriced counts at its priced part and sets `partial` (a lower bound)
 */
export function decomposeStepTerms(result, outputs, deps) {
    const basis = alchemyRunBasis(result);
    if (!basis || !Array.isArray(outputs)) return null;
    const unitsPerHour = basis.actionsPerHour * basis.bulk;
    let net = -basis.overheadPerHour / unitsPerHour;
    const children = [];
    const partialItems = [];
    for (const output of outputs) {
        const expected = output.count * basis.successRate;
        if (!(expected > 0)) continue;
        if (deps.isChainable(output.itemHrid)) {
            children.push({ hrid: output.itemHrid, multiplier: expected });
            continue;
        }
        const unit = usablePrice(outputPricing(output.itemHrid, deps).priceOf(output.itemHrid));
        if (unit === null) return null;
        net += expected * unit;
    }
    for (const drop of bonusDrops(result)) {
        const units = Number(drop.dropsPerHour) || 0;
        if (units <= 0) continue;
        const pricing = outputPricing(drop.itemHrid, deps);
        const unit = bonusUnitPrice(drop, pricing.priceOf, pricing.containerValue);
        if (unit.value === null) return null;
        // Some contents unpriced: a lower bound, kept rather than dropping the whole step
        if (unit.partlyUnpriced) partialItems.push(drop.itemHrid);
        net += (units / unitsPerHour) * unit.value;
    }
    return { net, seconds: SECONDS_PER_HOUR / unitsPerHour, children, partial: partialItems.length > 0, partialItems };
}

/**
 * Transmute an item you already hold, keep the wanted outputs and sell the
 * rest — versus selling the item instead.
 *
 * The input's cost is what selling it would realize (sell-side price after the
 * character-aware tax); a wanted output is worth what you would pay for it
 * (buy side, untaxed), any other what selling it realizes (after tax). A
 * self-return gives the item back, so it is worth the same as the input,
 * marked or not. Per hour, with `unit` as {@link outputPricing} picks it:
 *   input    = calculatePriceAfterTax(sellPrice)
 *   outputs  = Σ non-self drop: avg(min,max) × bulk × dropRate × successRate × actionsPerHour × unit
 *            + Σ self-return:   avg(min,max) × bulk × dropRate × successRate × actionsPerHour × input
 *            + Σ bonus drop:    dropsPerHour × unit
 *   cost     = input × bulk × actionsPerHour + coin + catalyst + tea (per hour)
 *   net      = outputs − cost;  net per action = net / actionsPerHour
 *
 * @param {Object} result - `calculateTransmuteProfit(itemHrid)`
 * @param {Object} itemDetails - The transmuted item's details (for `transmuteDropTable`)
 * @param {Object} opts
 * @param {number|null} opts.sellPrice - The input's sell-side price, before tax
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price
 * @param {(hrid: string) => number|{value: number|null, partlyUnpriced?: boolean}|null} [opts.containerValue]
 *   A crate's untaxed opened value
 * @param {(hrid: string) => boolean} [opts.isWanted] - Kept outputs ({@link outputPricing})
 * @param {(hrid: string) => number|null} [opts.sellOf] - After-tax sale of an unwanted output
 * @param {Function} [opts.sellContainerValue] - An unwanted crate's opened value, contents sold after tax
 * @returns {Object|null} `{netPerHour, netPerAction, inputValue, outputValuePerHour, costPerHour,
 *   actionsPerHour, successRate, unpriced, partlyUnpriced, kept}` — `kept` lists the outputs the
 *   keep list names, the self-return aside
 */
export function selfUseTransmuteHeld(result, itemDetails, opts) {
    const { sellPrice } = opts;
    const basis = alchemyRunBasis(result);
    const table = itemDetails?.alchemyDetail?.transmuteDropTable;
    const sell = usablePrice(sellPrice);
    if (!basis || !Array.isArray(table) || sell === null) return null;

    const inputValue = calculatePriceAfterTax(sell);
    const selfHrid = result.itemHrid;
    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    const unpriced = [];
    const kept = new Set();
    let partlyUnpriced = false;
    let outputValuePerHour = 0;
    for (const drop of table) {
        const average = (Number(drop.minCount) + Number(drop.maxCount)) / 2;
        const units = average * bulk * (Number(drop.dropRate) || 0) * successRate * actionsPerHour;
        if (!(units > 0)) continue;
        let unit = inputValue;
        if (drop.itemHrid !== selfHrid) {
            const pricing = outputPricing(drop.itemHrid, opts);
            if (pricing.marked) kept.add(drop.itemHrid);
            unit = usablePrice(pricing.priceOf(drop.itemHrid));
        }
        if (unit === null) {
            unpriced.push(drop.itemHrid);
            continue;
        }
        outputValuePerHour += units * unit;
    }
    for (const drop of bonusDrops(result)) {
        const pricing = outputPricing(drop.itemHrid, opts);
        if (pricing.marked) kept.add(drop.itemHrid);
        const value = bonusValuePerHour(drop, pricing.priceOf, pricing.containerValue);
        if (value.value === null) unpriced.push(drop.itemHrid);
        else outputValuePerHour += value.value;
        if (value.partlyUnpriced && value.value !== null) unpriced.push(drop.itemHrid);
        partlyUnpriced ||= value.partlyUnpriced;
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
        partlyUnpriced: unpriced.length > 0 || partlyUnpriced,
        kept: [...kept],
    };
}

/**
 * What one unit of an item costs when you get it out of alchemy instead of buying it.
 *
 * The source item is bought at `inputPrice` and decomposed or transmuted; the
 * target is the output you are after, and every other output is kept or sold
 * the way {@link outputPricing} picks (a kept one at the untaxed buy side, any
 * other at its after-tax sale). A transmute's self-return gives the source back,
 * so it is worth what the source cost. Per action, from the calculator result:
 *   spend          = inputPrice × bulk + (coin + catalyst + tea per hour) / actionsPerHour
 *   target units   = Σ target output: count × bulk × successRate (decompose)
 *                                     avg(min,max) × bulk × dropRate × successRate (transmute)
 *                  + a bonus drop that is the target: dropsPerHour / actionsPerHour
 *   credit         = Σ every other output × its unit value (self-return at inputPrice)
 *   cost per unit  = (spend − credit) / target units
 *   seconds / unit = 3600 / actionsPerHour / target units
 *
 * An unpriced other output is left out of the credit, so a partly unpriced cost
 * is an upper bound: buying could only be beaten by more, never by less.
 *
 * @param {Object} result - `calculateDecomposeProfit` / `calculateTransmuteProfit` (or one candidate) for the source
 * @param {Object} sourceDetails - The source item's details (`alchemyDetail`)
 * @param {Object} opts
 * @param {'decompose'|'transmute'|'coinify'} opts.actionType - Coinify's output is its coins, at face value
 * @param {string} opts.targetHrid - The item to obtain
 * @param {number|null} opts.inputPrice - What one unit of the source costs
 * @param {(hrid: string) => number|null} opts.priceOf - Untaxed buy-side price (kept outputs)
 * @param {Function} [opts.containerValue] - A kept crate's untaxed opened value
 * @param {(hrid: string) => boolean} [opts.isWanted] - Kept outputs ({@link outputPricing})
 * @param {(hrid: string) => number|null} [opts.sellOf] - After-tax sale of an unwanted output
 * @param {Function} [opts.sellContainerValue] - An unwanted crate's opened value, contents sold after tax
 * @returns {Object|null} `{costPerUnit, secondsPerUnit, targetPerAction, spendPerAction, creditPerAction,
 *   actionsPerHour, successRate, unpriced, partlyUnpriced, kept}`, or null when the source cannot run
 *   or never yields the target
 */
export function alchemySourceUnitCost(result, sourceDetails, opts) {
    const { actionType, targetHrid } = opts;
    const basis = alchemyRunBasis(result);
    const input = usablePrice(opts.inputPrice);
    const alchemy = sourceDetails?.alchemyDetail;
    if (!basis || input === null || !targetHrid) return null;

    const { actionsPerHour, bulk, successRate, overheadPerHour } = basis;
    let outputs = null;
    if (actionType === 'decompose' && Array.isArray(alchemy?.decomposeItems)) {
        outputs = alchemy.decomposeItems.map((output) => ({
            itemHrid: output?.itemHrid,
            units: (Number(output?.count) || 0) * bulk * successRate,
        }));
    } else if (actionType === 'coinify' && alchemy) {
        // The coins are the calculator's own count (sell price × bulk × 5), worth their face value
        const coins = (Array.isArray(result.dropRevenues) ? result.dropRevenues : []).find(
            (drop) => drop?.itemHrid === COIN_HRID && !drop.isEssence && !drop.isRare
        );
        outputs = [{ itemHrid: COIN_HRID, units: (Number(coins?.count) || 0) * successRate }];
    } else if (actionType === 'transmute' && Array.isArray(alchemy?.transmuteDropTable)) {
        outputs = alchemy.transmuteDropTable.map((drop) => ({
            itemHrid: drop?.itemHrid,
            units:
                ((Number(drop?.minCount) + Number(drop?.maxCount)) / 2) *
                bulk *
                (Number(drop?.dropRate) || 0) *
                successRate,
        }));
    }
    if (!outputs) return null;

    const sourceHrid = result.itemHrid;
    const unpriced = [];
    const kept = new Set();
    let partlyUnpriced = false;
    let targetPerAction = 0;
    let creditPerAction = 0;
    for (const { itemHrid, units } of outputs) {
        if (!(units > 0)) continue;
        if (itemHrid === targetHrid) {
            targetPerAction += units;
            continue;
        }
        if (itemHrid === sourceHrid) {
            creditPerAction += units * input;
            continue;
        }
        if (itemHrid === COIN_HRID) {
            creditPerAction += units;
            continue;
        }
        const pricing = outputPricing(itemHrid, opts);
        if (pricing.marked) kept.add(itemHrid);
        const unit = usablePrice(pricing.priceOf(itemHrid));
        if (unit === null) unpriced.push(itemHrid);
        else creditPerAction += units * unit;
    }
    for (const drop of bonusDrops(result)) {
        const units = (Number(drop.dropsPerHour) || 0) / actionsPerHour;
        if (!(units > 0)) continue;
        if (drop.itemHrid === targetHrid) {
            targetPerAction += units;
            continue;
        }
        const pricing = outputPricing(drop.itemHrid, opts);
        if (pricing.marked) kept.add(drop.itemHrid);
        const unit = bonusUnitPrice(drop, pricing.priceOf, pricing.containerValue);
        if (unit.value === null) unpriced.push(drop.itemHrid);
        else creditPerAction += units * unit.value;
        if (unit.partlyUnpriced && unit.value !== null) unpriced.push(drop.itemHrid);
        partlyUnpriced ||= unit.partlyUnpriced;
    }
    if (!(targetPerAction > 0)) return null;

    const spendPerAction = input * bulk + overheadPerHour / actionsPerHour;
    return {
        costPerUnit: (spendPerAction - creditPerAction) / targetPerAction,
        secondsPerUnit: SECONDS_PER_HOUR / actionsPerHour / targetPerAction,
        targetPerAction,
        spendPerAction,
        creditPerAction,
        actionsPerHour,
        successRate,
        unpriced,
        partlyUnpriced: unpriced.length > 0 || partlyUnpriced,
        kept: [...kept],
    };
}
