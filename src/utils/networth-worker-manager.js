/**
 * Networth Item Valuation Worker Manager
 * Manages parallel item valuation calculations including enhancement paths
 */

import WorkerPool, { createIdlePoolReaper } from './worker-pool.js';
import { BASE_SUCCESS_RATES, BLESSED_TEA_BASE_CHANCE, buildEnhancementMarkov } from './enhancement-calculator.js';
import { createMatrixMath } from './matrix-inverse.js';

// Worker pool instance
let workerPool = null;
const idleReaper = createIdlePoolReaper(
    () => terminateItemValueWorkerPool(),
    undefined,
    () => Boolean(workerPool) && (workerPool.getStats().busyWorkers > 0 || workerPool.getStats().queuedTasks > 0)
);

// Worker script as inline string.
// The Markov chain is not written here: a blob worker cannot import a module, so the real
// buildEnhancementMarkov is serialised in below and networth costs the same chain the tooltip
// quotes, clamp and blessed-tea chance included.
const WORKER_SCRIPT = `
// The matrix helper the chain needs, serialised in the same way the chain
// itself is — this used to importScripts ~600 KB of unminified math.js per
// worker for one 20x20 inverse.
const math = (${createMatrixMath.toString()})();

// Cache for item valuations
const valuationCache = new Map();

// Enhancement calculation BASE_SUCCESS_RATES
const BASE_SUCCESS_RATES = ${JSON.stringify(BASE_SUCCESS_RATES)};
const DEFAULT_BLESSED_TEA_CHANCE = ${BLESSED_TEA_BASE_CHANCE};
const buildEnhancementMarkov = ${buildEnhancementMarkov.toString()};

/**
 * Calculate production cost from crafting/upgrading recipe
 * @param {string} itemHrid - Item HRID
 * @param {Object} priceMap - Price map
 * @param {Object} recipes - Action detail map from game data
 * @returns {number} Production cost
 */
function calculateProductionCost(itemHrid, priceMap, recipes) {
    // The recipe index is built on the main thread from the same any-output
    // rule calculateCraftingCost uses, and carries the matched output's count
    const action = recipes[itemHrid] || null;

    if (!action) {
        return 0;
    }

    let totalPrice = 0;

    // Sum up input material costs
    if (action.inputItems) {
        for (const input of action.inputItems) {
            // Match main thread: calculateCraftingCost prices inputs through
            // getMarketPrice, which honors networth_pricingMode. The manager
            // writes that mode's price at the plain base key (see priceMapFor)
            // and leaves the key unset when the mode has no price, which is
            // exactly main's "no price -> fall through" case. Reading :0_ask
            // here instead priced every input on the ask side no matter what
            // the setting said.
            let inputPrice = priceMap[input.itemHrid + ':0'];
            if (!(inputPrice > 0)) inputPrice = 0;

            // Recursively calculate production cost if no market price (matches main thread)
            if (inputPrice === 0) {
                inputPrice = calculateProductionCost(input.itemHrid, priceMap, recipes);
            }

            totalPrice += inputPrice * input.count;
        }
    }

    // Apply Artisan Tea reduction (0.9x)
    totalPrice *= 0.9;

    // Add upgrade item cost if this is an upgrade recipe (for refined items)
    if (action.upgradeItemHrid) {
        // Same mode-priced base key as the inputs above
        let upgradePrice = priceMap[action.upgradeItemHrid + ':0'];
        if (!(upgradePrice > 0)) upgradePrice = 0;

        // Recursively calculate production cost if no market price (matches main thread)
        if (upgradePrice === 0) {
            upgradePrice = calculateProductionCost(action.upgradeItemHrid, priceMap, recipes);
        }

        totalPrice += upgradePrice;
    }

    // Divide by the matched output's count, as calculateCraftingCost does: an
    // action that yields ten of something does not make each one cost a batch.
    return totalPrice / (action.outputCount || 1);
}

/**
 * Calculate enhancement path cost using proper strategy optimization
 * @param {Object} params - Enhancement calculation parameters
 * @returns {number} Total cost
 */
function calculateEnhancementCost(params) {
    const { itemHrid, targetLevel, enhancementParams, itemDetails, priceMap, recipes } = params;

    if (!itemDetails.enhancementCosts || targetLevel < 1 || targetLevel > 20) {
        return null;
    }

    const itemLevel = itemDetails.itemLevel || 1;

    // Get base item cost using realistic pricing (matches main thread logic)
    const basePrice = getRealisticPrice(itemHrid, null, priceMap, recipes);

    // Build cost array for each level by testing all protection strategies
    const targetCosts = new Array(targetLevel + 1);
    targetCosts[0] = basePrice;

    for (let level = 1; level <= targetLevel; level++) {
        // Calculate per-attempt material cost (sum of ALL materials)
        let perAttemptMaterialCost = 0;
        if (itemDetails.enhancementCosts && itemDetails.enhancementCosts.length > 0) {
            for (const material of itemDetails.enhancementCosts) {
                let materialPrice = 0;

                // Special cases
                if (material.itemHrid.startsWith('/items/trainee_')) {
                    materialPrice = 250000; // Trainee charms are untradeable, fixed price
                } else if (material.itemHrid === '/items/coin') {
                    materialPrice = 1; // Coins have face value of 1
                } else {
                    // Get material details for sellPrice fallback
                    const materialDetail = itemDetails.enhancementCosts ?
                        (itemDetails.allItemDetails && itemDetails.allItemDetails[material.itemHrid]) : null;

                    // Try to get market price from priceMap
                    const hasMarketData = (material.itemHrid + ':0_ask') in priceMap || (material.itemHrid + ':0') in priceMap;

                    if (hasMarketData) {
                        let ask = priceMap[material.itemHrid + ':0_ask'];
                        if (ask === undefined) ask = priceMap[material.itemHrid + ':0'];
                        let bid = priceMap[material.itemHrid + ':0_bid'];

                        // Match MCS behavior: if one price is positive and other is negative, use positive for both
                        if (ask > 0 && bid < 0) {
                            bid = ask;
                        }
                        if (bid > 0 && ask < 0) {
                            ask = bid;
                        }

                        // MCS uses just ask for material prices (matches main thread)
                        materialPrice = ask || 0;
                    } else {
                        // Fallback to sellPrice if no market data (matches main thread)
                        materialPrice = materialDetail?.sellPrice || 0;
                    }
                }

                perAttemptMaterialCost += materialPrice * material.count;
            }
        }

        // Test no protection (protectFrom = 0)
        let minCost = Infinity;
        const noProtResult = calculateStrategyRealCost(
            enhancementParams,
            itemLevel,
            level,
            0,
            perAttemptMaterialCost,
            basePrice,
            priceMap,
            itemDetails,
            itemHrid,
            recipes
        );
        if (noProtResult < minCost) {
            minCost = noProtResult;
        }

        // Test protection from level 2 to current level
        for (let protectFrom = 2; protectFrom <= level; protectFrom++) {
            const protResult = calculateStrategyRealCost(
                enhancementParams,
                itemLevel,
                level,
                protectFrom,
                perAttemptMaterialCost,
                basePrice,
                priceMap,
                itemDetails,
                itemHrid,
                recipes
            );
            if (protResult < minCost) {
                minCost = protResult;
            }
        }

        targetCosts[level] = minCost;
    }

    // Apply Philosopher's Mirror optimization
    let mirrorPrice = priceMap['/items/philosophers_mirror:0'] || 0;
    if (mirrorPrice === 0) {
        mirrorPrice = calculateProductionCost('/items/philosophers_mirror', priceMap, recipes);
    }

    if (mirrorPrice > 0) {
        for (let level = 3; level <= targetLevel; level++) {
            const traditionalCost = targetCosts[level];
            const mirrorCost = targetCosts[level - 2] + targetCosts[level - 1] + mirrorPrice;
            if (mirrorCost < traditionalCost) {
                targetCosts[level] = mirrorCost;
            }
        }
    }

    return targetCosts[targetLevel];
}

/**
 * Calculate real cost for a specific protection strategy
 * Now includes support for Blessed Tea
 */
function calculateStrategyRealCost(
    enhancementParams,
    itemLevel,
    targetLevel,
    protectFrom,
    perAttemptMaterialCost,
    baseItemPrice,
    priceMap,
    itemDetails,
    itemHrid,
    recipes
) {
    const { enhancingLevel, toolBonus, blessedTea = false, guzzlingBonus = 1.0, blessedTeaBonus = DEFAULT_BLESSED_TEA_CHANCE } = enhancementParams;

    // Calculate success multiplier
    let totalBonus;
    if (enhancingLevel >= itemLevel) {
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }

    // Build Markov chain (shared with the main-thread calculator)
    const markov = buildEnhancementMarkov(math, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier: totalBonus,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    // Solve for expected attempts and protections
    const Q = markov.subset(math.index(math.range(0, targetLevel), math.range(0, targetLevel)));
    const I = math.identity(targetLevel);
    const M = math.inv(math.subtract(I, Q));

    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([0, i]);
    }

    // Calculate expected protection uses
    let protections = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([0, i]);
            const failureChance = markov.get([i, i - 1]);
            protections += timesAtLevel * failureChance;
        }
    }

    // Get protection item price using realistic pricing (like main thread)
    let protectionPrice = 0;
    if (protections > 0) {
        protectionPrice = getRealisticPrice(itemHrid, baseItemPrice, priceMap, recipes);

        // Check mirror of protection
        const mirrorPrice = getRealisticPrice('/items/mirror_of_protection', null, priceMap, recipes);
        if (mirrorPrice > 0 && mirrorPrice < protectionPrice) {
            protectionPrice = mirrorPrice;
        }

        // Check specific protection items
        if (itemDetails.protectionItemHrids && itemDetails.protectionItemHrids.length > 0) {
            for (const protHrid of itemDetails.protectionItemHrids) {
                const protPrice = getRealisticPrice(protHrid, null, priceMap, recipes);
                if (protPrice > 0 && protPrice < protectionPrice) {
                    protectionPrice = protPrice;
                }
            }
        }
    }

    const materialCost = perAttemptMaterialCost * attempts;
    const protectionCost = protectionPrice * protections;

    return baseItemPrice + materialCost + protectionCost;
}

/**
 * Get realistic price for an item (matches main thread logic)
 * Handles inflation detection and fallbacks
 */
function getRealisticPrice(itemHrid, knownBasePrice, priceMap, recipes) {
    let ask = priceMap[itemHrid + ':0_ask'];
    if (ask === undefined) ask = priceMap[itemHrid + ':0'];
    if (ask === null || ask === undefined) ask = 0;

    let bid = priceMap[itemHrid + ':0_bid'];
    if (bid === null || bid === undefined) bid = 0;

    // Calculate production cost as fallback
    const productionCost = calculateProductionCost(itemHrid, priceMap, recipes);

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

    // No market data - use production cost or known base price
    return productionCost > 0 ? productionCost : (knownBasePrice || 0);
}

/**
 * Calculate value for a single item
 * @param {Object} data - Item data
 * @returns {Object} {itemIndex, value}
 */
function calculateItemValue(data) {
    const { itemIndex, item, priceMap, useHighEnhancementCost, minLevel, enhancementParams, itemDetails, recipes } = data;
    const { itemHrid, enhancementLevel = 0, count = 1 } = item;

    let itemValue = 0;

    // For enhanced items (1+)
    if (enhancementLevel >= 1) {
        // For high enhancement levels, use cost instead of market price (if enabled)
        if (useHighEnhancementCost && enhancementLevel >= minLevel) {
            // Calculate enhancement cost
            const cost = calculateEnhancementCost({
                itemHrid,
                targetLevel: enhancementLevel,
                enhancementParams,
                itemDetails,
                priceMap,
                recipes
            });

            if (cost !== null && cost > 0) {
                itemValue = cost;
            } else {
                // Fallback to base item price or production cost
                let basePrice = priceMap[itemHrid + ':0'] || 0;
                if (basePrice === 0) {
                    basePrice = calculateProductionCost(itemHrid, priceMap, recipes);
                }
                itemValue = basePrice;
            }
        } else {
            // Normal logic: try market price first
            const marketPrice = priceMap[itemHrid + ':' + enhancementLevel] || 0;

            if (marketPrice > 0) {
                itemValue = marketPrice;
            } else {
                // No market data, calculate enhancement cost
                const cost = calculateEnhancementCost({
                    itemHrid,
                    targetLevel: enhancementLevel,
                    enhancementParams,
                    itemDetails,
                    priceMap,
                    recipes
                });

                if (cost !== null && cost > 0) {
                    itemValue = cost;
                } else {
                    let basePrice = priceMap[itemHrid + ':0'] || 0;
                    if (basePrice === 0) {
                        basePrice = calculateProductionCost(itemHrid, priceMap, recipes);
                    }
                    itemValue = basePrice;
                }
            }
        }
    } else {
        // Unenhanced items: use market price or production cost
        itemValue = priceMap[itemHrid + ':0'] || 0;
        if (itemValue === 0) {
            itemValue = calculateProductionCost(itemHrid, priceMap, recipes);
        }
    }

    return { itemIndex, value: itemValue * count };
}

/**
 * Calculate values for a batch of items
 * @param {Array} items - Array of item data objects
 * @returns {Array} Array of {itemIndex, value} results
 */
function calculateItemValueBatch(items, shared) {
    const results = [];

    for (const itemData of items) {
        // The heavy shared pieces ride the message once, not once per item
        const result = calculateItemValue(Object.assign({}, itemData, shared));
        results.push(result);
    }

    return results;
}

self.onmessage = function (e) {
    const { taskId, data } = e.data;
    try {
        const { action, params } = data;

        if (action === 'calculateBatch') {
            const shared = {
                priceMap: params.priceMap,
                recipes: params.recipes,
                useHighEnhancementCost: params.useHighEnhancementCost,
                minLevel: params.minLevel,
                enhancementParams: params.enhancementParams
            };
            const results = calculateItemValueBatch(params.items, shared);
            self.postMessage({ taskId, result: results });
        } else if (action === 'clearCache') {
            valuationCache.clear();
            self.postMessage({ taskId, result: { success: true, message: 'Cache cleared' } });
        } else {
            throw new Error(\`Unknown action: \${action}\`);
        }
    } catch (error) {
        self.postMessage({ taskId, error: error.message || String(error) });
    }
};
`;

/**
 * Get or create the worker pool instance
 */
async function getWorkerPool() {
    idleReaper.touch();

    if (workerPool) {
        return workerPool;
    }

    try {
        // Create worker blob from inline script
        const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' });

        // Initialize worker pool with 2-4 workers
        workerPool = new WorkerPool(blob);
        await workerPool.initialize();

        return workerPool;
    } catch (error) {
        throw error;
    }
}

/**
 * Calculate values for multiple items in parallel
 * @param {Array} items - Array of item objects
 * @param {Object} priceMap - Price map for all items
 * @param {Object} config - Configuration options
 * @param {Object} gameData - Game data with item details
 * @returns {Promise<Array>} Array of values in same order as input
 */
/**
 * Recipe index (item hrid → its producing action), built once per game data.
 *
 * The worker used to receive the whole actionDetailMap and scan it per lookup;
 * structured-cloning that map into every chunk of every batch was most of the
 * networth recalc's remaining main-thread stall (2026-08-29). The index keeps
 * only the recipes each batch can actually reach.
 *
 * It mirrors the main thread's `byAnyOutput` index exactly (see
 * getActionIndexes in networth-calculator.js): an item is "produced by" the
 * first action that lists it among *any* of its outputs, not only as the
 * primary one, and the matched output's count rides along so the worker can
 * divide a batch cost down to a per-item cost the way calculateCraftingCost
 * does. Indexing on the primary output alone left every secondary output — the
 * by-products of a craft — with no recipe at all in the worker.
 */
const recipeIndexMemo = new WeakMap();

function recipeIndexFor(actionDetailMap) {
    let index = recipeIndexMemo.get(actionDetailMap);
    if (index) return index;
    index = new Map();
    for (const actionHrid in actionDetailMap) {
        const action = actionDetailMap[actionHrid];
        if (!action.outputItems || action.outputItems.length === 0) continue;
        for (const output of action.outputItems) {
            if (index.has(output.itemHrid)) continue;
            index.set(output.itemHrid, {
                inputItems: action.inputItems || null,
                upgradeItemHrid: action.upgradeItemHrid || null,
                outputCount: output.count || 1,
            });
        }
    }
    recipeIndexMemo.set(actionDetailMap, index);
    return index;
}

export async function calculateItemValueBatch(items, priceMap, configOptions, gameData) {
    const pool = await getWorkerPool();

    const recipeIndex = recipeIndexFor(gameData.actionDetailMap || {});

    // Every hrid the worker's fallback chains can reach from this batch: the
    // items themselves, their enhancement materials and protection items, the
    // two special mirrors, and the transitive production closure of all of it
    const needed = new Set();
    const addWithProduction = (hrid) => {
        if (!hrid || needed.has(hrid)) return;
        needed.add(hrid);
        const recipe = recipeIndex.get(hrid);
        if (!recipe) return;
        if (recipe.inputItems) {
            for (const input of recipe.inputItems) addWithProduction(input.itemHrid);
        }
        if (recipe.upgradeItemHrid) addWithProduction(recipe.upgradeItemHrid);
    };
    addWithProduction('/items/philosophers_mirror');
    addWithProduction('/items/mirror_of_protection');

    // Prepare data for workers - need to include item details and material details
    const itemsWithDetails = items.map((item, index) => {
        const itemDetails = gameData.itemDetailMap[item.itemHrid];
        addWithProduction(item.itemHrid);

        // Include material item details for sellPrice fallback
        const allItemDetails = {};
        if (itemDetails && itemDetails.enhancementCosts) {
            for (const material of itemDetails.enhancementCosts) {
                addWithProduction(material.itemHrid);
                const materialDetail = gameData.itemDetailMap[material.itemHrid];
                if (materialDetail) {
                    allItemDetails[material.itemHrid] = {
                        sellPrice: materialDetail.sellPrice,
                        name: materialDetail.name,
                    };
                }
            }
        }
        if (itemDetails && itemDetails.protectionItemHrids) {
            for (const protHrid of itemDetails.protectionItemHrids) addWithProduction(protHrid);
        }

        return {
            itemIndex: index,
            item,
            itemDetails: itemDetails ? { ...itemDetails, allItemDetails } : {},
        };
    });

    // Only the reachable slice of each shared structure crosses the thread
    // boundary. Keys are copied only where they exist, because the worker's
    // enhancement-material path tests presence, not value.
    const recipes = {};
    const prunedPriceMap = {};
    for (const hrid of needed) {
        const recipe = recipeIndex.get(hrid);
        if (recipe) recipes[hrid] = recipe;
        for (const suffix of [':0', ':0_ask', ':0_bid']) {
            const key = hrid + suffix;
            if (key in priceMap) prunedPriceMap[key] = priceMap[key];
        }
    }
    for (const item of items) {
        const levelKey = `${item.itemHrid}:${item.enhancementLevel || 0}`;
        if (levelKey in priceMap) prunedPriceMap[levelKey] = priceMap[levelKey];
    }

    const shared = {
        priceMap: prunedPriceMap,
        recipes,
        useHighEnhancementCost: configOptions.useHighEnhancementCost,
        minLevel: configOptions.minLevel,
        enhancementParams: configOptions.enhancementParams,
    };

    // Split items into chunks for parallel processing. The floor matters: a
    // twenty-item batch split across the whole pool cloned the shared context
    // once per worker for two items each — parallelism only pays once a chunk
    // carries enough work to outweigh its own serialisation.
    const chunkSize = Math.max(Math.ceil(itemsWithDetails.length / pool.getStats().poolSize), 16);
    const chunks = [];

    for (let i = 0; i < itemsWithDetails.length; i += chunkSize) {
        chunks.push(itemsWithDetails.slice(i, i + chunkSize));
    }

    // Process chunks in parallel
    const tasks = chunks.map((chunk) => ({
        action: 'calculateBatch',
        params: { items: chunk, ...shared },
    }));

    const results = await pool.executeAll(tasks);

    // Flatten results and sort by itemIndex to maintain order
    const flatResults = results.flat();
    flatResults.sort((a, b) => a.itemIndex - b.itemIndex);

    // Extract just the values
    return flatResults.map((r) => r.value);
}

/**
 * Clear the worker cache
 */
export async function clearItemValueCache() {
    if (!workerPool) {
        return;
    }

    const pool = await getWorkerPool();
    return pool.execute({
        action: 'clearCache',
    });
}

/**
 * Get worker pool statistics
 */
export function getItemValueWorkerStats() {
    return workerPool ? workerPool.getStats() : null;
}

/**
 * Terminate the worker pool
 */
export function terminateItemValueWorkerPool() {
    idleReaper.cancel();
    if (workerPool) {
        workerPool.terminate();
        workerPool = null;
    }
}
