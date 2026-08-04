/**
 * Guild credit pricing
 *
 * Guild credits are never listed on the marketplace, so "what did this shrine
 * level cost" has no direct answer. It has an indirect one: credits are obtained
 * by handing in ordinary tradeable items at published conversion rates, so the
 * gold value of a credit is the price of the cheapest item that yields one.
 *
 * That is the same reasoning the guild credit exchange table uses, kept here so
 * the upgrade advisor and the build score agree with the exchange table and with
 * each other rather than each inventing a rate.
 *
 * Guild *tokens* are deliberately not priced. Nothing converts into them, so any
 * gold figure would be invented; callers show the token count separately.
 */

import dataManager from '../core/data-manager.js';
import { getItemPrice } from './market-data.js';

/**
 * Cheapest gold cost of one credit of each type, by conversion.
 * @param {string} [mode='ask'] - Pricing side: 'ask' to buy the items in, 'bid' to value what you hand over
 * @returns {Object} creditItemHrid → gold per credit
 */
export function buildGoldPerCredit(mode = 'ask') {
    const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};
    const cheapest = {};

    for (const [hrid, item] of Object.entries(itemDetailMap)) {
        for (const conversion of item.guildCreditConversions || []) {
            const price = getItemPrice(hrid, { mode });
            if (!(price > 0) || !(conversion.creditCount > 0)) continue;
            const perCredit = (price * conversion.itemCount) / conversion.creditCount;
            const creditHrid = conversion.creditItemHrid;
            if (!cheapest[creditHrid] || perCredit < cheapest[creditHrid]) cheapest[creditHrid] = perCredit;
        }
    }

    return cheapest;
}

/**
 * Price a list of credit costs in gold.
 *
 * A credit item with a market listing of its own is taken at that price; every
 * other one falls back to the cheapest conversion. An item with neither is
 * reported rather than counted as free — a total that quietly drops a line is
 * worse than no total.
 *
 * @param {Array<{itemHrid: string, count: number}>} creditCosts - Costs to price
 * @param {Object} [options]
 * @param {string} [options.mode='ask'] - Pricing side
 * @param {Object} [options.goldPerCredit] - Prebuilt rate map, to avoid rebuilding it per call
 * @returns {{lines: Array<Object>, total: number|null, unpriced: Array<string>}}
 */
export function priceGuildCreditCosts(creditCosts, { mode = 'ask', goldPerCredit = null } = {}) {
    const rates = goldPerCredit || buildGoldPerCredit(mode);
    const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap || {};

    const lines = [];
    const unpriced = [];
    let total = 0;

    for (const { itemHrid, count } of creditCosts || []) {
        if (!itemHrid || !(count > 0)) continue;
        const name = itemDetailMap[itemHrid]?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        const direct = getItemPrice(itemHrid, { mode });
        const each = direct > 0 ? direct : rates[itemHrid] || null;

        lines.push({ itemHrid, name, count, goldEach: each, gold: each === null ? null : each * count });
        if (each === null) unpriced.push(name);
        else total += each * count;
    }

    return { lines, total: unpriced.length > 0 ? null : total, unpriced };
}
