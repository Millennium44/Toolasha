/**
 * What a transmute earns when the player keeps retransmuting the outputs that are worth more transmuted again than
 * sold, and sells the rest.
 *
 * A transmute yields other books, and many of those have a transmute table of their own. The plain figure sells every
 * output. This one values each book reachable through the drop tables as V = max(sell value, retransmute value):
 *
 *   sell value S   the after-tax order on the pricing mode's sell side (null when there is no real order)
 *   retransmute T  success x sum(dropRate x count x V of each drop) - catalyst and coin per attempt - the attempt's
 *                  time, charged at the player's gold rate (per held copy: the cost is shared by the bulk multiplier)
 *
 * The books can point at each other, so V is found by iteration from V = S, and a book that drops itself is solved as
 * a continuation, T = (rest - cost) / (1 - success x selfDropRate x count). The tree walk of the decompose chain does
 * not apply: transmuting is cyclic.
 *
 * The figure is the plain figure plus the first attempt's gain from retransmuting. Everything else the plain figure
 * counts (essence and rare drops, tea, the buy price, a self-return credited at the buy price) is left as it is, so
 * the two are the same number when nothing is worth transmuting again, and the first attempt's time stays in the
 * hourly rate rather than being charged at the gold rate as well. Attempts after the first are charged at the gold
 * rate, because their time is not in that rate. They pay for tea, but their bonus drops are not counted.
 *
 * A book with no real sell order is left out of every sum, and the result is then partial (a lower bound).
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import { alchemyProfitCalculator } from './bundle-bridge.js';
import { getItemPriceInfo } from './market-data.js';
import { calculatePriceAfterTax } from './profit-helpers.js';
import { pricingSignature } from './decompose-chain-value.js';

/** The setting that gates the line in the alchemy panel and the Best Items sort */
export const RETRANSMUTE_SETTING = 'alchemy_retransmute';

/** Your gold per hour (repeated, not imported, from alchemy-instead-of-buying, which would pull its feature graph in) */
const GOLD_RATE_SETTING = 'actionPanel_craftingPlanGoldPerHour';

/** Most books walked from one item; reaching it marks the result partial */
export const MAX_NODES = 200;
/** Most rounds of the value iteration */
export const MAX_ITERATIONS = 100;
/** Largest relative change of any value that counts as settled */
const TOLERANCE = 1e-9;
/** How long a figure lives even when no price signal clears it (gear, skills and the bag move) */
const CACHE_BUCKET_MS = 60 * 1000;

/** The pricing signature the caches hold figures for */
let cacheSignature = null;
const resultCache = new Map();
const termsCache = new Map();

/**
 * Forget every memoised figure and per-book term.
 * @returns {void}
 */
export function clearRetransmuteCaches() {
    cacheSignature = null;
    resultCache.clear();
    termsCache.clear();
}

/**
 * The gold rate the time cost is charged at.
 * @returns {number} 0 when unset
 */
export function retransmuteGoldRate() {
    return Math.max(0, Number(config.getSetting(GOLD_RATE_SETTING)) || 0);
}

/**
 * The after-tax sell value of a book: a real order on the mode's sell side, never a value-map estimate.
 * @param {string} hrid
 * @returns {number|null}
 */
function sellValueOf(hrid) {
    const info = getItemPriceInfo(hrid, { context: 'profit', side: 'sell' });
    if (info.price === null || info.price === undefined || info.estimated) return null;
    return calculatePriceAfterTax(info.price);
}

/**
 * A book's transmute table, when transmuting it can succeed at all.
 * @param {string} hrid
 * @returns {Array<{itemHrid: string, dropRate: number, minCount: number, maxCount: number}>|null}
 */
function tableOf(hrid) {
    const alchemy = dataManager.getItemDetails(hrid)?.alchemyDetail;
    const table = alchemy?.transmuteDropTable;
    if (!Array.isArray(table) || table.length === 0) return null;
    if (!(alchemy.transmuteSuccessRate > 0)) return null;
    return table;
}

/**
 * Whether any output of an item's transmute is itself a book that can be transmuted, so a retransmute figure is
 * possible at all (a plain input such as milk has none, and needs no note about the gold rate).
 * @param {string} itemHrid
 * @returns {boolean}
 */
export function hasRetransmutableOutput(itemHrid) {
    return Boolean(tableOf(itemHrid)?.some((drop) => tableOf(drop.itemHrid)));
}

/**
 * What a retransmute figure says on hover: which books are retransmuted, which are sold, which are left out.
 * @param {Object} result - An ok result of {@link retransmuteValue}
 * @returns {string} Lines joined by newlines
 */
export function describeRetransmutePolicy(result) {
    const nameOf = (hrid) => dataManager.getItemDetails(hrid)?.name || hrid.split('/').pop();
    const names = (action) =>
        result.policy
            .filter((entry) => entry.action === action)
            .map((entry) => nameOf(entry.itemHrid))
            .join(', ');
    const lines = [];
    const again = names('retransmute');
    const sold = names('sell');
    const left = names('unpriced');
    if (again) lines.push(`Retransmuted: ${again}`);
    if (sold) lines.push(`Sold: ${sold}`);
    if (left) lines.push(`Left out, no real sell order: ${left}`);
    lines.push(
        `A book is retransmuted when that beats selling it, with each extra attempt's time charged at your gold rate ` +
            `(${Math.round(result.goldRate).toLocaleString('en-US')}/hr). The first attempt's time is in the rate.`
    );
    lines.push('Extra attempts pay for tea but their bonus drops are not counted. Not capped by market volume.');
    if (result.partial) lines.push('A lower bound: some books are left out of the sums.');
    if (result.nodeCapHit) lines.push(`Stopped after ${MAX_NODES} books.`);
    if (!result.converged) lines.push('The values had not settled after the iteration limit.');
    return lines.join('\n');
}

/**
 * How a plain result was set up, as the arguments the calculator's terms method takes.
 * @param {Object} plain - The calculator's transmute result
 * @param {{useLiveSetup?: boolean, catalystChoice?: string|null}} [setup]
 * @returns {Object}
 */
function setupFor(plain, setup = {}) {
    if (setup.useLiveSetup || setup.catalystChoice) {
        return { useLiveSetup: Boolean(setup.useLiveSetup), catalystChoice: setup.catalystChoice ?? null };
    }
    return { catalystHrid: plain.winningCatalystHrid || null, usesTea: Boolean(plain.winningTeaUsed) };
}

/**
 * The character's alchemy level, which moves every book's success rate.
 * @returns {number}
 */
function alchemyLevel() {
    return dataManager.getSkills?.()?.find((skill) => skill.skillHrid === '/skills/alchemy')?.level ?? 0;
}

/**
 * Per-attempt terms of one book under a setup, memoised per price snapshot and minute.
 * @param {string} hrid
 * @param {Object} setup - Arguments for the calculator's terms method
 * @param {string} setupKey
 * @returns {Object|null}
 */
function termsOf(hrid, setup, setupKey) {
    const key = `${hrid}|${setupKey}|${alchemyLevel()}|${Math.floor(Date.now() / CACHE_BUCKET_MS)}`;
    if (termsCache.has(key)) return termsCache.get(key);
    let terms = null;
    try {
        terms = alchemyProfitCalculator()?.calculateTransmuteAttemptTerms?.(hrid, setup) ?? null;
    } catch (error) {
        console.error('[RetransmuteValue] Could not read the attempt terms:', error);
    }
    termsCache.set(key, terms);
    return terms;
}

/**
 * Value every book reachable from a transmute's outputs, and what the first attempt gains from retransmuting.
 *
 * @param {Object} plain - The calculator's transmute result being compared with (its `requirementCosts[0].price` is
 *   the buy price, `actionsPerHour` and `netProfitPerAttempt` the first attempt's)
 * @param {Object} [setup] - `{useLiveSetup, catalystChoice}` when the plain result was a live or what-if one;
 *   otherwise the setup is the plain result's winning catalyst and tea
 * @param {{maxNodes?: number}} [options]
 * @returns {Object} `{status}` is `'ok'`, `'noGoldRate'` or `'noFigure'` (with `reason`). An ok result carries
 *   `adjustedPerHour`, `plainPerHour`, `differs` (some output is worth retransmuting and the figure rose),
 *   `partial` and `partialItems`, `converged`, `nodeCapHit`, `goldRate` and `policy`, one
 *   `{itemHrid, action: 'sell'|'retransmute'|'unpriced', sellValue, retransmuteValue}` per book reached
 */
export function retransmuteValue(plain, setup = {}, options = {}) {
    const goldRate = retransmuteGoldRate();
    if (goldRate <= 0) return { status: 'noGoldRate' };
    if (!plain || plain.actionType !== 'transmute') {
        return { status: 'noFigure', reason: 'no transmute' };
    }
    if (plain.enhancementLevel > 0) return { status: 'noFigure', reason: 'enhanced input' };
    const rootHrid = plain.itemHrid;
    const rootTable = tableOf(rootHrid);
    const buyPrice = plain.requirementCosts?.[0]?.price;
    const bulk = plain.requirementCosts?.[0]?.count || 1;
    if (!rootTable || !(buyPrice >= 0) || !(plain.actionsPerHour > 0)) {
        return { status: 'noFigure', reason: 'no transmute table or price' };
    }

    const signature = pricingSignature();
    if (signature !== cacheSignature) {
        clearRetransmuteCaches();
        cacheSignature = signature;
    }
    const calcSetup = setupFor(plain, setup);
    // Everything of the plain result that a book's success rate and speed depend on: the slotted catalyst and
    // drinks, the character's efficiency, and the root's own success and attempt rate (which move with gear and
    // level), so a swapped catalyst or tea never serves another book's terms from the old setup
    const setupKey = JSON.stringify([
        calcSetup,
        plain.catalystCost?.itemHrid ?? plain.winningCatalystHrid ?? null,
        Boolean(plain.winningTeaUsed),
        (plain.consumableCosts ?? []).map((cost) => cost?.itemHrid).filter(Boolean),
        plain.efficiency ?? null,
        plain.successRate,
        plain.actionsPerHour,
    ]);
    const maxNodes = options.maxNodes ?? MAX_NODES;
    const key = [
        rootHrid,
        goldRate,
        setupKey,
        alchemyLevel(),
        buyPrice,
        plain.actionsPerHour,
        plain.successRate,
        plain.profitPerHour,
        plain.netProfitPerAttempt,
        maxNodes,
        Math.floor(Date.now() / CACHE_BUCKET_MS),
    ].join('|');
    if (resultCache.has(key)) return resultCache.get(key);

    const result = work(plain, calcSetup, setupKey, goldRate, { rootHrid, rootTable, buyPrice, bulk, maxNodes });
    resultCache.set(key, result);
    return result;
}

/**
 * The walk and the iteration of {@link retransmuteValue}, uncached.
 * @param {Object} plain
 * @param {Object} calcSetup
 * @param {string} setupKey
 * @param {number} goldRate
 * @param {{rootHrid: string, rootTable: Array, buyPrice: number, bulk: number, maxNodes: number}} root
 * @returns {Object}
 */
function work(plain, calcSetup, setupKey, goldRate, { rootHrid, rootTable, buyPrice, bulk, maxNodes }) {
    // Every book reachable through the drop tables, breadth first, up to the cap
    const nodes = new Map();
    const partialItems = new Set();
    let nodeCapHit = false;
    const queue = rootTable.map((drop) => drop.itemHrid);
    while (queue.length > 0) {
        const hrid = queue.shift();
        if (nodes.has(hrid)) continue;
        if (nodes.size >= maxNodes) {
            nodeCapHit = true;
            partialItems.add(hrid);
            continue;
        }
        const table = tableOf(hrid);
        const sell = sellValueOf(hrid);
        const node = { hrid, table, sell, terms: null, value: sell, retransmute: false, retransmuteValue: null };
        nodes.set(hrid, node);
        // A book with no price cannot be sold, and one with neither price nor table is nothing to value
        if (sell === null) {
            partialItems.add(hrid);
            continue;
        }
        if (table) {
            node.terms = termsOf(hrid, calcSetup, setupKey);
            // A table that cannot be run here (an unpriced catalyst) leaves the book at its sell value, partly known
            if (!node.terms) partialItems.add(hrid);
            else for (const drop of table) queue.push(drop.itemHrid);
        }
    }

    const priced = [...nodes.values()].filter((node) => node.sell !== null);
    const rootOutputs = rootTable.map((drop) => nodes.get(drop.itemHrid)).filter(Boolean);
    if (!rootOutputs.some((node) => node.sell !== null)) {
        return { status: 'noFigure', reason: 'every output is unpriced', partial: true };
    }

    // The value of a drop table's contents, leaving out the book being valued itself and any left-out book
    const restOf = (node) => {
        let rest = 0;
        let self = 0;
        for (const drop of node.table) {
            const other = nodes.get(drop.itemHrid);
            if (!other || other.value === null) continue;
            const count = (drop.minCount + drop.maxCount) / 2;
            if (drop.itemHrid === node.hrid) self += drop.dropRate * count;
            else rest += drop.dropRate * count * other.value;
        }
        return { rest, self };
    };
    const runners = priced.filter((node) => node.table && node.terms);
    // Value one copy's retransmute: the cost of an attempt is shared by the copies it consumes
    const retransmuteOf = (node) => {
        const { successRate, actionsPerHour, catalystCostPerAttempt, coinCost, teaCostPerAttempt, bulkMultiplier } =
            node.terms;
        const timeCost = actionsPerHour > 0 ? goldRate / actionsPerHour : 0;
        const cost = (catalystCostPerAttempt + coinCost + (teaCostPerAttempt || 0) + timeCost) / (bulkMultiplier || 1);
        const { rest, self } = restOf(node);
        const q = successRate * self;
        if (q >= 1) return null;
        return (successRate * rest - cost) / (1 - q);
    };

    let converged = runners.length === 0;
    for (let round = 0; round < MAX_ITERATIONS && !converged; round += 1) {
        let change = 0;
        for (const node of runners) {
            const t = retransmuteOf(node);
            node.retransmuteValue = t;
            const next = t !== null && t > node.sell ? t : node.sell;
            node.retransmute = next !== node.sell;
            const scale = Math.max(Math.abs(next), Math.abs(node.value), 1);
            change = Math.max(change, Math.abs(next - node.value) / scale);
            node.value = next;
        }
        converged = change < TOLERANCE;
    }
    // A cycle whose books each return more than they cost grows without bound; its "value" is no figure
    if (!converged) return { status: 'noFigure', reason: 'did not settle', partial: true };

    // The first attempt's gain over what the plain figure already counts, per attempt: each other output at its
    // value less its sell value, and a self-return at its value above the buy price the plain figure credits
    const { successRate: rootSuccess } = plain;
    let gain = 0;
    let improves = false;
    for (const drop of rootTable) {
        const node = nodes.get(drop.itemHrid);
        if (!node || node.sell === null) continue;
        const count = (drop.minCount + drop.maxCount) / 2;
        const base = drop.itemHrid === rootHrid ? buyPrice : node.sell;
        const lift = node.value - base;
        if (lift > 0 && node.retransmute) {
            gain += drop.dropRate * count * lift;
            improves = true;
        }
    }
    gain *= rootSuccess * bulk;

    const adjustedPerHour = plain.profitPerHour + gain * plain.actionsPerHour;
    const policy = [...nodes.values()].map((node) => ({
        itemHrid: node.hrid,
        action: node.sell === null ? 'unpriced' : node.retransmute ? 'retransmute' : 'sell',
        sellValue: node.sell,
        retransmuteValue: node.retransmuteValue,
    }));
    return {
        status: 'ok',
        adjustedPerHour,
        plainPerHour: plain.profitPerHour,
        differs: improves,
        partial: partialItems.size > 0,
        partialItems: [...partialItems],
        converged,
        nodeCapHit,
        goldRate,
        policy,
    };
}
