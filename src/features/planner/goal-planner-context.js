/**
 * The join between the game and the planner.
 *
 * `goal-planner.js` decides what to do in what order and knows nothing about
 * where numbers come from. This module is the other half: it asks the
 * calculators Toolasha already has, and hands the answers over as plain data
 * and a handful of synchronous lookups.
 *
 * ## Nothing here does arithmetic that lives somewhere else
 *
 * Every figure is somebody else's:
 *
 * - gold per hour — `gathering-profit.js` / `production-profit.js`, the same
 *   calculators behind the action panel's profit line; `alchemy-rankings.js`,
 *   which is the loop behind the Best Items table; and the last all-zones
 *   simulation, by way of `combat-rates.js`
 * - experience per hour — `experience-calculator.js`, the one the skill tiles use
 * - buy versus craft — `crafting-plan-calculator.js`
 * - an enhancement run — `tooltip-enhancement.js`'s path optimiser, over the
 *   Markov chain in `utils/enhancement-calculator.js`
 * - house upgrades — `utils/house-cost-calculator.js`
 *
 * A planner that re-derived any of them would be a second opinion, and two
 * numbers for the same question is worse than one. The only arithmetic written
 * here is enhancing experience per hour, which exists in the codebase only
 * inside the XPH panel's private helper — so the *composition* is repeated
 * (`calculateEnhancement` → visit counts → `calculateSuccessXP`), never the
 * formulas.
 *
 * ## Rates are precomputed, lookups are not
 *
 * Ranking every action the character can do means running the profit
 * calculators a few hundred times, which is a refresh, not a render. So that
 * work happens once in {@link buildPlannerContext} and the result rides on the
 * context as an array. The per-item lookups — a price, a recipe, an enhancement
 * run — are cheap and lazy, and memoised for the life of one context so a plan
 * with three steps against the same item asks once.
 */

import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { calculateProductionProfit } from '../actions/production-profit.js';
import { alchemyGoldRates } from '../alchemy/alchemy-rankings.js';
import { loadCombatRates } from './combat-rates.js';
import { applyLiquidityLimits } from './market-liquidity.js';
import { computeBestCraftingPlan } from '../crafting-plan/crafting-plan-calculator.js';
import {
    calculateEnhancementPath,
    getProductionChainTime,
    getCheapestProtectionPrice,
} from '../enhancement/tooltip-enhancement.js';
import { calculateSuccessXP, calculateFailureXP } from '../enhancement/enhancement-xp.js';
import { enhancementParamsFor, describeEnhancementSource } from '../enhancement/enhancement-params-source.js';
import * as houseCostCalculator from '../../utils/house-cost-calculator.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { calculateExpPerHour } from '../../utils/experience-calculator.js';
import { GATHERING_TYPES, PRODUCTION_TYPES } from '../../utils/profit-constants.js';
import { getPriceAgeString } from '../../utils/market-data.js';
import { priceMaterial } from '../../utils/enhancement-input-pricing.js';
import { effectiveInventory, shortfallNote } from '../../utils/inventory-reservations.js';
import { RESERVATION_OWNER_PREFIX } from './goal-planner.js';
import { canStartAction } from '../../utils/efficiency.js';
import { resolveActionContext } from '../../utils/action-context.js';
import { getDrinkConcentration, parseActionLevelBonus, parseTeaSkillLevelBonus } from '../../utils/tea-parser.js';

const COIN_HRID = '/items/coin';
const INVENTORY_LOCATION = '/item_locations/inventory';
const ENHANCING_SKILL = '/skills/enhancing';

/** The enhancement run length the enhancing XP rate is quoted for */
const ENHANCING_XP_TARGET_LEVEL = 5;
/** How many held items the enhancing XP rate ranks, highest item level first */
const ENHANCING_XP_CANDIDATES = 25;

/**
 * Coins in hand.
 *
 * Only the inventory copy: coins also appear against market listings, and money
 * committed to a buy order cannot be spent on the next step of a plan.
 *
 * @returns {number} Coins
 */
export function coinsHeld() {
    const items = dataManager.getInventory();
    if (!Array.isArray(items)) return 0;
    const coin = items.find((item) => item.itemHrid === COIN_HRID && item.itemLocationHrid === INVENTORY_LOCATION);
    return coin?.count || 0;
}

/**
 * How many unenhanced copies of an item are in the bag.
 * @param {string} itemHrid - The item
 * @returns {number} Count
 */
function heldCount(itemHrid) {
    const items = dataManager.getInventory();
    if (!Array.isArray(items)) return 0;
    let total = 0;
    for (const item of items) {
        if (item.itemHrid !== itemHrid) continue;
        if (item.itemLocationHrid !== INVENTORY_LOCATION) continue;
        if (item.enhancementLevel) continue;
        total += item.count || 0;
    }
    return total;
}

/**
 * How many of an item one goal may actually plan against.
 *
 * The bag, less what every OTHER goal, crafting plan or open panel has claimed
 * of it — see `utils/inventory-reservations.js`. Never less what this goal
 * itself claimed, or a goal would subtract its own claim from its own stock and
 * report a shortfall that grows on every replan.
 *
 * With the reservation ledger switched off this is {@link heldCount} exactly,
 * which is what it has always been.
 *
 * @param {string} itemHrid - The item
 * @param {string|null} [goalId] - The goal asking; its own claim is not deducted
 * @returns {number} Count
 */
function availableCount(itemHrid, goalId = null) {
    return effectiveInventory(itemHrid, 0, {
        excludeOwner: goalId ? `${RESERVATION_OWNER_PREFIX}${goalId}` : null,
        held: heldCount(itemHrid),
    });
}

/**
 * The best copy of an item the character has, anywhere.
 *
 * Equipped counts: a plan for "own Sinister Cape +10" is finished when the cape
 * is on your back, not when a second one is in the bag.
 *
 * @param {string} itemHrid - The item
 * @returns {number} Highest enhancement level owned, or -1 when there is none
 */
function bestOwnedLevel(itemHrid) {
    let best = -1;

    const items = dataManager.getInventory();
    if (Array.isArray(items)) {
        for (const item of items) {
            if (item.itemHrid !== itemHrid) continue;
            if (!(item.count > 0)) continue;
            best = Math.max(best, item.enhancementLevel || 0);
        }
    }

    const equipment = dataManager.getEquipment();
    if (equipment) {
        for (const item of equipment.values()) {
            if (item?.itemHrid !== itemHrid) continue;
            best = Math.max(best, item.enhancementLevel || 0);
        }
    }

    return best;
}

/**
 * A skill's level and experience.
 * @param {string} skillHrid - The skill
 * @returns {{level: number, experience: number}} Its state, or level 1 when unknown
 */
function skillState(skillHrid) {
    const skill = (dataManager.getSkills() || []).find((entry) => entry.skillHrid === skillHrid);
    return { level: skill?.level ?? 1, experience: skill?.experience ?? 0 };
}

/**
 * Title-case a skill or room hrid, for anything the game has not named.
 * @param {string} hrid - An hrid
 * @returns {string} A readable name
 */
function humanise(hrid) {
    return String(hrid || '')
        .split('/')
        .pop()
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * What a rate says when nothing limits how long it can be run.
 *
 * Frozen and shared: it is the same statement on every gathering, production
 * and combat rate, and a per-rate copy is weight for nothing.
 */
const UNBOUNDED = Object.freeze({ unbounded: true });

/**
 * Whether a profit figure had to guess at what the action costs.
 *
 * Only the cost side. A missing *output* price makes a profit understated,
 * which is a conservative error and still a usable ranking; a missing *input*
 * price makes it overstated without limit, because the calculators bill an
 * unpriceable material at nothing.
 *
 * @param {Object} profit - A result from the gathering or production calculator
 * @returns {boolean} Whether something it consumes could not be priced
 */
function costSideIncomplete(profit) {
    if ((profit?.materialCosts || []).some((material) => material?.missingPrice)) return true;
    if ((profit?.teaCosts || []).some((tea) => tea?.missingPrice)) return true;
    if ((profit?.drinkCosts || []).some((drink) => drink?.missingPrice)) return true;
    return false;
}

/**
 * What a gathering method puts on the market each hour.
 *
 * The drop table, less the raw items Processing Tea turns into their processed
 * item, plus that processed item — the sell-through check has to ask about the
 * Cheese a Processing run actually makes, not about Milk it no longer has.
 *
 * @param {Object} profit - A result from `calculateGatheringProfit`
 * @returns {Array<{itemHrid: string, name: string|null, unitsPerHour: number}>}
 */
export function gatheringSells(profit) {
    const byItem = new Map();
    const add = (itemHrid, name, units) => {
        if (!itemHrid || !Number.isFinite(units)) return;
        const line = byItem.get(itemHrid) || { itemHrid, name: name || null, unitsPerHour: 0 };
        line.unitsPerHour += units;
        byItem.set(itemHrid, line);
    };
    for (const output of profit?.baseOutputs || []) add(output?.itemHrid, output?.name, output?.itemsPerHour);
    for (const conversion of profit?.processingConversions || []) {
        add(conversion?.rawItemHrid, conversion?.rawItem, -(conversion?.rawConsumedPerHour || 0));
        add(conversion?.processedItemHrid, conversion?.processedItem, conversion?.conversionsPerHour || 0);
    }
    return [...byItem.values()].filter((line) => line.unitsPerHour > 0);
}

/**
 * The level bonuses the drinks that will actually buff an action give it: a skill-level
 * bonus (raises the level) and, for production skills, an Action Level bonus
 * (Artisan Tea — raises the requirement). They are different numbers and
 * `canStartAction` treats them differently, so they travel separately.
 *
 *
 * The drinks and gear come from `resolveActionContext`, the same resolution the
 * profit and experience calculators use: a tea that is slotted but out of stock
 * neither lifts the level nor raises the requirement, and a saved loadout's
 * drinks count the way they do everywhere else.
 *
 * @param {Object} action - The action detail
 * @param {Object} itemDetailMap - Item details, for reading the drinks
 * @returns {{teaSkillLevelBonus: number, actionLevelBonus: number}}
 */
function startBonuses(action, itemDetailMap) {
    const { equipment, drinks: activeDrinks } = resolveActionContext(action.type);
    const drinkConcentration = getDrinkConcentration(equipment, itemDetailMap);
    const teaSkillLevelBonus = parseTeaSkillLevelBonus(action.type, activeDrinks, itemDetailMap, drinkConcentration);
    // Action Level teas (Artisan Tea) only exist for production skills — see
    // profit-constants.js's PRODUCTION_TYPES/GATHERING_TYPES split.
    const actionLevelBonus = PRODUCTION_TYPES.includes(action.type)
        ? parseActionLevelBonus(activeDrinks, itemDetailMap, drinkConcentration)
        : 0;
    return { teaSkillLevelBonus, actionLevelBonus };
}

/**
 * What starting a production action costs: one action's materials, as the
 * calculator reports them (Artisan-adjusted, priced at ask, no credit for what
 * is already in the bag). Gathering consumes nothing. Shared by the money-making
 * ranking and the XP rates so the two cannot disagree about who can start.
 *
 * @param {Object|null} profit - A production profit result
 * @returns {number} Coins, never negative
 */
function productionUpfrontCost(profit) {
    return Math.max(0, Number(profit?.totalMaterialCost) || 0);
}

/**
 * The part of an action's hourly margin that is a per-hour drink or tea bill.
 * It is charged by the hour, so it is costed by the duration of a climb, not by
 * the completions in it.
 *
 * @param {Object|null} profit - A profit calculator result
 * @returns {number} Gold per hour (positive), 0 when the result reports none
 */
function trainingDrinkCostOf(profit) {
    // Gathering reports drinkCostPerHour, production totalTeaCostPerHour; both are a positive
    // per-HOUR cost already subtracted inside profitPerHour. A result with neither field gives 0,
    // so its whole margin is costed per completion, as before this split.
    const cost = Number(profit?.drinkCostPerHour ?? profit?.totalTeaCostPerHour);
    return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * The signed hourly margin of an action, for costing the XP it trains.
 *
 * Null when it cannot be trusted: no result, a non-finite margin, or a cost
 * side with an item that has no market listing (that margin treats the item as
 * free, and a cost that cannot be read is not a cost of zero).
 *
 * @param {Object|null} profit - A profit calculator result
 * @returns {number|null} Gold per hour, negative for a loss, or null if unknown
 */
function trainingMarginOf(profit) {
    const margin = profit?.profitPerHour;
    if (typeof margin !== 'number' || !Number.isFinite(margin)) return null;
    return costSideIncomplete(profit) ? null : margin;
}

/**
 * Remember what a trained action sells, for {@link boundTrainingMargins}.
 *
 * @param {Array<Object>} sales - Accumulator
 * @param {string} actionHrid - The action
 * @param {Object|null} profit - Its profit calculator result
 * @param {Array<Object>} sells - What one hour puts on the market
 */
function noteTrainingSales(sales, actionHrid, profit, sells) {
    const margin = trainingMarginOf(profit);
    if (margin === null || !sells.length) return;
    // Net of tax, because the margin already is: this is the coin the unsold part never brings in
    const proceeds = (Number(profit.revenuePerHour) || 0) - (Number(profit.marketTax) || 0);
    if (!(proceeds > 0)) return;
    sales.push({ actionHrid, sells, proceeds });
}

/**
 * Hold each training margin to what the market can absorb.
 *
 * Runs the sale proceeds through `applyLiquidityLimits`, the very bound an earning rate gets, and
 * takes the unsold share out of the margin. Not `margin * throttle`: a loss-making craft would
 * shrink toward zero and read better. The action still runs at full speed (the XP is the point), so
 * costs stay; only the proceeds of the units the book cannot absorb go. An output with no volume
 * measurement is not throttled, exactly as for an earning rate.
 *
 * @param {Array<{actionHrid: string, sells: Array<Object>, proceeds: number}>} sales - From {@link noteTrainingSales}
 * @param {Map<string, number|null>} trainingMargin - Edited in place
 * @returns {Promise<void>}
 */
async function boundTrainingMargins(sales, trainingMargin) {
    if (!sales.length) return;
    try {
        const bounded = await applyLiquidityLimits(
            sales.map((sale) => ({ actionHrid: sale.actionHrid, goldPerHour: sale.proceeds, sells: sale.sells }))
        );
        const byAction = new Map((bounded?.rates || []).map((rate) => [rate.actionHrid, rate]));
        for (const sale of sales) {
            const kept = Number(byAction.get(sale.actionHrid)?.goldPerHour);
            if (!Number.isFinite(kept) || kept >= sale.proceeds) continue;
            const margin = trainingMargin.get(sale.actionHrid);
            if (typeof margin === 'number')
                trainingMargin.set(sale.actionHrid, margin - (sale.proceeds - Math.max(0, kept)));
        }
    } catch (error) {
        console.error('[GoalPlanner] Bounding training margins by market volume failed:', error);
    }
}

/**
 * Every action the character's levels allow, of a set of types.
 *
 * "Allow" means what the game itself would let you start right now: the base
 * skill level check, plus the character's real currently-active drinks for
 * that action type — including Artisan Tea's Action Level buff, which raises
 * the requirement rather than the level. A production action the bare skill
 * level clears can still be one the currently-worn Artisan Tea blocks, and
 * this must not rank it alongside what can actually be started.
 *
 * @param {Array<string>} types - Action type hrids
 * @returns {Array<{hrid: string, action: Object}>} Actions the character can start
 */
function availableActions(types) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return [];
    const skills = dataManager.getSkills() || [];
    const levels = new Map(skills.map((skill) => [skill.skillHrid, skill.level]));
    const itemDetailMap = gameData.itemDetailMap || {};

    const found = [];
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (!types.includes(action.type)) continue;
        const requirement = action.levelRequirement;
        if (requirement?.skillHrid) {
            const skillLevel = levels.get(requirement.skillHrid) ?? 1;
            const bonuses = startBonuses(action, itemDetailMap);
            if (!canStartAction({ requiredLevel: requirement.level || 1, skillLevel, ...bonuses })) {
                continue;
            }
        }
        found.push({ hrid, action });
    }
    return found;
}

/**
 * What every activity the character can do pays per hour.
 *
 * Four sources, ranked against each other on one number:
 *
 * - **gathering and production** — the action profit calculators, over every
 *   action the character's levels allow;
 * - **alchemy** — `alchemy-rankings.js`, which runs the real alchemy profit
 *   calculator over every item each of the three actions applies to. The coin
 *   fee alchemy charges is inside those figures, because the calculator
 *   subtracts it before it reports a profit;
 * - **combat** — the last all-zones simulation, which is a measurement rather
 *   than a live calculation and says its own age in its label.
 *
 * Only the first two are returned as a per-action map. Alchemy quotes many
 * rates against the same three action hrids and combat quotes one per zone, so
 * folding either into a map keyed by action would either clobber entries or
 * pair an experience rate with the gold from a different item.
 *
 * ## Two kinds of rate, and only one of them has a ceiling
 *
 * Gathering, production and combat are marked `unbounded`. Gathering consumes
 * nothing; production and combat pay for their inputs at ask *inside the margin
 * they report*, so the margin is repeatable for as long as the market will sell
 * to you. Alchemy is the exception, and says so for itself — it eats the item
 * it is run on, and {@link alchemyGoldRates} caps each rate at what is in the
 * bag.
 *
 * ## A cost that could not be priced is not a cost of zero
 *
 * A production margin whose material list contains an item with no market
 * listing is computed as though that material were free, which turns a modest
 * craft into an eight-figure hourly income. Those rates are dropped rather than
 * quoted: an unpriceable input makes the *profit* unknown, not large.
 *
 * @returns {Promise<{rates: Array<Object>, byAction: Map<string, number>, notes: Array<string>}>}
 *   Rates best first, gold by action for the skilling rates, and anything the panel should say
 */
async function measureGoldRates() {
    const rates = [];
    const byAction = new Map();
    // Signed, and apart from `rates`: the rankings only want what pays, but training
    // an XP skill costs its margin whether that is positive, zero or negative.
    // null = the margin could not be read (no price on something it consumes).
    const trainingMargin = new Map();
    const trainingDrinkCost = new Map();
    const trainingUpfront = new Map();
    // What each trained action sells and takes in, so its margin can be held to what the market
    // absorbs the way an earning rate is. Built beside the margin maps, applied after the sweep.
    const trainingSales = [];
    const notes = [];
    let unpriceable = 0;

    for (const { hrid, action } of availableActions(GATHERING_TYPES)) {
        try {
            const profit = await calculateGatheringProfit(hrid, { keepSellTax: true });
            trainingMargin.set(hrid, trainingMarginOf(profit));
            trainingDrinkCost.set(hrid, trainingDrinkCostOf(profit));
            trainingUpfront.set(hrid, 0);
            noteTrainingSales(trainingSales, hrid, profit, gatheringSells(profit));
            if (!(profit?.profitPerHour > 0)) continue;
            if (costSideIncomplete(profit)) {
                unpriceable += 1;
                continue;
            }
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                goldPerHour: profit.profitPerHour,
                kind: 'gathering',
                sustainable: UNBOUNDED,
                // Gathering consumes nothing, so it needs no capital to start;
                // what it sells is its own drop table, after Processing
                upfrontCost: 0,
                sells: gatheringSells(profit),
            });
            byAction.set(hrid, profit.profitPerHour);
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${hrid} failed:`, error);
        }
    }

    for (const { hrid, action } of availableActions(PRODUCTION_TYPES)) {
        try {
            const profit = await calculateProductionProfit(hrid, { keepSellTax: true });
            trainingMargin.set(hrid, trainingMarginOf(profit));
            trainingDrinkCost.set(hrid, trainingDrinkCostOf(profit));
            trainingUpfront.set(hrid, productionUpfrontCost(profit));
            noteTrainingSales(
                trainingSales,
                hrid,
                profit,
                profit?.itemHrid
                    ? [
                          {
                              itemHrid: profit.itemHrid,
                              name: profit.itemName || null,
                              unitsPerHour: Number(profit.totalItemsPerHour) || 0,
                          },
                      ]
                    : []
            );
            if (!(profit?.profitPerHour > 0)) continue;
            if (costSideIncomplete(profit)) {
                unpriceable += 1;
                continue;
            }
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                goldPerHour: profit.profitPerHour,
                kind: 'production',
                sustainable: UNBOUNDED,
                // One action's materials is what it costs to start crafting
                upfrontCost: productionUpfrontCost(profit),
                sells: profit.itemHrid
                    ? [
                          {
                              itemHrid: profit.itemHrid,
                              name: profit.itemName || null,
                              unitsPerHour: Number(profit.totalItemsPerHour) || 0,
                          },
                      ]
                    : [],
            });
            byAction.set(hrid, profit.profitPerHour);
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${hrid} failed:`, error);
        }
    }

    if (unpriceable > 0) {
        notes.push(
            `${unpriceable} action${unpriceable === 1 ? '' : 's'} could not be ranked: something they consume ` +
                'has no market listing, and a cost that cannot be read is not a cost of zero.'
        );
    }

    try {
        rates.push(...alchemyGoldRates({ priceStamp: marketAPI.lastFetchTimestamp || 0 }));
    } catch (error) {
        console.error('[GoalPlanner] Ranking alchemy failed:', error);
        notes.push('Alchemy could not be ranked — see the console.');
    }

    let combatStatus = null;
    try {
        const combat = await loadCombatRates();
        rates.push(...combat.rates);
        combatStatus = combat.status;
        if (combat.status.note) notes.push(combat.status.note);
    } catch (error) {
        console.error('[GoalPlanner] Reading combat rates failed:', error);
        notes.push('Combat could not be ranked — see the console.');
    }

    // Everything above priced what a method *produces*. This is the last step
    // between production and coins: somebody has to buy it. A rate whose output
    // trades once a week cannot be earned at anything like its quoted pace, and
    // ranking it first is how the planner recommended a method that cannot be run.
    let liquidity;
    try {
        liquidity = await applyLiquidityLimits(rates);
    } catch (error) {
        console.error('[GoalPlanner] Bounding rates by market volume failed:', error);
        liquidity = { rates, measured: false };
    }

    if (!liquidity.measured) {
        notes.push(
            'Market volume is not being checked, so a rate here is what its output is *worth*, not what ' +
                'you could sell. Turn on pooled market history to bound methods by how fast they actually trade.'
        );
    }

    // Training sells its output through the same book, so its margin gets the same bound. Without
    // it a thin-market craft trained for XP counted every unit sold at the quoted price.
    await boundTrainingMargins(trainingSales, trainingMargin);

    liquidity.rates.sort((a, b) => b.goldPerHour - a.goldPerHour);
    return {
        rates: liquidity.rates,
        byAction,
        trainingMargin,
        trainingDrinkCost,
        trainingUpfront,
        notes,
        combatStatus,
    };
}

/**
 * What each action gives per hour, for one skill.
 *
 * Gold is carried alongside experience because a grind is rarely free: a plan
 * that trains Cheesesmithing to 90 and does not say what it costs is only half
 * an answer.
 *
 * @param {string} skillHrid - The skill
 * @param {Map<string, number>} goldByAction - Gold per hour, by action
 * @returns {Array<Object>} Rates, best first
 */
function measureXpRates(skillHrid, goldByAction, drinkCostByAction = new Map(), upfrontByAction = new Map()) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) return [];

    const itemDetailMap = gameData.itemDetailMap || {};

    const rates = [];
    for (const [hrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.experienceGain?.skillHrid !== skillHrid) continue;
        if (!(action.experienceGain.value > 0)) continue;
        const measuredType = GATHERING_TYPES.includes(action.type) || PRODUCTION_TYPES.includes(action.type);

        try {
            const experience = calculateExpPerHour(hrid);
            if (!experience?.expPerHour) continue;
            rates.push({
                actionHrid: hrid,
                label: action.name || humanise(hrid),
                requiredLevel: action.levelRequirement?.level || 1,
                // Kept apart so the planner applies the same start rule as the gold ranking
                ...startBonuses(action, itemDetailMap),
                xpPerHour: experience.expPerHour,
                xpPerAction: experience.modifiedXP,
                actionTime: experience.actionTime,
                totalEfficiency: experience.totalEfficiency,
                // Completions per hour at the level the margin was measured, efficiency repeats included
                actionsPerHour: experience.actionsPerHour,
                // Gathering and production are costed above; a missing or unreadable margin
                // there is unknown, not free. Other types have no calculator to ask.
                goldPerHour: measuredType ? (goldByAction.get(hrid) ?? null) : 0,
                // The per-hour drink bill inside goldPerHour, which the planner charges by duration
                drinkCostPerHour: measuredType ? (drinkCostByAction.get(hrid) ?? 0) : 0,
                // One completion's inputs: the working capital needed to start, as the ranking carries it
                upfrontCost: measuredType ? (upfrontByAction.get(hrid) ?? 0) : 0,
                goldKnown: !measuredType || Number.isFinite(goldByAction.get(hrid)),
            });
        } catch (error) {
            console.error(`[GoalPlanner] Rating ${hrid} failed:`, error);
        }
    }

    rates.sort((a, b) => b.xpPerHour - a.xpPerHour);
    return rates;
}

/**
 * Experience per hour from enhancing, and the item that gives it.
 *
 * The one rate the codebase cannot hand over: the XPH panel works it out inside
 * a private helper, and enhancing has a single action whose experience depends
 * entirely on what is being enhanced. So the pieces are re-assembled here —
 * the Markov run, the per-level success and failure experience, the material
 * bill — from the exported functions that own each of them.
 *
 * Ranked over the enhanceable items already in the bag, because those are the
 * ones that can be started today, and quoted for short `+0 → +5` runs, which is
 * how enhancing is trained.
 *
 * @returns {Array<Object>} Rates, best first
 */
function measureEnhancingRates() {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return [];

    // The character's own bench, always: this rates how fast THEIR skill climbs. The item-rule
    // surface ('planner') is for costing a piece, where the market can matter; it used to be
    // asked here with '/items/coin' as a stand-in, leaving the bench choice riding on whether
    // coin's game data happens to carry `isTradable`.
    const params = enhancementParamsFor('planner:training');
    const held = (dataManager.getInventory() || [])
        .filter((item) => item.itemLocationHrid === INVENTORY_LOCATION && item.count > 0 && !item.enhancementLevel)
        .map((item) => ({ hrid: item.itemHrid, details: gameData.itemDetailMap[item.itemHrid] }))
        .filter((entry) => entry.details?.enhancementCosts?.length)
        .sort((a, b) => (b.details.itemLevel || 0) - (a.details.itemLevel || 0))
        .slice(0, ENHANCING_XP_CANDIDATES);

    const rates = [];
    for (const { hrid, details } of held) {
        try {
            const run = calculateEnhancement({
                enhancingLevel: params.enhancingLevel,
                houseLevel: params.houseLevel,
                toolBonus: params.toolBonus || 0,
                speedBonus: params.speedBonus || 0,
                itemLevel: details.itemLevel || 0,
                targetLevel: ENHANCING_XP_TARGET_LEVEL,
                startLevel: 0,
                protectFrom: 0,
                blessedTea: params.teas?.blessed,
                guzzlingBonus: params.guzzlingBonus,
                blessedTeaBonus: params.blessedTeaBonus,
            });
            if (!run?.visitCounts || !(run.totalTime > 0)) continue;

            const benchWisdom = (params.experienceBonus || 0) / 100;
            let totalXP = 0;
            for (let level = 0; level < ENHANCING_XP_TARGET_LEVEL; level += 1) {
                const visits = run.visitCounts[level];
                if (!visits) continue;
                const successRate = (run.successRates[level]?.actualRate ?? 0) / 100;
                totalXP +=
                    visits *
                    (successRate * calculateSuccessXP(level, hrid, benchWisdom) +
                        (1 - successRate) * calculateFailureXP(level, hrid, benchWisdom));
            }
            if (!(totalXP > 0)) continue;

            let materialPerAttempt = 0;
            let materialUnpriced = false;
            for (const cost of details.enhancementCosts || []) {
                const price = priceMaterial(cost.itemHrid).price || 0;
                if (!(price > 0) && cost.count > 0) materialUnpriced = true;
                materialPerAttempt += (price || 0) * cost.count;
            }
            // An unpriced material would make this run look cheaper than it is: leave the
            // candidate out rather than quote a partial bill as a full one
            if (materialUnpriced) continue;

            const xpPerHour = (totalXP / run.totalTime) * 3600;
            rates.push({
                actionHrid: '/actions/enhancing/enhance',
                label: `${details.name || humanise(hrid)} +0 → +${ENHANCING_XP_TARGET_LEVEL}`,
                requiredLevel: 1,
                xpPerHour,
                xpPerAction: totalXP / run.attempts,
                actionTime: run.perActionTime,
                totalEfficiency: 0,
                // Enhancing has no efficiency repeats, so the level-by-level
                // climb the skilling calculator models does not apply
                flatRate: true,
                goldPerHour: -(materialPerAttempt * 3600) / run.perActionTime,
            });
        } catch (error) {
            console.error(`[GoalPlanner] Rating enhancing on ${hrid} failed:`, error);
        }
    }

    rates.sort((a, b) => b.xpPerHour - a.xpPerHour);
    return rates;
}

/**
 * Buy it or make it, whichever the book says is cheaper right now.
 * @param {string} itemHrid - The item
 * @returns {Object|null} `{strategy, totalCost, buyPrice, craftCost, actionHrid, timeHours, requires}`
 */
function acquisitionFor(itemHrid) {
    const plan = computeBestCraftingPlan(itemHrid, 1, 'ask');
    if (!plan || !Number.isFinite(plan.totalCost)) return null;

    const requires = [];
    if (plan.strategy === 'craft' && plan.actionHrid) {
        const requirement = dataManager.getActionDetails(plan.actionHrid)?.levelRequirement;
        if (requirement?.skillHrid && requirement.level > 1) {
            requires.push({ skillHrid: requirement.skillHrid, level: requirement.level });
        }
    }

    return {
        strategy: plan.strategy,
        totalCost: plan.totalCost,
        unitCost: plan.unitCost,
        buyPrice: plan.buyPrice ?? null,
        craftCost: plan.craftCost ?? null,
        actionHrid: plan.actionHrid || null,
        actionsNeeded: plan.actionsNeeded || 0,
        timeHours: plan.strategy === 'craft' ? (getProductionChainTime(itemHrid) || 0) / 3600 : 0,
        requires,
        children: plan.children || [],
    };
}

/**
 * What it costs to take an item to a level.
 *
 * The path optimiser answers the from-scratch case, including which level to
 * start protecting from and whether mirroring beats grinding. A character who
 * already holds a partly enhanced copy is a different chain — one that can fall
 * back below where it started — so that case is run through the Markov
 * calculator directly at the protection level the optimiser chose, priced off
 * the same per-attempt bill.
 *
 * @param {Object} request - `{itemHrid, targetLevel, startLevel}`
 * @returns {Object|null} The run, or null when the item cannot be enhanced
 */
function enhancementRun({ itemHrid, targetLevel, startLevel = 0 }) {
    const params = enhancementParamsFor('planner', itemHrid);
    const path = calculateEnhancementPath(itemHrid, targetLevel, params);
    const strategy = path?.optimalStrategy;
    if (!strategy) return null;

    const source = describeEnhancementSource(params);
    const common = {
        protectFrom: strategy.protectFrom,
        usedMirror: Boolean(strategy.usedMirror),
        baseCost: strategy.baseCost,
        primaryBaseCost: strategy.usedMirror ? strategy.primaryBaseCost : null,
        paramsSource: source.kind,
        paramsNote: source.detail,
        xpPerHour: path.xpPerHour,
    };

    if (!(startLevel > 0) || strategy.usedMirror) {
        return {
            ...common,
            attempts: strategy.expectedAttempts,
            totalTimeSeconds: strategy.totalTime,
            materialCost: strategy.materialCost,
            protectionCost: strategy.protectionCost,
            protectionCount: strategy.protectionCount,
            totalCost: strategy.totalCost,
            materialBill: strategy.materialBill || [],
            fromLevel: 0,
        };
    }

    const itemLevel = dataManager.getItemDetails(itemHrid)?.itemLevel || 0;
    const run = calculateEnhancement({
        enhancingLevel: params.enhancingLevel,
        houseLevel: params.houseLevel,
        toolBonus: params.toolBonus || 0,
        speedBonus: params.speedBonus || 0,
        itemLevel,
        targetLevel,
        startLevel,
        protectFrom: strategy.protectFrom,
        blessedTea: params.teas?.blessed,
        guzzlingBonus: params.guzzlingBonus,
        blessedTeaBonus: params.blessedTeaBonus,
    });

    // The per-attempt bill the optimiser already priced, reused rather than
    // rebuilt so a partial run and a full one cannot disagree about materials
    const perAttempt = strategy.expectedAttempts > 0 ? strategy.materialCost / strategy.expectedAttempts : 0;
    const protectionUnit =
        strategy.protectionCount > 0
            ? strategy.protectionCost / strategy.protectionCount
            : getCheapestProtectionPrice(itemHrid)?.price || 0;

    const materialCost = perAttempt * run.attempts;
    const protectionCost = protectionUnit * run.protectionCount;

    return {
        ...common,
        attempts: run.attempts,
        totalTimeSeconds: run.totalTime,
        materialCost,
        protectionCost,
        protectionCount: run.protectionCount,
        // baseCost is subtracted by the engine, which buys the base separately;
        // a run that starts from a copy already held pays for no base at all
        baseCost: 0,
        totalCost: materialCost + protectionCost,
        materialBill: rescaleMaterialBill(strategy.materialBill, {
            attempts: run.attempts,
            fromAttempts: strategy.expectedAttempts,
            protectionCount: run.protectionCount,
            fromProtectionCount: strategy.protectionCount,
        }),
        fromLevel: startLevel,
    };
}

/**
 * The optimiser's bill, restated for a run that starts part of the way up.
 *
 * Same reasoning as the cost above it: the shorter chain is a different Markov
 * run but the same per-attempt recipe, so the bill is scaled by the ratio of
 * attempts rather than rebuilt — a partial run and a full one cannot then
 * disagree about what an attempt consumes.
 *
 * Base and mirror lines are dropped. A character already holding a partly
 * enhanced copy is not buying it again, and a start above +0 never takes the
 * mirror branch.
 *
 * @param {Array<Object>} bill - `materialBill` from the optimiser's strategy
 * @param {Object} ratios - `{attempts, fromAttempts, protectionCount, fromProtectionCount}`
 * @returns {Array<Object>} The rescaled bill
 */
function rescaleMaterialBill(bill, { attempts, fromAttempts, protectionCount, fromProtectionCount }) {
    if (!Array.isArray(bill)) return [];

    const materialRatio = fromAttempts > 0 ? attempts / fromAttempts : 0;
    const protectionRatio = fromProtectionCount > 0 ? protectionCount / fromProtectionCount : 0;

    const rescaled = [];
    for (const line of bill) {
        if (line.kind === 'base' || line.kind === 'mirror') continue;
        const ratio = line.kind === 'protection' ? protectionRatio : materialRatio;
        const count = (line.count || 0) * ratio;
        if (!(count > 0)) continue;
        rescaled.push({ ...line, count, totalCost: (line.unitPrice || 0) * count });
    }
    return rescaled;
}

/**
 * Assemble everything the planner needs, once.
 *
 * @param {Object} [options] - Options
 * @param {boolean} [options.measureRates=true] - Rank every activity's income. Off for a
 *   redraw that only needs names and levels, since the ranking is the expensive part.
 * @returns {Promise<Object>} A context for `planGoal`
 */
export async function buildPlannerContext({ measureRates = true } = {}) {
    if (!marketAPI.isLoaded?.()) {
        try {
            await marketAPI.fetch();
        } catch (error) {
            console.error('[GoalPlanner] Loading market data failed:', error);
        }
    }

    const gameData = dataManager.getInitClientData();
    const measured = measureRates
        ? await measureGoldRates()
        : {
              rates: [],
              byAction: new Map(),
              trainingMargin: new Map(),
              trainingDrinkCost: new Map(),
              trainingUpfront: new Map(),
              notes: [],
              combatStatus: null,
          };
    const rates = measured.rates;
    const goldByAction = measured.trainingMargin;
    const drinkCostByAction = measured.trainingDrinkCost;
    const upfrontByAction = measured.trainingUpfront;

    const acquisitions = new Map();
    const runs = new Map();
    const xpCache = new Map();
    const houseCosts = new Map();

    return {
        now: Date.now(),
        // When the quotes were true (the snapshot's own time, whether fetched just now or
        // loaded from an older cache). Null when no market data loaded at all.
        pricedAt: marketAPI.lastFetchTimestamp || null,
        gold: coinsHeld(),
        levelExperienceTable: gameData?.levelExperienceTable || null,
        pricingNote: `Priced against market data from ${getPriceAgeString() || 'an unknown time'}. Costs move with the book — re-price before committing.`,

        // What a rate provider wants said out loud: a combat snapshot that is
        // missing or stale is a fact about the ranking, not a silent omission
        rateNotes: measured.notes,

        // Which loadout the combat rates were judged against, and what else
        // could have been picked — the panel offers the choice when there is one
        combatStatus: measured.combatStatus,

        itemName: (itemHrid) => dataManager.getItemDetails(itemHrid)?.name || humanise(itemHrid),
        skillName: (skillHrid) => humanise(skillHrid),
        houseRoomName: (roomHrid) => gameData?.houseRoomDetailMap?.[roomHrid]?.name || humanise(roomHrid),

        skill: skillState,
        owned: availableCount,
        reservationNote: (short, itemHrid, goalId) =>
            shortfallNote(short, itemHrid, 0, {
                excludeOwner: goalId ? `${RESERVATION_OWNER_PREFIX}${goalId}` : null,
            }),
        ownedEnhancementLevel: bestOwnedLevel,
        houseLevel: (roomHrid) => dataManager.getHouseRoomLevel(roomHrid),

        goldRates: () => rates,

        xpRates: (skillHrid) => {
            if (xpCache.has(skillHrid)) return xpCache.get(skillHrid);
            const measured =
                skillHrid === ENHANCING_SKILL
                    ? measureEnhancingRates()
                    : measureXpRates(skillHrid, goldByAction, drinkCostByAction, upfrontByAction);
            xpCache.set(skillHrid, measured);
            return measured;
        },

        acquire: (itemHrid) => {
            if (!acquisitions.has(itemHrid)) acquisitions.set(itemHrid, acquisitionFor(itemHrid));
            return acquisitions.get(itemHrid);
        },

        enhance: (request) => {
            const key = `${request.itemHrid}|${request.startLevel || 0}|${request.targetLevel}`;
            if (!runs.has(key)) runs.set(key, enhancementRun(request));
            return runs.get(key);
        },

        // Filled in by withHouseCosts before planning, because the house
        // calculator is asynchronous and the planner's lookups are not
        houseCost: (roomHrid, fromLevel, toLevel) => houseCosts.get(`${roomHrid}|${fromLevel}|${toLevel}`) ?? null,

        _houseCosts: houseCosts,
    };
}

/**
 * Price the house upgrades a set of goals needs, and fold them into a context.
 *
 * Separate from {@link buildPlannerContext} because the house calculator is
 * asynchronous per level and the planner's lookups are not; pre-resolving only
 * the rooms actually asked for keeps that from becoming a scan of every room in
 * the house.
 *
 * @param {Object} context - A context from `buildPlannerContext`
 * @param {Array<Object>} goals - The goals about to be planned
 * @returns {Promise<Object>} The same context, house costs filled in
 */
export async function withHouseCosts(context, goals) {
    const wanted = (Array.isArray(goals) ? goals : []).filter((goal) => goal?.type === 'house');
    if (!wanted.length) return context;

    try {
        await houseCostCalculator.initialize();
    } catch (error) {
        console.error('[GoalPlanner] Preparing the house calculator failed:', error);
    }

    for (const goal of wanted) {
        const fromLevel = context.houseLevel(goal.roomHrid);
        const toLevel = Number(goal.targetLevel);
        if (!(toLevel > fromLevel)) continue;

        const key = `${goal.roomHrid}|${fromLevel}|${toLevel}`;
        if (context._houseCosts.get(key)) continue;
        try {
            const cost = await houseCostCalculator.calculateCumulativeCost(goal.roomHrid, fromLevel, toLevel);
            const materials = (cost?.materials || []).map((material) => ({
                ...material,
                name: houseCostCalculator.getItemName(material.itemHrid),
            }));
            context._houseCosts.set(key, { ...cost, materials });
        } catch (error) {
            console.error(`[GoalPlanner] Costing ${goal.roomHrid} failed:`, error);
            context._houseCosts.set(key, null);
        }
    }

    return context;
}

export default {
    buildPlannerContext,
    withHouseCosts,
    coinsHeld,
};
