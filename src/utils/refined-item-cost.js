/**
 * Refined-item cost resolution.
 *
 * A refined item (`..._refined`, the ★ skilling capes) is frequently untradable
 * or simply unlisted, so the marketplace has nothing to say about it. Costing it
 * at 0 is the one answer that is certainly wrong: the cape was made, and the
 * refinement materials it swallowed are priced. This module resolves what a
 * refined item actually cost to obtain — the cheaper of a live listing and the
 * refinement craft — and reports which of the two answered, so a caller can name
 * the basis rather than present an inexplicable figure.
 *
 * It is deliberately free of caller state: every price lookup is injectable, so
 * the philo calculator can keep its own pricing mode, patient tick, Iron Cow
 * book and overrides while the history viewers use plain market pricing, and
 * both still compute the cost the same way.
 */

import dataManager from '../core/data-manager.js';
import { getItemPrice } from './market-data.js';
import { calculateArtisanBonus } from './material-calculator.js';
import { formatKMB, formatLargeNumber } from './formatters.js';
import { resolveItemPrice } from './profit-helpers.js';

/** Cached output-hrid → refinement action map, rebuilt when game data changes */
let refineActionByOutput = null;
let refineActionSource = null;

/**
 * Whether an hrid names a refined (★) item.
 * @param {string} itemHrid - Item HRID
 * @returns {boolean} True for `..._refined`
 */
export function isRefinedItem(itemHrid) {
    return typeof itemHrid === 'string' && itemHrid.endsWith('_refined');
}

/**
 * The upgrade action that produces a refined item, from game data.
 * @param {string} itemHrid - Refined item HRID
 * @returns {Object|null} Action detail, or null when nothing produces it
 */
export function findRefinementAction(itemHrid) {
    const actions = dataManager.getInitClientData()?.actionDetailMap || null;
    if (!actions) return null;
    if (refineActionByOutput === null || refineActionSource !== actions) {
        refineActionByOutput = new Map();
        refineActionSource = actions;
        for (const action of Object.values(actions)) {
            for (const output of action.outputItems || []) {
                if (isRefinedItem(output.itemHrid) && !refineActionByOutput.has(output.itemHrid)) {
                    refineActionByOutput.set(output.itemHrid, action);
                }
            }
        }
    }
    return refineActionByOutput.get(itemHrid) || null;
}

/**
 * Item name from game data, for breakdown lines.
 * @param {string} itemHrid - Item HRID
 * @returns {string} Display name
 */
function defaultItemName(itemHrid) {
    const itemData = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid];
    return itemData?.name || itemHrid.replace('/items/', '').replaceAll('_', ' ');
}

/**
 * Default buy-side price for one unit of a refinement material.
 * @param {string} itemHrid - Item HRID
 * @returns {number|null} Price, or null when unpriced
 */
function defaultPriceMaterial(itemHrid) {
    const resolved = resolveItemPrice(itemHrid, { side: 'buy', context: 'profit' });
    return resolved.missing || !(resolved.price > 0) ? null : resolved.price;
}

/**
 * Default acquisition price for the base item a refinement upgrades.
 * @param {string} itemHrid - Item HRID
 * @returns {number|null} Price, or null when unpriced
 */
function defaultPriceBase(itemHrid) {
    const resolved = resolveItemPrice(itemHrid, { side: 'buy', mode: 'ask', context: 'profit' });
    return resolved.missing || !(resolved.price > 0) ? null : resolved.price;
}

/**
 * Resolve the crafting cost of a refined item: the market cost of the
 * refinement materials its upgrade action consumes, plus the acquisition cost of
 * the base item being refined. Bases with no resolvable price (skilling capes,
 * which the player already owns) contribute nothing, and say so in `baseNote`.
 *
 * Artisan tea reduces the materials a craft consumes; the game's own requirement
 * line shows the reduced figure (88.9 shards, not 100), and a craft estimate
 * priced at the raw recipe overstates the cost by the whole bonus. Coins are not
 * materials and are not reduced.
 *
 * @param {string} itemHrid - Refined item HRID
 * @param {Object} [options] - Price injection
 * @param {Function} [options.priceMaterial] - (hrid) => number|null, buy-side unit price of a material
 * @param {Function} [options.priceBase] - (hrid) => number|null, acquisition price of a tradable base
 * @param {Function} [options.getItemName] - (hrid) => string, for breakdown lines
 * @returns {{cost: number, baseNote: string|null, lines: string[]}|null} Craft cost, or null when not resolvable
 */
export function computeRefinementCraftCost(itemHrid, options = {}) {
    const {
        priceMaterial = defaultPriceMaterial,
        priceBase = defaultPriceBase,
        getItemName = defaultItemName,
    } = options;

    const action = findRefinementAction(itemHrid);
    if (!action) return null;

    const artisanBonus = calculateArtisanBonus(action);
    const lines = [];
    let cost = 0;
    for (const input of action.inputItems || []) {
        const count = input.count || 0;
        if (input.itemHrid === '/items/coin') {
            cost += count;
            if (count > 0) lines.push(`${formatLargeNumber(count)} coins`);
            continue;
        }
        const price = priceMaterial(input.itemHrid);
        if (price === null || price === undefined) return null;
        const effective = count * (1 - artisanBonus);
        cost += price * effective;
        const countText = artisanBonus > 0 ? `${effective.toFixed(1)} (${count} less artisan)` : `${count}`;
        lines.push(
            `${countText} × ${getItemName(input.itemHrid)} @ ${formatLargeNumber(price)} = ` +
                formatLargeNumber(Math.round(price * effective))
        );
    }

    let baseNote = null;
    if (action.upgradeItemHrid) {
        const baseDetails = dataManager.getInitClientData()?.itemDetailMap?.[action.upgradeItemHrid];
        if (baseDetails?.isTradable !== true) {
            // The capes' bases are vendor items you bring yourself — no
            // market cost is the honest figure, and worth saying
            baseNote = 'untradable';
        } else {
            const base = priceBase(action.upgradeItemHrid);
            if (base !== null && base !== undefined && base > 0) {
                cost += base;
            } else {
                // A tradable base with no listing would silently understate
                // the craft cost; disclose rather than pretend
                baseNote = 'unpriced';
            }
        }
    }

    if (cost <= 0) return null;
    return { cost, baseNote, lines };
}

/**
 * Default buy-side market quote for a refined item at an enhancement level.
 * @param {string} itemHrid - Item HRID
 * @param {number} level - Enhancement level
 * @returns {number|null} Price, or null when unpriced
 */
function defaultQuoteAt(itemHrid, level) {
    const price = getItemPrice(itemHrid, { enhancementLevel: level, context: 'profit', side: 'buy' });
    return price > 0 ? price : null;
}

/**
 * Resolve what one refined item costs to acquire, and what a returned copy of it
 * is worth back.
 *
 * The +0 quote is compared against crafting (base item + refinement materials)
 * and the cheaper path wins; capes are often listed only at low enhancement
 * levels, so those are scanned as a last resort — and a cost resolved that way is
 * flagged, because a +3 listing is not a cost basis a +0 action can be run at.
 *
 * @param {string} itemHrid - Refined item HRID
 * @param {Object} [options] - Price injection
 * @param {Function} [options.quoteAt] - (level) => number|null, buy-side quote at an enhancement level
 * @param {Function} [options.sellQuote] - (hrid) => number, +0 sell value, for the enhanced-fallback self-return
 * @param {Object} [options.craft] - Options forwarded to {@link computeRefinementCraftCost}
 * @returns {{itemCost: number, selfReturnUnitValue: number, source: string, fallbackLevel: number,
 *   baseNote: string|null, breakdown: string[], craft: Object|null}|null} Cost basis, or null when
 *   nothing resolves. `craft` is the craft-path result whether or not it won the comparison.
 */
export function resolveRefinedItemCost(itemHrid, options = {}) {
    const { quoteAt = (level) => defaultQuoteAt(itemHrid, level), sellQuote, craft } = options;

    let itemCost = quoteAt(0);
    if (itemCost === undefined) itemCost = null;
    let source = itemCost === null ? null : 'market';
    let fallbackLevel = 0;
    let baseNote = null;
    let breakdown = [];

    const craftResult = computeRefinementCraftCost(itemHrid, craft);
    if (craftResult !== null) {
        baseNote = craftResult.baseNote;
        breakdown = craftResult.lines;
        if (itemCost === null || craftResult.cost < itemCost) {
            itemCost = craftResult.cost;
            source = 'craft';
        }
    }

    for (let level = 1; level <= 5 && itemCost === null; level++) {
        const quote = quoteAt(level);
        if (quote !== null && quote !== undefined) {
            itemCost = quote;
            source = 'enhanced';
            fallbackLevel = level;
        }
    }

    if (itemCost === null || itemCost === undefined) return null;

    // A self-return hands back a +0 item, never the enhanced listing the cost
    // basis had to borrow from, so credit it at the base item's own quote
    // (0 when the base has no market at all).
    let selfReturnUnitValue = itemCost;
    if (source === 'enhanced') {
        selfReturnUnitValue = sellQuote ? sellQuote(itemHrid) || 0 : 0;
    }

    return { itemCost, selfReturnUnitValue, source, fallbackLevel, baseNote, breakdown, craft: craftResult };
}

/**
 * Price a consumed input item, falling back to the refinement craft cost when
 * the market has nothing to say about it.
 *
 * A refined (★) item is often untradable, and costing it at 0 turns "unknown"
 * into "free" — the failure this exists to prevent. When nothing resolves the
 * price stays 0 but `unpriced` is set, so a caller can report an incomplete
 * figure rather than a confidently wrong one.
 *
 * @param {string} itemHrid - Input item HRID
 * @param {number|null} marketPrice - The price the caller's own market lookup produced
 * @param {Object} [options] - Options
 * @param {number} [options.enhancementLevel=0] - The session's enhancement level; the craft
 *   fallback is a +0 basis and is not applied above it
 * @param {string} [options.marketBasis='current buy'] - How to describe the market price
 * @returns {{price: number, basis: string|null, unpriced: boolean}} Unit price and its basis
 */
export function priceInputWithRefinementFallback(itemHrid, marketPrice, options = {}) {
    const { enhancementLevel = 0, marketBasis = 'current buy' } = options;
    if (marketPrice > 0) {
        return { price: marketPrice, basis: marketBasis, unpriced: false };
    }

    if (isRefinedItem(itemHrid) && enhancementLevel === 0) {
        try {
            const resolved = resolveRefinedItemCost(itemHrid);
            if (resolved && resolved.itemCost > 0) {
                const basis =
                    resolved.source === 'craft'
                        ? 'refinement craft cost'
                        : resolved.source === 'enhanced'
                          ? `+${resolved.fallbackLevel} listing`
                          : marketBasis;
                return { price: resolved.itemCost, basis, unpriced: false };
            }
        } catch (error) {
            console.error('[RefinedItemCost] Failed to resolve refinement cost:', error);
        }
    }

    return { price: 0, basis: null, unpriced: true };
}

/**
 * The "Inputs (…)" line of an alchemy history profit tooltip. It names the basis
 * the figure came from — a 79M craft cost appearing where the market says 0 is
 * otherwise inexplicable — and says outright when the input could not be priced,
 * so an incomplete profit never reads as a costless one.
 * @param {{netConsumed: number, inputCost: number, inputBasis: string|null, inputUnpriced: boolean}} detail
 *   A `computeSessionProfit` result
 * @returns {string} One tooltip line
 */
export function formatInputCostLine(detail) {
    if (detail.inputUnpriced) {
        return `Inputs (${detail.netConsumed}): unpriced — not counted, so this profit is incomplete`;
    }
    return `Inputs (${detail.netConsumed} @ ${detail.inputBasis}): −${formatKMB(detail.inputCost, 1)}`;
}

export default {
    isRefinedItem,
    priceInputWithRefinementFallback,
    formatInputCostLine,
    findRefinementAction,
    computeRefinementCraftCost,
    resolveRefinedItemCost,
};
