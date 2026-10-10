/**
 * The value of an item's whole decompose chain, bought at the ask and sold at the bid.
 *
 * Shared by the marketplace sort's chain mode and the Alchemy panel's Best Items
 * tab, so the two rank the same way off the same arithmetic. The chain walk is
 * `selfUseDecomposeChain`'s (the item tooltip's chain line runs it too); this
 * supplies the seller's prices instead of the tooltip's keep-it prices: the top
 * item costs its real ask, every terminal output is worth its real bid after
 * market tax. Each step is the calculator's own decompose result, pinned to
 * conservative pricing, so a step with no market data leaves the chain partly
 * unpriced and the item without a figure. A bonus crate is the exception: its
 * contents are priced like the tooltip prices them (Coin, tokens, Cowbells, shop
 * conversions), and a crate with some contents still unpriced counts at its priced
 * part, flagged `partial` on the result, instead of sinking the chain.
 *
 * The mode ranks by gold per hour of the whole chain, (Σ net) / (Σ seconds), so a
 * step's best setup depends on the chain around it: a setup that is best per hour on
 * its own can lose in a chain that already earns little per second. Every step's
 * catalyst/tea setup is therefore chosen jointly, by {@link maximizeChainRatio}.
 *
 * Candidate setups, their per-step terms and intermediate steps are memoised per
 * price snapshot in module-level caches; whoever knows the prices or the character's
 * setup moved calls {@link clearDecomposeChainCaches}.
 */

import dataManager from '../core/data-manager.js';
import alchemyProfitCalculator from '../features/market/alchemy-profit-calculator.js';
import expectedValueCalculator from '../features/market/expected-value-calculator.js';
import { withProfitPricingMode, getItemPriceInfo, isPriceEstimated } from './market-data.js';
import { calculatePriceAfterTax } from './profit-helpers.js';
import { getAlchemyOutputShopValue } from './alchemy-shop-value.js';
import { DUNGEON_TOKEN_HRIDS, calculateDungeonTokenValue } from './token-valuation.js';
import {
    CHAIN_MAX_DEPTH,
    bestSelfUseCandidate,
    decomposeStepTerms,
    selfUseDecompose,
    selfUseDecomposeChain,
    untaxedContainerValue,
} from './self-use-alchemy.js';

/** Ask in, bid out — the flow the chain quotes, regardless of the global setting */
const CHAIN_PRICING_MODE = 'conservative';

/**
 * Decompose calculator results per piece of gear: a chain reaches the same
 * intermediate gear from many items, so each is priced once per snapshot.
 */
const decomposeStepCache = new Map();
const decomposeCandidateCache = new Map();
/** Per-unit step terms of every priced candidate setup, per piece of gear */
const decomposeTermsCache = new Map();
/** Longest line of decomposable gear below each piece (Infinity on a cycle) */
const decomposeHeightCache = new Map();

/** Iteration cap for {@link maximizeChainRatio}; real chains settle in two to four */
export const MAX_RATIO_ITERATIONS = 32;

/**
 * Forget every memoised step and candidate setup.
 * @returns {void}
 */
export function clearDecomposeChainCaches() {
    decomposeStepCache.clear();
    decomposeCandidateCache.clear();
    decomposeTermsCache.clear();
    decomposeHeightCache.clear();
}

/**
 * Pick one setup per piece of gear to maximize a chain's (Σ net − rootCost) / (Σ seconds).
 *
 * Dinkelbach's iteration: for a guess λ, every step maximizes net − λ·seconds of its own
 * sub-tree, which separates bottom-up because a child's sub-tree enters its parent
 * linearly (weighted by the parent setup's expected units of it). The picked chain's
 * ratio becomes the next λ; the ratio rises every round and stops once a round cannot
 * beat it, which is the exact optimum over every combination of setups. Step terms
 * come from `termsOf` and are not recomputed between rounds.
 *
 * @param {string} rootHrid
 * @param {Object} opts
 * @param {(hrid: string) => Array<{result: *, net: number, seconds: number,
 *   children: Array<{hrid: string, multiplier: number}>}>|null} opts.termsOf - Priced setups of a step,
 *   per unit arriving ({@link decomposeStepTerms}); the gear tree must be acyclic
 * @param {number} opts.rootCost - Paid once per root unit (its ask)
 * @param {number} [opts.maxIterations=MAX_RATIO_ITERATIONS]
 * @returns {{selection: Map<string, *>, net: number, seconds: number, ratio: number, iterations: number,
 *   converged: boolean}|null} `selection` maps each step to its picked `result`; `ratio` is per second.
 *   Null when the chain cannot be priced under any combination of setups.
 */
export function maximizeChainRatio(rootHrid, { termsOf, rootCost, maxIterations = MAX_RATIO_ITERATIONS }) {
    // Best setup per step for one λ, bottom-up; a step's score is its sub-tree's net − λ·seconds
    const pickAll = (lambda) => {
        const picks = new Map();
        const score = (hrid) => {
            if (picks.has(hrid)) return picks.get(hrid)?.score ?? null;
            picks.set(hrid, null); // a cycle back here reads as unsolvable
            let best = null;
            for (const option of termsOf(hrid) ?? []) {
                let value = option.net - lambda * option.seconds;
                for (const child of option.children) {
                    const sub = score(child.hrid);
                    if (sub === null) {
                        value = NaN;
                        break;
                    }
                    value += child.multiplier * sub;
                }
                if (Number.isFinite(value) && (!best || value > best.score)) best = { score: value, option };
            }
            picks.set(hrid, best);
            return best?.score ?? null;
        };
        return score(rootHrid) === null ? null : picks;
    };
    // The picked chain's net and seconds per root unit
    const totalsOf = (picks) => {
        const totals = new Map();
        const total = (hrid) => {
            if (totals.has(hrid)) return totals.get(hrid);
            const { option } = picks.get(hrid);
            let net = option.net;
            let seconds = option.seconds;
            for (const child of option.children) {
                const sub = total(child.hrid);
                net += child.multiplier * sub.net;
                seconds += child.multiplier * sub.seconds;
            }
            const entry = { net, seconds };
            totals.set(hrid, entry);
            return entry;
        };
        return total(rootHrid);
    };

    let best = null;
    let lambda = 0;
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
        const picks = pickAll(lambda);
        if (!picks) return null;
        const { net, seconds } = totalsOf(picks);
        const ratio = (net - rootCost) / seconds;
        const converged = best !== null && ratio <= best.ratio + 1e-12 * Math.max(1, Math.abs(best.ratio));
        if (best === null || ratio > best.ratio) {
            const selection = new Map();
            for (const [hrid, pick] of picks) if (pick) selection.set(hrid, pick.option.result);
            best = { selection, net: net - rootCost, seconds, ratio, iterations: iteration, converged: false };
        }
        best.iterations = iteration;
        if (converged) {
            best.converged = true;
            return best;
        }
        lambda = ratio;
    }
    return best;
}

/** Sell-side resolver sources that are not a market price: Coin, Cowbells, dungeon tokens, nested crates */
const NON_MARKET_SOURCES = new Set(['coin', 'cowbell', 'dungeonToken', 'expectedValue']);

/**
 * The whole decompose chain of an item, ask in and taxed bid out.
 *
 * @param {string} itemHrid - Item HRID
 * @returns {Object|null} The chain result, plus `topStep`, the item's own chosen setup (`netPerHour` is null when any step is unpriced), or null when the item cannot be decomposed
 */
export function decomposeChain(itemHrid) {
    let chain = null;
    try {
        withProfitPricingMode(CHAIN_PRICING_MODE, () => {
            // Insta-sell value of an output: its real bid after market tax. An
            // estimate from the official value map is no bid anyone can sell into,
            // so it leaves the chain unpriced rather than ranking on a guess.
            const priceOf = (hrid) => {
                const info = getItemPriceInfo(hrid, { context: 'profit', side: 'sell' });
                if (info.price === null || info.price === undefined || info.estimated) return null;
                return calculatePriceAfterTax(info.price);
            };
            // A crate's contents are sold the way the item tooltip sells them: Coin at face
            // value, Cowbells, dungeon tokens and nested crates through the sell-side resolver
            // (taxed where it says so), a shop-only content as its conversion after tax, and
            // anything else at its real bid. Only the crate's contents get this latitude; the top
            // item's ask and the base outputs stay on the strict real-price rule.
            const contentPriceOf = (hrid) => {
                // A token's shop conversion follows the user's pricing setting, which the conservative
                // override above does not reach; this chain sells instantly, so pin it to the bid
                if (DUNGEON_TOKEN_HRIDS.has(hrid)) {
                    return calculateDungeonTokenValue(hrid, 'profitCalc_pricingMode', false);
                }
                const resolved = expectedValueCalculator.resolveSellSideValue?.(hrid);
                // Only the resolver's non-market sources pass as they are; an ordinary item's
                // market, custom or value-map figure needs a real order-book bid below
                if (resolved && NON_MARKET_SOURCES.has(resolved.source) && Number.isFinite(resolved.value)) {
                    return resolved.needsTax ? calculatePriceAfterTax(resolved.value) : resolved.value;
                }
                // An order-book bid only: a custom sell price is no bid anyone can sell into
                const info = getItemPriceInfo(hrid, { context: 'profit', side: 'sell' });
                if (info.source === 'book' && info.price > 0 && !info.estimated) {
                    return calculatePriceAfterTax(info.price);
                }
                const shop = getAlchemyOutputShopValue(hrid, { side: 'sell' });
                return shop ? calculatePriceAfterTax(shop.valuePerUnit) : null;
            };
            const containerValue = (hrid) =>
                untaxedContainerValue(hrid, {
                    containerDrops: (h) => dataManager.getInitClientData?.()?.openableLootDropMap?.[h] ?? null,
                    priceOf: contentPriceOf,
                });
            const chainDeps = {
                getItemDetails: (hrid) => dataManager.getItemDetails(hrid),
                isChainable: (hrid) => {
                    const details = dataManager.getItemDetails(hrid);
                    return Boolean(details?.equipmentDetail && details.alchemyDetail?.decomposeItems?.length);
                },
                priceOf,
                containerValue,
            };
            // A setup that needs a catalyst or tea with no real ask cannot be insta-bought,
            // whatever the value-map estimate says it costs, so it is not a candidate.
            const buyable = (result) =>
                ![result?.winningCatalystHrid, ...(result?.consumableCosts ?? []).map((c) => c?.itemHrid)]
                    .filter(Boolean)
                    .some((hrid) => isPriceEstimated(hrid, { context: 'profit', side: 'buy' }));
            const candidatesOf = (hrid) => {
                if (!decomposeCandidateCache.has(hrid)) {
                    let list = [];
                    try {
                        list = alchemyProfitCalculator.calculateCandidateResults?.('decompose', hrid) ?? [];
                        if (list.length === 0) {
                            list = [alchemyProfitCalculator.calculateDecomposeProfit(hrid, 0)].filter(Boolean);
                        }
                    } catch {
                        list = [];
                    }
                    decomposeCandidateCache.set(hrid, list.filter(buyable));
                }
                return decomposeCandidateCache.get(hrid);
            };
            const termsOf = (hrid) => {
                if (!decomposeTermsCache.has(hrid)) {
                    const outputs = dataManager.getItemDetails(hrid)?.alchemyDetail?.decomposeItems;
                    const terms = [];
                    for (const result of candidatesOf(hrid)) {
                        const stepTerms = decomposeStepTerms(result, outputs, chainDeps);
                        if (stepTerms) terms.push({ ...stepTerms, result });
                    }
                    decomposeTermsCache.set(hrid, terms);
                }
                return decomposeTermsCache.get(hrid);
            };
            const heightOf = (hrid, path = new Set()) => {
                if (decomposeHeightCache.has(hrid)) return decomposeHeightCache.get(hrid);
                if (path.has(hrid)) return Infinity;
                const inner = new Set([...path, hrid]);
                let height = 0;
                for (const output of dataManager.getItemDetails(hrid)?.alchemyDetail?.decomposeItems ?? []) {
                    if (!(Number(output?.count) > 0) || !chainDeps.isChainable(output.itemHrid)) continue;
                    height = Math.max(height, 1 + heightOf(output.itemHrid, inner));
                }
                // Path-independent either way: a cycle met below runs back through this gear
                decomposeHeightCache.set(hrid, height);
                return height;
            };

            // The fallback when the joint pick cannot run: a child step picks the setup
            // that maximizes the per-hour figure of its own sub-chain (input cost left at
            // 0, children memoised per price snapshot); the item's own top step then
            // re-picks over its candidates against those fixed children, with its real
            // ask in. A step that cannot be scored per hour (some branch unpriced) falls
            // back to scoring its own outputs.
            const pickStep = (hrid, ownUseCost, getChild) => {
                const details = dataManager.getItemDetails(hrid);
                const candidates = candidatesOf(hrid);
                return (
                    bestSelfUseCandidate(
                        candidates,
                        (result) =>
                            selfUseDecomposeChain(hrid, {
                                ...chainDeps,
                                getDecompose: (h) => (h === hrid ? result : getChild(h)),
                                ownUseCost,
                            }),
                        'netPerHour'
                    ) ??
                    bestSelfUseCandidate(
                        candidates,
                        (result) => selfUseDecompose(result, details, { ownUseCost, priceOf, containerValue }),
                        'netPerHour'
                    )
                );
            };
            const step = (hrid) => {
                if (decomposeStepCache.has(hrid)) return decomposeStepCache.get(hrid);
                // Placeholder first, so a cycle back to this step reads as unknown
                decomposeStepCache.set(hrid, null);
                decomposeStepCache.set(hrid, pickStep(hrid, 0, step)?.result ?? null);
                return decomposeStepCache.get(hrid);
            };

            // The ask is paid in coins at the book: an estimated ask is not a price to buy at
            const askOf = (result) =>
                isPriceEstimated(itemHrid, { context: 'profit', side: 'buy' })
                    ? null
                    : (result?.requirementCosts?.[0]?.price ?? null);

            // Every step's setup chosen jointly on the whole chain's gold per hour, when the
            // tree can be priced and walks without a cycle or reaching the depth cap
            const ask = askOf(candidatesOf(itemHrid)[0]);
            if (ask !== null && Number.isFinite(Number(ask)) && heightOf(itemHrid) <= CHAIN_MAX_DEPTH) {
                const solved = maximizeChainRatio(itemHrid, { termsOf, rootCost: Number(ask) });
                if (solved) {
                    chain = selfUseDecomposeChain(itemHrid, {
                        ...chainDeps,
                        getDecompose: (h) => solved.selection.get(h) ?? null,
                        ownUseCost: ask,
                    });
                    // The calculator result the item's own step was priced with (its catalyst and teas)
                    if (chain) chain = { ...chain, topStep: solved.selection.get(itemHrid) };
                    return;
                }
            }

            const first = step(itemHrid);
            if (!first) return;
            const firstAsk = askOf(first);
            const top = firstAsk === null ? first : (pickStep(itemHrid, firstAsk, step)?.result ?? first);
            chain = selfUseDecomposeChain(itemHrid, {
                ...chainDeps,
                getDecompose: (h) => (h === itemHrid ? top : step(h)),
                ownUseCost: firstAsk,
            });
            // The calculator result the item's own step was priced with (its catalyst and teas)
            if (chain) chain = { ...chain, topStep: top };
        });
    } catch (error) {
        console.error('[DecomposeChain] Chain failed for', itemHrid, error);
    }
    return chain;
}
