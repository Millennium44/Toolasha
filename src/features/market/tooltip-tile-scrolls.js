/**
 * The item tooltip's craft profit follows the skill page's action tiles: when the tiles would assume
 * simulated scrolls for the action that makes an item, the tooltip's figures assume the same ones, so a tile
 * and the tooltip of the item it makes never disagree about whether the craft pays.
 *
 * It reuses the tiles' own gate and arming (`getTileScrolls` / `runWithTileScrolls`); nothing here decides
 * which scrolls apply.
 */

import dataManager from '../../core/data-manager.js';
import { getTileScrolls, runWithTileScrolls, runWithoutScrolls } from '../actions/tile-scrolls.js';
import profitCalculator from './profit-calculator.js';

/**
 * The recipe the tooltip costs for an item, with its action type.
 * @param {string} itemHrid
 * @returns {{actionHrid: string, actionType: string}|null}
 */
function producingAction(itemHrid) {
    const found = itemHrid ? profitCalculator.findProductionAction?.(itemHrid) : null;
    if (!found?.actionHrid) return null;
    const actionType = dataManager.getActionDetails?.(found.actionHrid)?.type;
    return actionType ? { actionHrid: found.actionHrid, actionType } : null;
}

/**
 * A key for the scrolls the tooltip of an item would assume right now: part of the tooltip's "already
 * drawn" check, so a tooltip drawn before the toggle or the chosen scrolls changed is drawn again.
 * @param {string|null|undefined} itemHrid
 * @returns {string} Empty when no scroll would be assumed
 */
export function tooltipScrollSignature(itemHrid) {
    const producing = producingAction(itemHrid);
    if (!producing) return '';
    return [...getTileScrolls(producing.actionType)].sort().join(',');
}

/**
 * Craft profit for an item's tooltip, with the tiles' scrolls applied when they apply to its action.
 * @param {string} itemHrid
 * @returns {Promise<{profitData: Object|null, realProfitData: Object|null, simulated: string[]}>}
 *   `profitData` is what the tooltip shows; `realProfitData` is the same craft with no scroll assumed (the
 *   same object when nothing is simulated) for readers that value a real bench, such as self-use alchemy;
 *   `simulated` is the short names of the scrolls assumed (empty: the figures are the real ones)
 */
export async function calculateTooltipCraftProfit(itemHrid) {
    const options = { keepSellTax: true };
    const producing = producingAction(itemHrid);
    if (!producing || getTileScrolls(producing.actionType).size === 0) {
        const profitData = await profitCalculator.calculateProfit(itemHrid, options);
        return { profitData, realProfitData: profitData, simulated: [] };
    }
    // The recipe is named outside the armed span, so the tile's action and the tooltip's cannot differ
    const named = { ...options, actionHrid: producing.actionHrid };
    const { result, simulated } = runWithTileScrolls(producing.actionType, () =>
        profitCalculator.calculateProfit(itemHrid, named)
    );
    const profitData = await result;
    if (simulated.length === 0) return { profitData, realProfitData: profitData, simulated };
    const realProfitData = await runWithoutScrolls(producing.actionType, () =>
        profitCalculator.calculateProfit(itemHrid, named)
    );
    return { profitData, realProfitData, simulated };
}
