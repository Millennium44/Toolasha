/**
 * Enhancement Tooltip Module
 *
 * Provides enhancement analysis for item tooltips.
 * Calculates optimal enhancement path and total costs for reaching current enhancement level.
 *
 * This module is part of Phase 2 of Option D (Hybrid Approach):
 * - Enhancement panel: Shows 20-level enhancement table
 * - Item tooltips: Shows optimal path to reach current enhancement level
 */

import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import config from '../../core/config.js';
const toolashaConfig = config;
import dataManager from '../../core/data-manager.js';
import { calculateSuccessXP, calculateFailureXP } from './enhancement-xp.js';
import {
    buildSourceChipHTML,
    describeEnhancementSource,
    getTooltipEnhancementParams,
    sectionAttributes,
    toggleProRates,
    SECTION_ATTR,
    SOURCE_CHIP_CLASS,
} from './enhancement-params-source.js';
import { formatLargeNumber, numberFormatter, formatKMB, isAbbreviationEnabled } from '../../utils/formatters.js';
import { getItemPrice, getItemPrices } from '../../utils/market-data.js';
import { parseArtisanBonus, getDrinkConcentration } from '../../utils/tea-parser.js';
import { parseItemCount } from '../../utils/number-parser.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import marketAPI from '../../api/marketplace.js';

const _costCache = new Map();
const _chainTimeCache = new Map();

marketAPI.on(() => {
    _costCache.clear();
    _chainTimeCache.clear();
});

/**
 * Calculate optimal enhancement path for an item
 * Matches Enhancelator's algorithm exactly:
 * 1. Test all protection strategies for each level
 * 2. Pick minimum cost for each level (mixed strategies)
 * 3. Apply mirror optimization to mixed array
 *
 * @param {string} itemHrid - Item HRID (e.g., '/items/cheese_sword')
 * @param {number} currentEnhancementLevel - Current enhancement level (1-20)
 * @param {Object} config - Enhancement configuration from enhancement-config.js
 * @returns {Object|null} Enhancement analysis or null if not enhanceable
 */
export function calculateEnhancementPath(itemHrid, currentEnhancementLevel, config) {
    // Validate inputs
    if (!itemHrid || currentEnhancementLevel < 1 || currentEnhancementLevel > 20) {
        return null;
    }

    // Get item details
    const gameData = dataManager.getInitClientData();
    if (!gameData) return null;

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails) return null;

    // Check if item is enhanceable
    if (!itemDetails.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 1;

    // Step 1: Build 2D matrix like Enhancelator (all_results)
    // For each target level (1 to currentEnhancementLevel)
    // Test all protection strategies (0, 2, 3, ..., targetLevel)
    // Result: allResults[targetLevel][protectFrom] = cost data

    const allResults = [];

    for (let targetLevel = 1; targetLevel <= currentEnhancementLevel; targetLevel++) {
        const resultsForLevel = [];

        // Test "never protect" (0)
        const neverProtect = calculateCostForStrategy(itemHrid, targetLevel, 0, itemLevel, config);
        if (neverProtect) {
            resultsForLevel.push({ protectFrom: 0, ...neverProtect });
        }

        // Test all "protect from X" strategies (2 through targetLevel)
        for (let protectFrom = 2; protectFrom <= targetLevel; protectFrom++) {
            const result = calculateCostForStrategy(itemHrid, targetLevel, protectFrom, itemLevel, config);
            if (result) {
                resultsForLevel.push({ protectFrom, ...result });
            }
        }

        allResults.push(resultsForLevel);
    }

    // Step 2: Build target_costs and target_times arrays (minimum cost/time for each level)
    // Like Enhancelator line 451-453
    const targetCosts = new Array(currentEnhancementLevel + 1);
    const targetTimes = new Array(currentEnhancementLevel + 1);
    const targetAttempts = new Array(currentEnhancementLevel + 1);
    targetCosts[0] = toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost')
        ? Math.min(getProductionCost(itemHrid) || Infinity, getItemPrices(itemHrid, 0)?.ask || Infinity) ||
          getRealisticBaseItemPrice(itemHrid)
        : getRealisticBaseItemPrice(itemHrid); // Level 0: base item
    targetTimes[0] = 0; // Level 0: no time needed
    targetAttempts[0] = 0; // Level 0: no attempts needed

    for (let level = 1; level <= currentEnhancementLevel; level++) {
        const resultsForLevel = allResults[level - 1];
        // No strategy succeeded for this level (e.g. missing data) — cannot build a path
        if (resultsForLevel.length === 0) {
            return null;
        }
        // Find the result with minimum cost
        const minResult = resultsForLevel.reduce((best, curr) => (curr.totalCost < best.totalCost ? curr : best));
        targetCosts[level] = minResult.totalCost;
        targetTimes[level] = minResult.totalTime;
        targetAttempts[level] = minResult.expectedAttempts;
    }

    // Snapshot the pre-mirror numbers before the mirror pass rewrites targetCosts in place.
    // These arrays used to be aliases of the same array, so the "traditional" cost of a level
    // silently became its mirror cost the moment the pass touched it.
    const traditionalCosts = [...targetCosts];
    const traditionalTimes = [...targetTimes];
    const traditionalAttempts = [...targetAttempts];

    // Step 3: Apply Philosopher's Mirror optimization (single pass, in-place)
    // Like Enhancelator lines 456-465
    const mirrorPrice = getRealisticBaseItemPrice('/items/philosophers_mirror');
    const usedMirror = new Array(currentEnhancementLevel + 1).fill(false);

    if (mirrorPrice > 0) {
        // +2 is reachable by mirroring a +0 and a +1, so it belongs in the search as well
        for (let level = 2; level <= currentEnhancementLevel; level++) {
            const traditionalCost = targetCosts[level];
            const mirrorCost = targetCosts[level - 2] + targetCosts[level - 1] + mirrorPrice;

            if (mirrorCost < traditionalCost) {
                usedMirror[level] = true;
                targetCosts[level] = mirrorCost;
            }
        }
    }

    // Step 4: Build final result with breakdown
    const _finalCost = targetCosts[currentEnhancementLevel];

    // Find which protection strategy was optimal for final level (before mirrors)
    const finalLevelResults = allResults[currentEnhancementLevel - 1];
    if (finalLevelResults.length === 0) {
        return null;
    }
    const optimalTraditional = finalLevelResults.reduce((best, curr) =>
        curr.totalCost < best.totalCost ? curr : best
    );

    // Which levels the finished plan actually mirrors is a question about the path back from
    // the target, not about the first level where mirroring happened to look cheap. A level
    // that mirrors but is never reached from the target contributes nothing.
    const mirrorPlan = expandMirrorPlan(currentEnhancementLevel, usedMirror);

    let optimalStrategy;

    if (mirrorPlan.mirrorCount > 0) {
        // Mirror was used - build mirror-optimized result
        optimalStrategy = buildMirrorOptimizedResult(
            itemHrid,
            currentEnhancementLevel,
            mirrorPlan,
            traditionalCosts,
            traditionalTimes,
            traditionalAttempts,
            targetCosts,
            optimalTraditional,
            mirrorPrice
        );
    } else {
        // No mirror used - return traditional result
        optimalStrategy = {
            protectFrom: optimalTraditional.protectFrom,
            label: optimalTraditional.protectFrom === 0 ? 'Never' : `+${optimalTraditional.protectFrom}`,
            expectedAttempts: optimalTraditional.expectedAttempts,
            totalTime: optimalTraditional.totalTime,
            baseCost: optimalTraditional.baseCost,
            baseAskPrice: optimalTraditional.baseAskPrice,
            baseBidPrice: optimalTraditional.baseBidPrice,
            baseAskIsCrafted: optimalTraditional.baseAskIsCrafted,
            baseBidIsCrafted: optimalTraditional.baseBidIsCrafted,
            materialCost: optimalTraditional.materialCost,
            materialBreakdown: optimalTraditional.materialBreakdown,
            protectionCost: optimalTraditional.protectionCost,
            protectionItemHrid: optimalTraditional.protectionItemHrid,
            protectionCount: optimalTraditional.protectionCount,
            protectionAskPrice: optimalTraditional.protectionAskPrice,
            protectionBidPrice: optimalTraditional.protectionBidPrice,
            totalCost: optimalTraditional.totalCost,
            usedMirror: false,
            mirrorStartLevel: null,
        };
    }

    // Calculate XP/hr for the optimal path
    let xpPerHour = null;
    let totalExpectedXP = null;
    try {
        const xpCalc = calculateEnhancement({
            enhancingLevel: config.enhancingLevel,
            houseLevel: config.houseLevel,
            toolBonus: config.toolBonus || 0,
            speedBonus: config.speedBonus || 0,
            itemLevel,
            targetLevel: currentEnhancementLevel,
            protectFrom: optimalStrategy.protectFrom,
            blessedTea: config.teas.blessed,
            guzzlingBonus: config.guzzlingBonus,
            blessedTeaBonus: config.blessedTeaBonus,
        });

        if (xpCalc && xpCalc.visitCounts && xpCalc.totalTime > 0) {
            // Same XP formula the tracker and the XPH calculator use. The old inline copy read
            // itemDetails.level, which enhanceable equipment does not have, so it fell through
            // to a level-requirement lookup and produced a different number for the same item.
            let totalXP = 0;
            for (let i = 0; i < currentEnhancementLevel; i++) {
                const visits = xpCalc.visitCounts[i];
                if (!visits) continue;
                const successRate = xpCalc.successRates[i].actualRate / 100;
                const successXP = calculateSuccessXP(i, itemHrid);
                const failXP = calculateFailureXP(i, itemHrid);
                totalXP += visits * (successRate * successXP + (1 - successRate) * failXP);
            }
            xpPerHour = Math.round((totalXP / xpCalc.totalTime) * 3600);
            totalExpectedXP = Math.round(totalXP);
        }
    } catch {
        // XP data is optional; don't let it break the tooltip
    }

    return {
        itemHrid,
        targetLevel: currentEnhancementLevel,
        itemLevel,
        optimalStrategy,
        allStrategies: [optimalStrategy], // Only return optimal
        xpPerHour,
        totalExpectedXP,
        // Carried through so the tooltip can say whose stats these numbers describe: the
        // character's own, a hand-entered set, or the pro kit
        enhancementParams: config,
        paramsNote: describeEnhancementSource(config).detail,
    };
}

/**
 * Calculate cost for a single protection strategy to reach a target level
 * @private
 */
function calculateCostForStrategy(itemHrid, targetLevel, protectFrom, itemLevel, config) {
    try {
        const params = {
            enhancingLevel: config.enhancingLevel,
            houseLevel: config.houseLevel,
            toolBonus: config.toolBonus || 0,
            speedBonus: config.speedBonus || 0,
            itemLevel,
            targetLevel,
            protectFrom,
            blessedTea: config.teas.blessed,
            guzzlingBonus: config.guzzlingBonus,
            blessedTeaBonus: config.blessedTeaBonus,
        };

        // Calculate enhancement statistics. The matrix inversion is the expensive part of a
        // strategy, and the cost pass needs exactly the same numbers, so it is handed the
        // result rather than inverting an identical matrix a second time.
        const result = calculateEnhancement(params);

        if (!result || typeof result.attempts !== 'number' || typeof result.totalTime !== 'number') {
            console.error('[Enhancement Tooltip] Invalid result from calculateEnhancement:', result);
            return null;
        }

        // Calculate costs
        const costs = calculateTotalCost(itemHrid, targetLevel, protectFrom, config, result);

        return {
            expectedAttempts: result.attempts,
            totalTime: result.totalTime,
            ...costs,
        };
    } catch (error) {
        console.error('[Enhancement Tooltip] Strategy calculation error:', error);
        return null;
    }
}

/**
 * Walk the mirror DP back from the target level to the items the plan actually builds.
 *
 * The DP decides mirror-or-not level by level, and those decisions are not necessarily a clean
 * run: +6 can mirror while +5 does not. Assuming a contiguous block from the first mirrored
 * level and expanding it with Fibonacci quantities invents items the plan never buys. Walking
 * the decisions backwards from the target instead yields exactly the leaves it does buy.
 *
 * @param {number} targetLevel - Level the plan is building
 * @param {boolean[]} usedMirror - Per-level mirror decisions from the DP
 * @returns {{leaves: Array<{level: number, quantity: number}>, mirrorCount: number,
 *   mirrorStartLevel: number|null}} Leaves are levels bought traditionally, highest first
 * @private
 */
function expandMirrorPlan(targetLevel, usedMirror) {
    const need = new Array(targetLevel + 1).fill(0);
    need[targetLevel] = 1;

    let mirrorCount = 0;
    let mirrorStartLevel = null;

    // High to low: a level is only expanded once every demand for it is known
    for (let level = targetLevel; level >= 2; level--) {
        const quantity = need[level];
        if (!quantity || !usedMirror[level]) continue;

        mirrorCount += quantity;
        mirrorStartLevel = level; // Lowest mirrored level reached, since we descend
        need[level - 1] += quantity;
        need[level - 2] += quantity;
        need[level] = 0;
    }

    const leaves = [];
    for (let level = targetLevel; level >= 0; level--) {
        if (need[level] > 0) {
            leaves.push({ level, quantity: need[level] });
        }
    }

    return { leaves, mirrorCount, mirrorStartLevel };
}

/**
 * Build mirror-optimized result from an expanded plan
 * @param {string} itemHrid - Item being enhanced
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} plan - Result of expandMirrorPlan()
 * @param {number[]} traditionalCosts - Pre-mirror cost per level
 * @param {number[]} traditionalTimes - Pre-mirror time per level
 * @param {number[]} traditionalAttempts - Pre-mirror attempts per level
 * @param {number[]} targetCosts - Post-mirror cost per level
 * @param {Object} optimalTraditional - Best non-mirror strategy for the target level
 * @param {number} mirrorPrice - Price of one Philosopher's Mirror
 * @private
 */
function buildMirrorOptimizedResult(
    itemHrid,
    targetLevel,
    plan,
    traditionalCosts,
    traditionalTimes,
    traditionalAttempts,
    targetCosts,
    optimalTraditional,
    mirrorPrice
) {
    const { leaves, mirrorCount, mirrorStartLevel } = plan;

    // Every leaf is a level the plan buys outright, so it is priced at its traditional cost
    const consumedItems = leaves.map(({ level, quantity }) => ({
        level,
        quantity,
        costEach: traditionalCosts[level],
        totalCost: quantity * traditionalCosts[level],
    }));

    const consumedItemsCost = consumedItems.reduce((sum, item) => sum + item.totalCost, 0);
    const totalMirrorsCost = mirrorCount * mirrorPrice;

    // Mirror combinations are instant, so only the leaves cost time and attempts
    const totalTime = leaves.reduce((sum, { level, quantity }) => sum + quantity * traditionalTimes[level], 0);
    const totalAttempts = leaves.reduce((sum, { level, quantity }) => sum + quantity * traditionalAttempts[level], 0);

    // For mirror phase: ONLY consumed items + mirrors
    // The consumed item costs from targetCosts already include base/materials/protection
    // NO separate base/materials/protection for main item!

    return {
        protectFrom: optimalTraditional.protectFrom,
        label: optimalTraditional.protectFrom === 0 ? 'Never' : `From +${optimalTraditional.protectFrom}`,
        expectedAttempts: totalAttempts,
        totalTime: totalTime,
        baseCost: 0, // Not applicable for mirror phase
        materialCost: 0, // Not applicable for mirror phase
        protectionCost: 0, // Not applicable for mirror phase
        protectionItemHrid: null,
        protectionCount: 0,
        consumedItemsCost,
        philosopherMirrorCost: totalMirrorsCost,
        totalCost: targetCosts[targetLevel], // Use recursive formula result for consistency
        mirrorStartLevel: mirrorStartLevel,
        usedMirror: true,
        traditionalCost: optimalTraditional.totalCost,
        consumedItems: consumedItems,
        mirrorCount: mirrorCount,
        consumedItemHrid: itemHrid,
    };
}

/**
 * Fixed price for untradeable trainee charms, which have no market listing.
 */
const TRAINEE_CHARM_PRICE = 250000;

/**
 * Price one enhancement material.
 *
 * Three callers used to each carry their own copy of these rules — trainee charms are
 * untradeable and priced flat, coins are worth their face value, and a market quote with one
 * side missing borrows the side that exists — and they had already drifted apart. This is the
 * single answer all of them ask.
 *
 * @param {string} itemHrid - Material item HRID
 * @param {'ask'|'bid'} [side='ask'] - Which side of the book to price against
 * @returns {number} Unit price in coins, or 0 when nothing is known about the item
 */
export function getEnhancementMaterialPrice(itemHrid, side = 'ask') {
    if (!itemHrid) return 0;

    // Untradeable: no market listing exists, so use the fixed value on both sides
    if (itemHrid.startsWith('/items/trainee_')) {
        return TRAINEE_CHARM_PRICE;
    }
    if (itemHrid === '/items/coin') {
        return 1;
    }

    const marketPrice = getItemPrices(itemHrid, 0);
    if (marketPrice) {
        let ask = marketPrice.ask;
        let bid = marketPrice.bid;

        // Match MCS behavior: when only one side is quoted, both sides use it
        if (ask > 0 && bid < 0) bid = ask;
        if (bid > 0 && ask < 0) ask = bid;

        const price = side === 'bid' ? bid : ask;
        if (price > 0) return price;
    }

    // Fallback: production cost, then NPC sell price
    const gameData = dataManager.getInitClientData();
    const materialDetail = gameData?.itemDetailMap?.[itemHrid];
    return getProductionCost(itemHrid, side) || materialDetail?.sellPrice || 0;
}

/**
 * Calculate total cost for enhancement path
 * Matches original MWI Tools v25.0 cost calculation
 * @param {string} itemHrid - Item HRID
 * @param {number} targetLevel - Target enhancement level
 * @param {number} protectFrom - Protection threshold
 * @param {Object} config - Enhancement configuration
 * @param {Object} pathResult - Markov result for this strategy, already computed by the caller
 * @private
 */
function calculateTotalCost(itemHrid, targetLevel, protectFrom, config, pathResult) {
    const gameData = dataManager.getInitClientData();
    const itemDetails = gameData.itemDetailMap[itemHrid];

    // Calculate per-action material cost (same for all enhancement levels)
    // enhancementCosts is a flat array of materials needed per attempt
    let perActionCost = 0;
    const materialBreakdown = [];
    if (itemDetails.enhancementCosts) {
        for (const material of itemDetails.enhancementCosts) {
            const materialDetail = gameData.itemDetailMap[material.itemHrid];
            const price = getEnhancementMaterialPrice(material.itemHrid, 'ask');
            const bidPrice = getEnhancementMaterialPrice(material.itemHrid, 'bid');
            perActionCost += price * material.count;

            const totalQuantity = material.count * pathResult.attempts;
            materialBreakdown.push({
                itemHrid: material.itemHrid,
                name: materialDetail?.name || material.itemHrid,
                countPerAction: material.count,
                totalQuantity,
                unitPrice: price,
                bidPrice,
                totalCost: price * totalQuantity,
            });
        }
    }

    // Total material cost = per-action cost × total attempts
    const materialCost = perActionCost * pathResult.attempts;

    // Protection cost = cheapest protection option × protection count
    let protectionCost = 0;
    let protectionItemHrid = null;
    let protectionCount = 0;
    let protectionAskPrice = 0;
    let protectionBidPrice = 0;
    if (protectFrom > 0 && pathResult.protectionCount > 0) {
        const protectionInfo = getCheapestProtectionPrice(itemHrid);
        if (protectionInfo.price > 0) {
            protectionCost = protectionInfo.price * pathResult.protectionCount;
            protectionItemHrid = protectionInfo.itemHrid;
            protectionCount = pathResult.protectionCount;
            protectionAskPrice = protectionInfo.price;
            const protPrices = getItemPrices(protectionInfo.itemHrid, 0);
            protectionBidPrice = protPrices?.bid > 0 ? protPrices.bid : protectionInfo.price;
        }
    }

    // Base item cost (initial investment) — market price or min(crafting, market) per setting
    const craftingCostAsk = getProductionCost(itemHrid, 'ask');
    const craftingCostBid = getProductionCost(itemHrid, 'bid');
    const baseItemPrices = getItemPrices(itemHrid, 0);
    const marketAsk = baseItemPrices?.ask > 0 ? baseItemPrices.ask : 0;
    const marketBid = baseItemPrices?.bid > 0 ? baseItemPrices.bid : 0;
    const useCraftingCost = toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost');
    // Ask drives the decision: use crafted if ask is missing OR crafted ask is cheaper
    const askIsCrafted = useCraftingCost && craftingCostAsk > 0 && (marketAsk === 0 || craftingCostAsk < marketAsk);
    const baseAskPrice = askIsCrafted ? craftingCostAsk : marketAsk || getRealisticBaseItemPrice(itemHrid);
    const baseBidPrice = askIsCrafted
        ? craftingCostBid || craftingCostAsk
        : marketBid || getProductionCost(itemHrid, 'bid') || getRealisticBaseItemPrice(itemHrid);
    const baseCost = baseAskPrice;
    const baseAskIsCrafted = askIsCrafted;
    const baseBidIsCrafted = askIsCrafted;

    return {
        baseCost,
        baseAskPrice,
        baseBidPrice,
        baseAskIsCrafted,
        baseBidIsCrafted,
        materialCost,
        materialBreakdown,
        protectionCost,
        protectionItemHrid,
        protectionCount,
        protectionAskPrice,
        protectionBidPrice,
        totalCost: baseCost + materialCost + protectionCost,
    };
}

/**
 * Get realistic base item price with production cost fallback
 * Matches original MWI Tools v25.0 getRealisticBaseItemPrice logic
 * @private
 */
export function getRealisticBaseItemPrice(itemHrid) {
    const marketPrice = getItemPrices(itemHrid, 0);
    const ask = marketPrice?.ask > 0 ? marketPrice.ask : 0;
    const bid = marketPrice?.bid > 0 ? marketPrice.bid : 0;

    // Calculate production cost as fallback
    const productionCost = getProductionCost(itemHrid);

    // If both ask and bid exist
    if (ask > 0 && bid > 0) {
        // If ask is significantly higher than bid (>30% markup), use max(bid, production)
        if (ask / bid > 1.3) {
            return Math.max(bid, productionCost);
        }
        // Otherwise use ask (normal market)
        return ask;
    }

    // If only ask exists
    if (ask > 0) {
        // If ask is inflated compared to production, use production
        if (productionCost > 0 && ask / productionCost > 1.3) {
            return productionCost;
        }
        // Otherwise use max of ask and production
        return Math.max(ask, productionCost);
    }

    // If only bid exists, use max(bid, production)
    if (bid > 0) {
        return Math.max(bid, productionCost);
    }

    // No market data - use production cost as fallback
    return productionCost;
}

/**
 * Calculate production cost from crafting recipe
 * Matches original MWI Tools v25.0 getBaseItemProductionCost logic
 * @param {string} itemHrid
 * @param {'ask'|'bid'} [mode='ask'] - Pricing side to use for input materials
 * @private
 */
export function getProductionCost(itemHrid, mode = 'ask') {
    const cacheKey = `${itemHrid}|${mode}`;
    if (_costCache.has(cacheKey)) return _costCache.get(cacheKey);
    const result = _computeProductionCost(itemHrid, mode);
    _costCache.set(cacheKey, result);
    return result;
}

function _computeProductionCost(itemHrid, mode = 'ask') {
    const gameData = dataManager.getInitClientData();
    const itemDetails = gameData.itemDetailMap[itemHrid];

    if (!itemDetails || !itemDetails.name) {
        return 0;
    }

    // Find the action that produces this item
    let actionHrid = null;
    let outputCount = 1;
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.outputItems && action.outputItems.length > 0) {
            const output = action.outputItems[0];
            if (output.itemHrid === itemHrid) {
                actionHrid = hrid;
                outputCount = output.count || 1;
                break;
            }
        }
    }

    if (!actionHrid) {
        return 0;
    }

    const action = gameData.actionDetailMap[actionHrid];
    let totalPrice = 0;

    // Compute artisan tea reduction dynamically (same approach as material-calculator.js)
    let artisanBonus = 0;
    try {
        const equipment = dataManager.getEquipment();
        const itemDetailMap = gameData.itemDetailMap || {};
        const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
        const activeDrinks = dataManager.getActionDrinkSlots(action.type);
        artisanBonus = parseArtisanBonus(activeDrinks, itemDetailMap, drinkConcentration);
    } catch {
        // Fall back to no reduction if data unavailable
    }

    // Sum up input material costs (artisan tea reduces material quantities, not upgrade items)
    if (action.inputItems) {
        for (const input of action.inputItems) {
            if (input.itemHrid === '/items/coin') {
                totalPrice += input.count * (1 - artisanBonus);
                continue;
            }
            let inputPrice = getItemPrice(input.itemHrid, { mode }) || 0;
            if (inputPrice === 0) {
                inputPrice = getProductionCost(input.itemHrid, mode);
            }
            totalPrice += inputPrice * input.count * (1 - artisanBonus);
        }
    }

    // Add upgrade item cost if this is an upgrade recipe (not affected by artisan tea)
    // Use min(market, craft) so refined items reflect the cheapest way to obtain the base item
    if (action.upgradeItemHrid) {
        const upgradeMarketPrice = getItemPrice(action.upgradeItemHrid, { mode }) || 0;
        const upgradeCraftPrice = getProductionCost(action.upgradeItemHrid, mode);
        let upgradePrice;
        if (upgradeMarketPrice > 0 && upgradeCraftPrice > 0) {
            upgradePrice = Math.min(upgradeMarketPrice, upgradeCraftPrice);
        } else {
            upgradePrice = upgradeMarketPrice || upgradeCraftPrice;
        }
        totalPrice += upgradePrice;
    }

    return totalPrice / outputCount;
}

/**
 * Get total crafting chain time for an item's upgrade path (recursive).
 * Sums base action times through the upgrade item chain, stopping when market is cheaper.
 * @param {string} itemHrid - Item HRID to get production chain time for
 * @returns {number} Total chain time in seconds (base times, no speed bonuses applied)
 */
export function getProductionChainTime(itemHrid) {
    if (_chainTimeCache.has(itemHrid)) return _chainTimeCache.get(itemHrid);
    const result = _computeProductionChainTime(itemHrid);
    _chainTimeCache.set(itemHrid, result);
    return result;
}

function _computeProductionChainTime(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return 0;

    let action = null;
    for (const act of Object.values(gameData.actionDetailMap)) {
        if (act.outputItems?.[0]?.itemHrid === itemHrid) {
            action = act;
            break;
        }
    }

    if (!action || !action.baseTimeCost) return 0;

    let totalTime = action.baseTimeCost / 1e9;

    if (action.upgradeItemHrid) {
        const marketPrice = getItemPrice(action.upgradeItemHrid, { mode: 'ask' }) || 0;
        const craftPrice = getProductionCost(action.upgradeItemHrid, 'ask');
        if (craftPrice > 0 && (marketPrice === 0 || craftPrice < marketPrice)) {
            totalTime += getProductionChainTime(action.upgradeItemHrid);
        }
    }

    return totalTime;
}

/**
 * Get cheapest protection item price
 * Tests: item itself, mirror of protection, and specific protection items
 * @private
 */
export function getCheapestProtectionPrice(itemHrid) {
    const gameData = dataManager.getInitClientData();
    const itemDetails = gameData.itemDetailMap[itemHrid];

    // Build list of protection options: [item itself, mirror, ...specific items]
    const protectionOptions = [itemHrid, '/items/mirror_of_protection'];

    // Add specific protection items if they exist
    if (itemDetails.protectionItemHrids && itemDetails.protectionItemHrids.length > 0) {
        protectionOptions.push(...itemDetails.protectionItemHrids);
    }

    // Find cheapest option
    let cheapestPrice = Infinity;
    let cheapestItemHrid = null;
    for (const protectionHrid of protectionOptions) {
        const price = getRealisticBaseItemPrice(protectionHrid);
        if (price > 0 && price < cheapestPrice) {
            cheapestPrice = price;
            cheapestItemHrid = protectionHrid;
        }
    }

    return {
        price: cheapestPrice === Infinity ? 0 : cheapestPrice,
        itemHrid: cheapestItemHrid,
    };
}

/**
 * Minimum sell price that covers the total cost plus a target hourly rate for the
 * time the enhancement takes, optionally grossed up for the marketplace seller tax.
 * @param {number} totalCost - Total cost to reach the level, on one side (ask or bid)
 * @param {number} totalTimeSeconds - Total enhancing time, in seconds
 * @param {number} hourlyRate - Target coins/hour for time spent
 * @param {boolean} includeTax - Whether to gross up for the marketplace seller tax
 * @returns {number} Minimum sell price
 */
export function calculateMinimumSellPrice(totalCost, totalTimeSeconds, hourlyRate, includeTax) {
    const breakeven = totalCost + hourlyRate * (totalTimeSeconds / 3600);
    return includeTax ? breakeven / (1 - MARKET_TAX) : breakeven;
}

/**
 * Build HTML for enhancement tooltip section
 * @param {Object} enhancementData - Enhancement analysis from calculateEnhancementPath()
 * @returns {string} HTML string
 */
export function buildEnhancementTooltipHTML(enhancementData) {
    if (!enhancementData || !enhancementData.optimalStrategy) {
        return '';
    }

    const { itemHrid, targetLevel, optimalStrategy, xpPerHour, totalExpectedXP, paramsNote, enhancementParams } =
        enhancementData;

    // Validate required fields
    if (
        typeof optimalStrategy.expectedAttempts !== 'number' ||
        typeof optimalStrategy.totalTime !== 'number' ||
        typeof optimalStrategy.materialCost !== 'number' ||
        typeof optimalStrategy.totalCost !== 'number'
    ) {
        console.error('[Enhancement Tooltip] Missing required fields in optimal strategy:', optimalStrategy);
        return '';
    }

    let html =
        `<div ${sectionAttributes('path', itemHrid, targetLevel)} ` +
        'style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px;">';
    html +=
        '<div style="font-weight: bold; margin-bottom: 4px;">ENHANCEMENT PATH (+0 → +' +
        targetLevel +
        ')' +
        buildSourceChipHTML(enhancementParams) +
        '</div>';
    html += '<div style="font-size: 0.9em; margin-left: 8px;">';

    // Optimal strategy
    if (optimalStrategy.protectFrom === 0) {
        html += '<div>No protection needed for +' + targetLevel + '</div>';
    } else {
        html += '<div>Protect from: ' + optimalStrategy.label + '</div>';
    }

    // Show Philosopher's Mirror usage if applicable
    if (optimalStrategy.usedMirror && optimalStrategy.mirrorStartLevel) {
        html +=
            '<div style="color: ' +
            config.COLOR_MIRROR +
            ';">Uses Philosopher\'s Mirror from +' +
            optimalStrategy.mirrorStartLevel +
            '</div>';
    }

    html += '<div>Expected Attempts: ' + formatLargeNumber(optimalStrategy.expectedAttempts.toFixed(1)) + '</div>';

    // Costs table
    html += '<div style="margin-top: 8px;">';
    html += `<table style="width: 100%; border-collapse: collapse; font-size: 0.85em; color: ${config.COLOR_TOOLTIP_INFO};">`;

    // Table header
    html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
    html += '<th style="padding: 2px 4px; text-align: left;">Material</th>';
    html += '<th style="padding: 2px 4px; text-align: center;">Count</th>';
    html += '<th style="padding: 2px 4px; text-align: right;">Ask</th>';
    html += '<th style="padding: 2px 4px; text-align: right;">Bid</th>';
    html += '</tr>';

    // Hoisted so both breakdowns populate them and the minimum-sell section below can read them
    let totalAsk = 0;
    let totalBid = 0;

    // Check if using mirror optimization
    if (optimalStrategy.usedMirror && optimalStrategy.consumedItems && optimalStrategy.consumedItems.length > 0) {
        // Mirror-optimized breakdown
        // Calculate totals for mirror path

        // Consumed items (enhanced items at specific levels)
        const sortedConsumed = [...optimalStrategy.consumedItems]
            .filter((item) => item.quantity > 0)
            .sort((a, b) => b.level - a.level);

        const gameData = dataManager.getInitClientData();
        const consumedHrid = optimalStrategy.consumedItemHrid ?? itemHrid;
        const baseItemDetails = gameData?.itemDetailMap[consumedHrid];
        const baseItemName = baseItemDetails?.name || consumedHrid;

        const consumedRows = sortedConsumed.map((item) => {
            const prices = getItemPrices(consumedHrid, item.level);
            const askPrice = prices?.ask > 0 ? prices.ask : item.costEach;
            const bidPrice = prices?.bid > 0 ? prices.bid : item.costEach;
            totalAsk += askPrice * item.quantity;
            totalBid += bidPrice * item.quantity;
            return { name: baseItemName + ' +' + item.level, count: item.quantity, askPrice, bidPrice };
        });

        // Philosopher's Mirror row
        if (optimalStrategy.philosopherMirrorCost > 0 && optimalStrategy.mirrorCount > 0) {
            const mirrorPrices = getItemPrices('/items/philosophers_mirror', 0);
            const mirrorAsk = mirrorPrices?.ask > 0 ? mirrorPrices.ask : 0;
            const mirrorBid = mirrorPrices?.bid > 0 ? mirrorPrices.bid : 0;
            totalAsk += mirrorAsk * optimalStrategy.mirrorCount;
            totalBid += mirrorBid * optimalStrategy.mirrorCount;
            consumedRows.push({
                name: "Philosopher's Mirror",
                count: optimalStrategy.mirrorCount,
                askPrice: mirrorAsk,
                bidPrice: mirrorBid,
            });
        }

        // Color total ask/bid by comparison to market price of enhanced item
        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const totalAskColor =
            enhancedPrices?.ask > 0
                ? totalAsk < enhancedPrices.ask
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';
        const totalBidColor =
            enhancedPrices?.bid > 0
                ? totalBid < enhancedPrices.bid
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';

        // Total row
        html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
        html += '<td style="padding: 2px 4px; font-weight: bold;">Total</td>';
        html += '<td style="padding: 2px 4px; text-align: center;"></td>';
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalAskColor ? ' color: ' + totalAskColor + ';' : ''}">${formatKMB(totalAsk)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalBidColor ? ' color: ' + totalBidColor + ';' : ''}">${formatKMB(totalBid)}</td>`;
        html += '</tr>';

        // Item rows
        for (const row of consumedRows) {
            html += '<tr>';
            html += `<td style="padding: 2px 4px;">${row.name}</td>`;
            html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(row.count)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.askPrice)}</td>`;
            html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.bidPrice)}</td>`;
            html += '</tr>';
        }
    } else {
        // Traditional (non-mirror) breakdown
        // Calculate totals
        let totalCount = 1; // Base item counts as 1
        totalAsk = optimalStrategy.baseAskPrice || optimalStrategy.baseCost;
        totalBid = optimalStrategy.baseBidPrice || optimalStrategy.baseCost;

        const rows = [];

        // Base item row
        const baseItemLabel = optimalStrategy.baseAskIsCrafted ? 'Craft Item' : 'Buy Item';
        rows.push({
            name: toolashaConfig.isFeatureEnabled('enhanceSim_baseItemCraftingCost') ? baseItemLabel : 'Base Item',
            count: 1,
            askPrice: optimalStrategy.baseAskPrice || optimalStrategy.baseCost,
            bidPrice: optimalStrategy.baseBidPrice || optimalStrategy.baseCost,
        });

        // Material rows
        if (optimalStrategy.materialBreakdown && optimalStrategy.materialBreakdown.length > 0) {
            for (const mat of optimalStrategy.materialBreakdown) {
                const count = mat.totalQuantity;
                const askPrice = mat.unitPrice;
                const bidPrice = mat.bidPrice || mat.unitPrice;
                totalCount += count;
                totalAsk += askPrice * count;
                totalBid += bidPrice * count;
                rows.push({ name: mat.name, count, askPrice, bidPrice, isCoin: mat.itemHrid === '/items/coin' });
            }
        }

        // Protection row
        if (optimalStrategy.protectionCost > 0 && optimalStrategy.protectionCount > 0) {
            const count = optimalStrategy.protectionCount;
            const askPrice = optimalStrategy.protectionAskPrice || 0;
            const bidPrice = optimalStrategy.protectionBidPrice || askPrice;
            totalCount += count;
            totalAsk += askPrice * count;
            totalBid += bidPrice * count;

            let protName = 'Protection';
            if (optimalStrategy.protectionItemHrid) {
                const gameData = dataManager.getInitClientData();
                const protDetails = gameData?.itemDetailMap[optimalStrategy.protectionItemHrid];
                if (protDetails?.name) {
                    protName = protDetails.name;
                }
            }
            rows.push({ name: protName, count, askPrice, bidPrice });
        }

        // Color total ask/bid by comparison to market price of enhanced item
        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const totalAskColor =
            enhancedPrices?.ask > 0
                ? totalAsk < enhancedPrices.ask
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';
        const totalBidColor =
            enhancedPrices?.bid > 0
                ? totalBid < enhancedPrices.bid
                    ? config.COLOR_TOOLTIP_PROFIT
                    : config.COLOR_TOOLTIP_LOSS
                : '';

        // Total row
        html += `<tr style="border-bottom: 1px solid ${config.COLOR_BORDER};">`;
        html += '<td style="padding: 2px 4px; font-weight: bold;">Total</td>';
        html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(totalCount)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalAskColor ? ' color: ' + totalAskColor + ';' : ''}">${formatKMB(totalAsk)}</td>`;
        html += `<td style="padding: 2px 4px; text-align: right; font-weight: bold;${totalBidColor ? ' color: ' + totalBidColor + ';' : ''}">${formatKMB(totalBid)}</td>`;
        html += '</tr>';

        // Item rows
        for (const row of rows) {
            html += '<tr>';
            html += `<td style="padding: 2px 4px;">${row.name}</td>`;
            if (row.isCoin) {
                html += '<td style="padding: 2px 4px; text-align: center;">—</td>';
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.count)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.count)}</td>`;
            } else {
                html += `<td style="padding: 2px 4px; text-align: center;">${formatKMB(row.count)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.askPrice)}</td>`;
                html += `<td style="padding: 2px 4px; text-align: right;">${formatKMB(row.bidPrice)}</td>`;
            }
            html += '</tr>';
        }
    }

    html += '</table>';
    html += '</div>';

    // Time estimate
    const totalSeconds = optimalStrategy.totalTime;

    if (totalSeconds < 60) {
        // Less than 1 minute: show seconds
        html += '<div>Time: ~' + Math.round(totalSeconds) + ' seconds</div>';
    } else if (totalSeconds < 3600) {
        // Less than 1 hour: show minutes
        const minutes = Math.round(totalSeconds / 60);
        html += '<div>Time: ~' + minutes + ' minutes</div>';
    } else if (totalSeconds < 86400) {
        // Less than 1 day: show hours
        const hours = (totalSeconds / 3600).toFixed(1);
        html += '<div>Time: ~' + hours + ' hours</div>';
    } else {
        // 1 day or more: show days
        const days = (totalSeconds / 86400).toFixed(1);
        html += '<div>Time: ~' + days + ' days</div>';
    }

    if (xpPerHour !== null && xpPerHour > 0) {
        html += '<div style="margin-top: 4px;">XP/hr: ' + formatLargeNumber(xpPerHour) + '</div>';
    }
    if (totalExpectedXP !== null && totalExpectedXP > 0) {
        html += '<div>Total XP: ~' + formatLargeNumber(totalExpectedXP) + '</div>';
    }

    // Target hourly rate / minimum sell price — only when a rate is configured.
    // The rate is a text setting, so it is read with getSettingValue(); getSetting() only
    // ever answers with a boolean and would silently parse to 0 here.
    const hourlyRate = parseItemCount(config.getSettingValue('itemTooltip_enhancingHourlyRate', ''), 0);
    if (hourlyRate > 0) {
        const includeTax = config.getSetting('itemTooltip_enhancingHourlyRateTax');
        const minSellAsk = calculateMinimumSellPrice(totalAsk, optimalStrategy.totalTime, hourlyRate, includeTax);
        const minSellBid = calculateMinimumSellPrice(totalBid, optimalStrategy.totalTime, hourlyRate, includeTax);

        const enhancedPrices = getItemPrices(itemHrid, targetLevel);
        const priceColor = (price, minimum) =>
            price > 0 ? (price >= minimum ? config.COLOR_TOOLTIP_PROFIT : config.COLOR_TOOLTIP_LOSS) : '';
        const askColor = priceColor(enhancedPrices?.ask, minSellAsk);
        const bidColor = priceColor(enhancedPrices?.bid, minSellBid);

        html += '<div style="margin-top: 4px;">Your rate: ' + formatKMB(hourlyRate) + '/hr</div>';
        html += '<div>Minimum sell: ';
        html += `<span${askColor ? ` style="color: ${askColor};"` : ''}>${formatKMB(minSellAsk)}</span>(ask)/`;
        html += `<span${bidColor ? ` style="color: ${bidColor};"` : ''}>${formatKMB(minSellBid)}</span>(bid)`;
        html += '</div>';
    }

    // A quiet note, not a warning: these numbers are only as true as the stats behind them,
    // and a hand-entered stat is the one place they can quietly stop describing this character
    if (paramsNote) {
        html += `<div style="margin-top: 4px; font-size: 0.8em; opacity: 0.6;">${paramsNote}</div>`;
    }

    html += '</div>'; // Close margin-left div
    html += '</div>'; // Close main container

    return html;
}

/**
 * Redraw every enhancement section currently on screen with whatever source is now active.
 *
 * The sections are plain HTML inside a game tooltip, so the cheapest correct refresh is to
 * rebuild the same section from the same item and level and swap it in. Anything still open
 * therefore switches the moment the toggle flips, rather than showing the old kit's numbers
 * under the new kit's label until the next hover.
 */
export function rerenderOpenEnhancementSections() {
    if (typeof document === 'undefined') return;

    for (const section of document.querySelectorAll(`[${SECTION_ATTR}]`)) {
        try {
            const itemHrid = section.getAttribute('data-toolasha-enh-item');
            if (!itemHrid) continue;

            const kind = section.getAttribute(SECTION_ATTR);
            const params = getTooltipEnhancementParams(itemHrid);

            let html;
            if (kind === 'milestones') {
                html = buildEnhancementMilestonesHTML(itemHrid, params);
            } else {
                const level = parseInt(section.getAttribute('data-toolasha-enh-level'), 10);
                const data = level > 0 ? calculateEnhancementPath(itemHrid, level, params) : null;
                html = data ? buildEnhancementTooltipHTML(data) : '';
            }

            // An empty rebuild means the new params produced nothing to say; leaving the old
            // section up would label it with a source that did not produce it, so it goes
            section.outerHTML = html;
        } catch (error) {
            console.error('[Enhancement Tooltip] Failed to redraw section for new stats source:', error);
        }
    }
}

let _sourceToggleHandlers = null;

/**
 * Make the source chip live: clicking it, or pressing P while a section is on screen, switches
 * the prediction between the player's own stats and pro rates and redraws what is open.
 *
 * The key is what makes the toggle usable on a hover tooltip, which vanishes the moment the
 * pointer leaves the item it describes — there is no way to walk the cursor over to the chip.
 * The chip stays clickable for the tooltips that do stay open (item click popups).
 */
export function installEnhancementSourceToggle() {
    if (typeof document === 'undefined' || _sourceToggleHandlers) return;

    const flip = () => {
        toggleProRates();
        rerenderOpenEnhancementSections();
    };

    const onClick = (event) => {
        const chip = event.target?.closest?.(`.${SOURCE_CHIP_CLASS}`);
        if (!chip) return;
        event.preventDefault();
        event.stopPropagation();
        flip();
    };

    const onKeyDown = (event) => {
        if (event.key?.toLowerCase() !== 'p' || event.ctrlKey || event.altKey || event.metaKey) return;

        // Never steal a keystroke from chat, a price box or any other field being typed into
        const target = event.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;

        // Only meaningful while a prediction is actually on screen to be re-sourced
        if (!document.querySelector(`[${SECTION_ATTR}]`)) return;

        event.preventDefault();
        flip();
    };

    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    _sourceToggleHandlers = { onClick, onKeyDown };
}

/**
 * Remove the source toggle's listeners.
 */
export function uninstallEnhancementSourceToggle() {
    if (typeof document === 'undefined' || !_sourceToggleHandlers) return;

    document.removeEventListener('click', _sourceToggleHandlers.onClick, true);
    document.removeEventListener('keydown', _sourceToggleHandlers.onKeyDown, true);
    _sourceToggleHandlers = null;
}

const MILESTONE_LEVELS = [5, 7, 10, 12];

/**
 * Build compact enhancement milestones HTML for unenhanced item tooltips
 * Shows expected cost and XP for +5, +7, +10, +12
 * @param {string} itemHrid - Item HRID
 * @param {Object} enhancementConfig - Enhancement configuration from getEnhancingParams()
 * @returns {string} HTML string, or empty string if item is not enhanceable
 */
export function buildEnhancementMilestonesHTML(itemHrid, enhancementConfig) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) return '';

    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails?.enhancementCosts?.length) return '';

    const showPrices = config.getSetting('itemTooltip_prices');
    const useKMB = isAbbreviationEnabled();
    const fmt = (n) => (n != null && n > 0 ? (useKMB ? formatLargeNumber(n, 0) : numberFormatter(Math.round(n))) : '—');
    const fmtCost = (n) =>
        n != null && n > 0 ? (useKMB ? formatLargeNumber(n, 1) : numberFormatter(Math.round(n))) : '—';

    const rows = [];
    for (const level of MILESTONE_LEVELS) {
        const data = calculateEnhancementPath(itemHrid, level, enhancementConfig);
        if (!data) continue;

        const cost = fmtCost(data.optimalStrategy.totalCost);
        const xp = data.totalExpectedXP !== null ? fmt(Math.round(data.totalExpectedXP)) : '—';

        let ask = '—';
        let bid = '—';
        if (showPrices) {
            const prices = getItemPrices(itemHrid, level);
            ask = fmt(prices?.ask);
            bid = fmt(prices?.bid);
        }

        rows.push({ level, cost, xp, ask, bid });
    }

    if (rows.length === 0) return '';

    const tdStyle = (align = 'right', color = '') =>
        `style="padding: 1px 6px; text-align: ${align};${color ? ` color: ${color};` : ''}"`;
    const thStyle = (align = 'right') =>
        `style="padding: 1px 6px; text-align: ${align}; opacity: 0.6; font-weight: normal;"`;

    let html =
        `<div ${sectionAttributes('milestones', itemHrid, 0)} ` +
        'style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px;">';
    html +=
        '<div style="font-weight: bold; margin-bottom: 4px;">Enhancement Milestones' +
        buildSourceChipHTML(enhancementConfig) +
        '</div>';
    html += '<table style="font-size: 0.9em; border-collapse: collapse; width: 100%;">';
    html += '<thead><tr>';
    html += `<th ${thStyle('left')}>Level</th>`;
    html += `<th ${thStyle()}>Cost</th>`;
    if (showPrices) html += `<th ${thStyle()}>Ask / Bid</th>`;
    html += `<th ${thStyle()}>XP</th>`;
    html += '</tr></thead><tbody>';

    for (const row of rows) {
        html += '<tr>';
        html += `<td ${tdStyle('left', config.COLOR_TOOLTIP_INFO)}>+${row.level}</td>`;
        html += `<td ${tdStyle('right', config.COLOR_TOOLTIP_INFO)}>${row.cost}</td>`;
        if (showPrices) {
            html += `<td ${tdStyle('right', config.COLOR_TOOLTIP_INFO)}>${row.ask} / ${row.bid}</td>`;
        }
        html += `<td ${tdStyle('right', config.COLOR_XP_RATE)}>${row.xp}</td>`;
        html += '</tr>';
    }

    html += '</tbody></table>';

    const paramsNote = describeEnhancementSource(enhancementConfig).detail;
    if (paramsNote) {
        html += `<div style="font-size: 0.8em; opacity: 0.6; margin-top: 2px;">${paramsNote}</div>`;
    }

    html += '</div>';

    return html;
}
