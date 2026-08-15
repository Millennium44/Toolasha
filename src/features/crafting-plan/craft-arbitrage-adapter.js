/**
 * Craft Arbitrage Adapter
 *
 * A read-only view of "what would one of these cost *me* to make", for callers
 * outside this bundle that want to compare a craft against a market price.
 *
 * The distinction it exists to protect is that a crafting cost is personal. Two
 * characters looking at the same recipe on the same day pay different amounts:
 * artisan tea removes materials, efficiency gives free actions, gear and house
 * levels change the action time. A generic "recipe cost" computed from the
 * market alone is the wrong number for everybody. So every figure here comes
 * from `computeBestCraftingPlan` and `calculateActionStats` against the logged-in
 * character, and the caller is handed the skill and level behind it so it can
 * say whose cost it is showing.
 *
 * Nothing here mutates game state, places actions, or writes storage — it reads
 * the plan and reports it.
 *
 * Published as `window.Toolasha.Actions.craftArbitrage`; see src/libraries/actions.js.
 */

import dataManager from '../../core/data-manager.js';
import { computeBestCraftingPlan } from './crafting-plan-calculator.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { calculateEfficiencyMultiplier } from '../../utils/efficiency.js';

/**
 * Which action produces which item, built once per game-data object.
 *
 * The plan calculator scans the whole action map for every item it costs, which
 * is fine for one tooltip and quadratic for a caller sweeping the market. The
 * index is keyed off the identity of `actionDetailMap` itself, so a reload that
 * replaces the game data invalidates it without any explicit cache-busting.
 */
const productionCache = { source: null, index: null };

/**
 * @returns {Map<string, {actionHrid: string, action: Object, outputCount: number}>|null}
 */
function productionIndex() {
    const actionMap = dataManager.getInitClientData()?.actionDetailMap;
    if (!actionMap) return null;
    if (productionCache.source === actionMap) return productionCache.index;

    const index = new Map();
    for (const [actionHrid, action] of Object.entries(actionMap)) {
        if (!action?.outputItems) continue;
        for (const output of action.outputItems) {
            // First writer wins, which is what the plan calculator's own scan
            // does — the two must agree or the cost and the action disagree
            if (!output?.itemHrid || index.has(output.itemHrid)) continue;
            index.set(output.itemHrid, { actionHrid, action, outputCount: output.count || 1 });
        }
    }

    productionCache.source = actionMap;
    productionCache.index = index;
    return index;
}

/**
 * Seconds of game time one unit of output takes this character.
 *
 * Efficiency is a chance at a free repeat, so it divides the time rather than
 * adding output, and an action yielding several units divides it again.
 *
 * @param {string} actionHrid - Action HRID
 * @param {Object} action - Action detail
 * @param {number} outputCount - Units produced per action
 * @param {Map} [cache] - Per-sweep cache keyed by actionHrid
 * @returns {number|null} Seconds per output unit, or null when the stats cannot be read
 */
function secondsPerUnitFor(actionHrid, action, outputCount, cache) {
    if (cache?.has(actionHrid)) return cache.get(actionHrid);

    let seconds = null;
    try {
        const gameData = dataManager.getInitClientData();
        const stats = calculateActionStats(action, {
            skills: dataManager.getSkills(),
            equipment: dataManager.getEquipment(),
            itemDetailMap: gameData?.itemDetailMap,
            actionHrid,
        });
        const efficiency = calculateEfficiencyMultiplier(stats?.totalEfficiency);
        if (Number.isFinite(stats?.actionTime) && efficiency > 0 && outputCount > 0) {
            seconds = stats.actionTime / efficiency / outputCount;
        }
    } catch (error) {
        console.error('[CraftArbitrage] Could not read action stats:', error);
    }

    cache?.set(actionHrid, seconds);
    return seconds;
}

/**
 * What one unit of an item costs this character to make.
 *
 * `unitCost` is always the cost of *crafting* the root, with each material below
 * it priced at whichever of buying and crafting is cheaper. `strategy` is the
 * separate question of whether crafting the root is worth doing at all: 'buy'
 * means the market already sells it for less than the materials cost, so the row
 * is a flip rather than a craft. Both are reported because collapsing them would
 * either hide unprofitable recipes or quote a market price as a crafting cost.
 *
 * @param {string} itemHrid - Item to cost
 * @param {Object} [options] - Costing options
 * @param {string} [options.mode='ask'] - Pricing mode for material lookups
 * @param {Map} [options.memo] - Shared unit-cost memo, for costing many items at once
 * @param {Map} [options.actionStats] - Shared action-stats cache, same purpose
 * @param {boolean} [options.skipProcessing=false] - Buy processed intermediates
 *   (material conversions like hide→leather, log→lumber) rather than making them,
 *   so `unitCost` reflects a direct craft off bought materials instead of tanning
 *   and refining the whole tree down to raw drops
 * @param {number} [options.timeCostPerHour=0] - Gold value of an hour of the
 *   character's crafting time; when > 0 it is folded into `unitCost` at every
 *   node so a slow deep-craft is no longer free
 * @returns {Object|null} { itemHrid, unitCost, strategy, actionHrid, actionsNeeded,
 *   secondsPerUnit, skillHrid, requiredLevel, inputs } — null when the item has no
 *   recipe, the game data is not loaded, or a material has no obtainable price.
 *   `actionsNeeded` and each input's `quantityPerUnit` are per unit of output and
 *   may be fractional; `inputs` carries the material list so a caller can check
 *   what the materials themselves can actually supply.
 */
export function describeCraft(itemHrid, options = {}) {
    if (!itemHrid) return null;

    const index = productionIndex();
    const production = index?.get(itemHrid);
    if (!production) return null;

    const { mode = 'ask', memo = new Map(), actionStats, skipProcessing = false, timeCostPerHour = 0 } = options;
    const { actionHrid, action, outputCount } = production;

    let plan;
    try {
        // maxDepth / buyRawOnly / forceRootCraft keep their defaults (undefined);
        // only the time cost and the skip-processing flag are surfaced here.
        plan = computeBestCraftingPlan(
            itemHrid,
            1,
            mode,
            new Set(),
            memo,
            0,
            undefined,
            undefined,
            undefined,
            timeCostPerHour,
            skipProcessing
        );
    } catch (error) {
        console.error(`[CraftArbitrage] Could not plan ${itemHrid}:`, error);
        return null;
    }

    // `craftCost` is filled in even when the plan settles on buying, which is
    // exactly the case this reports on. A material with no price propagates as
    // Infinity rather than as a free ingredient, so it is rejected here.
    const unitCost = plan?.craftCost;
    if (!Number.isFinite(unitCost) || unitCost <= 0) return null;

    const perUnit = outputCount > 0 ? 1 / outputCount : 1;
    const inputs = (action.inputItems || []).map((input) => ({
        itemHrid: input.itemHrid,
        quantityPerUnit: (input.count || 1) * perUnit,
    }));
    if (action.upgradeItemHrid) {
        inputs.push({ itemHrid: action.upgradeItemHrid, quantityPerUnit: perUnit });
    }

    return {
        itemHrid,
        unitCost,
        strategy: plan.strategy,
        actionHrid,
        actionsNeeded: perUnit,
        secondsPerUnit: secondsPerUnitFor(actionHrid, action, outputCount, actionStats),
        skillHrid: action.levelRequirement?.skillHrid ?? null,
        requiredLevel: action.levelRequirement?.level ?? 0,
        inputs,
    };
}

/**
 * Cost many items in one pass.
 *
 * Sharing the memo is the whole point: the recipe graph overlaps heavily, so
 * costing the market item by item re-derives the same sub-materials hundreds of
 * times. The memo is safe to share here because nothing forces a decision at the
 * root — every item is costed the same way whether it is asked for directly or
 * reached as somebody's ingredient.
 *
 * @param {Array<string>} itemHrids - Items to cost
 * @param {Object} [options] - Same options as describeCraft, minus the caches
 * @returns {Map<string, Object>} itemHrid → describeCraft result, skipping items with none
 */
export function describeCrafts(itemHrids, options = {}) {
    const memo = options.memo ?? new Map();
    const actionStats = options.actionStats ?? new Map();
    const results = new Map();

    for (const itemHrid of itemHrids || []) {
        if (results.has(itemHrid)) continue;
        const described = describeCraft(itemHrid, { ...options, memo, actionStats });
        if (described) results.set(itemHrid, described);
    }

    return results;
}

/**
 * Whether an item has a recipe at all, without costing it.
 * @param {string} itemHrid - Item HRID
 * @returns {boolean}
 */
export function isCraftable(itemHrid) {
    return Boolean(itemHrid && productionIndex()?.has(itemHrid));
}
