/**
 * Trade ledger arithmetic — fills from listing diffs, and realized profit from fills.
 *
 * The wire never says "you just sold 40 for 3,920 coins". What it says, via
 * `market_listings_updated`, is the new state of a listing: `filledQuantity`
 * went from 60 to 100. This module owns both halves of turning that into a
 * ledger: diffing successive listing states into fill records, and aggregating
 * those records into per-item and per-week realized profit.
 *
 * Honesty rules, enforced here rather than in the UI:
 * - A fill is only ever a *delta from an observed baseline*. The first sighting
 *   of a listing establishes state; a listing first seen at 60/100 filled
 *   contributes nothing until it moves.
 * - Sell proceeds are always net of the 5% market tax.
 * - Realized profit uses average-cost matching, and only against buys this
 *   ledger recorded. Sells with no recorded cost stay revenue, never profit.
 */

import { MARKET_TAX } from './profit-constants.js';

/**
 * How many fill records are kept per character, oldest-out.
 *
 * Generous on purpose: a record is ~100 bytes, so this is a couple of MB at
 * worst, and an active flipper produces tens of fills a day, not thousands —
 * this is years of history before anything is evicted.
 */
export const LEDGER_RECORD_CAP = 20000;

/** Listing status HRIDs after which a listing can never fill again. */
const TERMINAL_STATUSES = new Set([
    '/market_listing_status/cancelled',
    '/market_listing_status/expired',
    '/market_listing_status/filled',
]);

/**
 * Coins a fill moved, from the taker's side of the tax.
 *
 * Buys spend the full `quantity × price` (the game taxes the seller, not the
 * buyer); sells receive `quantity × price` minus the 5% market tax, rounded to
 * whole coins the way every other net-of-tax figure in this codebase is.
 *
 * @param {boolean} isSell - Which side of the trade this fill is
 * @param {number} quantity - Units filled
 * @param {number} price - Coins per unit on the listing
 * @returns {number} Coins received (sell, after tax) or spent (buy)
 */
export function fillCoins(isSell, quantity, price) {
    const gross = quantity * price;
    return isSell ? Math.round(gross * (1 - MARKET_TAX)) : gross;
}

/**
 * Whether a wire listing carries everything a diff needs.
 * @param {Object} listing - Listing object from `market_listings_updated`
 * @returns {boolean} True when it can be diffed
 */
function isDiffableListing(listing) {
    return Boolean(
        listing &&
        typeof listing.id === 'number' &&
        typeof listing.itemHrid === 'string' &&
        typeof listing.filledQuantity === 'number' &&
        typeof listing.price === 'number'
    );
}

/**
 * Diff a batch of wire listings against the previously observed states,
 * producing fill records and the next state map.
 *
 * The rule, verified against what the game actually sends: one listing object
 * per changed listing, with `filledQuantity` cumulative for the listing's
 * lifetime. So a fill is `filledQuantity - previouslyObserved.filledQuantity`
 * when positive; partial fills are just smaller deltas. A listing with no
 * previous state only establishes a baseline — even if it arrives already
 * partially filled, that history predates the ledger and is not invented.
 *
 * Listings whose status is terminal (cancelled / expired / filled) are diffed
 * one last time — a cancel after a partial fill still reports the fill — and
 * then dropped from the state map, which is what keeps it bounded by the
 * number of concurrently open listings.
 *
 * @param {Object<string, Object>} prevStates - Listing id → last observed
 *   `{filledQuantity, itemHrid, enhancementLevel, price, isSell}` (JSON-safe)
 * @param {Array<Object>} listings - Listing objects from the wire
 * @param {Object} [options] - Diff options
 * @param {number} [options.now] - Timestamp stamped on fills (injectable for tests)
 * @param {boolean} [options.snapshot] - Treat `listings` as the complete set of
 *   open listings: state entries absent from it ended while we were not looking,
 *   and their final fills are unknowable — dropped without inventing anything
 * @returns {{fills: Array<Object>, states: Object<string, Object>, changed: boolean}}
 *   Fill records `{t, itemHrid, enhancementLevel, side, quantity, price, coins,
 *   listingId}`, the next state map, and whether the state map differs from `prevStates`
 */
export function detectFills(prevStates, listings, options = {}) {
    const { now = Date.now(), snapshot = false } = options;
    const states = { ...(prevStates || {}) };
    const fills = [];
    let changed = false;

    const seenIds = new Set();

    for (const listing of Array.isArray(listings) ? listings : []) {
        if (!isDiffableListing(listing)) {
            continue;
        }

        const key = String(listing.id);
        seenIds.add(key);
        const prev = states[key];

        if (prev && listing.filledQuantity > prev.filledQuantity) {
            const quantity = listing.filledQuantity - prev.filledQuantity;
            const isSell = Boolean(listing.isSell);
            fills.push({
                t: now,
                itemHrid: listing.itemHrid,
                enhancementLevel: listing.enhancementLevel || 0,
                side: isSell ? 'sell' : 'buy',
                quantity,
                price: listing.price,
                coins: fillCoins(isSell, quantity, listing.price),
                listingId: listing.id,
            });
        }

        if (TERMINAL_STATUSES.has(listing.status)) {
            if (prev) {
                delete states[key];
                changed = true;
            }
        } else if (!prev || prev.filledQuantity !== listing.filledQuantity) {
            states[key] = {
                filledQuantity: listing.filledQuantity,
                itemHrid: listing.itemHrid,
                enhancementLevel: listing.enhancementLevel || 0,
                price: listing.price,
                isSell: Boolean(listing.isSell),
            };
            changed = true;
        }
    }

    if (snapshot) {
        for (const key of Object.keys(states)) {
            if (!seenIds.has(key)) {
                delete states[key];
                changed = true;
            }
        }
    }

    return { fills, states, changed };
}

/**
 * Keep the ledger under its cap, oldest-out.
 *
 * Records arrive in time order, so this is normally a cheap slice; the sort is
 * insurance against an imported or hand-edited store.
 *
 * @param {Array<Object>} records - Fill records
 * @param {number} [cap] - Maximum records to keep
 * @returns {Array<Object>} At most `cap` records, oldest dropped first
 */
export function trimLedger(records, cap = LEDGER_RECORD_CAP) {
    const safe = Array.isArray(records) ? [...records] : [];
    if (safe.length <= cap) {
        return safe;
    }
    safe.sort((a, b) => a.t - b.t);
    return safe.slice(safe.length - cap);
}

/**
 * Start of the local week (Monday 00:00) containing `t`.
 * @param {number} t - Timestamp in milliseconds
 * @returns {number} Timestamp of that week's Monday midnight, local time
 */
export function weekStartOf(t) {
    const date = new Date(t);
    date.setHours(0, 0, 0, 0);
    const daysSinceMonday = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday);
    return date.getTime();
}

/**
 * Aggregate fill records into per-item and per-week realized figures.
 *
 * Average-cost matching, chronological per item+enhancement: buys grow a pool
 * of quantity and cost; each sell is matched against the pool's current average
 * cost for up to the pooled quantity. The matched slice realizes
 * `netProceeds − averageCost × matched`; any unmatched remainder — the item was
 * never bought through this ledger — is reported as `unmatchedRevenue` and
 * never as profit, because calling untracked cost zero would fake a 100% margin.
 *
 * @param {Array<Object>} records - Fill records from {@link detectFills}
 * @returns {{
 *   items: Array<Object>,
 *   weeks: Array<Object>,
 *   totals: {boughtCoins: number, soldCoinsNet: number, realizedProfit: number, unmatchedRevenue: number}
 * }} `items` sorted by most recent activity; `weeks` sorted most recent first.
 *   Per item: `{itemHrid, enhancementLevel, boughtQty, boughtCoins, avgBuyPrice,
 *   soldQty, soldCoinsNet, avgSellNet, matchedQty, realizedProfit, unmatchedRevenue,
 *   lastActivity}` — `avgBuyPrice`/`avgSellNet` null with no fills on that side,
 *   `realizedProfit` null when no sell was ever matched against a recorded buy.
 *   Per week: `{weekStart, boughtQty, boughtCoins, soldQty, soldCoinsNet,
 *   matchedSellQty, realizedProfit, unmatchedRevenue}` with the same null rule.
 */
export function aggregateLedger(records) {
    const sorted = (Array.isArray(records) ? records.filter((record) => record && record.itemHrid) : []).sort(
        (a, b) => a.t - b.t
    );

    const items = new Map(); // itemHrid:enhancementLevel -> aggregate + cost pool
    const weeks = new Map(); // weekStart -> aggregate

    const itemFor = (record) => {
        const key = `${record.itemHrid}:${record.enhancementLevel || 0}`;
        let item = items.get(key);
        if (!item) {
            item = {
                itemHrid: record.itemHrid,
                enhancementLevel: record.enhancementLevel || 0,
                boughtQty: 0,
                boughtCoins: 0,
                soldQty: 0,
                soldCoinsNet: 0,
                matchedQty: 0,
                realizedProfit: 0,
                unmatchedRevenue: 0,
                lastActivity: 0,
                _poolQty: 0,
                _poolCost: 0,
            };
            items.set(key, item);
        }
        return item;
    };

    const weekFor = (record) => {
        const weekStart = weekStartOf(record.t);
        let week = weeks.get(weekStart);
        if (!week) {
            week = {
                weekStart,
                boughtQty: 0,
                boughtCoins: 0,
                soldQty: 0,
                soldCoinsNet: 0,
                matchedSellQty: 0,
                realizedProfit: 0,
                unmatchedRevenue: 0,
            };
            weeks.set(weekStart, week);
        }
        return week;
    };

    for (const record of sorted) {
        const item = itemFor(record);
        const week = weekFor(record);
        const quantity = record.quantity || 0;
        const coins = record.coins || 0;
        item.lastActivity = Math.max(item.lastActivity, record.t);

        if (record.side === 'buy') {
            item.boughtQty += quantity;
            item.boughtCoins += coins;
            item._poolQty += quantity;
            item._poolCost += coins;
            week.boughtQty += quantity;
            week.boughtCoins += coins;
        } else if (record.side === 'sell') {
            item.soldQty += quantity;
            item.soldCoinsNet += coins;
            week.soldQty += quantity;
            week.soldCoinsNet += coins;

            const matched = Math.min(quantity, item._poolQty);
            if (matched > 0) {
                const avgCost = item._poolCost / item._poolQty;
                const costOut = avgCost * matched;
                const matchedProceeds = coins * (matched / quantity);
                const realized = matchedProceeds - costOut;
                item._poolQty -= matched;
                item._poolCost -= costOut;
                item.matchedQty += matched;
                item.realizedProfit += realized;
                week.matchedSellQty += matched;
                week.realizedProfit += realized;
            }
            const unmatchedRevenue = coins * ((quantity - matched) / quantity);
            item.unmatchedRevenue += unmatchedRevenue;
            week.unmatchedRevenue += unmatchedRevenue;
        }
    }

    const totals = { boughtCoins: 0, soldCoinsNet: 0, realizedProfit: 0, unmatchedRevenue: 0 };

    const itemRows = [...items.values()].map((item) => {
        totals.boughtCoins += item.boughtCoins;
        totals.soldCoinsNet += item.soldCoinsNet;
        totals.realizedProfit += item.matchedQty > 0 ? item.realizedProfit : 0;
        totals.unmatchedRevenue += item.unmatchedRevenue;
        return {
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel,
            boughtQty: item.boughtQty,
            boughtCoins: item.boughtCoins,
            avgBuyPrice: item.boughtQty > 0 ? item.boughtCoins / item.boughtQty : null,
            soldQty: item.soldQty,
            soldCoinsNet: item.soldCoinsNet,
            avgSellNet: item.soldQty > 0 ? item.soldCoinsNet / item.soldQty : null,
            matchedQty: item.matchedQty,
            realizedProfit: item.matchedQty > 0 ? item.realizedProfit : null,
            unmatchedRevenue: item.unmatchedRevenue,
            lastActivity: item.lastActivity,
        };
    });
    itemRows.sort((a, b) => b.lastActivity - a.lastActivity);

    const weekRows = [...weeks.values()].map((week) => ({
        ...week,
        realizedProfit: week.matchedSellQty > 0 ? week.realizedProfit : null,
    }));
    weekRows.sort((a, b) => b.weekStart - a.weekStart);

    return { items: itemRows, weeks: weekRows, totals };
}
