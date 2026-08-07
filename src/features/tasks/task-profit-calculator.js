/**
 * Task Profit Calculator
 * Calculates total profit for gathering and production tasks
 * Includes task rewards (coins, task tokens, Purple's Gift) + action profit
 */

import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { calculateProductionProfit } from '../actions/production-profit.js';
import bundledActionPanelSort from '../actions/action-panel-sort.js';
import { actionPanelSort } from '../../utils/bundle-bridge.js';
import {
    calculateProductionActionTotalsFromBase,
    calculateGatheringActionTotalsFromBase,
} from '../../utils/profit-helpers.js';
import { getItemPrice } from '../../utils/market-data.js';

const TASK_TOKEN_HRID = '/items/task_token';

// Purple's Gift drops once per 50 completed tasks — the basis is tasks, not
// tokens, so the prorated value is credited per task rather than per token.
const TASKS_PER_PURPLES_GIFT = 50;

/**
 * Value one Task Shop line is worth per task token.
 * Openable items (the caches/crates/chests) are worth their expected contents;
 * anything else tradable is worth its market price.
 * @param {string} itemHrid - Shop item
 * @param {Object} itemDetailMap - Game item details
 * @returns {number} Coins the item is worth, or 0 when unpriceable
 */
function valueOfShopItem(itemHrid, itemDetailMap) {
    let value = getItemPrice(itemHrid, { context: 'profit', side: 'sell' }) || 0;

    if (itemDetailMap?.[itemHrid]?.isOpenable) {
        const evData = expectedValueCalculator.calculateExpectedValue(itemHrid);
        const expectedValue = evData?.expectedValue || 0;
        if (expectedValue > value) {
            value = expectedValue;
        }
    }

    return value;
}

/**
 * A shop line's costs, whichever shape the game used for it.
 * @param {Object} line - Shop line
 * @returns {Array<Object>} Cost entries
 */
function shopCosts(line) {
    if (Array.isArray(line?.costs)) return line.costs;
    if (line?.cost) return [line.cost];
    return [];
}

/**
 * Find the best coins-per-token line in the Task Shop.
 *
 * Reads taskShopItemDetailMap, so a new shop line, a changed token price or a
 * line that buys several of something is priced correctly — none of which a
 * hardcoded list of three chests at 30 tokens each could ever notice.
 *
 * @returns {{perToken: number, itemHrid: string, tokenCost: number, itemValue: number}|null}
 */
export function findBestTaskShopValue() {
    const gameData = dataManager.getInitClientData();
    const shopMap = gameData?.taskShopItemDetailMap;
    if (!shopMap) {
        return null;
    }

    const itemDetailMap = gameData.itemDetailMap || {};
    let best = null;

    for (const line of Object.values(shopMap)) {
        const itemHrid = line?.itemHrid;
        if (!itemHrid) continue;

        // Only lines actually bought with task tokens say anything about what a
        // task token is worth
        const costs = shopCosts(line);
        if (costs.length !== 1 || costs[0]?.itemHrid !== TASK_TOKEN_HRID) continue;

        const tokenCost = costs[0].count || 0;
        if (tokenCost <= 0) continue;

        const unitValue = valueOfShopItem(itemHrid, itemDetailMap);
        if (unitValue <= 0) continue;

        // One purchase can hand over several of something, and the shop says so
        const itemValue = unitValue * (line.outputCount || 1);
        const perToken = itemValue / tokenCost;
        if (!best || perToken > best.perToken) {
            best = { perToken, itemHrid, tokenCost, itemValue };
        }
    }

    return best;
}

/**
 * Calculate Task Token value from Task Shop items
 * Uses the best coins-per-token line the Task Shop actually offers.
 * @returns {Object} Token value breakdown or error state
 */
export function calculateTaskTokenValue() {
    // Return error state if expected value calculator isn't ready
    if (!expectedValueCalculator.isInitialized) {
        return {
            tokenValue: null,
            giftPerTask: null,
            totalPerToken: null,
            error: 'Market data not loaded',
        };
    }

    const best = findBestTaskShopValue();
    if (!best) {
        return {
            tokenValue: null,
            giftPerTask: null,
            totalPerToken: null,
            error: 'Task Shop data unavailable',
        };
    }

    const taskTokenValue = best.perToken;

    // Calculate Purple's Gift prorated value (one gift per 50 tasks)
    const giftResult = expectedValueCalculator.calculateExpectedValue('/items/purples_gift');
    if (!giftResult) {
        console.warn('[TaskProfit] Expected value returned null for /items/purples_gift');
    }
    const giftValue = giftResult?.expectedValue || 0;
    const giftPerTask = giftValue / TASKS_PER_PURPLES_GIFT;

    return {
        tokenValue: taskTokenValue,
        giftPerTask: giftPerTask,
        bestShopItemHrid: best.itemHrid,
        bestShopTokenCost: best.tokenCost,
        totalPerToken: taskTokenValue + giftPerTask,
        error: null,
    };
}

/**
 * Calculate task reward value (coins + tokens + Purple's Gift)
 *
 * Tokens scale with the token payout; Purple's Gift does not — the game hands
 * one out every 50 tasks regardless of how many tokens each task paid, so a
 * multi-token task must not be credited a multiple of the gift.
 *
 * @param {number} coinReward - Coin reward amount
 * @param {number} taskTokenReward - Task token reward amount
 * @param {number} [taskCount=1] - Number of tasks this reward covers
 * @returns {Object} Reward value breakdown
 */
export function calculateTaskRewardValue(coinReward, taskTokenReward, taskCount = 1) {
    const tokenData = calculateTaskTokenValue();

    // Handle error state (market data not loaded)
    if (tokenData.error) {
        return {
            coins: coinReward,
            taskTokens: 0,
            purpleGift: 0,
            total: coinReward,
            breakdown: {
                tokenValue: 0,
                tokensReceived: taskTokenReward,
                giftPerTask: 0,
                taskCount,
            },
            error: tokenData.error,
        };
    }

    const taskTokenValue = taskTokenReward * tokenData.tokenValue;
    const purpleGiftValue = taskCount * tokenData.giftPerTask;

    return {
        coins: coinReward,
        taskTokens: taskTokenValue,
        purpleGift: purpleGiftValue,
        total: coinReward + taskTokenValue + purpleGiftValue,
        breakdown: {
            tokenValue: tokenData.tokenValue,
            tokensReceived: taskTokenReward,
            giftPerTask: tokenData.giftPerTask,
            taskCount,
        },
        error: null,
    };
}

/**
 * What one cowbell is worth in coins.
 * Cowbells are not listed on their own, so they are priced through the Bag of
 * 10 Cowbells — the same basis the net worth calculator uses.
 * @returns {number} Coins per cowbell
 */
export function getCowbellValue() {
    const bagPrice = getItemPrice('/items/bag_of_10_cowbells', { context: 'networth', side: 'sell' }) || 0;
    if (bagPrice > 0) {
        return bagPrice / 10;
    }
    // Fallback: vendor value, matching networth-calculator.js
    return 100000;
}

/**
 * Best profit/hr the player could be earning instead of running this task.
 *
 * Reads the profit/hr the action panels have already computed and cached, so
 * this costs nothing extra and only reports a figure once the player has
 * actually seen alternatives. Returns null when there is nothing to compare to.
 *
 * @param {string} [excludeActionHrid] - The task's own action, excluded
 * @returns {number|null} Best alternative profit per hour, or null
 */
export function getBestAlternativeProfitPerHour(excludeActionHrid) {
    const cached = (actionPanelSort() || bundledActionPanelSort)?.cachedStats;
    if (!cached) {
        return null;
    }

    let best = null;
    for (const [actionHrid, stats] of Object.entries(cached)) {
        if (actionHrid === excludeActionHrid) continue;
        const perHour = stats?.profitPerHour;
        if (!Number.isFinite(perHour)) continue;
        if (best === null || perHour > best) {
            best = perHour;
        }
    }

    return best;
}

/**
 * Detect task type from description
 * @param {string} taskDescription - Task description text (e.g., "Cheesesmithing - Holy Cheese")
 * @returns {string} Task type: 'gathering', 'production', 'combat', or 'unknown'
 */
function detectTaskType(taskDescription) {
    // Extract skill from "Skill - Action" format
    const skillMatch = taskDescription.match(/^([^-]+)\s*-/);
    if (!skillMatch) return 'unknown';

    const skill = skillMatch[1].trim().toLowerCase();

    // Gathering skills
    if (['foraging', 'woodcutting', 'milking'].includes(skill)) {
        return 'gathering';
    }

    // Production skills
    if (['cheesesmithing', 'brewing', 'cooking', 'crafting', 'tailoring'].includes(skill)) {
        return 'production';
    }

    // Combat
    if (skill === 'defeat') {
        return 'combat';
    }

    return 'unknown';
}

/**
 * Parse task description to extract action HRID
 * Format: "Skill - Action Name" (e.g., "Cheesesmithing - Holy Cheese", "Milking - Cow")
 * @param {string} taskDescription - Task description text
 * @param {string} taskType - Task type (gathering/production)
 * @param {number} quantity - Task quantity
 * @param {number} currentProgress - Current progress (actions completed)
 * @returns {Object|null} {actionHrid, quantity, currentProgress, description} or null if parsing fails
 */
function parseTaskDescription(taskDescription, taskType, quantity, currentProgress) {
    const gameData = dataManager.getInitClientData();
    if (!gameData) {
        console.warn('[TaskProfit] parseTaskDescription: initClientData is null', { taskDescription, taskType });
        return null;
    }

    const actionDetailMap = gameData.actionDetailMap;
    if (!actionDetailMap) {
        console.warn('[TaskProfit] parseTaskDescription: actionDetailMap missing from initClientData', {
            taskDescription,
        });
        return null;
    }

    // Extract action name from "Skill - Action" format
    const match = taskDescription.match(/^[^-]+\s*-\s*(.+)$/);
    if (!match) {
        console.warn('[TaskProfit] parseTaskDescription: regex did not match description', { taskDescription });
        return null;
    }

    const actionName = match[1].trim();

    // Find matching action HRID by searching for action name in action details
    for (const [actionHrid, actionDetail] of Object.entries(actionDetailMap)) {
        if (actionDetail.name && actionDetail.name.toLowerCase() === actionName.toLowerCase()) {
            return { actionHrid, quantity, currentProgress, description: taskDescription };
        }
    }

    console.warn('[TaskProfit] parseTaskDescription: no actionHrid found for action name', {
        taskDescription,
        extractedActionName: actionName,
        taskType,
        actionDetailMapSize: Object.keys(actionDetailMap).length,
    });
    return null;
}

/**
 * Task speed multiplier from the equipped task badge.
 * The badge speeds the actions a task is made of, so the hours a task occupies
 * — and therefore the drinks/teas burned over those hours — shrink with it.
 * @returns {number} Multiplier applied to actions per hour (>= 1)
 */
function getTaskSpeedMultiplier() {
    const taskSpeedBonus = dataManager.getTaskSpeedBonus?.() || 0;
    return 1 + taskSpeedBonus / 100;
}

/**
 * Calculate gathering task profit
 * @param {string} actionHrid - Action HRID
 * @param {number} quantity - Total actions the task asks for
 * @param {number} remainingQuantity - Actions still owed (quantity − progress)
 * @returns {Promise<Object>} Profit breakdown
 */
async function calculateGatheringTaskProfit(actionHrid, quantity, remainingQuantity) {
    let profitData;
    try {
        profitData = await calculateGatheringProfit(actionHrid);
    } catch (error) {
        console.error('[TaskProfitCalculator] Gathering profit calculation failed:', error);
        profitData = null;
    }

    if (!profitData) {
        // Flag as missing so the display shows a warning instead of a confident 0
        return {
            totalValue: 0,
            fullTotalValue: 0,
            hasMissingPrices: true,
            breakdown: {
                actionHrid,
                quantity: remainingQuantity,
                totalQuantity: quantity,
                perAction: 0,
            },
        };
    }

    const hasMissingPrices = profitData.hasMissingPrices;

    // Consumable costs are charged per hour, so the duration they are charged
    // over has to carry the task speed bonus the displayed time already does
    const baseParams = {
        actionsPerHour: (profitData.actionsPerHour || 0) * getTaskSpeedMultiplier(),
        baseOutputs: profitData.baseOutputs,
        bonusDrops: profitData.bonusRevenue?.bonusDrops || [],
        processingRevenueBonusPerAction: profitData.processingRevenueBonusPerAction,
        gourmetRevenueBonusPerAction: profitData.gourmetRevenueBonusPerAction,
        drinkCostPerHour: profitData.drinkCostPerHour,
        efficiencyMultiplier: profitData.efficiencyMultiplier || 1,
    };

    // Primary figure covers what is still owed, matching the time remaining the
    // card shows; the full-quantity figure feeds the per-hour rating, which
    // must not inflate as the task progresses.
    const totals = calculateGatheringActionTotalsFromBase({ ...baseParams, actionsCount: remainingQuantity });
    const fullTotals =
        remainingQuantity === quantity
            ? totals
            : calculateGatheringActionTotalsFromBase({ ...baseParams, actionsCount: quantity });

    return {
        totalValue: hasMissingPrices ? null : totals.totalProfit,
        fullTotalValue: hasMissingPrices ? null : fullTotals.totalProfit,
        hoursNeeded: totals.hoursNeeded,
        fullHoursNeeded: fullTotals.hoursNeeded,
        hasMissingPrices,
        breakdown: {
            actionHrid,
            // The breakdown describes what is left to do, so its parts add up
            // to the total the card shows
            quantity: remainingQuantity,
            totalQuantity: quantity,
            perAction: remainingQuantity > 0 ? totals.totalProfit / remainingQuantity : 0,
        },
        // Include detailed data for expandable display
        details: {
            profitPerHour: profitData.profitPerHour,
            actionsPerHour: profitData.actionsPerHour,
            baseOutputs: profitData.baseOutputs,
            gourmetBonuses: profitData.gourmetBonuses,
            bonusRevenue: profitData.bonusRevenue,
            processingConversions: profitData.processingConversions,
            processingRevenueBonusPerAction: profitData.processingRevenueBonusPerAction,
            processingBonus: profitData.processingBonus,
            gourmetRevenueBonusPerAction: profitData.gourmetRevenueBonusPerAction,
            gourmetBonus: profitData.gourmetBonus,
            efficiencyMultiplier: profitData.efficiencyMultiplier,
        },
    };
}

/**
 * Calculate production task profit
 * @param {string} actionHrid - Action HRID
 * @param {number} quantity - Total actions the task asks for
 * @param {number} remainingQuantity - Actions still owed (quantity − progress)
 * @returns {Promise<Object>} Profit breakdown
 */
async function calculateProductionTaskProfit(actionHrid, quantity, remainingQuantity) {
    let profitData;
    try {
        profitData = await calculateProductionProfit(actionHrid);
    } catch (error) {
        console.error('[TaskProfitCalculator] Production profit calculation failed:', error);
        profitData = null;
    }

    if (!profitData) {
        // Flag as missing so the display shows a warning instead of a confident 0
        return {
            totalProfit: 0,
            fullTotalProfit: 0,
            hasMissingPrices: true,
            breakdown: {
                actionHrid,
                quantity: remainingQuantity,
                totalQuantity: quantity,
                outputValue: 0,
                materialCost: 0,
                perAction: 0,
            },
        };
    }

    const hasMissingPrices = profitData.hasMissingPrices;

    const bonusDrops = profitData.bonusRevenue?.bonusDrops || [];
    // Tea is charged per hour, so its duration carries the task speed bonus too
    const baseParams = {
        actionsPerHour: (profitData.actionsPerHour || 0) * getTaskSpeedMultiplier(),
        outputAmount: profitData.outputAmount || 1,
        outputPrice: profitData.outputPrice,
        gourmetBonus: profitData.gourmetBonus || 0,
        bonusDrops,
        materialCosts: profitData.materialCosts,
        totalTeaCostPerHour: profitData.totalTeaCostPerHour,
        efficiencyMultiplier: profitData.efficiencyMultiplier || 1,
    };

    const totals = calculateProductionActionTotalsFromBase({ ...baseParams, actionsCount: remainingQuantity });
    const fullTotals =
        remainingQuantity === quantity
            ? totals
            : calculateProductionActionTotalsFromBase({ ...baseParams, actionsCount: quantity });

    return {
        totalProfit: hasMissingPrices ? null : totals.totalProfit,
        fullTotalProfit: hasMissingPrices ? null : fullTotals.totalProfit,
        hoursNeeded: totals.hoursNeeded,
        fullHoursNeeded: fullTotals.hoursNeeded,
        hasMissingPrices,
        breakdown: {
            actionHrid,
            // The breakdown describes what is left to do, so its parts add up
            // to the total the card shows
            quantity: remainingQuantity,
            totalQuantity: quantity,
            outputValue: totals.totalBaseRevenue + totals.totalGourmetRevenue,
            materialCost: totals.totalMaterialCost + totals.totalTeaCost,
            perAction: remainingQuantity > 0 ? totals.totalProfit / remainingQuantity : 0,
        },
        // Include detailed data for expandable display
        details: {
            profitPerHour: profitData.profitPerHour,
            materialCosts: profitData.materialCosts,
            teaCosts: profitData.teaCosts,
            outputAmount: profitData.outputAmount,
            itemName: profitData.itemName,
            itemHrid: profitData.itemHrid,
            gourmetBonus: profitData.gourmetBonus,
            priceEach: profitData.outputPrice,
            outputPriceMissing: profitData.outputPriceMissing,
            actionsPerHour: profitData.actionsPerHour,
            efficiencyMultiplier: profitData.efficiencyMultiplier || 1,
            bonusRevenue: profitData.bonusRevenue, // Pass through bonus revenue data
        },
    };
}

/**
 * Calculate complete task profit
 * @param {Object} taskData - Task data {description, coinReward, taskTokenReward}
 * @returns {Promise<Object|null>} Complete profit breakdown or null for combat/unknown tasks
 */
export async function calculateTaskProfit(taskData) {
    const taskType = detectTaskType(taskData.description);

    // Skip combat tasks entirely
    if (taskType === 'combat') {
        return null;
    }

    // Parse task details
    const taskInfo = parseTaskDescription(taskData.description, taskType, taskData.quantity, taskData.currentProgress);
    if (!taskInfo) {
        // Return error state for UI to display "Unable to calculate"
        return {
            type: taskType,
            error: 'Unable to parse task description',
            totalProfit: 0,
        };
    }

    // Calculate task rewards
    const rewardValue = calculateTaskRewardValue(taskData.coinReward, taskData.taskTokenReward);

    // Only the actions still owed are worth anything from here on — the ones
    // already done are sunk, and the time the card shows is remaining time.
    const totalQuantity = taskInfo.quantity || 0;
    const remainingQuantity = Math.max(totalQuantity - (taskInfo.currentProgress || 0), 0);

    // Calculate action profit based on task type
    let actionProfit = null;
    if (taskType === 'gathering') {
        actionProfit = await calculateGatheringTaskProfit(taskInfo.actionHrid, totalQuantity, remainingQuantity);
    } else if (taskType === 'production') {
        actionProfit = await calculateProductionTaskProfit(taskInfo.actionHrid, totalQuantity, remainingQuantity);
    }

    if (!actionProfit) {
        return {
            type: taskType,
            error: 'Unable to calculate action profit',
            totalProfit: 0,
        };
    }

    // Calculate total profit
    const isProduction = taskType === 'production';
    const actionValue = isProduction ? actionProfit.totalProfit : actionProfit.totalValue;
    const fullActionValue = isProduction ? actionProfit.fullTotalProfit : actionProfit.fullTotalValue;
    const hasMissingPrices = actionProfit.hasMissingPrices;
    const totalProfit = hasMissingPrices ? null : rewardValue.total + actionValue;
    const fullTotalProfit = hasMissingPrices ? null : rewardValue.total + fullActionValue;

    // Secondary "marginal" figure: what the task is worth over and above simply
    // spending the same hours on the best alternative the player has priced.
    // Rewards are pure upside; the action time is what the alternative competes
    // for. Null when no alternative has been priced yet.
    const bestAlternativePerHour = getBestAlternativeProfitPerHour(taskInfo.actionHrid);
    const hoursNeeded = actionProfit.hoursNeeded;
    let opportunityCost = null;
    let marginalProfit = null;
    if (!hasMissingPrices && bestAlternativePerHour !== null && Number.isFinite(hoursNeeded)) {
        opportunityCost = bestAlternativePerHour * hoursNeeded;
        marginalProfit = totalProfit - opportunityCost;
    }

    return {
        type: taskType,
        totalProfit,
        fullTotalProfit,
        marginalProfit,
        opportunityCost,
        bestAlternativePerHour,
        hasMissingPrices,
        rewards: rewardValue,
        action: actionProfit,
        taskInfo: taskInfo,
    };
}
