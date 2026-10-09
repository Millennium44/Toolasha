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
 * unpriced and the item without a figure.
 *
 * Intermediate steps and candidate setups are memoised per price snapshot in
 * module-level caches; whoever knows the prices or the character's setup moved
 * calls {@link clearDecomposeChainCaches}.
 */

import dataManager from '../core/data-manager.js';
import alchemyProfitCalculator from '../features/market/alchemy-profit-calculator.js';
import { withProfitPricingMode, getItemPriceInfo, isPriceEstimated } from './market-data.js';
import { calculatePriceAfterTax } from './profit-helpers.js';
import {
    bestSelfUseCandidate,
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

/**
 * Forget every memoised step and candidate setup.
 * @returns {void}
 */
export function clearDecomposeChainCaches() {
    decomposeStepCache.clear();
    decomposeCandidateCache.clear();
}

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
            const containerValue = (hrid) =>
                untaxedContainerValue(hrid, {
                    containerDrops: (h) => dataManager.getInitClientData?.()?.openableLootDropMap?.[h] ?? null,
                    priceOf,
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

            // The mode ranks by gold per hour of the whole chain (net over the summed
            // seconds of every step), which is a ratio and cannot be maximized one step
            // at a time exactly. The two levels are handled like this: a child step
            // picks the setup that maximizes the per-hour figure of its own sub-chain
            // (input cost left at 0, children memoised per price snapshot); the item's
            // own top step then re-picks over its candidates against those fixed
            // children, with its real ask in, so the ranked figure is optimized on the
            // whole chain's per-hour value. A step that cannot be scored per hour (some
            // branch unpriced) falls back to scoring its own outputs.
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

            const first = step(itemHrid);
            if (!first) return;
            // The ask is paid in coins at the book: an estimated ask is not a price to buy at
            const ask = isPriceEstimated(itemHrid, { context: 'profit', side: 'buy' })
                ? null
                : (first.requirementCosts?.[0]?.price ?? null);
            const top = ask === null ? first : (pickStep(itemHrid, ask, step)?.result ?? first);
            chain = selfUseDecomposeChain(itemHrid, {
                ...chainDeps,
                getDecompose: (h) => (h === itemHrid ? top : step(h)),
                ownUseCost: ask,
            });
            // The calculator result the item's own step was priced with (its catalyst and teas)
            if (chain) chain = { ...chain, topStep: top };
        });
    } catch (error) {
        console.error('[DecomposeChain] Chain failed for', itemHrid, error);
    }
    return chain;
}
