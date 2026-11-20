/**
 * Talisman orb crafting cost
 *
 * What one talisman orb costs to craft from its recipe, so an orb with no market listing can still carry a coin
 * price. Inputs are priced at their buy-side market quote (as the orbs are) and the artisan tea reduction is applied the way
 * refined-item-cost.js does. Essence and rare-crate drops and crafting time are ignored.
 *
 * Never a partial sum: an input with no price (or only an estimate) means the orb has no recipe price.
 */

import dataManager from '../core/data-manager.js';
import { calculateArtisanBonus } from './material-calculator.js';
import { getItemPriceInfo } from './market-data.js';

/** Cached output-hrid → actions map, rebuilt when game data changes */
let actionsByOutput = null;
let actionsSource = null;

/**
 * Every action that outputs an item, from game data (scanned once per game-data load).
 * @param {string} itemHrid
 * @returns {Object[]}
 */
export function findActionsOutputting(itemHrid) {
    const actions = dataManager.getInitClientData()?.actionDetailMap || null;
    if (!actions) return [];
    if (actionsByOutput === null || actionsSource !== actions) {
        actionsByOutput = new Map();
        actionsSource = actions;
        for (const action of Object.values(actions)) {
            for (const output of action.outputItems || []) {
                if (!actionsByOutput.has(output.itemHrid)) actionsByOutput.set(output.itemHrid, []);
                actionsByOutput.get(output.itemHrid).push(action);
            }
        }
    }
    return actionsByOutput.get(itemHrid) || [];
}

/**
 * A recipe input's buy-side market price, read the same way `orbWeights` reads the orbs (`marketQuote: true`,
 * only a live listing or the player's own override), so crafted orbs and market orbs share one scale. A vendor,
 * coinify or other liquidation value (an Iron Cow's valuation) and any estimate are not market prices.
 * @param {string} hrid
 * @param {Function} [priceInfo] - getItemPriceInfo-shaped; injectable for tests
 * @returns {number|null}
 */
export function marketInputPrice(hrid, priceInfo = getItemPriceInfo) {
    let quote = null;
    try {
        quote = priceInfo(hrid, { context: 'profit', side: 'buy', marketQuote: true });
    } catch (error) {
        console.error('[TalismanOrbRecipeCost] Pricing a recipe input failed:', error);
    }
    if (!quote || (quote.source !== 'book' && quote.source !== 'custom')) return null;
    return quote.price > 0 ? quote.price : null;
}

/**
 * Coins to craft one orb, or null when it has no recipe or any input is unpriced.
 * @param {string} orbHrid
 * @param {Object} [options]
 * @param {Set<string>} [options.orbHrids] - Every talisman orb; an input that is itself an orb is priced by its
 *   market price only (`priceOrb`), never by its own recipe (no recursion)
 * @param {Function} [options.priceInput] - (hrid) => number|null, buy-side unit price
 * @param {Function} [options.priceOrb] - (hrid) => number|null, market price of an orb
 * @param {Function} [options.artisanBonus] - (action) => 0..1
 * @returns {number|null}
 */
export function orbRecipeCost(orbHrid, options = {}) {
    const {
        orbHrids = new Set(),
        priceInput = marketInputPrice,
        priceOrb = () => null,
        artisanBonus = calculateArtisanBonus,
    } = options;
    let best = null;
    for (const action of findActionsOutputting(orbHrid)) {
        const outputCount = (action.outputItems || []).find((o) => o.itemHrid === orbHrid)?.count || 0;
        if (!(outputCount > 0)) continue;
        const bonus = Number(artisanBonus(action)) || 0;
        let cost = 0;
        let complete = (action.inputItems || []).length > 0;
        for (const input of action.inputItems || []) {
            const count = input.count || 0;
            if (input.itemHrid === '/items/coin') {
                cost += count * (1 - bonus);
                continue;
            }
            const price = orbHrids.has(input.itemHrid) ? priceOrb(input.itemHrid) : priceInput(input.itemHrid);
            if (!(price > 0)) {
                complete = false;
                break;
            }
            cost += price * count * (1 - bonus);
        }
        if (complete && action.upgradeItemHrid) {
            const base = orbHrids.has(action.upgradeItemHrid)
                ? priceOrb(action.upgradeItemHrid)
                : priceInput(action.upgradeItemHrid);
            if (base > 0) cost += base;
            else complete = false;
        }
        if (!complete || !(cost > 0)) continue;
        const perOrb = cost / outputCount;
        if (best === null || perOrb < best) best = perOrb;
    }
    return best;
}
