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
import { calculateDungeonTokenValueDetail } from '../../utils/token-valuation.js';
import { canStartAction } from '../../utils/efficiency.js';
import { calculateDrinksPerHour, calculatePriceAfterTax, outputTaxRate } from '../../utils/profit-helpers.js';
import {
    ARTISAN_MATERIAL_MODE,
    artisanInputTotal,
    getArtisanMaterialMode,
    usesWorstCaseRounding,
} from '../../utils/artisan-material-mode.js';
import { findRefinementAction } from '../../utils/refined-item-cost.js';
import { findProducingAction } from '../../utils/production-index.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { yieldToEventLoop } from '../../utils/background-work.js';
import { productionRecipes, stateFingerprint } from './production-arbitrage.js';
import {
    OWNED_MODES,
    buildCraftEnhanceRow,
    buildDungeonInputIndex,
    buildHeldPool,
    craftUnitFigures,
    dungeonInputKind,
    hasDungeonInput,
    normalizeOwnedMode,
    normalizeTargetLevel,
    priceCraftMaterials,
} from './craft-enhance-rank.js';

/** The setting that turns the window on */
export const CRAFT_ENHANCE_SETTING = 'actions_craftEnhance';
/** The target level the window remembers */
export const TARGET_LEVEL_SETTING = 'actions_craftEnhance_targetLevel';
/** Whether the dungeon drops held count at their sale value or at 0 (or, in buy mode, are not counted at all) */
export const OWNED_MODE_SETTING = 'actions_craftEnhance_ownedDrops';

/** Recipes costed before the main thread is handed back */
const BATCH_SIZE = 8;

/** Only these production skills make gear. Cooking and brewing outputs have nothing to enhance. */
const GEAR_SKILLS = new Set(['/skills/cheesesmithing', '/skills/crafting', '/skills/tailoring']);

let cache = { fingerprint: null, rows: null, pending: null, isCurrent: null };

/** The dungeon index of the game data last seen; it is static for a session and costs a pass over every action */
const dungeonIndexCache = new WeakMap();

/**
 * @param {Object} gameData - The game's `initClientData`
 * @returns {{drops: Map, tokenShop: Map}}
 */
function dungeonIndexFor(gameData) {
    let index = dungeonIndexCache.get(gameData);
    if (!index) {
        index = buildDungeonInputIndex(gameData);
        dungeonIndexCache.set(gameData, index);
    }
    return index;
}

/**
 * The recipes the window rates: gear that can be enhanced and sold, with a dungeon input among its direct inputs.
 * @param {Object} gameData - The game's `initClientData`
 * @param {{drops: Map, tokenShop: Map}} index - From {@link dungeonIndexFor}
 * @returns {Array<Object>}
 */
function qualifyingRecipes(gameData, index) {
    return productionRecipes().filter((recipe) => {
        if (!GEAR_SKILLS.has(recipe.skill.skillHrid)) return false;
        const output = gameData.itemDetailMap?.[recipe.itemHrid];
        // Only a tradable piece that can be enhanced has anything to sell at +N
        if (!output?.isTradable || !(output.enhancementCosts?.length > 0)) return false;
        return hasDungeonInput(recipe.action, index);
    });
}

/**
 * What the character holds of the items a row could draw on, as a string that changes exactly when a row could.
 *
 * The rows depend on the stacks of the dungeon inputs and of the upgrade items (a base held at some level), nothing
 * else in the inventory, so unrelated changes (every action moves the inventory) do not make the window recompute.
 * No inventory loaded and an empty one are different keys, because the first holds nothing known and the second
 * holds nothing. Buy mode ignores the inventory entirely, so it has none.
 *
 * @param {string} ownedMode - The mode in force
 * @param {Object|null} gameData - The game's `initClientData`
 * @param {number} targetLevel - Held bases above it are not candidates and are left out
 * @param {Map<string, number>|null} [pool] - The held pool to digest; the inventory's own by default
 * @returns {string}
 */
export function heldStockDigest(
    ownedMode,
    gameData,
    targetLevel,
    pool = buildHeldPool(dataManager.getInventory?.() ?? null)
) {
    if (ownedMode === OWNED_MODES.BUY) return 'ignored';
    if (!pool) return 'no-inventory';
    if (!gameData) return 'no-data';
    const index = dungeonIndexFor(gameData);
    const watched = new Set();
    for (const recipe of qualifyingRecipes(gameData, index)) {
        for (const input of recipe.action.inputItems || []) {
            if (input?.itemHrid && dungeonInputKind(input.itemHrid, index)) watched.add(input.itemHrid);
        }
        if (recipe.action.upgradeItemHrid) watched.add(recipe.action.upgradeItemHrid);
    }
    const parts = [];
    for (const [key, count] of pool) {
        const split = key.lastIndexOf(':');
        const level = Number(key.slice(split + 1));
        if (watched.has(key.slice(0, split)) && level <= targetLevel) parts.push(`${key}=${count}`);
    }
    return `held:${parts.sort().join(',')}`;
}

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
 * @returns {{value: number, estimated: boolean}|null} `estimated` when the token's value rests on a value-map price
 */
function tokenRouteDetail(index, itemHrid) {
    const line = index.tokenShop.get(itemHrid);
    if (!line) return null;
    const detail = calculateDungeonTokenValueDetail(line.tokenHrid);
    if (!(detail?.value > 0)) return null;
    return {
        value: calculatePriceAfterTax((detail.value * line.tokenCount) / line.outputCount),
        estimated: Boolean(detail.estimated),
    };
}

/**
 * The market data's age stamp. The window compares it with the one its rows were built on to know they are stale.
 * A new snapshot moves the fetch time; an order book opened or a custom price edited moves only `priceVersion`,
 * so both are in it.
 * @returns {string}
 */
export function craftEnhancePriceStamp() {
    return `${marketAPI.lastFetchTimestamp || 0}:${marketAPI.priceVersion || 0}`;
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
 * The crafts a quote's protection copies add: each copy of the item spent at craft price is one more craft, so the
 * time those crafts take and the crafting XP they teach (per finished item) ride beside the run as their own fields.
 * They are not enhancing time (the drinks are billed on that) and not enhancing XP.
 *
 * @param {Object} quote - From {@link enhanceWithDrinks}, with `selfCopyCrafts` when the plan spent crafted copies
 * @param {{seconds: number, xp: number|null}|null} selfCopy - The crafting of one copy
 * @returns {Object} The quote with `extraCraftSeconds` and `extraCraftXp` (null when the crafting XP is unknown)
 */
export function withSelfCopyCrafts(quote, selfCopy) {
    const crafts = selfCopy ? Number(quote.selfCopyCrafts) || 0 : 0;
    return {
        ...quote,
        selfCopyCrafts: crafts,
        extraCraftSeconds: crafts * (Number(selfCopy?.seconds) || 0),
        // The bonus drops those crafts also yield, net of tax, per finished item
        extraCraftNet: crafts * (Number(selfCopy?.otherNet) || 0),
        extraCraftXp: crafts > 0 && !Number.isFinite(selfCopy?.xp) ? null : crafts * (Number(selfCopy?.xp) || 0),
    };
}

/**
 * Whether a recipe is a refinement whose base can be enhanced first: the refined item's own refinement action,
 * which keeps every enhancement level of the base it upgrades. Anything else has no base route.
 *
 * @param {Object} recipe - From productionRecipes
 * @returns {string|null} The base item, or null when there is no such route
 */
export function refinementBaseOf(recipe) {
    const refinement = findRefinementAction(recipe.itemHrid);
    if (!refinement?.upgradeItemHrid || refinement.retainAllEnhancement !== true) return null;
    // The refined item's action found by output may be another recipe's; only this very recipe's counts
    if (refinement !== recipe.action && refinement.hrid !== recipe.actionHrid) return null;
    return refinement.upgradeItemHrid;
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
export function craftEnhanceFingerprint({ targetLevel, ownedMode, params, priceStamp, heldDigest = '' }) {
    return [
        // Artisan rounding moves every craft cost, so a change of the setting is a different ranking
        getArtisanMaterialMode(),
        stateFingerprint(priceStamp),
        dataManager.getCurrentCharacterId?.() ?? '',
        targetLevel,
        ownedMode,
        // Held stacks of the inputs and bases: a change of what is held reprices the split
        heldDigest,
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
        const targetLevel = normalizeTargetLevel(config.getSettingValue(TARGET_LEVEL_SETTING, 5));
        const ownedMode = normalizeOwnedMode(config.getSettingValue(OWNED_MODE_SETTING, 'market'));
        return craftEnhanceFingerprint({
            targetLevel,
            ownedMode,
            params: getAutoDetectedParams(),
            priceStamp: craftEnhancePriceStamp(),
            heldDigest: heldStockDigest(ownedMode, dataManager.getInitClientData(), targetLevel),
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
    priceStamp = craftEnhancePriceStamp(),
    onProgress,
    isCurrent = () => true,
} = {}) {
    const targetLevel = normalizeTargetLevel(requestedLevel ?? config.getSettingValue(TARGET_LEVEL_SETTING, 5));
    const ownedMode = normalizeOwnedMode(requestedMode ?? config.getSettingValue(OWNED_MODE_SETTING, 'market'));
    const params = getAutoDetectedParams();
    // Read once: the key and the pricing see the same inventory, and a stack changing mid-run cannot split a row
    const inventory = dataManager.getInventory?.() ?? null;
    const heldPool = buildHeldPool(inventory);
    const fingerprint = craftEnhanceFingerprint({
        targetLevel,
        ownedMode,
        params,
        priceStamp,
        heldDigest: heldStockDigest(ownedMode, dataManager.getInitClientData(), targetLevel, heldPool),
    });

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
        const index = dungeonIndexFor(gameData);
        const taxRate = outputTaxRate();
        const recipes = qualifyingRecipes(gameData, index);

        const drinkCost = enhancingDrinkCost(params);
        // Enhancement runs by item, starting level, END level and what a crafted protection copy costs (price, seconds,
        // XP): a run from +3 is not a run from +0, a run to +3 is not a run to +5, and the same item can be crafted by
        // two recipes at two prices
        const enhanceByItem = new Map();
        /**
         * @param {string} itemHrid - The item to enhance
         * @param {number} startLevel - Level it starts at
         * @param {{cost: number, seconds: number, xp: number|null}|null} [selfCopy] - What one more copy
         *   of the item costs to craft (a complete figure), the seconds that craft takes and the crafting XP it
         *   gives; null prices a protection copy at market only
         * @param {number} [level] - The level the run ends at; the target by default
         * @returns {Object|null}
         */
        const enhanceFrom = (itemHrid, startLevel, selfCopy = null, level = targetLevel) => {
            const key = `${itemHrid}:${startLevel}:${level}:${selfCopy ? `${selfCopy.cost}|${selfCopy.seconds}|${selfCopy.xp}|${selfCopy.otherNet ?? 0}` : ''}`;
            if (!enhanceByItem.has(key)) {
                const quoteWith = (copy) =>
                    enhanceWithDrinks(
                        quoteDirectEnhancement(itemHrid, startLevel, level, gameData, {
                            params,
                            selfCopyCraftCost: copy?.cost ?? null,
                        }),
                        drinkCost
                    );
                const crafted = selfCopy ? quoteWith(selfCopy) : null;
                const market = quoteWith(null);
                // The crafted-copy quote carries the market-only one beside it: which is the better hour depends on
                // the sale and the craft, so the level's rating (rateLevel) keeps whichever earns more an hour
                enhanceByItem.set(
                    key,
                    crafted ? { ...withSelfCopyCrafts(crafted, selfCopy), marketOnly: market } : market
                );
            }
            return enhanceByItem.get(key);
        };
        const itemName = (hrid) => gameData.itemDetailMap?.[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
        const round2 = (value) => Math.round(value * 100) / 100;
        // Artisan rounds per craft. The average is the calculator's own; the worst case bills each craft's
        // requirement rounded up. Hybrid has no run length here (the rate is per hour), so it reads as expected.
        const artisanMode = getArtisanMaterialMode();
        const worstCase = usesWorstCaseRounding(artisanMode, Infinity);
        const rows = [];
        const baseCopies = new Map();

        for (let start = 0; start < recipes.length; start += BATCH_SIZE) {
            for (const recipe of recipes.slice(start, start + BATCH_SIZE)) {
                let profit = null;
                try {
                    profit = await profitCalculator.calculateProfit(recipe.itemHrid, {
                        actionHrid: recipe.actionHrid,
                        keepSellTax: true,
                        // A crafted upgrade item's own inputs are billed whole per craft too
                        upgradeCraftArtisanMode: worstCase ? ARTISAN_MATERIAL_MODE.WORST_CASE : null,
                    });
                } catch (error) {
                    console.error(`[CraftEnhance] Costing ${recipe.actionHrid} failed:`, error);
                }
                // Superseded while the calculator ran: this result is for a character or a setting no longer on screen
                if (!isCurrent()) return abandon();
                if (!profit || (profit.actionHrid && profit.actionHrid !== recipe.actionHrid)) continue;

                try {
                    const row = await buildRow(recipe, profit);
                    // Superseded while a held-base figure was costed
                    if (!isCurrent()) return abandon();
                    rows.push(row);
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
         * The pricing arguments for one recipe's inputs. The upgrade item is not reduced by Artisan; a regular input
         * is, and rounds up per craft under the worst-case mode.
         * @param {Object} answer - The calculator's answer for the recipe
         * @param {Array<Object>} materials - Its `materialCosts`
         * @param {Map<string, number>|null} pool - What is held
         * @param {number|null} hourCrafts - Crafts in an hour
         * @param {string} mode - The owned-drops mode
         * @returns {Object}
         */
        function materialsPricing(answer, materials, pool, hourCrafts, mode) {
            return {
                materials,
                index,
                ownedMode: mode,
                heldPool: pool,
                craftsPerHour: hourCrafts,
                valueDrop: (hrid) => saleAfterTaxAt(hrid, 0),
                valueToken: (hrid) => tokenRouteDetail(index, hrid)?.value ?? null,
                tokenEstimated: (hrid) => Boolean(tokenRouteDetail(index, hrid)?.estimated),
                amountOf: (material) =>
                    worstCase && !material.isUpgradeItem && Number(material.baseAmount) > 0
                        ? artisanInputTotal(
                              material.baseAmount,
                              Number(answer.artisanBonus) || 0,
                              1,
                              ARTISAN_MATERIAL_MODE.WORST_CASE
                          )
                        : material.amount,
            };
        }

        /**
         * The crafting XP of one finished item. When the calculator charged the upgrade item's production chain time,
         * the chain's actions are inside the same hour, so what they teach is counted too. One chain action whose XP
         * cannot be read leaves the whole figure unknown, never a partial one.
         * @param {Object} action - The recipe's action
         * @param {string} actionHrid - Its hrid
         * @param {Object} answer - The calculator's answer for it
         * @returns {number|null}
         */
        function craftXpPerUnitOf(action, actionHrid, answer) {
            const chainActions = answer.upgradeChainCrafted
                ? getProductionChainActions(action.upgradeItemHrid, worstCase ? ARTISAN_MATERIAL_MODE.WORST_CASE : null)
                : [];
            const xpPerAction = [actionHrid, ...chainActions].map((hrid) => calculateExpPerHour(hrid)?.modifiedXP);
            if (!xpPerAction.every((value) => Number.isFinite(value))) return null;
            const perUnit = (Number(answer.outputAmount) || 1) * (1 + (Number(answer.gourmetBonus) || 0));
            return xpPerAction.reduce((sum, value) => sum + value, 0) / perUnit;
        }

        /**
         * What one copy of a refinement's base costs to craft, how long it takes and what it teaches, from the
         * calculator's own answer for the base's recipe. Null when the base cannot be crafted, or its bill has a
         * price missing: a partial figure is not a price, so the copy stays at market.
         * @param {string} baseHrid - The base item
         * @param {Object} recipe - The refinement recipe being rated
         * @returns {Promise<{cost: number, seconds: number, xp: number|null}|null>}
         */
        async function baseCopyFor(baseHrid, recipe) {
            // The XP credited depends on whether the base is crafted in the recipe's own skill
            const key = `${baseHrid}|${recipe.action.type ?? ''}|${recipe.skill?.skillHrid ?? ''}`;
            if (!baseCopies.has(key)) {
                baseCopies.set(key, await costBaseCopy(baseHrid, recipe));
            }
            return baseCopies.get(key);
        }

        async function costBaseCopy(baseHrid, recipe) {
            const found = findProducingAction(baseHrid, {
                primaryOnly: true,
                actionDetailMap: gameData.actionDetailMap,
            });
            if (!found?.action) return null;
            let answer = null;
            try {
                answer = await profitCalculator.calculateProfit(baseHrid, {
                    actionHrid: found.actionHrid,
                    keepSellTax: true,
                    upgradeCraftArtisanMode: worstCase ? ARTISAN_MATERIAL_MODE.WORST_CASE : null,
                });
            } catch (error) {
                console.error(`[CraftEnhance] Costing a copy of ${baseHrid} failed:`, error);
            }
            if (!answer || (answer.actionHrid && answer.actionHrid !== found.actionHrid)) return null;
            if (answer.hasMissingPrices || (answer.teaCosts || []).some((tea) => tea.missingPrice)) return null;
            const itemsPerHour = Number(answer.totalItemsPerHour) || 0;
            if (!(itemsPerHour > 0)) return null;
            // Priced the way the main recipe is: every input bought, each craft's requirement rounded up under the
            // worst-case Artisan mode (the calculator's hourly figure is the averaged consumption)
            const perCraft = (Number(answer.outputAmount) || 1) * (1 + (Number(answer.gourmetBonus) || 0));
            const bought = priceCraftMaterials(
                materialsPricing(answer, answer.materialCosts, null, itemsPerHour / perCraft, OWNED_MODES.BUY)
            );
            if (bought.unpriced.length > 0) return null;
            const figures = craftUnitFigures({ materialCostPerAction: bought.costPerAction, profit: answer, taxRate });
            if (!(figures?.craftCostPerUnit > 0)) return null;
            const cost = figures.craftCostPerUnit;
            const xp = craftXpPerUnitOf(found.action, found.actionHrid, answer);
            return {
                cost,
                seconds: 3600 / itemsPerHour,
                // The bonus drops (essence, rare finds) a craft of the base also yields, net of tax
                otherNet: figures.otherNetPerUnit,
                // The row's XP column is the recipe's skill: a base crafted in another skill teaches that one
                xp: found.action.type === recipe.action.type ? xp : 0,
            };
        }

        /**
         * @param {Object} recipe - From productionRecipes
         * @param {Object} profit - The calculator's answer
         * @returns {Object} A row
         */
        async function buildRow(recipe, profit) {
            // Crafts in an hour (actions that consume inputs): the items an hour makes over the items one craft makes.
            // The held stock is spread over this many crafts. Null when the recipe makes nothing per hour.
            const craftsPerHourOf = (answer) => {
                const perCraft = (Number(answer?.outputAmount) || 1) * (1 + (Number(answer?.gourmetBonus) || 0));
                const crafts = (Number(answer?.totalItemsPerHour) || 0) / perCraft;
                return crafts > 0 && Number.isFinite(crafts) ? crafts : null;
            };
            const craftsPerHour = craftsPerHourOf(profit);
            const pricingOf = (materials, pool, hourCrafts = craftsPerHour, mode = ownedMode) =>
                materialsPricing(profit, materials, pool, hourCrafts, mode);
            const priced = priceCraftMaterials(pricingOf(profit.materialCosts, heldPool));
            const figures = craftUnitFigures({
                materialCostPerAction: priced.costPerAction,
                profit,
                taxRate,
            });
            // Tea cost with a missing price understates the craft cost: unpriced, not cheap
            for (const tea of profit.teaCosts || []) {
                if (tea.missingPrice) priced.unpriced.push({ itemHrid: tea.itemHrid, reason: 'tea' });
            }

            const craftXpPerUnit = craftXpPerUnitOf(recipe.action, recipe.actionHrid, profit);
            const xpKnown = craftXpPerUnit !== null;
            // One more copy of the item itself costs this to craft: a complete figure only, so an unpriced input or
            // drink (counted above) or a recipe with no rate leaves the copy at market price
            // The copy is a bought bill: every input at its buy price as Buy mode counts it, whatever is held or sunk,
            // since the extra crafts are made on top of the hour's stock
            const bought = priceCraftMaterials(pricingOf(profit.materialCosts, null, craftsPerHour, OWNED_MODES.BUY));
            const boughtFigures =
                bought.unpriced.length === 0 && !(profit.teaCosts || []).some((tea) => tea.missingPrice)
                    ? craftUnitFigures({ materialCostPerAction: bought.costPerAction, profit, taxRate })
                    : null;
            const selfCopy =
                boughtFigures && boughtFigures.craftCostPerUnit > 0
                    ? {
                          cost: boughtFigures.craftCostPerUnit,
                          seconds: boughtFigures.secondsPerUnit,
                          otherNet: boughtFigures.otherNetPerUnit,
                          xp: craftXpPerUnit,
                      }
                    : null;
            const directRun = enhanceFrom(recipe.itemHrid, 0, selfCopy);

            // Enhancing the cheaper base first, then refining it, reaches the same +N: refinement keeps every level.
            // A copy of the base is what that run protects with, so it is crafted at the base's own cost.
            const baseHrid = refinementBaseOf(recipe);
            const baseCopy = baseHrid ? await baseCopyFor(baseHrid, recipe) : null;
            if (!isCurrent()) return null;
            const baseRun = baseHrid ? enhanceFrom(baseHrid, 0, baseCopy) : null;

            const level =
                dataManager.getSkills()?.find((skill) => skill.skillHrid === recipe.skill.skillHrid)?.level ?? 1;
            const requiredLevel = recipe.action.levelRequirement?.level || 1;

            // Starting the base-first route from a base the character already holds, one candidate per held level
            // at or below the target. Buy mode ignores what is held, and nothing is held when no inventory is loaded.
            const heldCandidates = [];
            const heldBaseLevels =
                baseHrid && heldPool && ownedMode !== OWNED_MODES.BUY
                    ? Array.from({ length: targetLevel + 1 }, (_, held) => held).filter(
                          (held) => (heldPool.get(`${baseHrid}:${held}`) || 0) >= 1
                      )
                    : [];
            if (heldBaseLevels.length > 0) {
                // Without the base's crafting chain the action is shorter and teaches less, so it is costed again
                // with the base owned; its own price comes out of the lines and the held base's goes in
                let heldProfit = null;
                try {
                    heldProfit = await profitCalculator.calculateProfit(recipe.itemHrid, {
                        actionHrid: recipe.actionHrid,
                        keepSellTax: true,
                        upgradeCraftArtisanMode: worstCase ? ARTISAN_MATERIAL_MODE.WORST_CASE : null,
                        upgradeItemOwned: true,
                    });
                } catch (error) {
                    console.error(`[CraftEnhance] Costing ${recipe.actionHrid} with a held base failed:`, error);
                }
                if (!isCurrent()) return null;
                const sameRecipe =
                    heldProfit && (!heldProfit.actionHrid || heldProfit.actionHrid === recipe.actionHrid);
                const teaGap = (heldProfit?.teaCosts || []).some((tea) => tea.missingPrice);
                const baseKind = dungeonInputKind(baseHrid, index);
                const perHeldUnit =
                    (Number(heldProfit?.outputAmount) || 1) * (1 + (Number(heldProfit?.gourmetBonus) || 0));
                const recipeXp = calculateExpPerHour(recipe.actionHrid)?.modifiedXP;
                // Crafts per hour unknown on either route: the stack cannot be spread over an hour, and pricing it
                // against one craft would call a whole stack a discount on every craft. No held-base candidate then.
                const hoursKnown = Boolean(craftsPerHour) && Boolean(craftsPerHourOf(heldProfit));
                for (const heldLevel of sameRecipe && !teaGap && hoursKnown ? heldBaseLevels : []) {
                    // A +0 base that is itself a dungeon input is already drawn from the same stack by the fresh
                    // route's ordinary split (its upgrade line), so blending a second use of it would count it twice
                    if (heldLevel === 0 && baseKind) continue;
                    // The held base's own cost: a dungeon input counts as sunk (0) when the mode says so; anything else,
                    // and every sunk-less case, is the sale it would fetch at its level. No real quote is no candidate.
                    let unitValue = null;
                    let via = null;
                    if (baseKind && ownedMode === OWNED_MODES.SUNK) {
                        unitValue = 0;
                    } else {
                        const sale = saleAfterTaxAt(baseHrid, heldLevel);
                        if (sale > 0) {
                            unitValue = sale;
                            via = 'sale';
                        } else if (heldLevel === 0 && baseKind?.token) {
                            const tokenValue = tokenRouteDetail(index, baseHrid)?.value;
                            if (tokenValue > 0) {
                                unitValue = tokenValue;
                                via = 'token';
                            }
                        }
                    }
                    if (unitValue === null) continue;
                    // The hour needs one base per craft. The held stack serves the crafts it can, at the held route's
                    // rate; the time left runs at the fresh route's rate (blended in the row), so a stack smaller than
                    // the hour's crafts never prices every craft as if it held a base. Coverage is the held share of
                    // that mixed hour's crafts: S / (S + (1 - S / heldRate) * freshRate)
                    const heldCrafts = craftsPerHourOf(heldProfit);
                    const stackCount = heldPool.get(`${baseHrid}:${heldLevel}`) || 0;
                    const heldUsed = Math.min(stackCount, heldCrafts);
                    const freshCrafts = (1 - heldUsed / heldCrafts) * craftsPerHour;
                    const coverage = heldUsed + freshCrafts > 0 ? heldUsed / (heldUsed + freshCrafts) : 0;
                    // A +0 base is the same stack an ordinary input of the same item would draw on: the copies this
                    // route spends in the hour come out of it first
                    const rest = new Map(heldPool);
                    if (heldLevel === 0) {
                        rest.set(`${baseHrid}:0`, stackCount - heldUsed);
                    }
                    // The other inputs are shared by both routes, so their stock is spread over the mixed hour's
                    // crafts (held plus fresh), never over each route's standalone hour
                    const mixedCrafts = heldUsed + freshCrafts;
                    const restPriced = priceCraftMaterials(
                        pricingOf(
                            profit.materialCosts.filter((material) => !material.isUpgradeItem),
                            rest,
                            mixedCrafts
                        )
                    );
                    if (restPriced.unpriced.length > 0) continue;
                    // The fresh crafts of that hour, priced against the same mixed hour; only needed when the held
                    // stack leaves some crafts to the fresh route
                    let freshCraftCostPerUnit = null;
                    if (coverage < 1) {
                        const freshMixed = priceCraftMaterials(pricingOf(profit.materialCosts, rest, mixedCrafts));
                        const freshMixedFigures =
                            freshMixed.unpriced.length === 0
                                ? craftUnitFigures({
                                      materialCostPerAction: freshMixed.costPerAction,
                                      profit,
                                      taxRate,
                                  })
                                : null;
                        // No figure for the fresh crafts: the held stack cannot be blended, so it is no candidate
                        if (!freshMixedFigures) continue;
                        freshCraftCostPerUnit = freshMixedFigures.craftCostPerUnit;
                    }
                    const figures = craftUnitFigures({
                        materialCostPerAction: restPriced.costPerAction + unitValue,
                        profit: heldProfit,
                        taxRate,
                    });
                    if (!figures) continue;
                    heldCandidates.push({
                        level: heldLevel,
                        count: stackCount,
                        coverage,
                        freshCraftCostPerUnit,
                        unitValue,
                        via,
                        craftCostPerUnit: figures.craftCostPerUnit,
                        secondsPerUnit: figures.secondsPerUnit,
                        otherNetPerUnit: figures.otherNetPerUnit,
                        craftXpPerUnit: Number.isFinite(recipeXp) ? recipeXp / perHeldUnit : null,
                    });
                }
            }

            // The runs of a held base to a level: only bases at or below that level can be used for it
            const heldAt = (toLevel) =>
                heldCandidates
                    .filter((candidate) => candidate.level <= toLevel)
                    .map((candidate) => ({
                        ...candidate,
                        enhance: enhanceFrom(baseHrid, candidate.level, baseCopy, toLevel),
                    }));
            // Every level below the target, rated by the same rules as the target itself (the sweep for "Best +L")
            const levels = [];
            for (let sweepLevel = 1; sweepLevel < targetLevel; sweepLevel++) {
                levels.push({
                    level: sweepLevel,
                    enhance: enhanceFrom(recipe.itemHrid, 0, selfCopy, sweepLevel),
                    viaBase: baseHrid ? enhanceFrom(baseHrid, 0, baseCopy, sweepLevel) : null,
                    heldBases: heldAt(sweepLevel),
                    saleAfterTax: saleAfterTaxAt(recipe.itemHrid, sweepLevel),
                });
            }

            const notes = [];
            if (ownedMode !== OWNED_MODES.BUY && !heldPool) {
                notes.push(
                    'The inventory is not loaded, so nothing is counted as held and dungeon inputs are priced as bought.'
                );
            }
            // The stock is spread over one hour of crafts; what the hour needs beyond it is bought
            for (const input of priced.heldInputs || []) {
                if (!(input.held > 0)) continue;
                notes.push(
                    `Holds ${round2(input.stock)} ${itemName(input.itemHrid)}; an hour of crafts needs ` +
                        `${round2(input.needed)}: ${round2(input.held)} from stock` +
                        (input.bought > 0 ? `, ${round2(input.bought)} bought` : '') +
                        '. The cost per item spreads the stock over that hour.'
                );
            }
            if (priced.perCraftFallback && ownedMode !== OWNED_MODES.BUY && heldPool) {
                notes.push('Crafts per hour are not known, so what you hold is priced against a single craft.');
            }
            if (!xpKnown)
                notes.push('The crafting XP of the recipe or its upgrade chain is not known, so it is left out.');
            if (priced.estimated.length > 0) {
                notes.push('An input is priced from the game value estimate, not a live order.');
            }
            if (directRun === null && !baseRun) {
                notes.push(
                    drinkCost.unpriced.length > 0
                        ? 'An enhancing drink has no price, so the enhancement cost is unknown.'
                        : 'The enhancement run could not be priced.'
                );
            }
            if (worstCase && (Number(profit.artisanBonus) || 0) > 0) {
                notes.push('Artisan worst case: each craft is billed its requirement rounded up to whole units.');
            }
            if (baseHrid && !baseRun && directRun) {
                notes.push('Enhancing the base first could not be priced, so it was not considered.');
            }
            if (baseHrid && baseRun && !directRun) {
                notes.push('Enhancing the star item itself could not be priced; the base route is used.');
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
                enhance: directRun,
                viaBase: baseRun,
                baseHrid,
                heldBases: heldAt(targetLevel),
                equipmentType: gameData.itemDetailMap?.[recipe.itemHrid]?.equipmentDetail?.type ?? null,
                levels,
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
