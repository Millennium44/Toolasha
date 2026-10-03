/**
 * GM Traffic
 *
 * Counts what this tab sends into and pulls out of the userscript manager:
 * storage writes and reads (by key) and cross-origin requests (by host).
 *
 * Why it exists: the manager's own process holds a copy of every value
 * `GM_setValue` is given, and no page script can read that process's memory.
 * What a page script can do is measure its own traffic into it, which bounds
 * what that process was ever asked to hold.
 *
 * These are wrapped helpers the call sites use, not patches on the globals. In
 * the manager's sandbox `GM_setValue` and friends are scope bindings that are
 * not reliably reassignable, and a patch would also be one more thing a second
 * script copy could double-wrap. The wrappers resolve the GM function at call
 * time, so they see test stubs and managers that grant lazily.
 *
 * Cost per call is a counter increment and a string length. A non-string value
 * is not serialized to be sized (that would double the cost of the write being
 * measured); it is counted as unsized instead.
 *
 * One copy per page: this module is published as `Toolasha.Core.gmTraffic` and
 * every bundle reaches it through that global (rollup.config.js), so the totals
 * are tab-wide. State is module-level and never reset by a feature restart.
 */

/** Per-minute buckets kept for the rolling rate: one hour. */
const BUCKET_COUNT = 60;
const MINUTE_MS = 60000;

/** Distinct keys / hosts tracked before the rest fold into one overflow row. */
const MAX_KEYS = 64;
const MAX_HOSTS = 32;
const OVERFLOW = '(other)';

/**
 * `request*` / `responseBytes` count GM requests only — the ones whose bodies
 * the manager holds. `page*` counts requests a caller sent with the page's own
 * `fetch` instead, kept apart so the GM figures still bound the manager's share.
 */
const COUNTER_FIELDS = [
    'writeCalls',
    'writeBytes',
    'deleteCalls',
    'readCalls',
    'readBytes',
    'requestCalls',
    'requestBytes',
    'responseBytes',
    'pageRequestCalls',
    'pageRequestBytes',
    'pageResponseBytes',
];

/** @returns {Object<string, number>} A zeroed counter set */
function emptyCounters() {
    const counters = {};
    for (const field of COUNTER_FIELDS) counters[field] = 0;
    return counters;
}

let startedAt = Date.now();
let totals = emptyCounters();
let writeErrors = 0;
let unsizedWrites = 0;
/** @type {Map<string, {calls: number, bytes: number, errors: number}>} */
let writesByKey = new Map();
/** @type {Map<string, {calls: number, bytes: number}>} */
let readsByKey = new Map();
/** @type {Map<string, {calls: number, bytes: number, errors: number}>} */
let requestsByHost = new Map();
/** @type {Map<string, {calls: number, bytes: number, errors: number}>} */
let pageRequestsByHost = new Map();
/** @type {Array<{minute: number, counters: Object<string, number>}|null>} */
let buckets = new Array(BUCKET_COUNT).fill(null);

/**
 * The bucket for the current minute, recycled from the hour before.
 * @returns {Object<string, number>} Counters for this minute
 */
function currentBucket() {
    const minute = Math.floor(Date.now() / MINUTE_MS);
    const slot = minute % BUCKET_COUNT;
    let bucket = buckets[slot];
    if (!bucket || bucket.minute !== minute) {
        bucket = { minute, counters: emptyCounters() };
        buckets[slot] = bucket;
    }
    return bucket.counters;
}

/**
 * Add to a total and to the current minute's bucket.
 * @param {string} field - One of COUNTER_FIELDS
 * @param {number} amount - What to add
 */
function bump(field, amount) {
    totals[field] += amount;
    currentBucket()[field] += amount;
}

/**
 * The row for a key, folding past the cap into one overflow row so a caller
 * that ever builds keys dynamically cannot grow this without bound.
 * @param {Map<string, Object>} map - The by-key map
 * @param {string} key - The row's name
 * @param {number} cap - Distinct rows allowed
 * @param {Function} make - Builds an empty row
 * @returns {Object} The row
 */
function rowFor(map, key, cap, make) {
    let row = map.get(key);
    if (row) return row;
    if (map.size >= cap) {
        row = map.get(OVERFLOW);
        if (!row) {
            row = make();
            map.set(OVERFLOW, row);
        }
        return row;
    }
    row = make();
    map.set(key, row);
    return row;
}

/**
 * Size of a stored or returned value, in UTF-16 units.
 * @param {*} value - A stored or returned value
 * @returns {number} Length for a string, or -1 when the value is not a string
 */
function sizeOf(value) {
    return typeof value === 'string' ? value.length : -1;
}

/**
 * `GM_setValue`, counted. Throws exactly what `GM_setValue` throws — callers
 * (the battle-bridge retry in websocket.js) depend on it — and counts a failed
 * write as an error rather than as bytes stored.
 * @param {string} key - Storage key
 * @param {*} value - Value to store (the callers all pass strings)
 * @returns {*} Whatever `GM_setValue` returns
 */
export function gmSetValue(key, value) {
    const row = rowFor(writesByKey, key, MAX_KEYS, () => ({ calls: 0, bytes: 0, errors: 0 }));
    let result;
    try {
        result = GM_setValue(key, value);
    } catch (error) {
        row.errors += 1;
        writeErrors += 1;
        throw error;
    }
    const size = sizeOf(value);
    row.calls += 1;
    bump('writeCalls', 1);
    if (size >= 0) {
        row.bytes += size;
        bump('writeBytes', size);
    } else {
        unsizedWrites += 1;
    }
    return result;
}

/**
 * `GM_deleteValue`, counted as a delete. Throws what `GM_deleteValue` throws,
 * uncounted.
 * @param {string} key - Storage key
 * @returns {*} Whatever `GM_deleteValue` returns
 */
export function gmDeleteValue(key) {
    const result = GM_deleteValue(key);
    bump('deleteCalls', 1);
    return result;
}

/**
 * `GM_getValue`, counted by key, with the size of what came back when it is a
 * string. Throws what `GM_getValue` throws.
 * @param {string} key - Storage key
 * @param {*} [defaultValue] - Returned when the key is absent
 * @returns {*} Whatever `GM_getValue` returns
 */
export function gmGetValue(key, defaultValue) {
    const result = GM_getValue(key, defaultValue);
    const row = rowFor(readsByKey, key, MAX_KEYS, () => ({ calls: 0, bytes: 0 }));
    row.calls += 1;
    bump('readCalls', 1);
    const size = sizeOf(result);
    if (size > 0) {
        row.bytes += size;
        bump('readBytes', size);
    }
    return result;
}

/**
 * The cross-origin request function this manager exposes, unwrapped.
 * @returns {Function|null} A GM request function, or null
 */
function rawRequestFunction() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
        return GM.xmlHttpRequest.bind(GM);
    }
    return null;
}

/**
 * Whether a GM request function exists at all, for callers that fall back to
 * `fetch` without one.
 * @returns {boolean} True when `gmRequest` can send
 */
export function gmRequestAvailable() {
    return rawRequestFunction() !== null;
}

/**
 * The host a URL goes to, or a placeholder when it will not parse.
 * @param {string} url - Request URL
 * @returns {string} Host, or `(unparsed)`
 */
function hostOf(url) {
    try {
        return new URL(url).host || '(unparsed)';
    } catch {
        return '(unparsed)';
    }
}

/**
 * `GM_xmlhttpRequest` / `GM.xmlHttpRequest`, counted by host. The request is
 * counted when sent; the response is sized when `onload` fires. The caller's
 * handlers still run, with the same arguments, and the return value (the
 * abort handle) is passed through.
 * @param {Object} details - The GM request details object
 * @returns {*} Whatever the underlying request function returns
 * @throws {Error} When no GM request function exists, or the underlying one throws
 */
export function gmRequest(details) {
    const send = rawRequestFunction();
    if (!send) throw new Error('No GM request function available');

    const row = rowFor(requestsByHost, hostOf(details?.url), MAX_HOSTS, () => ({ calls: 0, bytes: 0, errors: 0 }));
    row.calls += 1;
    bump('requestCalls', 1);
    // The body is what the manager's background page keeps after completion
    const sent = sizeOf(details?.data);
    if (sent > 0) bump('requestBytes', sent);

    const { onload, onerror, ontimeout } = details || {};
    const counted = {
        ...details,
        onload(response, ...rest) {
            const size = sizeOf(response?.responseText);
            if (size > 0) {
                row.bytes += size;
                bump('responseBytes', size);
            }
            return typeof onload === 'function' ? onload.call(this, response, ...rest) : undefined;
        },
        onerror(...args) {
            row.errors += 1;
            return typeof onerror === 'function' ? onerror.apply(this, args) : undefined;
        },
        ontimeout(...args) {
            row.errors += 1;
            return typeof ontimeout === 'function' ? ontimeout.apply(this, args) : undefined;
        },
    };
    return send(counted);
}

/**
 * Count a request a caller sent with the page's own `fetch`, which never
 * reaches the manager. Kept in its own fields and rows (see COUNTER_FIELDS).
 * @param {string} url - Request URL
 * @param {number} sentBytes - Request body length
 * @param {number} receivedBytes - Response body length
 * @param {boolean} failed - The fetch threw
 */
export function recordPageRequest(url, sentBytes, receivedBytes, failed) {
    const row = rowFor(pageRequestsByHost, hostOf(url), MAX_HOSTS, () => ({ calls: 0, bytes: 0, errors: 0 }));
    row.calls += 1;
    bump('pageRequestCalls', 1);
    if (sentBytes > 0) bump('pageRequestBytes', sentBytes);
    if (receivedBytes > 0) {
        row.bytes += receivedBytes;
        bump('pageResponseBytes', receivedBytes);
    }
    if (failed) row.errors += 1;
}

/**
 * Sum of the last hour's buckets.
 * @param {number} now - Current time, ms
 * @returns {{counters: Object<string, number>, windowMs: number}} Totals and the span they cover
 */
function recentCounters(now) {
    const minute = Math.floor(now / MINUTE_MS);
    const sum = emptyCounters();
    for (const bucket of buckets) {
        if (!bucket || minute - bucket.minute >= BUCKET_COUNT) continue;
        for (const field of COUNTER_FIELDS) sum[field] += bucket.counters[field];
    }
    // The window is the time actually observed, capped at an hour: a tab one
    // minute old has one minute of data, and dividing by an hour would read as
    // a tiny rate rather than the real one.
    const windowMs = Math.min(BUCKET_COUNT * MINUTE_MS, Math.max(now - startedAt, MINUTE_MS));
    return { counters: sum, windowMs };
}

/**
 * Rows of a by-key map, largest bytes first.
 * @param {Map<string, Object>} map - By-key map
 * @returns {Array<Object>} Rows with `name` added
 */
function sortedRows(map) {
    return [...map.entries()].map(([name, row]) => ({ name, ...row })).sort((a, b) => b.bytes - a.bytes);
}

/**
 * Everything counted so far, as plain data.
 * @returns {{startedAt: number, uptimeMs: number, totals: Object<string, number>, writeErrors: number,
 *   unsizedWrites: number, writesByKey: Array<Object>, readsByKey: Array<Object>,
 *   requestsByHost: Array<Object>, pageRequestsByHost: Array<Object>, perHour: Object<string, number>,
 *   rateWindowMs: number}}
 *   `perHour` extrapolates the observed window (at most the last hour) to an hour
 */
export function getGmTrafficSnapshot() {
    const now = Date.now();
    const { counters, windowMs } = recentCounters(now);
    const perHour = {};
    for (const field of COUNTER_FIELDS) perHour[field] = Math.round((counters[field] / windowMs) * 3600000);
    return {
        startedAt,
        uptimeMs: now - startedAt,
        totals: { ...totals },
        writeErrors,
        unsizedWrites,
        writesByKey: sortedRows(writesByKey),
        readsByKey: sortedRows(readsByKey),
        requestsByHost: sortedRows(requestsByHost),
        pageRequestsByHost: sortedRows(pageRequestsByHost),
        perHour,
        rateWindowMs: windowMs,
    };
}

/**
 * The few figures another tab needs, with no per-key detail.
 * @returns {{startedAt: number, totals: Object<string, number>, perHour: Object<string, number>,
 *   rateWindowMs: number}} Compact summary
 */
export function getGmTrafficSummary() {
    const snapshot = getGmTrafficSnapshot();
    return {
        startedAt: snapshot.startedAt,
        totals: snapshot.totals,
        perHour: snapshot.perHour,
        rateWindowMs: snapshot.rateWindowMs,
    };
}

/**
 * Forget everything and start the clock again. Tests only: nothing in the
 * product calls this, so a feature restart cannot zero the counters or count
 * twice.
 */
export function resetGmTraffic() {
    startedAt = Date.now();
    totals = emptyCounters();
    writeErrors = 0;
    unsizedWrites = 0;
    writesByKey = new Map();
    readsByKey = new Map();
    requestsByHost = new Map();
    pageRequestsByHost = new Map();
    buckets = new Array(BUCKET_COUNT).fill(null);
}
