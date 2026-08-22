/**
 * Every production recipe this character can run, costed against the market.
 *
 * ## What this is
 *
 * The action panel already answers "what does *this* recipe pay me?" — the
 * profit display asks `profit-calculator.js` about the one action that is open.
 * That calculator knows everything personal about a craft: artisan tea taking
 * materials off, efficiency repeating the action for free, gourmet copies,
 * processing, house and gear speed, the tea you drink to get them, market tax
 * on the sale and the Tester shop floor on the test server. What it does not do
 * is answer for five hundred recipes at once and line them up.
 *
 * This module is that line-up. It walks `actionDetailMap` for every recipe in
 * the production skills (cheesesmithing, crafting, tailoring, cooking, brewing),
 * puts each one through the same calculator the panel uses — not a second
 * opinion about the arithmetic, the same call with the recipe named — and
 * reports, per row, what a unit costs you in materials, what it sells for after
 * tax, and the margin per unit, per action, per hour and per day.
 *
 * ## Per day is the market's number, not yours
 *
 * A margin per hour describes how fast you can make the thing. How fast you can
 * *sell* it is a different question, and for anything but staple materials it
 * is the one that binds. Every row is therefore bounded the way the alchemy
 * ranking and the goal planner bound theirs — `utils/liquidity-cap.js`, which
 * reads the pooled market history and takes a share of what actually trades —
 * and carries `unitsPerDay` (the smaller of what you can make and what the book
 * absorbs) and `marginPerDay` (the margin on those units). The bound is applied
 * in a second pass, because the volume read is a network round trip per item
 * and the rows are useful before it lands.
 *
 * ## Never on the main thread for long
 *
 * Five hundred calculator calls is a noticeable freeze. The walk is sliced and
 * yields to the event loop between slices (`utils/background-work.js`), and the
 * whole result is memoised on a fingerprint of everything that could move a
 * figure — the price snapshot, the five skill levels, the drinks in every
 * production slot, the gear, the pricing mode — so reopening the board with
 * nothing changed costs nothing.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import profitCalculator from '../market/profit-calculator.js';
import { capProfitRate, sellsFromProfitData, liquidityCapEnabled } from '../../utils/liquidity-cap.js';
import { yieldToEventLoop } from '../../utils/background-work.js';
import { testerShopEnabled } from '../../utils/tester-shop.js';
import { HOURS_PER_DAY } from '../../utils/profit-constants.js';

/** The five production skills, in the order the board's filter lists them */
export const PRODUCTION_SKILLS = [
    { skillHrid: '/skills/cheesesmithing', type: '/action_types/cheesesmithing', label: 'Cheesesmithing' },
    { skillHrid: '/skills/crafting', type: '/action_types/crafting', label: 'Crafting' },
    { skillHrid: '/skills/tailoring', type: '/action_types/tailoring', label: 'Tailoring' },
    { skillHrid: '/skills/cooking', type: '/action_types/cooking', label: 'Cooking' },
    { skillHrid: '/skills/brewing', type: '/action_types/brewing', label: 'Brewing' },
];

/** Action type → skill descriptor */
const SKILL_BY_TYPE = new Map(PRODUCTION_SKILLS.map((skill) => [skill.type, skill]));

/** How many recipes are costed before the main thread is handed back */
export const BATCH_SIZE = 24;

/**
 * A price older than this is flagged on its row. The market feed refreshes every
 * fifteen minutes, so an hour means several refreshes have failed to land.
 */
export const STALE_PRICE_MS = 60 * 60 * 1000;

/** The last ranking, and the state it was computed against */
let cache = { fingerprint: null, rows: null, pending: null };

/**
 * The character's level in a skill.
 * @param {string} skillHrid - Skill hrid
 * @returns {number} Level, or 1 when skills are unavailable
 */
function skillLevel(skillHrid) {
    const skill = (dataManager.getSkills() || []).find((entry) => entry.skillHrid === skillHrid);
    return skill?.level ?? 1;
}

/**
 * A digest of everything a row depends on that is not the recipe itself.
 *
 * @param {number} priceStamp - When the caller's market data was fetched
 * @returns {string} A cache key
 */
export function stateFingerprint(priceStamp = marketAPI.lastFetchTimestamp || 0) {
    const levels = PRODUCTION_SKILLS.map((skill) => skillLevel(skill.skillHrid)).join(',');

    const drinks = PRODUCTION_SKILLS.map((skill) =>
        (dataManager.getActionDrinkSlots(skill.type) || []).map((slot) => slot?.itemHrid || 'empty').join('+')
    ).join(',');

    const equipment = dataManager.getEquipment();
    const gear = equipment
        ? Array.from(equipment.values())
              .map((item) => `${item?.itemHrid || ''}+${item?.enhancementLevel || 0}`)
              .sort()
              .join(',')
        : '';

    const settings = [
        config.getSettingValue('profitCalc_pricingMode', 'hybrid'),
        config.getSetting('profitCalc_craftUpgradeItems') ? 'craft' : 'buy',
        liquidityCapEnabled() ? 'cap' : 'nocap',
        testerShopEnabled() ? 'tester' : 'market',
    ].join(',');

    return `${priceStamp}|${levels}|${drinks}|${gear}|${settings}`;
}

/** Throw away the memoised ranking, for anything the fingerprint cannot see */
export function clearProductionArbitrageCache() {
    cache = { fingerprint: null, rows: null, pending: null };
}

/**
 * Every production recipe in the game data, with the skill it belongs to.
 *
 * Recipes with no output (there are none today, but the map is the game's) and
 * actions outside the five production skills are skipped.
 *
 * @returns {Array<{actionHrid: string, action: Object, skill: Object, itemHrid: string}>}
 */
export function productionRecipes() {
    const actionMap = dataManager.getInitClientData()?.actionDetailMap;
    if (!actionMap) return [];

    const recipes = [];
    for (const [actionHrid, action] of Object.entries(actionMap)) {
        const skill = SKILL_BY_TYPE.get(action?.type);
        if (!skill) continue;
        const itemHrid = action.outputItems?.[0]?.itemHrid;
        if (!itemHrid) continue;
        recipes.push({ actionHrid, action, skill, itemHrid });
    }
    return recipes;
}

/**
 * What is wrong with a row's prices, if anything.
 *
 * @param {Object} profitData - A profit-calculator result
 * @param {number} now - The clock
 * @returns {{flag: string|null, note: string}} `flag` is `'no-price'`, `'missing-input'`,
 *   `'stale'` or null; `note` says it in words for a tooltip
 */
export function dataQuality(profitData, now = Date.now()) {
    if (profitData.outputPriceMissing && !profitData.outputPriceEstimated) {
        return { flag: 'no-price', note: 'No market price for the output — the sale value is unknown' };
    }
    if (profitData.outputPriceEstimated) {
        return { flag: 'no-price', note: 'No market price for the output — valued at its crafting cost' };
    }
    if (profitData.hasMissingPrices) {
        return { flag: 'missing-input', note: 'A material or drink has no market price — the cost is understated' };
    }
    const stamp = marketAPI.getPriceTimestamp?.(profitData.itemHrid, 0);
    if (Number.isFinite(stamp) && stamp > 0 && now - stamp > STALE_PRICE_MS) {
        const hours = Math.round((now - stamp) / 3_600_000);
        return { flag: 'stale', note: `The output price is ${hours}h old` };
    }
    return { flag: null, note: '' };
}

/**
 * One board row out of one calculator answer.
 *
 * Every gold figure is the calculator's own. The per-unit margin is its
 * `profitPerItem` (tea, tax and bonus drops already inside it), the per-action
 * margin its `profitPerAction`, the per-hour its `profitPerHour`. The one thing
 * computed here is the day view, which starts as the hour view times
 * twenty-four and is cut by the volume cap later.
 *
 * @param {Object} recipe - From {@link productionRecipes}
 * @param {Object} profitData - The calculator's answer for it
 * @param {number} [now] - The clock
 * @returns {Object} A row
 */
export function rowFromProfit(recipe, profitData, now = Date.now()) {
    const { actionHrid, action, skill, itemHrid } = recipe;
    const level = skillLevel(skill.skillHrid);
    const requiredLevel = action.levelRequirement?.level || 1;
    const teaLevels = Number(profitData.teaSkillLevelBonus) || 0;
    const unitsPerHour = Number(profitData.totalItemsPerHour) || 0;
    const marginPerHour = Number(profitData.profitPerHour) || 0;
    const quality = dataQuality(profitData, now);

    return {
        itemHrid,
        itemName: profitData.itemName || dataManager.getItemDetails(itemHrid)?.name || itemHrid.split('/').pop(),
        actionHrid,
        actionName: action.name || actionHrid.split('/').pop(),
        skillHrid: skill.skillHrid,
        skillLabel: skill.label,
        requiredLevel,
        level,
        // Tea skill levels count towards starting an action, the same way the
        // efficiency arithmetic counts them
        levelMet: level + teaLevels >= requiredLevel,
        materialCostPerUnit: Number(profitData.costPerItem) || 0,
        saleAfterTax: Number(profitData.priceAfterTax) || 0,
        marginPerUnit: Number(profitData.profitPerItem) || 0,
        marginPerAction: Number(profitData.profitPerAction) || 0,
        marginPerHour,
        actionsPerHour: Number(profitData.actionsPerHour) || 0,
        unitsPerHour,
        // The day view before the market has been asked: what you could make
        makeablePerDay: unitsPerHour * HOURS_PER_DAY,
        unitsPerDay: unitsPerHour * HOURS_PER_DAY,
        marginPerDay: marginPerHour * HOURS_PER_DAY,
        uncappedMarginPerDay: marginPerHour * HOURS_PER_DAY,
        liquidityLimit: null,
        volumeChecked: false,
        quality: quality.flag,
        qualityNote: quality.note,
        profitData,
    };
}

/**
 * Bound one row's day view by how fast its output sells.
 *
 * The row is copied, never edited; the unbounded figure stays on
 * `uncappedMarginPerDay`, and `unitsPerDay` becomes "make N/day" — what the
 * market will take, when that is less than what you could make.
 *
 * @param {Object} row - From {@link rowFromProfit}
 * @returns {Promise<Object>} The row, bounded where the market binds
 */
export async function withVolumeCap(row) {
    const checked = { ...row, volumeChecked: true };
    if (!(row.marginPerHour > 0)) return checked;

    try {
        const capped = await capProfitRate({
            goldPerHour: row.marginPerHour,
            sells: sellsFromProfitData(row.profitData),
        });
        if (!capped.capped) return checked;
        const throttle = capped.limit?.throttle ?? capped.goldPerHour / row.marginPerHour;
        return {
            ...checked,
            unitsPerDay: row.makeablePerDay * throttle,
            marginPerDay: row.uncappedMarginPerDay * throttle,
            liquidityLimit: capped.limit,
        };
    } catch (error) {
        console.error('[ProductionArbitrage] Bounding a row by market volume failed:', error);
        return checked;
    }
}

/**
 * Every production recipe, costed, unsorted.
 *
 * Sliced so the page stays responsive: `onProgress(done, total)` is called after
 * each slice, and a caller that wants to draw what is ready so far can. The
 * result is memoised on {@link stateFingerprint}; a second call while the first
 * is still running joins it rather than starting another.
 *
 * @param {Object} [options] - Options
 * @param {number} [options.priceStamp] - When the market data behind the prices was fetched
 * @param {Function} [options.onProgress] - `(done, total, rows)` after each slice
 * @param {boolean} [options.volume=true] - Whether to run the volume-cap pass
 * @returns {Promise<Array<Object>>} Rows, in action-map order
 */
export function rankProductionArbitrage({ priceStamp, onProgress, volume = true } = {}) {
    const fingerprint = stateFingerprint(priceStamp);
    if (cache.fingerprint === fingerprint) {
        if (cache.rows) return Promise.resolve(cache.rows);
        if (cache.pending) return cache.pending;
    }

    const pending = (async () => {
        const recipes = productionRecipes();
        const rows = [];
        const now = Date.now();

        for (let index = 0; index < recipes.length; index += BATCH_SIZE) {
            const slice = recipes.slice(index, index + BATCH_SIZE);
            for (const recipe of slice) {
                let profitData = null;
                try {
                    profitData = await profitCalculator.calculateProfit(recipe.itemHrid, {
                        actionHrid: recipe.actionHrid,
                    });
                } catch (error) {
                    console.error(`[ProductionArbitrage] Costing ${recipe.actionHrid} failed:`, error);
                }
                // The calculator answers about the recipe it was handed; one
                // that answered about a different recipe for the same item is
                // not this row
                if (!profitData || (profitData.actionHrid && profitData.actionHrid !== recipe.actionHrid)) continue;
                rows.push(rowFromProfit(recipe, profitData, now));
            }
            onProgress?.(Math.min(index + BATCH_SIZE, recipes.length), recipes.length, rows);
            await yieldToEventLoop();
        }

        if (volume) {
            // The volume pass is a network read per item, and only rows that
            // earn anything need it — a loss bounded by the market is still a loss
            for (let index = 0; index < rows.length; index += BATCH_SIZE) {
                const slice = rows.slice(index, index + BATCH_SIZE);
                const bounded = await Promise.all(slice.map((row) => withVolumeCap(row)));
                rows.splice(index, bounded.length, ...bounded);
                onProgress?.(recipes.length, recipes.length, rows);
                await yieldToEventLoop();
            }
        }

        if (cache.fingerprint === fingerprint) cache = { fingerprint, rows, pending: null };
        return rows;
    })();

    cache = { fingerprint, rows: null, pending };
    return pending;
}

/** The sort keys the board offers, and what each compares */
export const SORT_KEYS = {
    day: (row) => row.marginPerDay,
    hour: (row) => row.marginPerHour,
    unit: (row) => row.marginPerUnit,
};

/**
 * Filter and order rows the way the board shows them.
 *
 * @param {Array<Object>} rows - From {@link rankProductionArbitrage}
 * @param {Object} [options] - Options
 * @param {string} [options.sort='day'] - `'day'`, `'hour'` or `'unit'`
 * @param {string|null} [options.skillHrid=null] - Only this skill
 * @param {string} [options.query=''] - Item or action name contains this (case-insensitive)
 * @param {boolean} [options.craftableOnly=false] - Only rows whose level you meet
 * @returns {Array<Object>} A new array, best first
 */
export function arrangeRows(rows, { sort = 'day', skillHrid = null, query = '', craftableOnly = false } = {}) {
    const key = SORT_KEYS[sort] || SORT_KEYS.day;
    const needle = String(query || '')
        .trim()
        .toLowerCase();

    const kept = (rows || []).filter((row) => {
        if (skillHrid && row.skillHrid !== skillHrid) return false;
        if (craftableOnly && !row.levelMet) return false;
        if (needle && !row.itemName.toLowerCase().includes(needle) && !row.actionName.toLowerCase().includes(needle)) {
            return false;
        }
        return true;
    });

    return kept.sort((a, b) => {
        const primary = key(b) - key(a);
        if (primary !== 0) return primary;
        return b.marginPerHour - a.marginPerHour;
    });
}

export default {
    PRODUCTION_SKILLS,
    SORT_KEYS,
    STALE_PRICE_MS,
    productionRecipes,
    rankProductionArbitrage,
    arrangeRows,
    rowFromProfit,
    withVolumeCap,
    dataQuality,
    stateFingerprint,
    clearProductionArbitrageCache,
};
