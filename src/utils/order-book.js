/**
 * Order book reading
 *
 * How deep a price level is, and how long an order placed there would wait.
 *
 * The game sends an order book with each listing's creation timestamp, and those
 * timestamps are the only rate signal available anywhere: twenty listings at one
 * price spanning ten minutes is a level that churns, and twenty spanning a week
 * is a level where an order is a week-long proposition.
 *
 * ## The assumption, stated
 *
 * Fill time is estimated as **depth ahead ÷ the rate at which depth arrived**.
 * That is the steady-state assumption — that a price level drains about as fast
 * as it fills — which holds in a liquid market and fails in a moving one. It is
 * the honest reading of what the data can support: the book says how fast orders
 * *arrive*, and nothing directly says how fast they are *taken*.
 *
 * The queue extrapolation is Ranged Way Idle's, by way of the queue length
 * estimator this shares its arithmetic with.
 */

/** The book only ever sends this many listings per side */
const VISIBLE_LISTINGS = 20;

/**
 * The best price on one side of the book.
 *
 * Listings arrive best-first, so this is simply the head — but reading it
 * through a function keeps the assumption in one place rather than in every
 * caller that indexes `[0]`.
 *
 * @param {Array<Object>} listings - One side of the book
 * @returns {number|null} The price, or null when the side is empty
 */
export function bestPrice(listings) {
    const price = listings?.[0]?.price;
    return price > 0 ? price : null;
}

/**
 * How much sits at a price, extrapolating past the twenty the game shows.
 *
 * When all twenty visible listings share the best price, the level is deeper
 * than the window and the timestamps are used to guess by how much — the same
 * extrapolation the queue length display makes, so the two never disagree.
 *
 * @param {Array<Object>} listings - One side of the book
 * @param {number} price - The price level to measure
 * @returns {{quantity: number, estimated: boolean, spanMs: number}} Depth at that price
 */
export function queueAt(listings, price) {
    const rows = listings || [];

    let quantity = 0;
    for (const listing of rows) {
        if (listing?.price === price) quantity += listing.quantity || 0;
    }

    // Fewer than a full window means the level is fully visible, and the count
    // is a fact rather than an estimate
    if (rows.length < VISIBLE_LISTINGS || rows[VISIBLE_LISTINGS - 1]?.price !== price) {
        return { quantity, estimated: false, spanMs: listingSpanMs(rows) };
    }

    const spanMs = listingSpanMs(rows);
    if (!(spanMs > 0)) return { quantity, estimated: false, spanMs };

    // Nothing has arrived since the newest listing when it arrived a moment ago,
    // which extrapolates to exactly the visible depth — a real answer, not an
    // inapplicable one, so it still counts as estimated
    const sinceLast = Math.max(0, Date.now() - new Date(rows[VISIBLE_LISTINGS - 1].createdTimestamp).getTime());

    // Ranged Way Idle's formula: the window covers a known stretch of time, and
    // the rest of the queue is assumed to have arrived at the same rate
    const multiplier = 1 + ((VISIBLE_LISTINGS - 1) / VISIBLE_LISTINGS) * (sinceLast / spanMs);
    return { quantity: quantity * multiplier, estimated: true, spanMs };
}

/**
 * How long the visible listings took to accumulate.
 * @param {Array<Object>} listings - One side of the book
 * @returns {number} Milliseconds, or 0 when it cannot be told
 */
function listingSpanMs(listings) {
    const rows = listings || [];
    if (rows.length < 2) return 0;

    const first = new Date(rows[0]?.createdTimestamp).getTime();
    const last = new Date(rows[rows.length - 1]?.createdTimestamp).getTime();
    const span = Math.abs(last - first);
    return Number.isFinite(span) ? span : 0;
}

/**
 * How long an order joining the back of a queue would wait.
 *
 * Depth ahead divided by the rate depth arrived at — see the note at the top of
 * this file for why that is the rate being used and what it assumes. Returns
 * null rather than a guess when the book gives nothing to measure, so a caller
 * can tell "slow" apart from "unknown".
 *
 * @param {Array<Object>} listings - The side the order would join
 * @param {number} count - How many the order is for
 * @returns {number|null} Seconds, or null when unmeasurable
 */
export function estimateFillSeconds(listings, count) {
    const price = bestPrice(listings);
    if (price === null) return null;

    const { quantity, spanMs } = queueAt(listings, price);
    if (!(spanMs > 0)) return null;

    // Quantity that arrived across the window, which is the rate's numerator.
    // The extrapolated total is what the order waits behind, not what arrived.
    let arrived = 0;
    for (const listing of listings) {
        if (listing?.price === price) arrived += listing.quantity || 0;
    }
    if (!(arrived > 0)) return null;

    const perSecond = arrived / (spanMs / 1000);
    // The order's own quantity counts: it is not filled until all of it is
    return (quantity + count) / perSecond;
}
