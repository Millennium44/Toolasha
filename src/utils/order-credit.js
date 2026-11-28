/**
 * Order credit
 *
 * A shopping list or a bill that is opened while buy orders are still resting nets those orders off
 * its count (`onOrder`): the units are on their way, so they are not bought again. Everything the
 * list later counts as "bought" must then leave those orders' own deliveries out, or they come off
 * twice. Two readers solved this badly:
 *
 * - the shopping list put `onOrder` into its baseline, so a real purchase made while an order was
 *   open was absorbed until that order filled (over-buying), and a cancelled order was never added
 *   back (under-buying);
 * - the craft bill sent required = wanted - open orders and then recounted held stock live, so the
 *   order's fills were subtracted a second time when they landed (under-buying: 1,000 wanted with
 *   400 on order read 600 missing, then 200 once the order filled).
 *
 * ## The rule
 *
 * At open, snapshot the open buy orders the caller netted: `{id, r0, filled0}` with
 * `r0 = orderQuantity - filledQuantity`. Afterwards, per credited order, read the live listing:
 *
 * - **Still open** (present, active, a remainder left): its own fills since open, `min(r0,
 *   filledNow - filled0)`, are in the held stock but are not purchases. They are returned as
 *   `openFilled`, for the reader to take off what it counts as bought.
 * - **Ended** (filled, cancelled, expired, or gone from the listings): the credit dissolves. Whatever
 *   it delivered is in the held stock (inventory, or unclaimed on a filled listing), and whatever it
 *   did not deliver is a shortfall again, so `r0` is added back to the count. The order's own fill
 *   count is not needed for this: held stock already carries it, so a listing the game drops on
 *   cancel or collect (it does) needs no remembered `filledQuantity`.
 *
 * The count is then `count + addBack - (bought - openFilled)` for a list, and the line's required
 * total is `required + addBack` against `held - openFilled` for a bill.
 *
 * ## Why it cannot under-buy
 *
 * Every way this can be wrong is an over-estimate of the shortfall: an order missing from the listings
 * (not yet synced, a character switch) reads as ended, which adds the whole `r0` back while its units
 * may still arrive; `openFilled` is read from the same listings that feed the unclaimed count, so it
 * never runs ahead of the stock it is taken off. A snapshot holding more than the caller netted
 * credits the larger set, which only over-buys; one holding less (an order filled or cancelled
 * between the caller's figures and the open) adds the gap back as `unbacked`.
 *
 * Plain data in, plain data out: a credit is a snapshot with no functions, so it survives
 * `structuredClone`.
 */

import dataManager from '../core/data-manager.js';

const ACTIVE = '/market_listing_status/active';

/**
 * @typedef {Object} OrderCredit
 * @property {string} itemHrid - The item
 * @property {Array<{id: *, r0: number, filled0: number}>} orders - Open buy orders at the open
 * @property {number} unbacked - Units the caller netted that no open order backed at the open
 */

/**
 * The remainder of an open buy order, by the same rule as `ownBuyOrders`: a buy listing for the
 * unenhanced item, active, with units still to fill.
 * @param {Object} listing - A `getMarketListings()` row
 * @param {string} itemHrid - The item
 * @returns {number} Units still to fill, 0 when the listing is not an open buy order for the item
 */
function openRemainder(listing, itemHrid) {
    if (!listing || listing.isSell || listing.itemHrid !== itemHrid) return 0;
    if (Number(listing.enhancementLevel) > 0) return 0;
    if (listing.status !== ACTIVE) return 0;
    const remaining = Math.floor(Number(listing.orderQuantity) - Number(listing.filledQuantity || 0));
    return remaining > 0 ? remaining : 0;
}

/**
 * Snapshot the open buy orders behind a line's `onOrder`.
 * @param {string} itemHrid - The item
 * @param {number} onOrder - Open-order units the caller netted off the count
 * @param {Array<Object>} [listings] - `getMarketListings()` rows; read from the data manager when omitted
 * @returns {OrderCredit|null} Null when nothing was netted
 */
export function snapshotOrderCredit(itemHrid, onOrder, listings = dataManager.getMarketListings?.()) {
    const netted = Math.max(0, Math.floor(Number(onOrder) || 0));
    if (!itemHrid || netted <= 0) return null;
    const orders = [];
    const seen = new Set();
    for (const listing of listings || []) {
        const r0 = openRemainder(listing, itemHrid);
        if (!r0 || seen.has(listing.id)) continue;
        seen.add(listing.id);
        orders.push({ id: listing.id, r0, filled0: Math.max(0, Math.floor(Number(listing.filledQuantity) || 0)) });
    }
    const backed = orders.reduce((sum, order) => sum + order.r0, 0);
    return { itemHrid, orders, unbacked: Math.max(0, netted - backed) };
}

/**
 * What a credit means now.
 * @param {OrderCredit|null|undefined} credit - From `snapshotOrderCredit`
 * @param {Array<Object>} [listings] - `getMarketListings()` rows; read from the data manager when omitted
 * @returns {{openFilled: number, addBack: number}} `openFilled`: units delivered by orders still open,
 *   which are in the held stock but are not purchases. `addBack`: units credited that no open order will
 *   deliver any more (ended orders' `r0`, plus the unbacked gap), to be bought or counted as held.
 */
export function orderCreditState(credit, listings = dataManager.getMarketListings?.()) {
    if (!credit?.orders) return { openFilled: 0, addBack: 0 };
    let openFilled = 0;
    let addBack = Math.max(0, Math.floor(Number(credit.unbacked) || 0));
    for (const order of credit.orders) {
        // The highest fill among rows sharing an id: a higher fill only ever raises the shortfall
        let row = null;
        for (const listing of listings || []) {
            if (!listing || listing.id !== order.id || !openRemainder(listing, credit.itemHrid)) continue;
            if (!row || Number(listing.filledQuantity) > Number(row.filledQuantity)) row = listing;
        }
        if (!row) {
            addBack += order.r0;
            continue;
        }
        const filled = Math.floor(Number(row.filledQuantity) || 0) - order.filled0;
        openFilled += Math.min(order.r0, Math.max(0, filled));
    }
    return { openFilled, addBack };
}
