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
 * Results are cached per target for one price snapshot (market fetch, price-update
 * notification or value-map push, character, keep list, gold rate, five-minute bucket), so a
 * repeat hover reads a map. The per-source calculator runs (about 2 ms each) are shared across
 * targets and kept across a price change that leaves the prices they ran on alone. A target
 * with more than a few sources still to run is worked out off the hover, in slices that yield
 * to the page, and the tooltip fills its line in when that is done.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
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
            'score',
            // Missing credits make each cost an upper bound, so the lowest partial one is the pick
            { rankPartial: true }
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

/**
 * Most uncached calculator runs one hover call makes itself (one run is every catalyst/tea
 * setup of one source, about 2 ms). A target with more sources to run than this is worked
 * out in the background, a slice at a time, and the tooltip line drawn when it is done.
 */
export const SYNC_SOURCE_RUNS = 4;

/** How long one background slice runs before it yields to the page */
const SLICE_MS = 8;

/** Background passes before a job stops re-checking a cache that prices keep emptying */
const MAX_JOB_PASSES = 3;

/** The catalysts every setup search weighs, as the calculator names them */
const CATALYST_HRIDS = {
    decompose: '/items/catalyst_of_decomposition',
    transmute: '/items/catalyst_of_transmutation',
    prime: '/items/prime_catalyst',
};

/**
 * Per source: `{raw, signature, generation, list}` — the calculator's setups, the prices they
 * were run on, and the buyable ones under the price snapshot last checked
 */
const candidateCache = new Map();
/** Per target, gold rate and keep list: the finished alternatives */
const resultCache = new Map();
/** Character and five-minute bucket: a change empties both caches */
let candidateStamp = null;
/** Every price input as well: a change empties the result cache only */
let resultStamp = null;
/** Running background jobs, by result key */
const jobs = new Map();
/** Bumped by clearInsteadCache, so a running job knows its caches went away */
let jobEpoch = 0;
/** The setup prices of one action type, memoized per price snapshot */
const setupSignatures = new Map();
/**
 * Bumped on every market price-update notification (a fetch or a burst of order-book patches)
 * and on every pushed value-map refresh (`market_item_values_updated`)
 */
let priceGeneration = 0;
let listeningForPrices = false;

/** One price change: every figure cached so far is from the old prices */
function onPricesChanged() {
    priceGeneration += 1;
}

/**
 * Start listening for price changes, once.
 *
 * A fresher order-book patch is served by getPrice() without moving the fetch time; the
 * market's price-update notification is what says a price changed. The hourly value-map
 * push swaps the tradable bands `reconcileBook` clamps every ask and bid to
 * (`applyMarketValuesMessage`), outside the market's notification, so it is observed too.
 * @returns {void}
 */
function listenForPrices() {
    if (listeningForPrices) return;
    if (typeof marketAPI?.on === 'function') marketAPI.on(onPricesChanged);
    if (typeof dataManager?.on === 'function') dataManager.on('market_item_values_updated', onPricesChanged);
    listeningForPrices = true;
}

/**
 * Stop listening for price changes (the tooltip feature's teardown) and stop any background
 * work. The next lookup listens again.
 * @returns {void}
 */
export function stopInsteadListeners() {
    jobEpoch += 1;
    jobs.clear();
    if (!listeningForPrices) return;
    if (typeof marketAPI?.off === 'function') marketAPI.off(onPricesChanged);
    if (typeof dataManager?.off === 'function') dataManager.off('market_item_values_updated', onPricesChanged);
    listeningForPrices = false;
}

/**
 * The price part of the snapshot: a fetch, a notification, a value-map push.
 * @returns {string}
 */
function priceKey() {
    return `${marketAPI?.lastFetchTimestamp ?? ''}|${priceGeneration}`;
}

/**
 * Bring both caches up to the current snapshot. Calculator runs outlive a price change (each
 * is re-checked against the prices it ran on before reuse); finished alternatives do not.
 * @returns {void}
 */
function syncStamps() {
    listenForPrices();
    const hard = `${dataManager.currentCharacterId ?? ''}|${Math.floor(Date.now() / CACHE_BUCKET_MS)}`;
    if (hard !== candidateStamp) {
        candidateCache.clear();
        candidateStamp = hard;
    }
    const full = `${hard}|${priceKey()}`;
    if (full !== resultStamp) {
        resultCache.clear();
        setupSignatures.clear();
        resultStamp = full;
    }
}

/**
 * Forget every cached figure and stop any background work.
 * @returns {void}
 */
export function clearInsteadCache() {
    candidateCache.clear();
    resultCache.clear();
    setupSignatures.clear();
    jobs.clear();
    jobEpoch += 1;
    candidateStamp = null;
    resultStamp = null;
    sourceIndex = null;
    sourceIndexOf = null;
}

/**
 * A price you could actually trade at, on one side: the order book's. A value-map
 * estimate is no listing, and neither is a player's custom price override — a route
 * costed on either could not be bought at the figure shown.
 * @param {string} hrid
 * @param {'ask'|'bid'} mode
 * @returns {number|null}
 */
function realPrice(hrid, mode) {
    // The override checked must be the one for this side: a buy-side override is what the
    // calculator costs a catalyst or tea with, and a sell-side check would miss it.
    const side = mode === 'ask' ? 'buy' : 'sell';
    const info = getItemPriceInfo(hrid, { mode, side, marketQuote: true });
    if (info.price === null || info.price === undefined || info.source !== 'book') return null;
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
 * One price exactly as the calculator reads it for a setup: the profit context's buy side
 * (under this module's pricing mode, which the caller sets).
 * @param {string} hrid
 * @returns {string}
 */
function calculatorBuyPrice(hrid) {
    const info = getItemPriceInfo(hrid, { context: 'profit', side: 'buy' });
    return `${info?.price ?? ''}:${info?.source ?? ''}`;
}

/**
 * Every price a calculator run of one action type depends on that is not the source's
 * own: the catalysts (an unpriced one is left out of the search, a priced one is charged)
 * and the alchemy drinks (charged, and an unpriced one drops the tea setups).
 * @param {string} actionType
 * @param {Array<Object>} raw - The run's setups, for any drink they charged
 * @returns {string}
 */
function setupSignature(actionType, raw) {
    const drinks = new Set();
    const slots = dataManager.getActionDrinkSlots?.('/action_types/alchemy');
    for (const drink of Array.isArray(slots) ? slots : []) {
        if (drink?.itemHrid) drinks.add(drink.itemHrid);
    }
    for (const result of raw) {
        for (const cost of result?.consumableCosts ?? []) {
            if (cost?.itemHrid) drinks.add(cost.itemHrid);
        }
    }
    const hrids = [CATALYST_HRIDS[actionType], CATALYST_HRIDS.prime, ...[...drinks].sort()].filter(Boolean);
    const key = `${actionType}|${hrids.join(',')}`;
    if (!setupSignatures.has(key)) {
        setupSignatures.set(
            key,
            withProfitPricingMode(PURCHASE_PRICING_MODE, () => hrids.map(calculatorBuyPrice).join(','))
        );
    }
    return setupSignatures.get(key);
}

/**
 * The prices one calculator run depends on: the source's own buy price (the calculator
 * runs nothing for an unpriced source) and the setup prices.
 * @param {string} actionType
 * @param {string} hrid
 * @param {Array<Object>} raw
 * @returns {string}
 */
function runSignature(actionType, hrid, raw) {
    const own = withProfitPricingMode(PURCHASE_PRICING_MODE, () => calculatorBuyPrice(hrid));
    return `${own}|${setupSignature(actionType, raw)}`;
}

/**
 * Whether one source's setups can be read without a calculator run.
 * @param {string} actionType
 * @param {string} hrid
 * @returns {boolean}
 */
function candidatesReady(actionType, hrid) {
    const entry = candidateCache.get(`${actionType}|${hrid}`);
    if (!entry) return false;
    if (entry.generation === priceKey()) return true;
    return entry.signature === runSignature(actionType, hrid, entry.raw);
}

/**
 * Every buyable catalyst/tea setup of one action on one source. The calculator run is
 * cached for the character and five-minute bucket and reused across price changes that
 * leave the prices it ran on alone; which setups are buyable is re-checked per price change.
 * @param {string} actionType
 * @param {string} hrid
 * @returns {Array<Object>}
 */
function liveCandidates(actionType, hrid) {
    const key = `${actionType}|${hrid}`;
    const generation = priceKey();
    let entry = candidateCache.get(key);
    if (entry && entry.generation !== generation) {
        if (entry.signature === runSignature(actionType, hrid, entry.raw)) {
            entry.generation = generation;
            entry.list = null;
        } else {
            entry = null;
        }
    }
    if (!entry) {
        let raw = [];
        try {
            withProfitPricingMode(PURCHASE_PRICING_MODE, () => {
                raw = alchemyProfitCalculator.calculateCandidateResults?.(actionType, hrid) ?? [];
                if (raw.length === 0) {
                    const single =
                        actionType === 'decompose'
                            ? alchemyProfitCalculator.calculateDecomposeProfit(hrid, 0)
                            : alchemyProfitCalculator.calculateTransmuteProfit(hrid);
                    raw = [single].filter(Boolean);
                }
            });
        } catch (error) {
            console.error('[AlchemyInstead] Candidate setups failed for', hrid, error);
            raw = [];
        }
        entry = { raw, signature: runSignature(actionType, hrid, raw), generation, list: null };
        candidateCache.set(key, entry);
    }
    if (entry.list === null) {
        try {
            entry.list = entry.raw.filter(buyableSetup);
        } catch (error) {
            console.error('[AlchemyInstead] Setup prices failed for', hrid, error);
            entry.list = [];
        }
    }
    return entry.list;
}

/**
 * The sources a lookup would still run the calculator for: a source without a real ask or
 * without item details is skipped before its setups are asked for.
 * @param {Array<{sourceHrid: string, actionType: string}>} sources
 * @returns {Array<{sourceHrid: string, actionType: string}>}
 */
function sourcesToRun(sources) {
    return sources.filter(
        ({ sourceHrid, actionType }) =>
            !candidatesReady(actionType, sourceHrid) &&
            realPrice(sourceHrid, 'ask') !== null &&
            Boolean(dataManager.getItemDetails(sourceHrid))
    );
}

/**
 * The key one lookup's finished result is cached under.
 * @param {string} targetHrid
 * @param {Set<string>} wanted
 * @returns {{key: string, goldPerHour: number}}
 */
function resultKey(targetHrid, wanted) {
    const goldPerHour = Math.max(0, Number(config.getSetting(GOLD_RATE_SETTING)) || 0);
    const keepKey = [...(wanted || [])].sort().join(',');
    return { key: `${targetHrid}|${goldPerHour}|${keepKey}`, goldPerHour };
}

/**
 * Work out one lookup now, every calculator run included, and cache it.
 * @param {string} targetHrid
 * @param {Set<string>} wanted
 * @returns {{targetAsk: number|null, alternatives: Array<Object>}}
 */
function computeAlternatives(targetHrid, wanted) {
    const { key, goldPerHour } = resultKey(targetHrid, wanted);
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
                        // Real book asks only, like every kept output: no custom or value-map price
                        priceOf: askOf,
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
                        // The book's bid after tax, like every other unwanted output: the profit mode's
                        // sell-side resolution (the ask, under hybrid) and custom prices are no listing
                        priceOf: sellOf,
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

/**
 * Give the page a turn between slices.
 * @returns {Promise<void>}
 */
function yieldToPage() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Run one lookup's calculator work in slices, then finish it.
 * @param {string} targetHrid
 * @param {Set<string>} wanted
 * @param {number} epoch - The cache epoch the job started in
 * @returns {Promise<{targetAsk: number|null, alternatives: Array<Object>, cancelled?: boolean}>}
 */
async function runJob(targetHrid, wanted, epoch) {
    const cancelled = { targetAsk: null, alternatives: [], cancelled: true };
    // Off the hover call: the tooltip draws everything else first
    await yieldToPage();
    for (let pass = 0; pass < MAX_JOB_PASSES; pass += 1) {
        if (epoch !== jobEpoch) return cancelled;
        syncStamps();
        const { key } = resultKey(targetHrid, wanted);
        if (resultCache.has(key)) return resultCache.get(key);
        const pending = sourcesToRun(sourcesOf(targetHrid));
        if (pending.length === 0) break;
        let sliceStart = Date.now();
        for (const { sourceHrid, actionType } of pending) {
            liveCandidates(actionType, sourceHrid);
            if (Date.now() - sliceStart >= SLICE_MS) {
                await yieldToPage();
                if (epoch !== jobEpoch) return cancelled;
                sliceStart = Date.now();
            }
        }
    }
    if (epoch !== jobEpoch) return cancelled;
    syncStamps();
    const { key } = resultKey(targetHrid, wanted);
    // Prices that kept moving for every pass leave a few runs to make here; it is still off the hover
    return resultCache.get(key) ?? computeAlternatives(targetHrid, wanted);
}

/**
 * The live alternatives for one item, cached per snapshot.
 *
 * Synchronous, and never makes more than {@link SYNC_SOURCE_RUNS} calculator runs: a target
 * with more sources still to run comes back `{pending: true}` with no alternatives, and the
 * work carries on in the background — {@link settleAlternatives} waits for it.
 * @param {string} targetHrid
 * @param {Set<string>} wanted - The character's keep list
 * @returns {{targetAsk: number|null, alternatives: Array<Object>, pending?: boolean}}
 */
export function liveAlternatives(targetHrid, wanted) {
    syncStamps();
    const { key } = resultKey(targetHrid, wanted);
    if (resultCache.has(key)) return resultCache.get(key);
    if (sourcesToRun(sourcesOf(targetHrid)).length > SYNC_SOURCE_RUNS) {
        settleAlternatives(targetHrid, wanted);
        return { targetAsk: null, alternatives: [], pending: true };
    }
    return computeAlternatives(targetHrid, wanted);
}

/**
 * The finished alternatives for one item: at once when cached, otherwise when the
 * background work started by {@link liveAlternatives} (or by this call) is done. A job
 * whose caches were cleared under it resolves `{cancelled: true}` with no alternatives.
 * @param {string} targetHrid
 * @param {Set<string>} wanted
 * @returns {Promise<{targetAsk: number|null, alternatives: Array<Object>, cancelled?: boolean}>}
 */
export async function settleAlternatives(targetHrid, wanted) {
    syncStamps();
    const { key } = resultKey(targetHrid, wanted);
    if (resultCache.has(key)) return resultCache.get(key);
    if (!jobs.has(key)) {
        const epoch = jobEpoch;
        const job = (async () => {
            try {
                return await runJob(targetHrid, wanted, epoch);
            } catch (error) {
                console.error('[AlchemyInstead] Background routes failed for', targetHrid, error);
                return { targetAsk: null, alternatives: [] };
            } finally {
                if (epoch === jobEpoch) jobs.delete(key);
            }
        })();
        jobs.set(key, job);
    }
    return jobs.get(key);
}
