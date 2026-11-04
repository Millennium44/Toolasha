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

/** Ranges the chart offers, in days (mooket II offers the same list, 365 included) */
export const HISTORY_RANGES = [1, 3, 7, 14, 30, 90, 180, 365];

/** An open chart is redrawn from fresh rows once its data is this old (mooket II's cadence) */
export const AUTO_REFRESH_MS = 10 * 60 * 1000;

/**
 * A shared-pool cool-down's remaining time, rounded to the minute a player
 * would actually read off a "retrying in" line. The cool-down itself runs
 * 30s–10min (see `market-history-api.js`), so anything under a minute still
 * reads as "~1m" rather than "~0m".
 *
 * @param {number} ms - Milliseconds remaining
 * @returns {string} e.g. "~1m", "~4m"
 */
export function describeCooldown(ms) {
    return `~${Math.max(1, Math.round(ms / 60000))}m`;
}

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
    // versa: the quoted side is the only price a trade could have happened at.
    // `atBid` is volume traded at the bid (sellers hitting it), `atAsk` volume
    // traded at the ask (buyers lifting it) — the same naming as the two-sided
    // case above.
    if (bid > 0) return { atAsk: 0, atBid: volume };
    if (ask > 0) return { atAsk: volume, atBid: 0 };
    return { atAsk: volume / 2, atBid: volume / 2 };
}

/**
 * Whether a row carries a volume at all. A row with no `v` is "no reading", which a
 * chart must not draw as a zero-volume hour.
 * @param {Object} row - History row
 * @returns {boolean}
 */
function hasVolumeReading(row) {
    return row?.v !== null && row?.v !== undefined && row?.v !== '' && Number.isFinite(Number(row.v));
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
 * The game's base market value for a point, as an optional `mv` field.
 * Older rows, and servers that do not send `market_value`, give nothing, so a
 * missing value is never drawn as 0.
 * @param {*} value - A row's `market_value`, or a bucket's median of them
 * @returns {{mv: number}|{}}
 */
function baseValueField(value) {
    const mv = Number(value);
    return mv > 0 ? { mv } : {};
}

/**
 * Footer lines for a chart tooltip point.
 *
 * @param {Object|undefined} point - A point from buildHistorySeries
 * @param {{hasVolume: boolean, showBaseValue: boolean}} options
 * @param {(n: number) => string} format - Number formatter
 * @returns {string} Newline-joined lines, '' when there is nothing to say
 */
export function tooltipFooterLines(point, { hasVolume, showBaseValue }, format) {
    if (!point) return '';
    const lines = [];
    // A grouped point's split is the sum over its readings; a point with no
    // volume reading at all (null) says nothing rather than "0".
    const total = point.grouped ? ' (3-hour total)' : '';
    const hasSplit = Number.isFinite(point.atAsk) && Number.isFinite(point.atBid);
    if (hasVolume && hasSplit) {
        lines.push(`Est. bought at the ask${total}: ${format(point.atAsk)}`);
        lines.push(`Est. sold into the bid${total}: ${format(point.atBid)}`);
    }
    if (showBaseValue && point.mv > 0) {
        lines.push(`Base value${point.grouped ? ' (median)' : ''}: ${format(Math.round(point.mv))}`);
    }
    return lines.join('\n');
}

/**
 * Reduce history rows to the points a chart draws.
 *
 * @param {Array<Object>} rows - Rows from the history API
 * @param {number} days - The range being shown
 * @returns {Array<Object>} { time, ask, bid, avg, volume, atAsk, atBid, mv? }, oldest first
 */
export function buildHistorySeries(rows, days) {
    if (!Array.isArray(rows)) return [];

    if (Number(days) <= DAILY_GROUPING_THRESHOLD) {
        return rows
            .map((row) => {
                const { atAsk, atBid } = splitVolume(row);
                const hasV = hasVolumeReading(row);
                return {
                    time: rowTime(row),
                    ask: row.a > 0 ? row.a : 0,
                    bid: row.b > 0 ? row.b : 0,
                    avg: row.p > 0 ? row.p : 0,
                    // No reading is null, not 0: a missing volume is not a quiet hour
                    volume: hasV ? Math.max(0, Number(row.v)) : null,
                    atAsk: hasV ? Math.round(atAsk) : null,
                    atBid: hasV ? Math.round(atBid) : null,
                    ...baseValueField(row.market_value),
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
            day = { time, asks: [], bids: [], avgs: [], mvs: [], volume: 0, atAsk: 0, atBid: 0, hasV: false };
            byDay.set(key, day);
        }

        const { atAsk, atBid } = splitVolume(row);
        if (hasVolumeReading(row)) {
            day.hasV = true;
            day.atAsk += atAsk;
            day.atBid += atBid;
            day.volume += Math.max(0, Number(row.v));
        }
        day.asks.push(row.a);
        day.bids.push(row.b);
        day.avgs.push(row.p);
        day.mvs.push(row.market_value);
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
            volume: day.hasV ? day.volume : null,
            atAsk: day.hasV ? Math.round(day.atAsk) : null,
            atBid: day.hasV ? Math.round(day.atBid) : null,
            ...baseValueField(median(day.mvs)),
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
    const withDate = Number(days) >= 3;
    return (series || []).map((point) => {
        const date = new Date(point.time * 1000);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        if (daily) return `${month}/${day}`;
        const hours = String(date.getHours()).padStart(2, '0');
        // From three days up the time alone does not say which day it is
        if (withDate) return `${month}/${day} ${hours}h`;
        return `${hours}:${String(date.getMinutes()).padStart(2, '0')}`;
    });
}

/** Grouping choices the toolbar offers, in hours; 1 means "show every reading" */
export const GROUP_CHOICES = [1, 3];
export const DEFAULT_GROUP_HOURS = 3;

/** Fewer points than this after grouping and grouping is not worth doing */
const MIN_GROUPED_POINTS = 12;

/**
 * A saved grouping choice, or the default when it is missing or unrecognized.
 * @param {*} value - prefs.groupHours
 * @returns {number} 1 or 3
 */
export function normalizeGroupHours(value) {
    const hours = Number(value);
    return GROUP_CHOICES.includes(hours) ? hours : DEFAULT_GROUP_HOURS;
}

/**
 * Median of the positive finite numbers, null when there are none.
 * @param {Array<*>} values - Candidate values
 * @returns {number|null}
 */
function medianOrNull(values) {
    const usable = values.filter((value) => Number.isFinite(value) && value > 0);
    return usable.length ? median(usable) : null;
}

/**
 * Sum of the finite numbers, null when there are none (no reading is not zero).
 * @param {Array<*>} values - Candidate values
 * @returns {number|null}
 */
function sumOrNull(values) {
    const usable = values.filter((value) => Number.isFinite(value));
    return usable.length ? usable.reduce((total, value) => total + value, 0) : null;
}

/**
 * Group a series into time buckets for drawing.
 *
 * Buckets are by time, counted back from the newest reading so the newest point
 * is always current: bucket k holds readings in (newest - (k+1)B, newest - kB].
 * Ask, bid and avg are the median of the bucket's readings that have a price;
 * volume and its ask/bid split are sums of the readings that have a volume; a
 * field with no reading in the bucket is null, never 0. Empty windows produce no
 * point. A grouped point is stamped with its latest reading and carries
 * `grouped`, `from`/`to` (the window, seconds) and `count`.
 *
 * The series comes back untouched when the choice is "every reading", when the
 * readings are already spaced 3 hours apart or more (long ranges), when any time
 * is unreadable, or when the result would be under about a dozen points (1 day).
 *
 * @param {Array<Object>} series - Result of buildHistorySeries, oldest first
 * @param {number} hours - Bucket size in hours (1 = no grouping)
 * @returns {{series: Array<Object>, grouped: boolean, bucketSeconds: number}}
 */
export function groupSeries(series, hours) {
    const bucketHours = normalizeGroupHours(hours);
    const bucketSeconds = bucketHours * 3600;
    const untouched = { series: series || [], grouped: false, bucketSeconds };
    if (bucketHours <= 1 || !Array.isArray(series) || series.length < 2) return untouched;
    if (series.some((point) => !(point.time > 0))) return untouched;

    const times = series.map((point) => point.time);
    const gaps = [];
    for (let i = 1; i < times.length; i += 1) if (times[i] > times[i - 1]) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    const typicalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    if (typicalGap >= 3 * 3600) return untouched;

    const newest = Math.max(...times);
    const buckets = new Map();
    for (const point of series) {
        const index = Math.floor((newest - point.time) / bucketSeconds);
        if (!buckets.has(index)) buckets.set(index, []);
        buckets.get(index).push(point);
    }
    if (buckets.size < MIN_GROUPED_POINTS) return untouched;

    const grouped = [...buckets.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([index, points]) => {
            const to = newest - index * bucketSeconds;
            return {
                time: Math.max(...points.map((point) => point.time)),
                ask: medianOrNull(points.map((point) => point.ask)),
                bid: medianOrNull(points.map((point) => point.bid)),
                avg: medianOrNull(points.map((point) => point.avg)),
                volume: sumOrNull(points.map((point) => point.volume)),
                atAsk: sumOrNull(points.map((point) => point.atAsk)),
                atBid: sumOrNull(points.map((point) => point.atBid)),
                ...baseValueField(medianOrNull(points.map((point) => Number(point.mv)))),
                grouped: true,
                from: to - bucketSeconds,
                to,
                count: points.length,
            };
        });
    return { series: grouped, grouped: true, bucketSeconds };
}

/**
 * Tooltip title for a grouped point: the window it covers.
 * @param {{from: number, to: number}} point - A grouped point
 * @returns {string} e.g. "11/02 12:00-15:00" or "11/02 22:00-11/03 01:00"
 */
export function groupedTitle(point) {
    const pad = (n) => String(n).padStart(2, '0');
    const start = new Date(point.from * 1000);
    const end = new Date(point.to * 1000);
    const date = (d) => `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
    const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay = date(start) === date(end);
    return `${date(start)} ${clock(start)}-${sameDay ? '' : `${date(end)} `}${clock(end)}`;
}

/**
 * Axis extents for a series, so the lines sit above the volume bars.
 *
 * Bars take the lower quarter (the volume axis tops out at four times the
 * largest volume). The price axis then starts below the lowest real price by
 * enough to leave the bars their own band. No volume, or only zero volume, gets
 * no bars and no reserved space.
 *
 * @param {Array<Object>} series - The series being drawn
 * @param {boolean} hasVolume - Whether the source has volume
 * @returns {{priceMin: number|undefined, priceLow: number|null, volumeMax: number|undefined}}
 */
export function chartExtents(series, hasVolume) {
    const prices = [];
    let maxVolume = 0;
    for (const point of series || []) {
        for (const key of ['ask', 'bid', 'avg']) if (point[key] > 0) prices.push(point[key]);
        if (Number.isFinite(point.volume) && point.volume > maxVolume) maxVolume = point.volume;
    }
    const priceLow = prices.length ? Math.min(...prices) : null;
    const high = prices.length ? Math.max(...prices) : null;
    const volumeMax = hasVolume && maxVolume > 0 ? maxVolume * 4 : undefined;
    if (volumeMax === undefined || priceLow === null) return { priceMin: undefined, priceLow, volumeMax };

    // Keep the lowest price about 30% up the chart: min = low - span * 0.3 / 0.7
    const span = Math.max(high - priceLow, high * 0.02, 1);
    return { priceMin: Math.max(0, priceLow - (span * 3) / 7), priceLow, volumeMax };
}

/**
 * Label for one price-axis tick.
 *
 * K/M/B shorthand rounds neighbouring ticks of a narrow range to the same text
 * ("1.0K" twice for 998 and 1,000), so when the shorthand would repeat itself
 * across the axis every tick is written out in full. Ticks under the lowest real
 * price are blank: they only exist to make room for the volume bars.
 *
 * @param {number} value - The tick's value
 * @param {Array<{value: number}>} ticks - All ticks on the axis
 * @param {number|null} low - Lowest real price drawn, or null
 * @param {(n: number) => string} short - K/M/B formatter
 * @param {(n: number) => string} exact - Full-number formatter
 * @returns {string}
 */
export function priceTickLabel(value, ticks, low, short, exact) {
    const hasLow = low !== null && low !== undefined;
    if (hasLow && value < low - Math.abs(low) * 1e-9) return '';
    const shown = (ticks || []).filter((tick) => !hasLow || tick.value >= low - Math.abs(low) * 1e-9);
    const labels = shown.map((tick) => short(tick.value));
    const repeats = new Set(labels).size < labels.length;
    // 995 beside 1.0K reads as two different scales, so a mixed axis is written out too
    const abbreviated = shown.filter((tick) => short(tick.value) !== exact(tick.value)).length;
    const mixed = abbreviated > 0 && abbreviated < shown.length;
    return repeats || mixed ? exact(value) : short(value);
}
