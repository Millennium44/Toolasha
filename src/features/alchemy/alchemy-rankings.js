/**
 * Every alchemy action this character could run, costed.
 *
 * ## Why this file exists
 *
 * There were two alchemy "profit" surfaces and neither could answer "what does
 * alchemy pay per hour?":
 *
 * - `alchemy-profit.js` reads the open panel — success rate out of
 *   `SkillActionDetail_successRate`, inputs and drops out of the drop table,
 *   the catalyst out of its slot, the tea duration off a React fiber. It
 *   describes *one* action, the one you are looking at, and only while you are
 *   looking at it.
 * - `alchemy-best-items.js` does the enumeration properly — it walks
 *   `itemDetailMap`, checks eligibility per alchemy type and asks the real
 *   calculator about each item — but that loop lived as a method on a class
 *   that owns a modal, so nothing without a DOM could call it.
 *
 * The loop is the valuable part, so it moved here. `alchemy-best-items.js` now
 * calls {@link rankAlchemyType} for its table and this module is what the goal
 * planner asks for gold rates, which means the table and the planner cannot
 * drift apart the way two copies of a loop would.
 *
 * ## Nothing here does profit arithmetic
 *
 * Every gold figure is `alchemy-profit-calculator.js`'s, taken off its result
 * unmodified — including the coin fee, which that calculator already subtracts
 * inside `computeNetProfit` via `utils/alchemy-fees.js` (and which is zero for
 * coinify, by the rule stated in that file). `starfruit-loop.js` is the
 * precedent for driving those calculators without a panel open; this is the
 * same trick applied to the whole item list rather than to three actions.
 *
 * The one piece of arithmetic here is experience per action, which the game
 * does not publish for alchemy and which three surfaces reverse-engineered
 * separately. {@link getAlchemyBaseXP} is the copy the ranking table has always
 * used, moved rather than rewritten.
 *
 * ## Item level gates nothing; it only hurts
 *
 * Alchemy has no per-item level requirement. Working above your level is
 * allowed and is punished with a success-rate penalty
 * (`getUnderLevelPenalty` in the calculator, `0.9 / itemLevel` per level
 * short). So an under-levelled item is not filtered out — it is quoted with the
 * penalty already inside its rate and flagged `underLevelled`, which is the
 * honest answer: it is a thing you can do, it just pays badly.
 *
 * The *action* is gated, and that gate is real: an alchemy level below
 * `/actions/alchemy/<type>`'s requirement means the character cannot start that
 * action at all, and the whole type drops out.
 */

import dataManager from '../../core/data-manager.js';
import alchemyProfitCalculator from '../market/alchemy-profit-calculator.js';
import { calculateExperienceMultiplier } from '../../utils/experience-parser.js';
import { getItemPrice } from '../../utils/market-data.js';

/** The three alchemy actions an item can be put through */
export const ALCHEMY_TYPES = ['coinify', 'decompose', 'transmute'];

const ALCHEMY_SKILL = '/skills/alchemy';

/** Which calculator method answers for which type */
const CALCULATOR_METHOD = {
    coinify: 'calculateCoinifyProfit',
    decompose: 'calculateDecomposeProfit',
    transmute: 'calculateTransmuteProfit',
};

/** The action each type is, for anything that identifies a rate by its action */
const ACTION_HRID = {
    coinify: '/actions/alchemy/coinify',
    decompose: '/actions/alchemy/decompose',
    transmute: '/actions/alchemy/transmute',
};

const TYPE_LABEL = {
    coinify: 'Coinify',
    decompose: 'Decompose',
    transmute: 'Transmute',
};

/**
 * How many alchemy rates the planner is handed.
 *
 * The full ranking is a few hundred rows and the planner only ever shows the
 * winner plus a handful of alternatives, so everything past this is weight
 * carried for nothing.
 */
export const PLANNER_RATE_LIMIT = 12;

/** The last aggregate, and the state it was computed against */
let rateCache = { fingerprint: null, rates: null };

/**
 * Get base XP for an alchemy action type and item level
 * (the same copy `alchemy-profit-display.js` shows on the panel)
 * @param {string} actionType - 'coinify', 'decompose', or 'transmute'
 * @param {number} itemLevel - Item level from itemDetailMap
 * @returns {number} Base XP before the wisdom multiplier
 */
export function getAlchemyBaseXP(actionType, itemLevel) {
    switch (actionType) {
        case 'coinify':
            return itemLevel + 10;
        case 'decompose':
            return itemLevel * 1.4 + 14;
        case 'transmute':
            return itemLevel * 1.6 + 16;
        default:
            return 0;
    }
}

/**
 * Calculate expected XP per action for an item
 * @param {string} actionType - 'coinify', 'decompose', or 'transmute'
 * @param {number} itemLevel - Item level from itemDetailMap
 * @param {number} successRate - Success rate as a decimal in [0, 1]
 * @returns {number} Expected XP per action, blending the full and failed-action awards
 */
export function calcXpPerAction(actionType, itemLevel, successRate) {
    const baseXP = getAlchemyBaseXP(actionType, itemLevel);
    if (baseXP === 0) return 0;

    const xpData = calculateExperienceMultiplier(ALCHEMY_SKILL, '/action_types/alchemy');
    const fullXP = baseXP * xpData.totalMultiplier;

    // Expected value: success gives full XP, failure gives 10%
    return successRate * fullXP + (1 - successRate) * fullXP * 0.1;
}

/**
 * The character's alchemy level.
 * @returns {number} Level, or 1 when skills are unavailable
 */
function alchemyLevel() {
    const skill = (dataManager.getSkills() || []).find((entry) => entry.skillHrid === ALCHEMY_SKILL);
    return skill?.level ?? 1;
}

/**
 * Whether an item can go through a given alchemy action at all.
 *
 * The same three checks the calculator makes before it will answer, restated
 * here so the enumeration can skip an item without paying for a calculator call
 * that is going to return null.
 *
 * @param {string} type - 'coinify' | 'decompose' | 'transmute'
 * @param {Object} itemDetails - Item details from itemDetailMap
 * @returns {boolean} Whether the action applies
 */
export function isEligible(type, itemDetails) {
    const detail = itemDetails?.alchemyDetail;
    if (!detail) return false;
    if (type === 'coinify') return detail.isCoinifiable === true;
    if (type === 'decompose') return Boolean(detail.decomposeItems);
    if (type === 'transmute') return Boolean(detail.transmuteDropTable);
    return false;
}

/**
 * Whether the character's alchemy level allows starting an action at all.
 * @param {string} type - 'coinify' | 'decompose' | 'transmute'
 * @param {Object} gameData - init_client_data
 * @param {number} level - The character's alchemy level
 * @returns {boolean} Whether the action can be started
 */
function actionUnlocked(type, gameData, level) {
    const requirement = gameData?.actionDetailMap?.[ACTION_HRID[type]]?.levelRequirement;
    if (!requirement?.skillHrid) return true;
    if (requirement.skillHrid !== ALCHEMY_SKILL) return true;
    return level >= (requirement.level || 1);
}

/**
 * Every item this alchemy action can be run on, costed through the real calculator.
 *
 * Unsorted and unfiltered, because the two callers want different orders: the
 * table sorts by whichever column is selected and shows losses on purpose,
 * while the planner only wants what pays.
 *
 * @param {string} type - 'coinify' | 'decompose' | 'transmute'
 * @returns {Array<Object>} One entry per eligible item
 */
export function rankAlchemyType(type) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.itemDetailMap) return [];

    const level = alchemyLevel();
    if (!actionUnlocked(type, gameData, level)) return [];

    const method = CALCULATOR_METHOD[type];
    if (!method) return [];

    const results = [];
    for (const [itemHrid, itemDetails] of Object.entries(gameData.itemDetailMap)) {
        if (!isEligible(type, itemDetails)) continue;

        let profitData;
        try {
            // Transmute takes no enhancement level — the item goes in as it is
            profitData =
                type === 'transmute'
                    ? alchemyProfitCalculator[method](itemHrid)
                    : alchemyProfitCalculator[method](itemHrid, 0);
        } catch {
            continue;
        }
        if (!profitData) continue;

        const itemLevel = itemDetails.itemLevel || 1;
        const xpPerAction = calcXpPerAction(type, itemLevel, profitData.successRate);

        results.push({
            action: type,
            actionHrid: ACTION_HRID[type],
            itemHrid,
            name: itemDetails.name,
            itemLevel,
            itemPrice: getItemPrice(itemHrid, { context: 'profit', side: 'buy' }) || 0,
            profitPerHour: profitData.profitPerHour,
            xpPerHour: profitData.actionsPerHour * xpPerAction,
            catalyst: profitData.winningCatalystHrid || null,
            // Item level is a penalty, not a gate — see the module doc
            requiresLevel: itemLevel,
            underLevelled: level < itemLevel,
            profitData,
        });
    }

    return results;
}

/**
 * A digest of everything a rate depends on that is not the market.
 *
 * Alchemy profit moves with the alchemy level (the under-level penalty), the
 * teas in the slots (success rate and cost) and the gear (speed, efficiency,
 * rare and essence find). Any of those changing has to invalidate the cache;
 * nothing else in the character does.
 *
 * @param {number} priceStamp - When the caller's market data was fetched
 * @returns {string} A cache key
 */
function stateFingerprint(priceStamp) {
    const level = alchemyLevel();

    const drinks = (dataManager.getActionDrinkSlots('/action_types/alchemy') || [])
        .map((slot) => slot?.itemHrid || 'empty')
        .join(',');

    const equipment = dataManager.getEquipment();
    const gear = equipment
        ? Array.from(equipment.values())
              .map((item) => `${item?.itemHrid || ''}+${item?.enhancementLevel || 0}`)
              .sort()
              .join(',')
        : '';

    return `${level}|${priceStamp}|${drinks}|${gear}`;
}

/**
 * Throw away the memoised aggregate.
 *
 * For anything that changes the world in a way the fingerprint cannot see — a
 * settings change to the pricing mode, say.
 *
 * @returns {void}
 */
export function clearAlchemyRateCache() {
    rateCache = { fingerprint: null, rates: null };
}

/**
 * What alchemy pays per hour, best first, in the shape the planner ranks.
 *
 * Memoised on the character state and the caller's price stamp, because the
 * ranking is three passes over `itemDetailMap` and the planner asks for it on
 * every refresh — including refreshes that happen because a *house* level
 * changed and cannot have moved an alchemy rate.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.priceStamp=0] - When the market data behind the prices was fetched
 * @param {number} [options.limit=PLANNER_RATE_LIMIT] - How many rates to keep
 * @returns {Array<Object>} `{actionHrid, label, goldPerHour, kind, ...}`, best first
 */
export function alchemyGoldRates({ priceStamp = 0, limit = PLANNER_RATE_LIMIT } = {}) {
    const fingerprint = stateFingerprint(priceStamp);
    if (rateCache.fingerprint === fingerprint && rateCache.rates) return rateCache.rates;

    const rates = [];
    for (const type of ALCHEMY_TYPES) {
        let ranked;
        try {
            ranked = rankAlchemyType(type);
        } catch (error) {
            console.error(`[AlchemyRankings] Ranking ${type} failed:`, error);
            continue;
        }

        for (const entry of ranked) {
            if (!(entry.profitPerHour > 0)) continue;
            rates.push({
                actionHrid: entry.actionHrid,
                label: `${TYPE_LABEL[type]} ${entry.name || entry.itemHrid.split('/').pop()}`,
                goldPerHour: entry.profitPerHour,
                kind: 'alchemy',
                action: type,
                itemHrid: entry.itemHrid,
                itemName: entry.name,
                requiresLevel: entry.requiresLevel,
                underLevelled: entry.underLevelled,
                xpPerHour: entry.xpPerHour,
                catalyst: entry.catalyst,
            });
        }
    }

    rates.sort((a, b) => b.goldPerHour - a.goldPerHour);
    const kept = rates.slice(0, limit);
    rateCache = { fingerprint, rates: kept };
    return kept;
}

export default {
    ALCHEMY_TYPES,
    rankAlchemyType,
    alchemyGoldRates,
    clearAlchemyRateCache,
    isEligible,
    getAlchemyBaseXP,
    calcXpPerAction,
};
