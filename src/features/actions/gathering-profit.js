/**
 * Gathering Profit Calculator
 *
 * Calculates comprehensive profit/hour for gathering actions (Foraging, Woodcutting, Milking) including:
 * - All drop table items at market prices
 * - Drink consumption costs
 * - Equipment speed bonuses
 * - Efficiency buffs (level, house, tea, equipment)
 * - Market tax
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { calculateBonusRevenue } from '../../utils/bonus-revenue-calculator.js';
import { getItemPrice } from '../../utils/market-data.js';
import { GATHERING_TYPES, MARKET_TAX } from '../../utils/profit-constants.js';
import { getActionEfficiencyContext } from '../../utils/efficiency.js';
import {
    calculateProfitPerAction,
    calculateProfitPerDay,
    calculateActionsPerHour,
    calculateTeaCostsPerHour,
    createPriceCache,
} from '../../utils/profit-helpers.js';

/**
 * Cache for processing action conversions (inputItemHrid → conversion data)
 * Built once per game data load to avoid O(n) searches through action map
 */
let processingConversionCache = null;

/**
 * Build processing conversion cache from game data
 * @param {Object} gameData - Game data from dataManager
 * @returns {Map} Map of inputItemHrid → {actionHrid, outputItemHrid, conversionRatio}
 */
function buildProcessingConversionCache(gameData) {
    const cache = new Map();
    const validProcessingTypes = [
        '/action_types/cheesesmithing', // Milk → Cheese conversions
        '/action_types/crafting', // Log → Lumber conversions
        '/action_types/tailoring', // Cotton/Flax/Bamboo/Cocoon/Radiant → Fabric conversions
    ];

    for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (!validProcessingTypes.includes(action.type)) {
            continue;
        }

        const inputItem = action.inputItems?.[0];
        const outputItem = action.outputItems?.[0];

        if (inputItem && outputItem) {
            cache.set(inputItem.itemHrid, {
                actionHrid: actionHrid,
                outputItemHrid: outputItem.itemHrid,
                conversionRatio: inputItem.count,
            });
        }
    }

    return cache;
}

/**
 * Expected whole conversions when Processing rolls once over all outputs of an
 * action completion. Efficiency repeats the gather roll before that conversion;
 * flooring an average stack loses the remainder carried between repeats.
 * @param {Object} drop - One game drop-table row
 * @param {number} conversionRatio - Raw items consumed per processed item
 * @param {number} gatheringQuantity - Gathering bonus as a decimal
 * @param {number} efficiencyMultiplier - Expected gather rolls per completion
 * @returns {number} Expected processed items if Processing procs
 */
function expectedProcessedItems(drop, conversionRatio, gatheringQuantity, efficiencyMultiplier) {
    const repeatCount = Math.floor(efficiencyMultiplier);
    const extraRepeatChance = efficiencyMultiplier - repeatCount;
    const outcomes = [];
    const countRange = drop.maxCount - drop.minCount + 1;
    for (let count = drop.minCount; count <= drop.maxCount; count++) {
        const boosted = count * (1 + gatheringQuantity);
        const whole = Math.floor(boosted);
        const fraction = boosted - whole;
        outcomes.push({ count: whole, probability: (drop.dropRate * (1 - fraction)) / countRange });
        if (fraction > 0) outcomes.push({ count: whole + 1, probability: (drop.dropRate * fraction) / countRange });
    }
    outcomes.push({ count: 0, probability: 1 - drop.dropRate });

    let remainders = Array(conversionRatio).fill(0);
    remainders[0] = 1;
    let expectedCount = 0;
    const perRepeatMean = drop.dropRate * ((drop.minCount + drop.maxCount) / 2) * (1 + gatheringQuantity);
    let baseConversions = 0;
    let extraConversions = 0;
    for (let repeat = 1; repeat <= repeatCount + (extraRepeatChance > 0 ? 1 : 0); repeat++) {
        const next = Array(conversionRatio).fill(0);
        for (let remainder = 0; remainder < conversionRatio; remainder++) {
            for (const outcome of outcomes) {
                next[(remainder + outcome.count) % conversionRatio] += remainders[remainder] * outcome.probability;
            }
        }
        remainders = next;
        expectedCount += perRepeatMean;
        const expectedRemainder = remainders.reduce((sum, probability, remainder) => sum + probability * remainder, 0);
        const conversions = (expectedCount - expectedRemainder) / conversionRatio;
        if (repeat === repeatCount) baseConversions = conversions;
        if (repeat === repeatCount + 1) extraConversions = conversions;
    }
    return baseConversions * (1 - extraRepeatChance) + extraConversions * extraRepeatChance;
}

/**
 * Calculate comprehensive profit for a gathering action
 * @param {string} actionHrid - Action HRID (e.g., "/actions/foraging/asteroid_belt")
 * @returns {Object|null} Profit data or null if not applicable
 */
export async function calculateGatheringProfit(actionHrid) {
    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData.actionDetailMap[actionHrid];

    if (!actionDetail) {
        return null;
    }

    // Only process gathering actions (Foraging, Woodcutting, Milking) with drop tables
    if (!GATHERING_TYPES.includes(actionDetail.type)) {
        return null;
    }

    if (!actionDetail.dropTable) {
        return null; // No drop table - nothing to calculate
    }

    // Build processing conversion cache once (lazy initialization)
    if (!processingConversionCache) {
        processingConversionCache = buildProcessingConversionCache(gameData);
    }

    const getCachedPrice = createPriceCache(getItemPrice);

    // Note: Market API is pre-loaded by caller (max-produceable.js)
    // No need to check or fetch here

    const effCtx = getActionEfficiencyContext(actionDetail, { isProduction: false, gameData });

    const {
        equipment,
        drinkSlots,
        drinkConcentration,
        actionTime: actualTimePerActionSec,
        speedBonus,
        gourmetBonus,
        processingBonus,
        equipmentEfficiency,
        equipmentEfficiencyItems,
        houseEfficiency,
        teaEfficiency,
        achievementEfficiency,
        personalEfficiency,
        totalGathering,
        gatheringDetails,
        efficiencyBreakdown,
        efficiencyMultiplier,
    } = effCtx;

    const { totalEfficiency, levelEfficiency } = efficiencyBreakdown;
    const {
        gatheringTea = 0,
        communityGathering = 0,
        achievementGathering = 0,
        personalGathering = 0,
    } = gatheringDetails ?? {};

    const teaCostData = calculateTeaCostsPerHour({
        drinkSlots,
        drinkConcentration,
        itemDetailMap: gameData.itemDetailMap,
        getItemPrice: getCachedPrice,
    });
    const drinkCostPerHour = teaCostData.totalCostPerHour;
    const drinkCosts = teaCostData.costs.map((tea) => ({
        name: tea.itemName,
        priceEach: tea.pricePerDrink,
        drinksPerHour: tea.drinksPerHour,
        costPerHour: tea.totalCost,
        missingPrice: tea.missingPrice,
    }));

    const actionsPerHour = calculateActionsPerHour(actualTimePerActionSec);

    // Calculate revenue from drop table
    // Processing rolls over the gathered stack for a completion, after any
    // efficiency repeats have added their drops to that stack.
    let baseRevenuePerHour = 0;
    // No longer accumulated: Gourmet only applies to production skills (see efficiency.js), and
    // this file only ever runs for gathering actions. Kept at 0 so the return shape matches
    // production-profit.js's for any shared display code.
    const gourmetRevenueBonus = 0;
    const gourmetRevenueBonusPerAction = 0;
    let processingRevenueBonus = 0; // Track extra revenue from Processing Tea
    let processingRevenueBonusPerAction = 0; // Per-action processing revenue
    const processingConversions = []; // Track conversion details for display
    const baseOutputs = []; // Baseline outputs (before gourmet and processing)
    const gourmetBonuses = []; // Gourmet bonus outputs (display-only)
    const dropTable = actionDetail.dropTable;

    for (const drop of dropTable) {
        const rawPrice = getCachedPrice(drop.itemHrid, { context: 'profit', side: 'sell' });
        const rawPriceMissing = rawPrice === null;
        const resolvedRawPrice = rawPriceMissing ? 0 : rawPrice;
        // Apply gathering quantity bonus to drop amounts
        const baseAvgAmount = (drop.minCount + drop.maxCount) / 2;
        const avgAmountPerAction = baseAvgAmount * (1 + totalGathering);

        // Check if this item has a Processing Tea conversion (using cache for O(1) lookup)
        // Processing Tea only applies to: Milk→Cheese, Log→Lumber, Cotton/Flax/Bamboo/Cocoon/Radiant→Fabric
        const conversionData = processingConversionCache.get(drop.itemHrid);
        const processedItemHrid = conversionData?.outputItemHrid || null;
        const _processingActionHrid = conversionData?.actionHrid || null;

        // Per-action calculations (efficiency will be applied when converting to items per hour)
        let processedPerAction = 0;

        const rawItemName = gameData.itemDetailMap[drop.itemHrid]?.name || 'Unknown';
        const baseItemsPerHour = actionsPerHour * drop.dropRate * avgAmountPerAction * efficiencyMultiplier;
        const baseItemsPerAction = drop.dropRate * avgAmountPerAction;
        const baseRevenuePerAction = baseItemsPerAction * resolvedRawPrice;
        const baseRevenueLine = baseItemsPerHour * resolvedRawPrice;
        baseRevenuePerHour += baseRevenueLine;

        baseOutputs.push({
            itemHrid: drop.itemHrid,
            name: rawItemName,
            itemsPerHour: baseItemsPerHour,
            itemsPerAction: baseItemsPerAction,
            dropRate: drop.dropRate,
            priceEach: resolvedRawPrice,
            revenuePerHour: baseRevenueLine,
            revenuePerAction: baseRevenuePerAction,
            missingPrice: rawPriceMissing,
        });

        if (processedItemHrid && processingBonus > 0) {
            // Get conversion ratio from cache (e.g., 1 Milk → 1 Cheese)
            const conversionRatio = conversionData.conversionRatio;

            // Processing rolls once on the whole completion, including efficiency repeats.
            // Average the floored conversion of each possible whole stack.
            const processedPerCompletion =
                processingBonus * expectedProcessedItems(drop, conversionRatio, totalGathering, efficiencyMultiplier);
            processedPerAction = efficiencyMultiplier > 0 ? processedPerCompletion / efficiencyMultiplier : 0;

            const processedPrice = getCachedPrice(processedItemHrid, { context: 'profit', side: 'sell' });
            const processedPriceMissing = processedPrice === null;
            const resolvedProcessedPrice = processedPriceMissing ? 0 : processedPrice;

            const processedItemsPerHour = actionsPerHour * processedPerCompletion;
            const processedItemsPerAction = processedPerAction;

            // Track processing details
            const processedItemName = gameData.itemDetailMap[processedItemHrid]?.name || 'Unknown';

            // Value gain per conversion = cheese value - cost of milk used
            const costOfMilkUsed = conversionRatio * resolvedRawPrice;
            const valueGainPerConversion = resolvedProcessedPrice - costOfMilkUsed;
            const revenueFromConversion = processedItemsPerHour * valueGainPerConversion;
            const rawConsumedPerHour = processedItemsPerHour * conversionRatio;
            const rawConsumedPerAction = processedItemsPerAction * conversionRatio;

            processingRevenueBonus += revenueFromConversion;
            processingRevenueBonusPerAction += processedItemsPerAction * valueGainPerConversion;
            processingConversions.push({
                rawItem: rawItemName,
                processedItem: processedItemName,
                valueGain: valueGainPerConversion,
                conversionsPerHour: processedItemsPerHour,
                conversionsPerAction: processedItemsPerAction,
                rawConsumedPerHour,
                rawConsumedPerAction,
                rawPriceEach: resolvedRawPrice,
                processedPriceEach: resolvedProcessedPrice,
                revenuePerHour: revenueFromConversion,
                revenuePerAction: processedItemsPerAction * valueGainPerConversion,
                missingPrice: rawPriceMissing || processedPriceMissing,
            });
        }
    }

    // Calculate bonus revenue from essence and rare find drops. This is intentionally returned
    // as-is (base actions/hour, not efficiency-scaled): profit-display.js's bonusDrops rendering
    // depends on that and re-applies efficiencyMultiplier itself via getBonusDropPerHourTotals.
    const bonusRevenue = calculateBonusRevenue(actionDetail, actionsPerHour, equipment, gameData.itemDetailMap);

    // Apply efficiency multiplier to bonus revenue (efficiency repeats the action, including bonus rolls)
    const efficiencyBoostedBonusRevenue = bonusRevenue.totalBonusRevenue * efficiencyMultiplier;

    const revenuePerHour =
        baseRevenuePerHour + gourmetRevenueBonus + processingRevenueBonus + efficiencyBoostedBonusRevenue;

    const hasMissingPrices =
        drinkCosts.some((drink) => drink.missingPrice) ||
        baseOutputs.some((output) => output.missingPrice) ||
        gourmetBonuses.some((output) => output.missingPrice) ||
        processingConversions.some((conversion) => conversion.missingPrice) ||
        (bonusRevenue?.hasMissingPrices ?? false);

    // Calculate market tax
    const marketTax = revenuePerHour * MARKET_TAX;

    // Calculate net profit (revenue - market tax - drink costs)
    const profitPerHour = revenuePerHour - marketTax - drinkCostPerHour;

    return {
        profitPerHour,
        profitPerAction: calculateProfitPerAction(profitPerHour, actionsPerHour * efficiencyMultiplier), // Profit per action
        profitPerDay: calculateProfitPerDay(profitPerHour), // Profit per day
        revenuePerHour,
        drinkCostPerHour,
        drinkCosts, // Array of individual drink costs {name, priceEach, costPerHour}
        actionsPerHour, // Base actions per hour (without efficiency)
        baseOutputs, // Display-only base outputs {name, itemsPerHour, dropRate, priceEach, revenuePerHour}
        gourmetBonuses, // Display-only gourmet bonus outputs
        totalEfficiency, // Total efficiency percentage
        efficiencyMultiplier, // Efficiency as multiplier (1 + totalEfficiency / 100)
        speedBonus,
        bonusRevenue, // Essence and rare find details
        gourmetBonus, // Gourmet bonus percentage
        processingBonus, // Processing Tea chance (as decimal)
        processingRevenueBonus, // Extra revenue from Processing conversions
        processingConversions, // Array of conversion details {rawItem, processedItem, valueGain}
        processingRevenueBonusPerAction, // Processing bonus per action
        gourmetRevenueBonus, // Gourmet bonus revenue per hour
        gourmetRevenueBonusPerAction, // Gourmet bonus revenue per action
        gatheringQuantity: totalGathering, // Total gathering quantity bonus (as decimal) - renamed for display consistency
        hasMissingPrices,
        pricingMode: config.getSettingValue('profitCalc_pricingMode', 'hybrid'), // Pricing mode for display
        details: {
            levelEfficiency,
            houseEfficiency,
            teaEfficiency,
            equipmentEfficiency,
            equipmentEfficiencyItems,
            achievementEfficiency,
            personalEfficiency,
            gourmetBonus,
            communityBuffQuantity: communityGathering, // Community Buff component (as decimal)
            gatheringTeaBonus: gatheringTea, // Gathering Tea component (as decimal)
            achievementGathering: achievementGathering, // Achievement Tier component (as decimal)
            personalGathering: personalGathering, // Personal buff (seal) component (as decimal)
        },
    };
}
