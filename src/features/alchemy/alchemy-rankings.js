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
 *
 * ## Per hour is not the whole truth, and for alchemy it is barely half of it
 *
 * Every alchemy action eats one copy of the item it is run on. So a rate here
 * is only real while there are copies: decomposing a Sundering Crossbow ★ may
 * be worth 850M in seven seconds, which is 437 *billion* an hour, and that
 * number describes a world in which you have five hundred crossbows. You have
 * one.
 *
 * {@link alchemyGoldRates} therefore ships a `sustainable` cap alongside every
 * rate — how much gold that item can produce in total before the stack is gone
 * — and the planner spends it as a one-off before moving down the ranking.
 *
 * The cap counts **stock on hand only**. Buying more input off the market and
 * running it through is genuinely possible and genuinely unbounded in theory,
 * but the bound in practice is order-book depth, and the game only sends a book
 * for the one item the marketplace is open on — there is no way to ask about
 * three hundred items without three hundred round trips. Own stock is the
 * conservative reading, and every rate says that is what it is.
 */

import config from '../../core/config.js';
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

/** What every alchemy rate says about where its ceiling came from */
export const OWN_STOCK_NOTE = 'own stock only — market depth is not counted';

const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * How many unenhanced copies of an item are in the bag.
 *
 * Unenhanced because that is what these rates are costed for — `rankAlchemyType`
 * asks the calculator about enhancement level 0 — and inventory only because a
 * cape on your back is not an input to anything.
 *
 * @param {Array<Object>} inventory - From `dataManager.getInventory()`
 * @returns {Map<string, number>} Item hrid → count held
 */
function stockByItem(inventory) {
    const held = new Map();
    for (const item of inventory || []) {
        if (!item?.itemHrid) continue;
        if (item.itemLocationHrid !== INVENTORY_LOCATION) continue;
        if (item.enhancementLevel) continue;
        if (!(item.count > 0)) continue;
        held.set(item.itemHrid, (held.get(item.itemHrid) || 0) + item.count);
    }
    return held;
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
 * rare and essence find).
 *
 * Since the rates began carrying a stock cap, the bag does too — decomposing
 * the last crossbow has to stop the rate being offered, and a cached answer
 * from before it went would go on offering it. Counted rather than digested:
 * one number over the inventory is cheap, and any consumption moves it.
 *
 * Three more inputs are in here because they move a rate and were not being
 * noticed: the **pricing mode**, which decides what every output is worth; the
 * **house**, whose rooms feed efficiency and rare find (the note below about a
 * house level not being able to move an alchemy rate was simply wrong); and the
 * **community buffs**, which anyone donating can change under you.
 *
 * Still uncovered: achievement, personal, guild and seal buffs. They are read by
 * the calculator but change rarely and only through events that also move
 * something above — a fingerprint over each of them would cost more per call
 * than the misses are worth. {@link clearAlchemyRateCache} is the way out when
 * one of them does change.
 *
 * @param {number} priceStamp - When the caller's market data was fetched
 * @returns {string} A cache key
 */
function stateFingerprint(priceStamp) {
    const level = alchemyLevel();

    const inventory = dataManager.getInventory() || [];
    const stock = `${inventory.length}:${inventory.reduce((sum, item) => sum + (item?.count || 0), 0)}`;

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

    const pricingMode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');

    const houseRooms = dataManager.getHouseRooms();
    const house = houseRooms ? Array.from(houseRooms.values()).reduce((sum, room) => sum + (room?.level || 0), 0) : 0;

    const community = (dataManager.characterData?.communityBuffs || [])
        .map((buff) => `${buff?.hrid || ''}:${buff?.level || 0}`)
        .sort()
        .join(',');

    return `${level}|${priceStamp}|${drinks}|${gear}|${stock}|${pricingMode}|${house}|${community}`;
}

/**
 * Throw away the memoised aggregate.
 *
 * For anything that changes the world in a way the fingerprint cannot see — an
 * achievement, guild or seal buff. Registered against the pricing-mode setting
 * below as well, which the fingerprint does cover: the setting is what the cache
 * was most visibly wrong about, and a stale ranking after a deliberate settings
 * change is the one nobody would think to blame on a cache.
 *
 * @returns {void}
 */
export function clearAlchemyRateCache() {
    rateCache = { fingerprint: null, rates: null };
}

// The pricing mode decides what every alchemy output is worth. Registered once,
// at import, because this module has no lifecycle of its own to hang it on.
config.onSettingChange?.('profitCalc_pricingMode', clearAlchemyRateCache);

/**
 * What alchemy pays per hour, best first, in the shape the planner ranks.
 *
 * Memoised on the character state and the caller's price stamp, because the
 * ranking is three passes over `itemDetailMap` and the planner asks for it on
 * every refresh — including refreshes that happen because something changed
 * that {@link stateFingerprint} can see has not moved an alchemy rate.
 *
 * Each rate carries a `sustainable` cap: alchemy eats one copy of its item per
 * action, so what the method is worth in total is the margin times what is in
 * the bag. An item with none left is not offered at all — a rate you cannot
 * start once is not a rate, and it is exactly the kind that tops the ranking.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.priceStamp=0] - When the market data behind the prices was fetched
 * @param {number} [options.limit=PLANNER_RATE_LIMIT] - How many rates to keep
 * @returns {Array<Object>} `{actionHrid, label, goldPerHour, sustainable, kind, ...}`, best first
 */
export function alchemyGoldRates({ priceStamp = 0, limit = PLANNER_RATE_LIMIT } = {}) {
    const fingerprint = stateFingerprint(priceStamp);
    if (rateCache.fingerprint === fingerprint && rateCache.rates) return rateCache.rates;

    const stock = stockByItem(dataManager.getInventory());

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

            const units = stock.get(entry.itemHrid) || 0;
            if (units <= 0) continue;

            // The calculator's own per-action margin, which already carries the
            // tea, catalyst and coin-fee arithmetic — dividing the hourly figure
            // here would be a second opinion about the same number
            const goldPerUnit = Number(entry.profitData?.profitPerAction);
            const perUnit = Number.isFinite(goldPerUnit) && goldPerUnit > 0 ? goldPerUnit : 0;
            if (!perUnit) continue;

            const name = entry.name || entry.itemHrid.split('/').pop();

            // What the method has to sell, and what it costs to start one.
            //
            // Neither is used here — both are for the goal planner, which bounds
            // a rate by how fast its output actually trades and refuses to
            // recommend a method whose inputs cost more than the character has.
            // They are attached at the point the rate is built because this is
            // where the calculator's own answer is still in scope; re-deriving
            // them later would be a second opinion about the same numbers.
            const sells = (entry.profitData?.dropRevenues || [])
                .filter((drop) => drop?.itemHrid && Number(drop.dropsPerHour) > 0)
                .map((drop) => ({
                    itemHrid: drop.itemHrid,
                    name: drop.itemName || null,
                    unitsPerHour: Number(drop.dropsPerHour) || 0,
                }));
            // The item itself is already in the bag — that is what the cap below
            // counts — so starting costs only the catalyst and the drinks
            const upfrontCost = Math.max(
                0,
                (Number(entry.profitData?.costPerAttempt) || 0) - (Number(entry.profitData?.materialCost) || 0)
            );

            rates.push({
                actionHrid: entry.actionHrid,
                sells,
                upfrontCost,
                label: `${TYPE_LABEL[type]} ${name}`,
                goldPerHour: entry.profitPerHour,
                kind: 'alchemy',
                action: type,
                itemHrid: entry.itemHrid,
                itemName: entry.name,
                requiresLevel: entry.requiresLevel,
                underLevelled: entry.underLevelled,
                xpPerHour: entry.xpPerHour,
                catalyst: entry.catalyst,
                sustainable: {
                    gold: perUnit * units,
                    goldPerUnit: perUnit,
                    units,
                    unitLabel: name,
                    verb: TYPE_LABEL[type],
                    source: 'inventory',
                    note: OWN_STOCK_NOTE,
                },
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
    OWN_STOCK_NOTE,
    rankAlchemyType,
    alchemyGoldRates,
    clearAlchemyRateCache,
    isEligible,
    getAlchemyBaseXP,
    calcXpPerAction,
};
