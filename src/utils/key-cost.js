/**
 * Dungeon key cost
 *
 * What one entry key or chest key costs, given that there are two ways to get
 * one: buy it off the market, or craft it from materials.
 *
 * ## Why both numbers, always
 *
 * A dungeon profit figure that prices keys at the market ask is answering "what
 * would it cost me to replace these keys right now, impatiently". That is a
 * real question, but it is not the only one, and when a key's materials are
 * cheaper than the key the answer overstates the cost of running the dungeon —
 * sometimes badly, because keys are thin markets and the ask drifts far above
 * what the recipe implies.
 *
 * So this reports both sides and names the cheaper one rather than picking
 * silently. The caller gets `unitCost` (the cheaper), and `buyPrice`,
 * `craftCost` and `cheaper` next to it, so a display can show the choice it made
 * instead of presenting one number as if it were the only one.
 *
 * ## Time is reported, not priced
 *
 * Crafting a key costs materials *and* time, and the time has no honest gold
 * value — it depends entirely on what the player would otherwise be doing.
 * `craftSeconds` is therefore handed back as seconds and never folded into
 * `craftCost`. A caller that wants to say "cheaper, but it costs you twelve
 * minutes" has what it needs; nothing here invents an hourly wage to make the
 * comparison come out one way.
 *
 * `craftSeconds` is the time for the key's own crafting action, per key, at this
 * character's efficiency. Materials are costed at whichever of buying and
 * crafting is cheaper for them (that is what `computeBestCraftingPlan` decides),
 * so if a material is itself crafted, its time is not in this figure.
 *
 * ## Whose cost this is
 *
 * A crafting cost is personal — artisan tea removes materials, efficiency gives
 * free actions, gear changes the action time. Everything here goes through
 * `describeCraft`, which costs the recipe against the logged-in character, so
 * two players reading the same dungeon get different and correct answers.
 */

import config from '../core/config.js';
import dataManager from '../core/data-manager.js';
import marketAPI from '../api/marketplace.js';
import { describeCraft } from '../features/crafting-plan/craft-arbitrage-adapter.js';
import { coinFormatter, timeReadable } from './formatters.js';

/** The setting that says which side of the book a key is priced from */
export const KEY_PRICING_SETTING = 'profitCalc_keyPricingMode';

/**
 * Which market price a key is bought at, per the user's setting.
 *
 * @returns {string} 'ask' (instant buy) or 'bid' (patient buy)
 */
export function getKeyPricingMode() {
    return config.getSettingValue(KEY_PRICING_SETTING) || 'ask';
}

/**
 * The market price of a key in the caller's pricing mode.
 *
 * Deliberately the same lookup the key-cost callers already used — `marketAPI`
 * directly, falling back to the ask when the chosen side is missing — so that
 * turning the craft comparison on cannot move the buy figure underneath it.
 *
 * @param {string} keyHrid - Key item HRID
 * @param {string} mode - 'ask' or 'bid'
 * @returns {number|null} Price, or null when the market has nothing
 */
function buyPriceFor(keyHrid, mode) {
    const prices = marketAPI.getPrice(keyHrid);
    if (!prices) return null;

    const price = prices[mode] ?? prices.ask;
    return Number.isFinite(price) && price > 0 ? price : null;
}

/**
 * What one key costs, bought and crafted, and which of those is cheaper.
 *
 * Either side may be missing and the result is still usable: a key with no
 * recipe reports `craftCost: null` and settles on buying, a key nobody is
 * selling reports `buyPrice: null` and settles on crafting. When both are
 * missing `unitCost` is null, which is the caller's signal that this key cannot
 * be costed at all rather than that it is free.
 *
 * @param {string} keyHrid - Key item HRID
 * @param {Object} [options] - Costing options
 * @param {string} [options.mode] - Pricing mode; defaults to the user's setting
 * @param {Map} [options.memo] - Shared unit-cost memo, for costing several keys
 * @param {Map} [options.actionStats] - Shared action-stats cache, same purpose
 * @returns {{itemHrid: string, itemName: string, pricingMode: string, buyPrice: number|null,
 *   craftCost: number|null, craftSeconds: number|null, craftActionHrid: string|null,
 *   cheaper: string|null, unitCost: number|null, savings: number}}
 */
export function describeKeyCost(keyHrid, options = {}) {
    const mode = options.mode || getKeyPricingMode();
    const itemName = dataManager.getItemDetails(keyHrid)?.name || keyHrid;

    const empty = {
        itemHrid: keyHrid,
        itemName,
        pricingMode: mode,
        buyPrice: null,
        craftCost: null,
        craftSeconds: null,
        craftActionHrid: null,
        cheaper: null,
        unitCost: null,
        savings: 0,
    };

    if (!keyHrid) return empty;

    const buyPrice = buyPriceFor(keyHrid, mode);

    let craft = null;
    try {
        craft = describeCraft(keyHrid, { mode, memo: options.memo, actionStats: options.actionStats });
    } catch (error) {
        console.error(`[KeyCost] Could not cost the recipe for ${keyHrid}:`, error);
    }

    // `describeCraft` already rejects a recipe whose materials cannot be priced,
    // so anything finite here is a cost somebody could actually pay.
    const craftCost = Number.isFinite(craft?.unitCost) && craft.unitCost > 0 ? craft.unitCost : null;
    const craftSeconds = Number.isFinite(craft?.secondsPerUnit) ? craft.secondsPerUnit : null;

    if (buyPrice === null && craftCost === null) return empty;

    // A tie goes to buying: the two cost the same gold and only one of them
    // also costs the player an afternoon.
    let cheaper;
    if (craftCost === null) cheaper = 'buy';
    else if (buyPrice === null) cheaper = 'craft';
    else cheaper = craftCost < buyPrice ? 'craft' : 'buy';

    const unitCost = cheaper === 'craft' ? craftCost : buyPrice;
    const savings = buyPrice !== null && craftCost !== null ? Math.abs(buyPrice - craftCost) : 0;

    return {
        itemHrid: keyHrid,
        itemName,
        pricingMode: mode,
        buyPrice,
        craftCost,
        craftSeconds,
        craftActionHrid: craft?.actionHrid ?? null,
        cheaper,
        unitCost,
        savings,
    };
}

/**
 * Cost several keys in one pass.
 *
 * The caches are shared across the keys because dungeon key recipes overlap —
 * costing four keys separately re-derives the same materials four times.
 *
 * @param {Array<string>} keyHrids - Key item HRIDs
 * @param {Object} [options] - Same options as `describeKeyCost`, minus the caches
 * @returns {Map<string, Object>} keyHrid → `describeKeyCost` result
 */
export function describeKeyCosts(keyHrids, options = {}) {
    const memo = options.memo ?? new Map();
    const actionStats = options.actionStats ?? new Map();
    const results = new Map();

    for (const keyHrid of keyHrids || []) {
        if (!keyHrid || results.has(keyHrid)) continue;
        results.set(keyHrid, describeKeyCost(keyHrid, { ...options, memo, actionStats }));
    }

    return results;
}

/**
 * One line saying what the key cost and why.
 *
 * Written for a breakdown row that has already shown the price being used, so
 * this is the justification rather than the figure: both sides, the time the
 * craft takes, and which one the number above it came from.
 *
 * @param {Object} cost - From `describeKeyCost`
 * @param {Object} [options] - Formatting options
 * @param {Function} [options.formatNumber] - Gold formatter, defaults to `coinFormatter`
 * @param {Function} [options.formatSeconds] - Time formatter, defaults to `timeReadable`
 * @returns {string} Empty when there is nothing worth saying
 */
export function formatKeyCostNote(cost, options = {}) {
    if (!cost || cost.unitCost === null || cost.unitCost === undefined) return '';

    const money = options.formatNumber || ((value) => coinFormatter(Math.round(value)));
    const time = options.formatSeconds || ((seconds) => timeReadable(Math.round(seconds)));

    const craftPart =
        cost.craftCost !== null && cost.craftCost !== undefined
            ? `craft ${money(cost.craftCost)}${cost.craftSeconds ? ` (${time(cost.craftSeconds)})` : ''}`
            : null;
    const buyPart = cost.buyPrice !== null && cost.buyPrice !== undefined ? `buy ${money(cost.buyPrice)}` : null;

    if (craftPart && buyPart) {
        const saved = cost.savings > 0 ? `, saves ${money(cost.savings)} ea` : '';
        return `${craftPart} ea vs ${buyPart} — using ${cost.cheaper === 'craft' ? 'crafted' : 'bought'}${saved}`;
    }
    if (craftPart) return `${craftPart} ea — not on the market, using crafted`;
    return `${buyPart} ea — no recipe, using bought`;
}

export default { KEY_PRICING_SETTING, getKeyPricingMode, describeKeyCost, describeKeyCosts, formatKeyCostNote };
