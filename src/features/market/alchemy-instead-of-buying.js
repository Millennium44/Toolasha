/**
 * "Instead of buying" — the cheapest alchemy route to an item you are about to buy.
 *
 * On the tooltip of an item T (a Goblin Essence before an enhancing session),
 * every item S whose decompose outputs or transmute drop table include T is a
 * way to get T without buying it: buy S at its ask, run the action, keep T and
 * sell (or keep) everything else. The arithmetic per unit of T is
 * `alchemySourceUnitCost` in `utils/self-use-alchemy.js`; this module finds the
 * sources, picks each one's best catalyst/tea setup, prices them and compares
 * the result with T's ask.
 *
 * Prices are a real purchase's: S, T, catalysts and teas at the ask; other
 * outputs at the bid after the character's tax, or at the ask when the player
 * marked them "Keep for self-use". A value-map estimate is no ask anyone can buy
 * at, so an estimated S or T, or a setup that needs an estimated catalyst or tea,
 * is left out — the same rule the marketplace's decompose-chain sort follows.
 *
 * With a gold rate set, the alchemy time is charged at that rate: the line then
 * appears only when the route still beats buying after paying for your time.
 *
 * Results are cached per target for one price snapshot (market fetch, character,
 * keep list, gold rate, five-minute bucket), and the per-source calculator runs
 * are shared across targets in the same snapshot, so a repeat hover reads a map.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
import expectedValueCalculator from './expected-value-calculator.js';
import { getItemPriceInfo, withProfitPricingMode } from '../../utils/market-data.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { alchemySourceUnitCost, bestSelfUseCandidate, untaxedContainerValue } from '../../utils/self-use-alchemy.js';

/** The setting that draws the lines */
export const INSTEAD_SETTING = 'itemTooltip_alchemyInsteadOfBuying';
/** Your gold per hour; 0 leaves alchemy time free */
export const GOLD_RATE_SETTING = 'itemTooltip_alchemyInsteadGoldPerHour';

/** Most alternatives shown */
export const MAX_ALTERNATIVES = 2;

/** Ask in, bid out, for every calculator price read under this module */
const PURCHASE_PRICING_MODE = 'conservative';

/** How long a cached figure lives even without a price refresh (gear and skills move) */
const CACHE_BUCKET_MS = 5 * 60 * 1000;

let sourceIndex = null;
let sourceIndexOf = null;

/**
 * Every alchemy source of every item, from the client's item details: which
 * items decompose into it, and which transmute into it (a self-return aside).
 * Built once per item-detail map.
 * @param {Object} itemDetailMap
 * @returns {Map<string, Array<{sourceHrid: string, actionType: 'decompose'|'transmute'}>>}
 */
export function buildSourceIndex(itemDetailMap) {
    const index = new Map();
    const add = (targetHrid, sourceHrid, actionType) => {
        if (!targetHrid || targetHrid === sourceHrid) return;
        const list = index.get(targetHrid) || [];
        if (!list.some((s) => s.sourceHrid === sourceHrid && s.actionType === actionType)) {
            list.push({ sourceHrid, actionType });
        }
        index.set(targetHrid, list);
    };
    for (const [sourceHrid, details] of Object.entries(itemDetailMap || {})) {
        const alchemy = details?.alchemyDetail;
        if (!alchemy) continue;
        for (const output of alchemy.decomposeItems || []) add(output?.itemHrid, sourceHrid, 'decompose');
        for (const drop of alchemy.transmuteDropTable || []) add(drop?.itemHrid, sourceHrid, 'transmute');
    }
    return index;
}

/**
 * The alchemy sources of one item, from the cached index.
 * @param {string} targetHrid
 * @returns {Array<{sourceHrid: string, actionType: 'decompose'|'transmute'}>}
 */
export function sourcesOf(targetHrid) {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap;
    if (!itemDetailMap) return [];
    if (sourceIndex === null || sourceIndexOf !== itemDetailMap) {
        sourceIndex = buildSourceIndex(itemDetailMap);
        sourceIndexOf = itemDetailMap;
    }
    return sourceIndex.get(targetHrid) || [];
}

/**
 * Find the alchemy routes to one item that beat buying it.
 *
 * Pure apart from what `deps` reaches; every price and calculator result comes
 * through it, so the arithmetic can be driven without a market.
 *
 * @param {string} targetHrid
 * @param {Object} deps
 * @param {Array<{sourceHrid: string, actionType: string}>} deps.sources - Items that yield the target
 * @param {(hrid: string) => Object|null} deps.getItemDetails
 * @param {(hrid: string) => number|null} deps.askOf - A real ask, null when unpriced or estimated
 * @param {(hrid: string) => number|null} deps.sellOf - A real bid after tax, null when unpriced or estimated
 * @param {(actionType: string, hrid: string) => Array<Object>} deps.candidatesOf - Calculator results, one
 *   per buyable catalyst/tea setup
 * @param {(hrid: string) => boolean} [deps.isWanted] - The keep list; absent, nothing is kept
 * @param {Function} [deps.containerValue] - A kept crate's opened value at the ask
 * @param {Function} [deps.sellContainerValue] - An unwanted crate's opened value, contents sold after tax
 * @param {number} [deps.goldPerHour=0] - The player's gold rate; 0 leaves time free
 * @param {number} [deps.limit=MAX_ALTERNATIVES]
 * @returns {{targetAsk: number|null, alternatives: Array<Object>}} Alternatives cheapest first, each
 *   `{sourceHrid, actionType, costPerUnit, timeCostPerUnit, effectiveCost, saving, savingPerHour,
 *   secondsPerUnit, partlyUnpriced, kept, result}`; empty when buying is cheapest
 */
export function findAlchemyAlternatives(targetHrid, deps) {
    const { sources, getItemDetails, askOf, sellOf, candidatesOf, isWanted, containerValue, sellContainerValue } = deps;
    const goldPerHour = Math.max(0, Number(deps.goldPerHour) || 0);
    const limit = deps.limit ?? MAX_ALTERNATIVES;
    const targetAsk = askOf(targetHrid);
    if (targetAsk === null || !(targetAsk > 0)) return { targetAsk: null, alternatives: [] };

    // Without a keep list nothing is kept: every other output is sold
    const pricing = {
        priceOf: askOf,
        containerValue,
        isWanted: typeof isWanted === 'function' ? isWanted : () => false,
        sellOf,
        sellContainerValue,
    };
    const alternatives = [];
    for (const { sourceHrid, actionType } of sources || []) {
        const inputPrice = askOf(sourceHrid);
        if (inputPrice === null) continue;
        const details = getItemDetails(sourceHrid);
        if (!details) continue;
        const timeCost = (evaluation) => (evaluation.secondsPerUnit / 3600) * goldPerHour;
        const pick = bestSelfUseCandidate(
            candidatesOf(actionType, sourceHrid),
            (result) => {
                const evaluation = alchemySourceUnitCost(result, details, {
                    ...pricing,
                    actionType,
                    targetHrid,
                    inputPrice,
                });
                if (!evaluation) return null;
                return { ...evaluation, score: -(evaluation.costPerUnit + timeCost(evaluation)) };
            },
            'score'
        );
        const evaluation = pick?.evaluation;
        if (!evaluation) continue;
        const timeCostPerUnit = timeCost(evaluation);
        const effectiveCost = evaluation.costPerUnit + timeCostPerUnit;
        const saving = targetAsk - effectiveCost;
        if (!(saving > 0)) continue;
        alternatives.push({
            sourceHrid,
            actionType,
            costPerUnit: evaluation.costPerUnit,
            timeCostPerUnit,
            effectiveCost,
            saving,
            // Per hour of alchemy: the saving rate, over and above the gold rate when one is set
            savingPerHour: evaluation.secondsPerUnit > 0 ? (saving * 3600) / evaluation.secondsPerUnit : null,
            secondsPerUnit: evaluation.secondsPerUnit,
            partlyUnpriced: evaluation.partlyUnpriced,
            kept: evaluation.kept,
            result: pick.result,
        });
    }
    alternatives.sort((a, b) => a.effectiveCost - b.effectiveCost);
    return { targetAsk, alternatives: alternatives.slice(0, limit) };
}

// ---- Live wiring: the market, the calculator and the keep list ----

const candidateCache = new Map();
const resultCache = new Map();
let cacheStamp = null;

/**
 * The snapshot every cached figure belongs to; a change empties both caches.
 * @returns {string}
 */
function priceSnapshot() {
    return [
        marketAPI?.lastFetchTimestamp ?? '',
        dataManager.currentCharacterId ?? '',
        Math.floor(Date.now() / CACHE_BUCKET_MS),
    ].join('|');
}

/**
 * Forget every cached figure.
 * @returns {void}
 */
export function clearInsteadCache() {
    candidateCache.clear();
    resultCache.clear();
    cacheStamp = null;
    sourceIndex = null;
    sourceIndexOf = null;
}

/**
 * A price you could actually trade at, on one side: the book's, never a value-map estimate.
 * @param {string} hrid
 * @param {'ask'|'bid'} mode
 * @returns {number|null}
 */
function realPrice(hrid, mode) {
    const info = getItemPriceInfo(hrid, { mode, marketQuote: true });
    if (info.price === null || info.price === undefined || info.estimated) return null;
    return info.price;
}

/**
 * A setup is buyable when its catalyst and teas have real asks.
 * @param {Object} result
 * @returns {boolean}
 */
function buyableSetup(result) {
    return ![result?.winningCatalystHrid, ...(result?.consumableCosts ?? []).map((c) => c?.itemHrid)]
        .filter(Boolean)
        .some((hrid) => realPrice(hrid, 'ask') === null);
}

/**
 * Every buyable catalyst/tea setup of one action on one source, cached per snapshot.
 * @param {string} actionType
 * @param {string} hrid
 * @returns {Array<Object>}
 */
function liveCandidates(actionType, hrid) {
    const key = `${actionType}|${hrid}`;
    if (!candidateCache.has(key)) {
        let list = [];
        try {
            withProfitPricingMode(PURCHASE_PRICING_MODE, () => {
                list = alchemyProfitCalculator.calculateCandidateResults?.(actionType, hrid) ?? [];
                if (list.length === 0) {
                    const single =
                        actionType === 'decompose'
                            ? alchemyProfitCalculator.calculateDecomposeProfit(hrid, 0)
                            : alchemyProfitCalculator.calculateTransmuteProfit(hrid);
                    list = [single].filter(Boolean);
                }
                list = list.filter(buyableSetup);
            });
        } catch (error) {
            console.error('[AlchemyInstead] Candidate setups failed for', hrid, error);
            list = [];
        }
        candidateCache.set(key, list);
    }
    return candidateCache.get(key);
}

/**
 * The live alternatives for one item, cached per snapshot.
 * @param {string} targetHrid
 * @param {Set<string>} wanted - The character's keep list
 * @returns {{targetAsk: number|null, alternatives: Array<Object>}}
 */
export function liveAlternatives(targetHrid, wanted) {
    const stamp = priceSnapshot();
    if (stamp !== cacheStamp) {
        candidateCache.clear();
        resultCache.clear();
        cacheStamp = stamp;
    }
    const goldPerHour = Math.max(0, Number(config.getSetting(GOLD_RATE_SETTING)) || 0);
    const keepKey = [...(wanted || [])].sort().join(',');
    const key = `${targetHrid}|${goldPerHour}|${keepKey}`;
    if (resultCache.has(key)) return resultCache.get(key);

    const sources = sourcesOf(targetHrid);
    let found = { targetAsk: null, alternatives: [] };
    if (sources.length > 0) {
        const askOf = (hrid) => realPrice(hrid, 'ask');
        const sellOf = (hrid) => {
            const bid = realPrice(hrid, 'bid');
            return bid === null ? null : calculatePriceAfterTax(bid);
        };
        const containerDrops = (h) => dataManager.getInitClientData?.()?.openableLootDropMap?.[h] ?? null;
        const crates = new Map();
        const containerValue = (hrid) => {
            if (!crates.has(`k|${hrid}`)) {
                crates.set(
                    `k|${hrid}`,
                    untaxedContainerValue(hrid, {
                        containerDrops,
                        priceOf: (h) => expectedValueCalculator.resolveBuySideValue?.(h)?.value ?? askOf(h),
                    })
                );
            }
            return crates.get(`k|${hrid}`);
        };
        const sellContainerValue = (hrid) => {
            if (!crates.has(`s|${hrid}`)) {
                crates.set(
                    `s|${hrid}`,
                    untaxedContainerValue(hrid, {
                        containerDrops,
                        priceOf: (h) => {
                            const resolved = expectedValueCalculator.resolveSellSideValue?.(h);
                            if (resolved && Number.isFinite(resolved.value)) {
                                return resolved.needsTax ? calculatePriceAfterTax(resolved.value) : resolved.value;
                            }
                            return sellOf(h);
                        },
                    })
                );
            }
            return crates.get(`s|${hrid}`);
        };
        found = findAlchemyAlternatives(targetHrid, {
            sources,
            getItemDetails: (hrid) => dataManager.getItemDetails(hrid),
            askOf,
            sellOf,
            candidatesOf: liveCandidates,
            isWanted: (hrid) => Boolean(wanted?.has(hrid)),
            containerValue,
            sellContainerValue,
            goldPerHour,
        });
    }
    resultCache.set(key, found);
    return found;
}
