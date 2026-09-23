/**
 * Market Clock Stats
 *
 * When an item is cheap, dear and busy — by hour of the player's day and by day
 * of their week — from the pooled price-history rows (`{a, b, p, v, time}`, see
 * `mooket/market-history-api.js`).
 *
 * `time` is Unix seconds, so it is UTC by construction; every bucket here is cut
 * with the local-time `Date` getters, which puts it in the player's time zone
 * (DST included) and nowhere else.
 *
 * Raw price medians per hour would mostly measure the trend: over a month an
 * item drifting 10% puts every hour's median wherever the drift happened to be.
 * So a price is measured against its own surroundings instead — an hourly
 * sighting against the median of its local day, a day against the median of the
 * days within three either side of it — and a bucket reports a trimmed mean of
 * those relative deviations. Volume is treated the same way, as a ratio to the
 * day's (or week's) average rather than a raw count.
 *
 * Trimmed mean rather than median: prices move in ticks, so most sightings sit
 * exactly on their day's median and a bucket median is 0 for nearly every
 * liquid item whatever the pattern. Trimming the outer tenth at each end keeps
 * the one absurd listing or one whale trade from carrying a bucket.
 *
 * A non-positive ask or bid is an empty side of the book (`-1`) and `p <= 0` is
 * an hour nothing traded; neither is ever a price. `v === 0` is a real
 * zero-volume hour and does count toward volume.
 *
 * Pure: rows in, buckets out.
 */

/** Sightings a bucket needs before its figure is presented as a pattern */
export const MIN_HOUR_SAMPLES = 7;

/** Days a weekday bucket needs before its figure is presented as a pattern */
export const MIN_WEEKDAY_SAMPLES = 6;

/**
 * Deviations smaller than this are within a tick or two for most items, so a
 * "cheapest hour" that wins by less is noise and is reported as no pattern.
 */
export const FLAT_THRESHOLD = 0.005;

/** A day needs this many sightings of a side before its median is a reference */
const MIN_DAY_SIGHTINGS = 4;

/**
 * A day needs this many rows before its volume counts: a partial day's average
 * is an average of whichever hours were sighted, not of the day.
 */
const MIN_DAY_ROWS_FOR_VOLUME = 20;

/** Days either side of a day that form its weekly reference */
const WEEK_HALF_WINDOW_DAYS = 3;

/** A weekly reference needs this many of its seven days present */
const MIN_WEEK_DAYS = 5;

const DAY_MS = 86_400_000;

/**
 * Seconds since the epoch for a row, whichever way the server wrote its time.
 * @param {Object} row - History row
 * @returns {number} Seconds, or 0 when unreadable
 */
export function rowSeconds(row) {
    if (typeof row?.time === 'number') return Number.isFinite(row.time) ? row.time : 0;
    const parsed = new Date(row?.time).getTime();
    return Number.isFinite(parsed) ? parsed / 1000 : 0;
}

/**
 * A quoted or traded price, or null for an empty side / an hour with no trade.
 * @param {*} value - `a`, `b` or `p` from a row
 * @returns {number|null}
 */
export function positivePrice(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function medianOf(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((x, y) => x - y);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Share of samples dropped from each end before averaging a bucket */
const TRIM_FRACTION = 0.1;

/**
 * Mean of the values left after dropping {@link TRIM_FRACTION} from each end.
 * @param {number[]} values - Samples, in any order
 * @returns {number|null} Null when there are none
 */
export function trimmedMean(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((x, y) => x - y);
    const cut = Math.floor(sorted.length * TRIM_FRACTION);
    return meanOf(sorted.slice(cut, sorted.length - cut));
}

function meanOf(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function emptyBuckets(count) {
    return Array.from({ length: count }, (_, index) => ({ index, ask: [], bid: [], volume: [] }));
}

/**
 * Collapse collected samples into the figures a bucket reports.
 * @param {Array<{index: number, ask: number[], bid: number[], volume: number[]}>} raw - Samples per bucket
 * @returns {Array<ClockBucket>}
 */
function finishBuckets(raw) {
    return raw.map((bucket) => ({
        index: bucket.index,
        ask: { value: trimmedMean(bucket.ask), n: bucket.ask.length },
        bid: { value: trimmedMean(bucket.bid), n: bucket.bid.length },
        volume: { value: trimmedMean(bucket.volume), n: bucket.volume.length },
    }));
}

/**
 * @typedef {Object} ClockMeasure
 * @property {number|null} value - Price: trimmed-mean fractional deviation (-0.01 = 1% below its
 *   reference). Volume: trimmed-mean ratio to its reference (1 = an ordinary hour/day). Null when there are no samples.
 * @property {number} n - Samples behind the value
 */

/**
 * @typedef {Object} ClockBucket
 * @property {number} index - Hour 0–23, or weekday 0–6 with 0 = Sunday (`Date#getDay`)
 * @property {ClockMeasure} ask
 * @property {ClockMeasure} bid
 * @property {ClockMeasure} volume
 */

/**
 * Bucket history rows by local hour of day and local day of week.
 *
 * @param {Array<Object>} rows - Rows from the history API
 * @param {Object} [options]
 * @param {boolean} [options.hasVolume=true] - False for a source that reports no volume;
 *   its `v: 0` would otherwise read as "nothing ever trades"
 * @returns {{hours: ClockBucket[], weekdays: ClockBucket[], rowCount: number, dayCount: number,
 *   firstTime: number|null, lastTime: number|null}}
 */
export function buildMarketClock(rows, { hasVolume = true } = {}) {
    const hourRaw = emptyBuckets(24);
    const weekdayRaw = emptyBuckets(7);

    const days = new Map();
    let rowCount = 0;
    let firstTime = null;
    let lastTime = null;

    for (const row of Array.isArray(rows) ? rows : []) {
        const seconds = rowSeconds(row);
        if (!seconds) continue;
        const date = new Date(seconds * 1000);
        const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        let day = days.get(key);
        if (!day) {
            day = {
                noon: new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime(),
                weekday: date.getDay(),
                sightings: [],
            };
            days.set(key, day);
        }
        const volume = Number(row?.v);
        day.sightings.push({
            hour: date.getHours(),
            ask: positivePrice(row?.a),
            bid: positivePrice(row?.b),
            volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
        });
        rowCount += 1;
        if (firstTime === null || seconds < firstTime) firstTime = seconds;
        if (lastTime === null || seconds > lastTime) lastTime = seconds;
    }

    const dayList = [...days.values()].sort((x, y) => x.noon - y.noon);

    for (const day of dayList) {
        for (const side of ['ask', 'bid']) {
            const prices = day.sightings.map((s) => s[side]).filter((p) => p !== null);
            day[side] = prices.length >= MIN_DAY_SIGHTINGS ? medianOf(prices) : null;
            if (day[side] === null) continue;
            for (const sighting of day.sightings) {
                if (sighting[side] === null) continue;
                hourRaw[sighting.hour][side].push(sighting[side] / day[side] - 1);
            }
        }

        day.volumeRate = null;
        if (!hasVolume) continue;
        const volumes = day.sightings.map((s) => s.volume).filter((v) => v !== null);
        if (volumes.length < MIN_DAY_ROWS_FOR_VOLUME) continue;
        day.volumeRate = meanOf(volumes);
        // A day on which nothing traded has no hour busier than another
        if (!(day.volumeRate > 0)) continue;
        for (const sighting of day.sightings) {
            if (sighting.volume === null) continue;
            hourRaw[sighting.hour].volume.push(sighting.volume / day.volumeRate);
        }
    }

    for (const day of dayList) {
        const window = dayList.filter(
            (other) => Math.abs(other.noon - day.noon) <= (WEEK_HALF_WINDOW_DAYS + 0.5) * DAY_MS
        );
        for (const side of ['ask', 'bid']) {
            if (day[side] === null) continue;
            const neighbours = window.map((other) => other[side]).filter((p) => p !== null);
            if (neighbours.length < MIN_WEEK_DAYS) continue;
            weekdayRaw[day.weekday][side].push(day[side] / medianOf(neighbours) - 1);
        }
        if (day.volumeRate === null) continue;
        const rates = window.map((other) => other.volumeRate).filter((r) => r !== null);
        if (rates.length < MIN_WEEK_DAYS) continue;
        const reference = meanOf(rates);
        if (reference > 0) weekdayRaw[day.weekday].volume.push(day.volumeRate / reference);
    }

    return {
        hours: finishBuckets(hourRaw),
        weekdays: finishBuckets(weekdayRaw),
        rowCount,
        dayCount: dayList.length,
        firstTime,
        lastTime,
    };
}

function extreme(buckets, measure, minSamples, pick) {
    let best = null;
    let low = Infinity;
    let high = -Infinity;
    for (const bucket of buckets) {
        const { value, n } = bucket[measure];
        if (value === null || n < minSamples) continue;
        low = Math.min(low, value);
        high = Math.max(high, value);
        if (!best || pick(value, best.value)) best = { index: bucket.index, value, n };
    }
    return best ? { ...best, spread: high - low } : null;
}

/**
 * The buckets worth naming: cheapest ask, dearest bid, busiest volume — chosen
 * only among buckets with enough samples. A price extreme whose buckets all sit
 * within {@link FLAT_THRESHOLD} of each other is returned with `flat: true`,
 * because naming a winner there would present a tick of noise as a pattern.
 *
 * @param {ClockBucket[]} buckets - `hours` or `weekdays` from {@link buildMarketClock}
 * @param {number} minSamples - Samples a bucket needs to be considered
 * @returns {{cheapestAsk: Object|null, dearestBid: Object|null, busiest: Object|null}}
 *   Each `{index, value, n, spread, flat}` or null when no bucket qualifies
 */
export function summarizeClock(buckets, minSamples) {
    const cheapestAsk = extreme(buckets, 'ask', minSamples, (value, best) => value < best);
    const dearestBid = extreme(buckets, 'bid', minSamples, (value, best) => value > best);
    const busiest = extreme(buckets, 'volume', minSamples, (value, best) => value > best);
    const mark = (entry, threshold) => (entry ? { ...entry, flat: entry.spread < threshold } : null);
    return {
        cheapestAsk: mark(cheapestAsk, FLAT_THRESHOLD),
        dearestBid: mark(dearestBid, FLAT_THRESHOLD),
        // Volume ratios move far more than prices; under 10% apart, no hour is busier
        busiest: mark(busiest, 0.1),
    };
}
