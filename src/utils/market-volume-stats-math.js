/**
 * Market Volume Stats — pure math
 *
 * Ported from the "交易量显示" (Trade Volume Display) userscript by baozhi &
 * SukiSukiDaiSuki (https://greasyfork.org/en/scripts/570243, CC-BY-NC-SA-4.0),
 * translated and adapted for Toolasha. Its `processMarketData`,
 * `calculateMedianPrice` and `getPriceTier` functions are the source for the
 * bucketing, weighted average/median, price-tier snapping and buy/sell split
 * below.
 *
 * A "row" is one sighting from the pooled history server: `{a, b, p, v, time}`
 * — best ask, best bid, an average transacted price, volume traded, and a
 * unix-seconds timestamp (see `market-history-api.js`). Pure: rows in,
 * numbers out. No DOM, no fetching.
 *
 * ## Deviation from the source: Average excludes unpriced rows
 *
 * The source's average divides `Σ(p·v)` by `Σv` over *every* row, including
 * rows whose price is non-positive (unknown) — a gap in the pool silently
 * drags the average toward zero because that row's volume still counts in the
 * denominator while contributing nothing to the numerator. Its own median
 * already excludes `p <= 0` rows. The average here is made consistent with
 * the median instead of reproducing the inconsistency: both exclude
 * non-positive prices from their input. Volume stays `Σv` over every row
 * regardless of price, since a trade's size is known even when its price
 * sighting is not.
 */

import { priceIncrement } from './market-values.js';

/**
 * Rows whose `time` falls within the last `days` days of `now`.
 * @param {Array<{time: number}>} rows - Rows, unix-seconds `time`
 * @param {number} days - Window size in days
 * @param {number} [now] - Reference time in ms, defaults to `Date.now()`
 * @returns {Array<Object>} The rows within the window
 */
export function filterWindow(rows, days, now = Date.now()) {
    if (!Array.isArray(rows)) return [];
    const cutoffMs = now - days * 24 * 60 * 60 * 1000;
    return rows.filter((row) => typeof row?.time === 'number' && row.time * 1000 >= cutoffMs);
}

/**
 * Snap a price to the marketplace's price-tier ladder (the game's
 * `getBinnedPrice`), reusing `priceIncrement` from `market-values.js` rather
 * than reimplementing the digit-count step rule the source's `getPriceTier`
 * computed separately.
 * @param {number} price - Any price
 * @param {'up'|'down'} direction - Which way to snap
 * @returns {number} The snapped price, or 0 for a non-positive input
 */
export function snapPriceTier(price, direction) {
    const numeric = Number(price);
    if (!Number.isFinite(numeric) || numeric <= 0) return 0;

    const whole = Math.trunc(numeric);
    if (whole <= 1) return 2;

    const step = priceIncrement(whole);
    const lower = whole - (whole % step);
    return direction === 'up' && whole > lower ? lower + step : lower;
}

/**
 * Volume-weighted median transacted price: sort priced rows, then find the
 * price at which half the traded volume has accumulated.
 * @param {Array<{p: number, v: number}>} rows - Rows in any order
 * @returns {number} The weighted median price, or 0 with no priced rows
 * @param {(row: Object) => number} [weightFn] - What to weigh each row by;
 *   defaults to its traded volume `v`. A source with no volume at all (mooket
 *   I) has nothing positive here to weigh by, which is why `computeMarketStats`
 *   passes a uniform weight of 1 per row instead when that happens — see there.
 */
export function weightedMedianPrice(rows, weightFn = (row) => row.v) {
    const priced = (rows || [])
        .filter((row) => row?.p > 0 && weightFn(row) > 0)
        .slice()
        .sort((a, b) => a.p - b.p);
    if (!priced.length) return 0;

    const totalWeight = priced.reduce((sum, row) => sum + weightFn(row), 0);
    if (totalWeight <= 0) return 0;

    const half = totalWeight / 2;
    let cumulative = 0;
    for (const row of priced) {
        cumulative += weightFn(row);
        if (cumulative >= half) return row.p;
    }
    return priced[priced.length - 1].p;
}

/**
 * Mean of the positive values in a row set's ask (`a`) or bid (`b') field.
 * @param {Array<Object>} rows - Rows
 * @param {'a'|'b'} field - Which field to average
 * @returns {number} The mean, or 0 with nothing positive to average
 */
function meanOfPositive(rows, field) {
    const values = rows.map((row) => row[field]).filter((value) => value > 0);
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Estimate how much of a window's traded volume was buyer-initiated
 * ("bought", lifting the ask) versus seller-initiated ("sold", hitting the
 * bid), from the source's hourly heuristic (`processMarketData`, L2288-2370).
 *
 * The pooled data records only that a trade happened and its average price —
 * not which side crossed the spread — so this is an estimate, not a
 * measurement: it is surfaced with that caveat in the panel's tooltip.
 *
 * Method: group rows by hour (`floor(time / 3600)`). For each hour, take the
 * mean ask and mean bid of that hour's positive `a`/`b` values, and of the
 * previous hour (falling back to the current hour's own average when the
 * previous hour has none). A row's volume then goes:
 * - entirely to "bought" when its price is at or above either hour's mean ask
 * - entirely to "sold" when its price is at or above neither ask but at or
 *   below either hour's mean bid
 * - split linearly across the two hours' combined ask/bid spread otherwise,
 *   or 50/50 when that spread is not positive
 *
 * @param {Array<Object>} rows - Rows with `a`, `b`, `p`, `v`, `time`
 * @returns {{buyVolume: number, sellVolume: number}} Rounded to whole units
 */
export function splitBuySellVolume(rows) {
    if (!rows?.length) return { buyVolume: 0, sellVolume: 0 };

    const byHour = new Map();
    for (const row of rows) {
        if (typeof row?.time !== 'number') continue;
        const hour = Math.floor(row.time / 3600);
        if (!byHour.has(hour)) byHour.set(hour, []);
        byHour.get(hour).push(row);
    }
    const hours = [...byHour.keys()].sort((a, b) => a - b);

    let buyVolume = 0;
    let sellVolume = 0;

    for (let i = 0; i < hours.length; i += 1) {
        const hourRows = byHour.get(hours[i]);
        const curAsk = meanOfPositive(hourRows, 'a');
        const curBid = meanOfPositive(hourRows, 'b');

        let lastAsk = curAsk;
        let lastBid = curBid;
        if (i > 0) {
            const prevRows = byHour.get(hours[i - 1]);
            const prevAsk = meanOfPositive(prevRows, 'a');
            const prevBid = meanOfPositive(prevRows, 'b');
            lastAsk = prevAsk > 0 ? prevAsk : curAsk;
            lastBid = prevBid > 0 ? prevBid : curBid;
        }

        for (const row of hourRows) {
            const v = Number(row.v) || 0;
            if (v <= 0) continue;
            const p = row.p;

            if ((curAsk > 0 && p >= curAsk) || (lastAsk > 0 && p >= lastAsk)) {
                buyVolume += v;
                continue;
            }
            if ((curBid > 0 && p <= curBid) || (lastBid > 0 && p <= lastBid)) {
                sellVolume += v;
                continue;
            }

            const avgRange = (curAsk - curBid + (lastAsk - lastBid)) / 2;
            if (avgRange > 0) {
                const minBid = Math.min(curBid, lastBid);
                const maxAsk = Math.max(curAsk, lastAsk);
                const actualRange = maxAsk - minBid;
                if (actualRange > 0) {
                    const buyRatio = (p - minBid) / actualRange;
                    buyVolume += v * buyRatio;
                    sellVolume += v * (1 - buyRatio);
                    continue;
                }
            }
            buyVolume += v * 0.5;
            sellVolume += v * 0.5;
        }
    }

    return { buyVolume: Math.round(buyVolume), sellVolume: Math.round(sellVolume) };
}

/**
 * @typedef {Object} MarketWindowStats
 * @property {number} volume - Total traded volume (Σv over every row)
 * @property {number} avgPrice - Volume-weighted average of priced rows
 * @property {number} medianPrice - Volume-weighted median of priced rows
 * @property {number} buyVolume - Estimated buyer-initiated volume
 * @property {number} sellVolume - Estimated seller-initiated volume
 * @property {number} minPrice - Lowest traded price, snapped down a tier
 * @property {number} maxPrice - Highest traded price, snapped up a tier
 */

/**
 * All five stats for one already-windowed set of rows.
 * @param {Array<Object>} rows - Rows already filtered to the window (see `filterWindow`)
 * @returns {MarketWindowStats}
 */
export function computeMarketStats(rows) {
    const safeRows = Array.isArray(rows) ? rows : [];

    const volume = safeRows.reduce((sum, row) => sum + (Number(row.v) || 0), 0);

    // See the module doc comment: unlike the source, both the average and the
    // median exclude non-positive prices from numerator and denominator alike.
    //
    // A source with no volume at all (mooket I; `v` is always 0 — see
    // `normaliseMooket1Rows`) has nothing positive to weigh by, which would
    // zero out both average and median rather than falling back to the ask/bid
    // midpoint `p` carries regardless. Weighing every priced row equally (1)
    // in that case is what lets a volume-less source still show a price; a
    // source that legitimately has *some* unvolumed hours mixed with volumed
    // ones (an ordinary gap in mooket II's data) keeps real volume-weighting,
    // since `anyVolume` is true and those hours simply weigh 0.
    const pricedRows = safeRows.filter((row) => row.p > 0);
    const anyVolume = pricedRows.some((row) => row.v > 0);
    const weightFn = (row) => (anyVolume ? Math.max(0, Number(row.v) || 0) : 1);

    const totalWeight = pricedRows.reduce((sum, row) => sum + weightFn(row), 0);
    const avgPrice =
        totalWeight > 0 ? pricedRows.reduce((sum, row) => sum + row.p * weightFn(row), 0) / totalWeight : 0;

    const medianPrice = weightedMedianPrice(safeRows, weightFn);

    const positivePrices = safeRows.map((row) => row.p).filter((p) => p > 0);
    let minPrice = 0;
    let maxPrice = 0;
    if (positivePrices.length) {
        minPrice = snapPriceTier(Math.min(...positivePrices), 'down');
        maxPrice = snapPriceTier(Math.max(...positivePrices), 'up');
    }

    const { buyVolume, sellVolume } = splitBuySellVolume(safeRows);

    return { volume, avgPrice, medianPrice, buyVolume, sellVolume, minPrice, maxPrice };
}

/** The windows the panel shows, in days */
export const STAT_WINDOWS_DAYS = [1, 3, 5];

/**
 * `computeMarketStats` for each of the panel's three windows (1d/3d/5d), all
 * sliced from one fetch.
 * @param {Array<Object>} rows - Unfiltered rows for the widest window fetched
 * @param {number} [now] - Reference time in ms, defaults to `Date.now()`
 * @returns {{days: number, stats: MarketWindowStats}[]}
 */
export function computeAllWindows(rows, now = Date.now()) {
    return STAT_WINDOWS_DAYS.map((days) => ({ days, stats: computeMarketStats(filterWindow(rows, days, now)) }));
}

/**
 * Trim the trailing zeros a fixed-decimal K/M/B string carries (`"558.10K"` ->
 * `"558.1K"`, `"558.00K"` -> `"558K"`), matching the source's
 * `formatCompactNumber`, which always trims rather than padding.
 * @param {string} text - A formatted magnitude string, e.g. from `formatKMB`
 * @returns {string}
 */
export function trimTrailingZeros(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/(\.\d*?)0+(?=[A-Za-z]|$)/, '$1').replace(/\.(?=[A-Za-z]|$)/, '');
}
