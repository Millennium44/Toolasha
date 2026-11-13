/**
 * Craft & Enhance: the game-facing half.
 *
 * `craft-enhance-rank.js` is the arithmetic and takes every price as an argument. This file is what
 * supplies them: it walks the production recipes whose output can be enhanced and which take a dungeon
 * input directly, costs each one through the same profit calculator the action panel uses, prices the
 * dungeon inputs the way the owned-drops setting says, quotes the enhancement run at the player's own
 * detected bench, and hands all of it to the pure module.
 *
 * ## The player's bench, always
 *
 * The enhancement cost uses `getAutoDetectedParams()` (gear, enhancing level, teas and buffs this
 * character really has), whatever the tooltip's auto-detect and Pro settings say. Nobody can enhance a
 * piece on a professional's behalf for this player to sell, so a Pro quote would be a fiction here.
 *
 * ## Same machinery as the arbitrage board
 *
 * The walk is sliced and yields between slices, the result is memoised on a fingerprint of everything
 * that could move a figure, and a caller that has been superseded (a character switch, a recompute)
 * says so through `isCurrent` and is dropped after every await.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import profitCalculator from '../market/profit-calculator.js';
import { quoteDirectEnhancement } from '../combat-sim/direct-enhancement-cost.js';
import { getAutoDetectedParams } from '../../utils/enhancement-config.js';
import { getProductionChainActions } from '../../utils/enhancement-pricing.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import { resolveActionContext } from '../../utils/action-context.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { calculateDungeonTokenValue } from '../../utils/token-valuation.js';
import { canStartAction } from '../../utils/efficiency.js';
import { calculateDrinksPerHour, calculatePriceAfterTax, outputTaxRate } from '../../utils/profit-helpers.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { yieldToEventLoop } from '../../utils/background-work.js';
import { productionRecipes, stateFingerprint } from './production-arbitrage.js';
import {
    buildCraftEnhanceRow,
    buildDungeonInputIndex,
    craftUnitFigures,
    hasDungeonInput,
    normalizeOwnedMode,
    normalizeTargetLevel,
    priceCraftMaterials,
} from './craft-enhance-rank.js';

/** The setting that turns the window on */
export const CRAFT_ENHANCE_SETTING = 'actions_craftEnhance';
/** The target level the window remembers */
export const TARGET_LEVEL_SETTING = 'actions_craftEnhance_targetLevel';
/** Whether owned dungeon drops count at their sale value or at 0 */
export const OWNED_MODE_SETTING = 'actions_craftEnhance_ownedDrops';

/** Recipes costed before the main thread is handed back */
const BATCH_SIZE = 8;

/** Only these production skills make gear. Cooking and brewing outputs have nothing to enhance. */
const GEAR_SKILLS = new Set(['/skills/cheesesmithing', '/skills/crafting', '/skills/tailoring']);

let cache = { fingerprint: null, rows: null, pending: null, isCurrent: null };

/** Drop the memoised ranking */
export function clearCraftEnhanceCache() {
    cache = { fingerprint: null, rows: null, pending: null, isCurrent: null };
}

/**
 * Whether this character can use the window. A character with no market has no sale and no tax, which
 * is what the whole ranking is about.
 * @returns {boolean}
 */
export function craftEnhanceAvailable() {
    return !isIronCowCharacter();
}

/**
 * A real sale quote for one unit at a level, after tax.
 *
 * A quote that is only the game's value-map estimate is no order anyone can sell into, and a missing one is
 * missing: both answer null, which the ranking carries as "no quote", never as 0.
 *
 * @param {string} itemHrid - The item
 * @param {number} level - Enhancement level
 * @returns {number|null}
 */
export function saleAfterTaxAt(itemHrid, level) {
    const info = getItemPriceInfo(itemHrid, { enhancementLevel: level, context: 'profit', side: 'sell' });
    if (!(info.price > 0) || info.estimated || !info.source) return null;
    return calculatePriceAfterTax(info.price);
}

/**
 * What one unit of a token-shop item is worth through the tokens it costs, after tax.
 * @param {{drops: Map, tokenShop: Map}} index - Dungeon input index
 * @param {string} itemHrid - The shop item
 * @returns {number|null}
 */
function tokenRouteValue(index, itemHrid) {
    const line = index.tokenShop.get(itemHrid);
    if (!line) return null;
    const perToken = calculateDungeonTokenValue(line.tokenHrid);
    if (!(perToken > 0)) return null;
    return calculatePriceAfterTax((perToken * line.tokenCount) / line.outputCount);
}

/**
 * The market data's age stamp. The window compares it with the one its rows were built on to know they are stale.
 * @returns {number}
 */
export function craftEnhancePriceStamp() {
    return marketAPI.lastFetchTimestamp || 0;
}

/**
 * What the enhancing drinks cost an hour, on the same rule the crafting side charges its teas by: one drink per
 * 300 / (1 + drink concentration) seconds in every slot.
 *
 * The detected bench includes the effects of the enhancing teas slotted, so the run has to carry what they cost.
 * A drink with no price makes the figure unknown (`unpriced`), never free.
 *
 * @param {Object} params - From getAutoDetectedParams (`guzzlingBonus` is 1 + drink concentration)
 * @returns {{costPerHour: number, unpriced: string[], drinks: string[]}}
 */
export function enhancingDrinkCost(params) {
    const slots = (resolveActionContext('/action_types/enhancing')?.drinks || []).filter((drink) => drink?.itemHrid);
    const perHour = calculateDrinksPerHour(Math.max(0, (Number(params?.guzzlingBonus) || 1) - 1));
    let costPerHour = 0;
    const unpriced = [];
    for (const drink of slots) {
        const { price } = getItemPriceInfo(drink.itemHrid, { context: 'profit', side: 'buy' });
        if (price === null || price === undefined || !(price >= 0)) unpriced.push(drink.itemHrid);
        else costPerHour += price * perHour;
    }
    return { costPerHour, unpriced, drinks: slots.map((drink) => drink.itemHrid) };
}

/**
 * The enhancement run to rate a row with: the plan's cost plus its drinks, or null when it cannot be priced.
 *
 * A quote that does not know its XP is the test server's guaranteed shop copy: its "cost" is the price of the
 * finished +N piece, which the craft already makes, so it is not an enhancement quote and is refused.
 *
 * @param {Object|null} quote - From quoteDirectEnhancement
 * @param {{costPerHour: number, unpriced: string[]}} drinks - From {@link enhancingDrinkCost}
 * @returns {Object|null}
 */
export function enhanceWithDrinks(quote, drinks) {
    if (!quote || quote.xpKnown === false) return null;
    if (drinks.unpriced.length > 0 && quote.seconds > 0) return null;
    return { ...quote, cost: quote.cost + (drinks.costPerHour * quote.seconds) / 3600 };
}

/**
 * The enhancing bench, as numbers that move the fingerprint.
 * @param {Object} params - From getAutoDetectedParams
 * @returns {string}
 */
function benchDigest(params) {
    const drinks = (resolveActionContext('/action_types/enhancing')?.drinks || []).map(
        (drink) => drink?.itemHrid || ''
    );
    return [
        drinks.join('+'),
        params.enhancingLevel,
        params.toolBonus,
        params.speedBonus,
        params.experienceBonus,
        params.guzzlingBonus,
        params.blessedTeaBonus,
        params.teas?.blessed ? 'blessed' : '',
    ].join(',');
}

/**
 * A key that changes exactly when a row could.
 * @param {Object} args - The run's inputs
 * @returns {string}
 */
export function craftEnhanceFingerprint({ targetLevel, ownedMode, params, priceStamp }) {
    return [
        stateFingerprint(priceStamp),
        dataManager.getCurrentCharacterId?.() ?? '',
        targetLevel,
        ownedMode,
        benchDigest(params),
        config.getSettingValue('expectedValue_respectPricingMode', true),
        config.getSettingValue('profitCalc_pricingMode', 'hybrid'),
    ].join('|');
}

/**
 * A digest of everything a held ranking depends on, for the window to compare on every draw: the full
 * fingerprint of the run it would start now (market data age, character, skill levels, gear, every drink slot,
 * pricing mode, target, owned mode, enhancing bench).
 *
 * @returns {string} Empty when it cannot be worked out (no skills loaded yet), which never matches a real key
 */
export function craftEnhanceStateKey() {
    try {
        return craftEnhanceFingerprint({
            targetLevel: normalizeTargetLevel(config.getSettingValue(TARGET_LEVEL_SETTING, 5)),
            ownedMode: normalizeOwnedMode(config.getSettingValue(OWNED_MODE_SETTING, 'market')),
            params: getAutoDetectedParams(),
            priceStamp: marketAPI.lastFetchTimestamp || 0,
        });
    } catch (error) {
        console.error('[CraftEnhance] Reading the state key failed:', error);
        return '';
    }
}

/**
 * Every qualifying recipe, rated at +0 and at the target level.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.targetLevel] - Overrides the stored target
 * @param {string} [options.ownedMode] - Overrides the stored owned-drops mode
 * @param {number} [options.priceStamp] - When the market data behind the prices was fetched
 * @param {Function} [options.onProgress] - `(done, total, rows)` after each slice
 * @param {Function} [options.isCurrent] - `() => boolean`; false once the caller has been superseded
 * @returns {Promise<Array<Object>|null>} Rows in recipe order, or null when superseded
 */
export function rankCraftEnhance({
    targetLevel: requestedLevel,
    ownedMode: requestedMode,
    priceStamp = marketAPI.lastFetchTimestamp || 0,
    onProgress,
    isCurrent = () => true,
} = {}) {
    const targetLevel = normalizeTargetLevel(requestedLevel ?? config.getSettingValue(TARGET_LEVEL_SETTING, 5));
    const ownedMode = normalizeOwnedMode(requestedMode ?? config.getSettingValue(OWNED_MODE_SETTING, 'market'));
    const params = getAutoDetectedParams();
    const fingerprint = craftEnhanceFingerprint({ targetLevel, ownedMode, params, priceStamp });

    if (cache.fingerprint === fingerprint) {
        if (cache.rows) return Promise.resolve(cache.rows);
        // A run its own caller has abandoned answers null; joining it would hand that to a live caller
        if (cache.pending && (cache.isCurrent?.() ?? true)) return cache.pending;
    }

    const gameData = dataManager.getInitClientData();
    if (!gameData) return Promise.resolve([]);

    const abandon = () => {
        if (cache.pending === pending) clearCraftEnhanceCache();
        return null;
    };

    let pending = null;
    pending = (async () => {
        const index = buildDungeonInputIndex(gameData);
        const taxRate = outputTaxRate();

        const recipes = productionRecipes().filter((recipe) => {
            if (!GEAR_SKILLS.has(recipe.skill.skillHrid)) return false;
            const output = gameData.itemDetailMap?.[recipe.itemHrid];
            // Only a tradable piece that can be enhanced has anything to sell at +N
            if (!output?.isTradable || !(output.enhancementCosts?.length > 0)) return false;
            return hasDungeonInput(recipe.action, index);
        });

        const drinkCost = enhancingDrinkCost(params);
        const enhanceByItem = new Map();
        const rows = [];

        for (let start = 0; start < recipes.length; start += BATCH_SIZE) {
            for (const recipe of recipes.slice(start, start + BATCH_SIZE)) {
                let profit = null;
                try {
                    profit = await profitCalculator.calculateProfit(recipe.itemHrid, {
                        actionHrid: recipe.actionHrid,
                        keepSellTax: true,
                    });
                } catch (error) {
                    console.error(`[CraftEnhance] Costing ${recipe.actionHrid} failed:`, error);
                }
                // Superseded while the calculator ran: this result is for a character or a setting no longer on screen
                if (!isCurrent()) return abandon();
                if (!profit || (profit.actionHrid && profit.actionHrid !== recipe.actionHrid)) continue;

                try {
                    rows.push(buildRow(recipe, profit));
                } catch (error) {
                    console.error(`[CraftEnhance] Rating ${recipe.actionHrid} failed:`, error);
                }
            }
            onProgress?.(Math.min(start + BATCH_SIZE, recipes.length), recipes.length, rows);
            await yieldToEventLoop();
            if (!isCurrent()) return abandon();
        }

        if (cache.pending === pending) cache = { fingerprint, rows, pending: null, isCurrent: null };
        return rows;

        /**
         * @param {Object} recipe - From productionRecipes
         * @param {Object} profit - The calculator's answer
         * @returns {Object} A row
         */
        function buildRow(recipe, profit) {
            const priced = priceCraftMaterials({
                materials: profit.materialCosts,
                index,
                ownedMode,
                valueDrop: (hrid) => saleAfterTaxAt(hrid, 0),
                valueToken: (hrid) => tokenRouteValue(index, hrid),
            });
            const figures = craftUnitFigures({
                materialCostPerAction: priced.costPerAction,
                profit,
                taxRate,
            });
            // Tea cost with a missing price understates the craft cost: unpriced, not cheap
            for (const tea of profit.teaCosts || []) {
                if (tea.missingPrice) priced.unpriced.push({ itemHrid: tea.itemHrid, reason: 'tea' });
            }

            if (!enhanceByItem.has(recipe.itemHrid)) {
                enhanceByItem.set(
                    recipe.itemHrid,
                    enhanceWithDrinks(
                        quoteDirectEnhancement(recipe.itemHrid, 0, targetLevel, gameData, { params }),
                        drinkCost
                    )
                );
            }

            // The crafting XP of one action. When the calculator charged the upgrade item's production chain time,
            // the chain's actions are inside the same hour, so what they teach is counted too. One chain action
            // whose XP cannot be read leaves the whole figure unknown, never a partial one.
            const chainActions = profit.upgradeChainCrafted
                ? getProductionChainActions(recipe.action.upgradeItemHrid)
                : [];
            const xpPerAction = [recipe.actionHrid, ...chainActions].map(
                (actionHrid) => calculateExpPerHour(actionHrid)?.modifiedXP
            );
            const xpKnown = xpPerAction.every((value) => Number.isFinite(value));
            const perUnit = (Number(profit.outputAmount) || 1) * (1 + (Number(profit.gourmetBonus) || 0));
            const craftXpPerUnit = xpKnown ? xpPerAction.reduce((sum, value) => sum + value, 0) / perUnit : null;

            const level =
                dataManager.getSkills()?.find((skill) => skill.skillHrid === recipe.skill.skillHrid)?.level ?? 1;
            const requiredLevel = recipe.action.levelRequirement?.level || 1;

            const notes = [];
            if (!xpKnown)
                notes.push('The crafting XP of the recipe or its upgrade chain is not known, so it is left out.');
            if (priced.estimated.length > 0) {
                notes.push('An input is priced from the game value estimate, not a live order.');
            }
            if (enhanceByItem.get(recipe.itemHrid) === null) {
                notes.push(
                    drinkCost.unpriced.length > 0
                        ? 'An enhancing drink has no price, so the enhancement cost is unknown.'
                        : 'The enhancement run could not be priced.'
                );
            }
            if (profit.bonusRevenue?.hasMissingPrices)
                notes.push('A bonus drop has no price and is left out of the profit.');

            return buildCraftEnhanceRow({
                recipe: {
                    itemHrid: recipe.itemHrid,
                    itemName: profit.itemName || gameData.itemDetailMap?.[recipe.itemHrid]?.name || recipe.itemHrid,
                    actionHrid: recipe.actionHrid,
                    actionName: recipe.action.name || recipe.actionHrid.split('/').pop(),
                    skillHrid: recipe.skill.skillHrid,
                    skillLabel: recipe.skill.label,
                    requiredLevel,
                    level,
                    // The game's own start check: a skill-level tea raises the level, Artisan's Action Level raises the
                    // requirement
                    levelMet: canStartAction({
                        requiredLevel,
                        skillLevel: level,
                        teaSkillLevelBonus: Number(profit.teaSkillLevelBonus) || 0,
                        actionLevelBonus: Number(profit.actionLevelBonus) || 0,
                    }),
                },
                priced,
                figures,
                craftXpPerUnit,
                targetLevel,
                enhance: enhanceByItem.get(recipe.itemHrid),
                saleBase: saleAfterTaxAt(recipe.itemHrid, 0),
                saleTarget: saleAfterTaxAt(recipe.itemHrid, targetLevel),
                notes,
            });
        }
    })();

    cache = { fingerprint, rows: null, pending, isCurrent };
    // A failed run must not leave its promise as the answer for the next caller
    pending.catch(() => {
        if (cache.pending === pending) clearCraftEnhanceCache();
    });
    return pending;
}

export default {
    craftEnhanceAvailable,
    rankCraftEnhance,
    clearCraftEnhanceCache,
    saleAfterTaxAt,
    craftEnhancePriceStamp,
    craftEnhanceStateKey,
};
