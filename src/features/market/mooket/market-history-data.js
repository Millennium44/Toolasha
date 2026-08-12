/**
 * Market History Data
 *
 * Turns the pooled history server's rows into the series a chart can draw.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * A row is one sighting of an item's market: the best ask (`a`), the best bid
 * (`b`), an average transacted price (`p`) and the volume traded (`v`). Two
 * things have to happen before that is drawable.
 *
 * **Long ranges are grouped by day.** Three months of raw sightings is tens of
 * thousands of points, and the shape is lost in the noise long before the
 * browser struggles. Grouping uses the median rather than the mean: a single
 * absurd ask — someone listing a 300-coin item at 40 million to see if anyone
 * bites — moves a mean for the whole day and moves a median not at all.
 *
 * **Volume is split between the two sides.** The server reports how much traded
 * and at what average price, not who crossed. Where in the spread that average
 * price landed says which side was doing the trading: at the ask, buyers were
 * lifting offers; at the bid, sellers were hitting bids; in between, both. It is
 * an estimate and labelled as one, but it is the difference between "this item
 * moved 4,000 units" and "buyers took 4,000 units off the shelf".
 *
 * Pure: rows in, series out. No DOM, no fetching.
 */

/** Ranges the chart offers, in days */
export const HISTORY_RANGES = [1, 3, 7, 14, 30, 90, 180];

/** Past this many days the rows are grouped into one point per day */
export const DAILY_GROUPING_THRESHOLD = 7;

/**
 * Middle value of the positive numbers in a list.
 *
 * Zero and negative mean "nothing was listed on that side", not "it was worth
 * nothing", so they are dropped rather than counted as low prices — averaging
 * them in would drag a day's ask toward zero every time the book emptied.
 *
 * @param {Array<number>} values - Values, in any order
 * @returns {number} Median of the positive values, or 0 when there are none
 */
export function median(values) {
    const positive = (values || []).filter((value) => value > 0).sort((a, b) => a - b);
    if (!positive.length) return 0;

    const middle = Math.floor(positive.length / 2);
    return positive.length % 2 ? positive[middle] : (positive[middle - 1] + positive[middle]) / 2;
}

/**
 * Split one row's volume between buyers lifting the ask and sellers hitting the
 * bid.
 *
 * Where the average transacted price sits in the spread is the only evidence
 * available. At or above the ask, everything traded was a buyer taking an offer;
 * at or below the bid, a seller taking a bid; in between, the split is linear in
 * how far up the spread the average landed.
 *
 * With only one side quoted there is nothing to interpolate against, so the
 * whole volume goes to the side that could have traded. With neither, it is
 * halved — an admission of ignorance rather than a measurement.
 *
 * @param {Object} row - { a, b, p, v }
 * @returns {{atAsk: number, atBid: number}}
 */
export function splitVolume(row) {
    const ask = row?.a > 0 ? row.a : 0;
    const bid = row?.b > 0 ? row.b : 0;
    const price = row?.p > 0 ? row.p : 0;
    const volume = Math.max(0, Number(row?.v) || 0);

    if (volume <= 0) return { atAsk: 0, atBid: 0 };

    if (ask > 0 && bid > 0 && ask > bid) {
        if (price >= ask) return { atAsk: volume, atBid: 0 };
        if (price <= bid) return { atAsk: 0, atBid: volume };
        const atAsk = (volume * (price - bid)) / (ask - bid);
        return { atAsk, atBid: volume - atAsk };
    }

    // Only a bid quoted means anything that traded was sold into it, and vice
    // versa. The naming is from the taker's side throughout.
    if (bid > 0) return { atAsk: volume, atBid: 0 };
    if (ask > 0) return { atAsk: 0, atBid: volume };
    return { atAsk: volume / 2, atBid: volume / 2 };
}

/**
 * Seconds since the epoch for a row, whichever way the server wrote its time.
 * @param {Object} row - History row
 * @returns {number}
 */
function rowTime(row) {
    if (typeof row?.time === 'number') return row.time;
    const parsed = new Date(row?.time).getTime();
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

/**
 * The newest sighting in a set of history rows, as ask/bid with a millisecond
 * timestamp.
 *
 * A row's `a`/`b` are best ask and best bid; a non-positive side was empty, not
 * a price of zero, so it becomes null. The time is normalised to milliseconds
 * (rows carry seconds) so a caller can compare it against `Date.now()` directly.
 * Pure, so picking the freshest can be tested without a server.
 *
 * @param {Array<Object>|null} rows - Rows from the history API
 * @returns {{time: number, ask: number|null, bid: number|null}|null} Freshest, or null
 */
export function freshestSighting(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;

    let best = null;
    for (const row of rows) {
        const seconds = rowTime(row);
        if (!seconds) continue;
        if (!best || seconds > best.seconds) {
            best = {
                seconds,
                ask: row?.a > 0 ? row.a : null,
                bid: row?.b > 0 ? row.b : null,
            };
        }
    }
    return best ? { time: best.seconds * 1000, ask: best.ask, bid: best.bid } : null;
}

/**
 * Reduce history rows to the points a chart draws.
 *
 * @param {Array<Object>} rows - Rows from the history API
 * @param {number} days - The range being shown
 * @returns {Array<Object>} { time, ask, bid, avg, volume, atAsk, atBid }, oldest first
 */
export function buildHistorySeries(rows, days) {
    if (!Array.isArray(rows)) return [];

    if (Number(days) <= DAILY_GROUPING_THRESHOLD) {
        return rows
            .map((row) => {
                const { atAsk, atBid } = splitVolume(row);
                return {
                    time: rowTime(row),
                    ask: row.a > 0 ? row.a : 0,
                    bid: row.b > 0 ? row.b : 0,
                    avg: row.p > 0 ? row.p : 0,
                    volume: Math.max(0, Number(row.v) || 0),
                    atAsk: Math.round(atAsk),
                    atBid: Math.round(atBid),
                };
            })
            .sort((a, b) => a.time - b.time);
    }

    const byDay = new Map();
    for (const row of rows) {
        const time = rowTime(row);
        const date = new Date(time * 1000);
        const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;

        let day = byDay.get(key);
        if (!day) {
            day = { time, asks: [], bids: [], avgs: [], volume: 0, atAsk: 0, atBid: 0 };
            byDay.set(key, day);
        }

        const { atAsk, atBid } = splitVolume(row);
        day.atAsk += atAsk;
        day.atBid += atBid;
        day.volume += Math.max(0, Number(row.v) || 0);
        day.asks.push(row.a);
        day.bids.push(row.b);
        day.avgs.push(row.p);
        // The day is stamped with its latest sighting, so a partial day sits
        // where it belongs on the axis rather than at midnight
        if (time > day.time) day.time = time;
    }

    return [...byDay.values()]
        .map((day) => ({
            time: day.time,
            ask: median(day.asks),
            bid: median(day.bids),
            avg: median(day.avgs),
            volume: day.volume,
            atAsk: Math.round(day.atAsk),
            atBid: Math.round(day.atBid),
        }))
        .sort((a, b) => a.time - b.time);
}

/**
 * Axis labels for a series.
 *
 * Time is drawn as a category axis rather than a real time scale: Chart.js needs
 * a date adapter for the latter, and pulling one in for evenly spaced sightings
 * would be a dependency for nothing.
 *
 * @param {Array<Object>} series - Result of buildHistorySeries
 * @param {number} days - The range being shown
 * @returns {Array<string>}
 */
export function historyLabels(series, days) {
    const daily = Number(days) > DAILY_GROUPING_THRESHOLD;
    return (series || []).map((point) => {
        const date = new Date(point.time * 1000);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (daily) return `${month}/${day}`;
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    });
}
