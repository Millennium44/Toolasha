/**
 * Shop-derived valuation for alchemy outputs the marketplace itself will
 * never price.
 *
 * Decomposing scrolls yields Labyrinth Tokens — untradeable, so
 * `getItemPrice` returns nothing for them and every such result used to price
 * at 0, turning a real return into a recorded pure loss ("Labyrinth Token
 * x90 = 0 (0 each)"). The token still has a value: the best conversion its own
 * Labyrinth Shop offers, the same figure the item's tooltip already shows as
 * "Labyrinth Shop Value" (see `features/inventory/dungeon-token-tooltips.js`).
 * This reuses the same primitive — `labyrinthTokenValueDetail` — as the price
 * source for the alchemy history viewers and the live alchemy profit calculator.
 *
 * Lives in utils because the calculator (market bundle) and the history
 * viewers (a later bundle) both read it.
 *
 * It never writes back to a session or a tracker: a
 * session recorded before this existed, or read straight from storage, still
 * carries `totalValue: 0` and `unpriced: true` for a Labyrinth Token result —
 * this function is called at render time to decide what to show instead, and
 * the caller is the one that has to mark the figure as shop-derived rather
 * than a market price, the same way an unpriced figure is marked, not shown
 * as a silent number.
 */

import dataManager from '../core/data-manager.js';
import { getItemPrice } from './market-data.js';
import { labyrinthTokenValueDetail } from './token-valuation.js';

/** The only alchemy output this currently covers. */
const LABYRINTH_TOKEN_HRID = '/items/labyrinth_token';

/**
 * A shop-derived value for one unit of an alchemy output the market cannot
 * price, or null when this output has no such fallback (most items — this is
 * deliberately narrow) or the shop itself has nothing priced either.
 *
 * @param {string} itemHrid - The result item
 * @returns {{valuePerUnit: number, sourceItemHrid: string, sourceItemName: string}|null}
 */
export function getAlchemyOutputShopValue(itemHrid) {
    if (itemHrid !== LABYRINTH_TOKEN_HRID) return null;

    const gameData = dataManager.getInitClientData();
    const shopMap = gameData?.labyrinthShopItemDetailMap;
    if (!shopMap) return null;

    const priceOf = (hrid) => getItemPrice(hrid, { context: 'profit', side: 'sell' });
    const best = labyrinthTokenValueDetail(shopMap, priceOf);
    if (!best || !(best.value > 0)) return null;

    const sourceItemDetails = gameData.itemDetailMap?.[best.itemHrid];
    return {
        valuePerUnit: best.value,
        sourceItemHrid: best.itemHrid,
        sourceItemName: sourceItemDetails?.name || best.itemHrid.split('/').pop().replace(/_/g, ' '),
    };
}

/**
 * The tooltip line explaining a shop-derived figure, so the marker on screen
 * is never unexplained.
 *
 * @param {{valuePerUnit: number, sourceItemName: string}} shopValue - From {@link getAlchemyOutputShopValue}
 * @param {(n: number) => string} formatValue - A formatter, e.g. `formatKMB`
 * @returns {string}
 */
export function describeShopValue(shopValue, formatValue) {
    return (
        `Not sold on the market — valued at the best Labyrinth Shop conversion: ` +
        `${formatValue(shopValue.valuePerUnit)} gold/token via ${shopValue.sourceItemName}.`
    );
}
