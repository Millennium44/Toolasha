/**
 * What a pull actually reconciled.
 *
 * A pull writes a downloaded payload over this device's stores, folding the
 * records that own a merge registration and taking the rest whole. Until now
 * the only thing said about it was a sentence counting the folds — so a player
 * whose watchlist came back different, or whose history did not, had no way to
 * ask which records the pull touched and how.
 *
 * Everything here is derived from what `applyPayload` already returned. There
 * is deliberately no second pass over storage: re-reading every key to diff it
 * against what was just written would double the cost of the one operation in
 * this script that already reads the whole database, and it would be reading
 * *after* the write, so it could not answer "what changed" anyway.
 *
 * That bounds what can be reported, and the bound is stated rather than papered
 * over. Per store the pull result carries the keys that were folded, the keys
 * held back because the local copy could not be read, the keys whose fold threw,
 * how many keys the store was asked to write, and how many keys the apply left
 * out because this device already held them with the same value. Written-whole
 * is the asked-for count less the folds. Unchanged is the left-out count — the
 * apply compares each downloaded key with this device's copy before writing (see
 * `dropUnchangedKeys` in `sync-payload.js`). A result that does not carry it (an
 * older caller) reports it as unknown, never as zero; keys the payload never
 * mentioned are in neither figure.
 *
 * The summary lives in memory for the session and nowhere else. It is a
 * diagnostic about one operation, not a record of the account, and it belongs to
 * the device rather than the character — a switch clears it (see
 * `sync-manager.js#initialize`).
 */

/**
 * Why the unchanged count is missing, in the words the panel prints.
 *
 * Named rather than inlined so the panel and any caller that renders the
 * summary as text say the same thing about the same gap.
 */
export const UNCHANGED_UNKNOWN = 'not reported — this pull result does not say which keys it left as they were';

/**
 * How many rows a stored value holds, for the pull report: the length of an array, the number of own keys
 * of a plain object, 0 for a missing value, null (printed `n/a`) for anything else.
 *
 * A count only, never the value, and never a copy of it: the summary keeps numbers.
 * @param {*} value - A stored value
 * @returns {number|null} The row count, or null when the value has no rows to count
 */
export function countRows(value) {
    if (value === undefined || value === null) return 0;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'object') {
        const proto = Object.getPrototypeOf(value);
        if (proto === Object.prototype || proto === null) return Object.keys(value).length;
    }
    return null;
}

/**
 * A count figure read back from a summary, or null.
 * @param {*} value - Anything
 * @returns {number|null} A finite non-negative count, else null
 */
function cleanCount(value) {
    return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Counts as a combined record carries them, or undefined when the entry has none (an older result).
 * @param {*} counts - Anything
 * @returns {{local: number|null, pulled: number|null, merged: number|null}|undefined} Cleaned counts
 */
function cleanCounts(counts) {
    if (!counts || typeof counts !== 'object') return undefined;
    return { local: cleanCount(counts.local), pulled: cleanCount(counts.pulled), merged: cleanCount(counts.merged) };
}

/**
 * The monotonic clock the heartbeat's lost-time windows are stamped on, or null without one.
 * @returns {number|null} `performance.now()`
 */
function perfNow() {
    try {
        return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : null;
    } catch {
        return null;
    }
}

/**
 * Milliseconds since the page began loading, on the wall clock.
 *
 * `Date.now() - performance.timeOrigin` rather than `performance.now()`: the monotonic clock may stand still
 * while the machine sleeps, so for a tab open many hours it would understate the page's age. The wall clock can
 * move if the system clock is changed; for "how long ago did this page load" that is the honest trade.
 * @returns {number|null} Milliseconds, or null without a time origin
 */
function sinceLoadNow() {
    try {
        const origin = typeof performance !== 'undefined' ? performance.timeOrigin : NaN;
        if (Number.isFinite(origin)) return Math.max(0, Date.now() - origin);
    } catch {
        // fall through to the monotonic clock
    }
    return perfNow();
}

/**
 * @returns {string|null} The tab's visibility state, or null without a document
 */
function visibilityNow() {
    try {
        return typeof document !== 'undefined' ? (document.visibilityState ?? null) : null;
    } catch {
        return null;
    }
}

/**
 * Note the moment a pull begins. Numbers and a short string only.
 * @param {{perfNow?: () => (number|null), sinceLoadNow?: () => (number|null),
 *   visibilityNow?: () => (string|null)}} [clock] - Overrides for a test
 * @returns {{startPerf: number|null, sinceLoadMs: number|null, visibility: string|null}} The start
 */
export function beginPullTiming(clock = {}) {
    return {
        startPerf: (clock.perfNow || perfNow)(),
        sinceLoadMs: (clock.sinceLoadNow || sinceLoadNow)(),
        visibility: (clock.visibilityNow || visibilityNow)(),
    };
}

/**
 * The longest stretch the page failed to run timers that overlaps a pull.
 *
 * `storage.diagnostics().lostTime.windows` is a short ring of the late heartbeats: each is `{perfAt, lostMs,
 * visibilityState}`, where `perfAt` is when the LATE beat ran (on the `performance.now()` clock, like the
 * pull's own stamps) and `lostMs` is how late it was. The time the page lost therefore ends at `perfAt` and
 * begins `lostMs` before it, and that stretch is what is compared with the pull, not the moment of the beat.
 * A stall that ended after the pull still counts when it began during it.
 *
 * The ring keeps only recent windows, so "none" is only as good as its reach. The running total still counts
 * windows that were dropped; when it exceeds what the retained windows add up to, and the oldest retained
 * window is newer than the pull's start, a dropped one may have overlapped it and the answer is `rolled-off`
 * rather than `none`.
 * @param {{running?: boolean, totalMs?: number, windows?: Array<{perfAt: number, lostMs: number,
 *   visibilityState?: string|null}>}|null|undefined} lostTime - `storage.diagnostics().lostTime`
 * @param {number|null} startPerf - The pull's start on the `performance.now()` clock
 * @param {number|null} endPerf - The pull's end on the same clock
 * @returns {{status: 'found'|'none'|'rolled-off'|'unmeasured', lostMs: number|null, visibility: string|null}}
 *   `found` carries the window's size and the tab's visibility during it
 */
export function longestStallDuring(lostTime, startPerf, endPerf) {
    const unmeasured = { status: 'unmeasured', lostMs: null, visibility: null };
    if (!Number.isFinite(startPerf) || !Number.isFinite(endPerf)) return unmeasured;
    if (!lostTime || typeof lostTime !== 'object' || !Array.isArray(lostTime.windows)) return unmeasured;
    if (lostTime.running === false) return unmeasured;

    let best = null;
    let retained = 0;
    let oldestPerfAt = Infinity;
    for (const window of lostTime.windows) {
        if (!window || !Number.isFinite(window.perfAt) || !Number.isFinite(window.lostMs)) continue;
        retained += window.lostMs;
        oldestPerfAt = Math.min(oldestPerfAt, window.perfAt);
        const overlaps = window.perfAt - window.lostMs < endPerf && window.perfAt > startPerf;
        if (overlaps && (!best || window.lostMs > best.lostMs)) best = window;
    }
    if (best) return { status: 'found', lostMs: best.lostMs, visibility: best.visibilityState ?? null };

    // Each window's size is rounded, and so is the total: allow a millisecond each
    const dropped = Number.isFinite(lostTime.totalMs) && lostTime.totalMs - retained > lostTime.windows.length + 1;
    if (dropped && oldestPerfAt > startPerf) return { status: 'rolled-off', lostMs: null, visibility: null };
    return { status: 'none', lostMs: null, visibility: null };
}

/**
 * Close a pull's timing: how long it took, and the longest stall that overlapped it as the ring stands now.
 * @param {{startPerf: number|null, sinceLoadMs: number|null, visibility: string|null}|null} begun - From
 *   {@link beginPullTiming}
 * @param {Object|null} lostTime - `storage.diagnostics().lostTime`, or null when it could not be read
 * @param {{perfNow?: () => (number|null)}} [clock] - Overrides for a test
 * @returns {Object|null} Numbers and short strings only, or null when the pull was never timed
 */
export function finishPullTiming(begun, lostTime, clock = {}) {
    if (!begun || typeof begun !== 'object') return null;
    const endPerf = (clock.perfNow || perfNow)();
    const startPerf = Number.isFinite(begun.startPerf) ? begun.startPerf : null;
    const timed = startPerf !== null && Number.isFinite(endPerf);
    return {
        startPerf,
        endPerf: Number.isFinite(endPerf) ? endPerf : null,
        sinceLoadMs: Number.isFinite(begun.sinceLoadMs) ? begun.sinceLoadMs : null,
        visibility: typeof begun.visibility === 'string' ? begun.visibility : null,
        durationMs: timed ? Math.max(0, endPerf - startPerf) : null,
        stall: longestStallDuring(lostTime, startPerf, timed ? endPerf : null),
    };
}

/**
 * A summary's timing as stored, or null. Anything that is not a number or a short string is dropped.
 * @param {*} timing - Anything
 * @returns {Object|null} Clean timing
 */
function cleanTiming(timing) {
    if (!timing || typeof timing !== 'object') return null;
    const stall = timing.stall && typeof timing.stall === 'object' ? timing.stall : null;
    const statuses = ['found', 'none', 'rolled-off', 'unmeasured'];
    return {
        startPerf: Number.isFinite(timing.startPerf) ? timing.startPerf : null,
        endPerf: Number.isFinite(timing.endPerf) ? timing.endPerf : null,
        sinceLoadMs: Number.isFinite(timing.sinceLoadMs) ? timing.sinceLoadMs : null,
        durationMs: Number.isFinite(timing.durationMs) ? timing.durationMs : null,
        visibility: typeof timing.visibility === 'string' ? timing.visibility : null,
        stall: stall
            ? {
                  status: statuses.includes(stall.status) ? stall.status : 'unmeasured',
                  lostMs: Number.isFinite(stall.lostMs) ? stall.lostMs : null,
                  visibility: typeof stall.visibility === 'string' ? stall.visibility : null,
              }
            : null,
    };
}

/** The last pull's summary, for this session only. Never persisted. */
let lastSummary = null;

/**
 * @typedef {Object} PullStoreSummary
 * @property {string} store - Object store name
 * @property {number} combined - Records a registered merge folded
 * @property {number|null} writtenWhole - Records written whole, or null when the store's
 *   expected count did not come back (an unknown store the import skipped)
 * @property {number} held - Records kept because this device's copy could not be read
 * @property {number} overwritten - Records whose fold threw and took the download whole
 * @property {number|null} unchanged - Keys left as they were because this device already held the downloaded
 *   value, or null when the result did not report it; see {@link UNCHANGED_UNKNOWN}
 * @property {Array<{key: string, label: string, counts?: {local: number|null, pulled: number|null,
 *   merged: number|null}}>} combinedRecords - Folded keys and their registration, with the row counts of this
 *   device's copy, the downloaded copy and the merged result when the result carried them (null: not countable)
 * @property {Array<{key: string}>} wholeRecords - Keys written whole, when the result named them (empty otherwise,
 *   including for a result from an older caller: the count above is then all there is)
 * @property {Array<{key: string, label: string}>} heldRecords - Held keys and their registration
 * @property {Array<{key: string}>} latchedRecords - Keys the pull latched against writes until a reload, when the
 *   result named them (empty otherwise)
 * @property {Array<{key: string, label: string}>} overwrittenRecords - Failed folds and their registration
 */

/**
 * Roll a pull result up into what the toast and the panel draw.
 *
 * Tolerant of a partial result on purpose: a pull that reported nothing about a
 * store still has to produce a summary, and the missing figure is reported as
 * unknown rather than guessed at.
 *
 * @param {Object} [result] - What `applyPayload` returned
 * @param {Array<{store: string, key: string, label: string}>} [result.merged] - Folded records
 * @param {Array<{store: string, key: string, label: string}>} [result.mergeFailed] - Folds that threw
 * @param {Array<{store: string, key: string, label: string}>} [result.mergeHeld] - Records held back
 * @param {Array<{store: string, key: string}>} [result.writtenWholeKeys] - Keys the import wrote that no fold
 *   produced, by store
 * @param {Array<{store: string, key: string}>} [result.latchedKeys] - Keys the import latched (the ones that
 *   forced "Reload now"), by store
 * @param {number|null} [result.latched] - How many keys the import latched; null when not reported
 * @param {Record<string, number>} [result.expected] - Keys each store was asked to write
 * @param {Record<string, number>|null} [result.unchanged] - Keys each store left as they were; null or
 *   missing when not reported
 * @param {string|null} [result.at] - When the pull landed, ISO
 * @param {Object|null} [result.timing] - From {@link finishPullTiming}; null or missing when the pull was not timed
 * @returns {{at: string|null, timing: Object|null, latched: number|null, combined: number, writtenWhole: number, writtenWholePartial: boolean,
 *   held: number, overwritten: number, unchanged: number|null, stores: Array<PullStoreSummary>}}
 */
export function buildPullSummary({
    merged = [],
    mergeFailed = [],
    mergeHeld = [],
    writtenWholeKeys = [],
    latchedKeys = [],
    latched = null,
    expected = {},
    unchanged = null,
    at = null,
    timing = null,
} = {}) {
    const reported = Boolean(unchanged) && typeof unchanged === 'object';
    const rows = new Map();
    /**
     * @param {string} store - Store name
     * @returns {PullStoreSummary}
     */
    const row = (store) => {
        if (!rows.has(store)) {
            rows.set(store, {
                store,
                combined: 0,
                writtenWhole: null,
                held: 0,
                overwritten: 0,
                unchanged: reported ? 0 : null,
                combinedRecords: [],
                wholeRecords: [],
                latchedRecords: [],
                heldRecords: [],
                overwrittenRecords: [],
            });
        }
        return rows.get(store);
    };

    for (const entry of merged || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.combined += 1;
        const counts = cleanCounts(entry.counts);
        store.combinedRecords.push({ key: entry.key, label: entry.label || '', ...(counts ? { counts } : {}) });
    }
    for (const entry of mergeHeld || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.held += 1;
        store.heldRecords.push({ key: entry.key, label: entry.label || '' });
    }
    for (const entry of mergeFailed || []) {
        if (!entry?.store) continue;
        const store = row(entry.store);
        store.overwritten += 1;
        store.overwrittenRecords.push({ key: entry.key, label: entry.label || '' });
    }

    for (const entry of writtenWholeKeys || []) {
        if (!entry?.store) continue;
        row(entry.store).wholeRecords.push({ key: entry.key });
    }

    for (const entry of latchedKeys || []) {
        if (!entry?.store) continue;
        row(entry.store).latchedRecords.push({ key: entry.key });
    }

    // A held key was deleted from the payload before the import, so it is not in
    // the expected count; a failed fold was written whole, so it is. What is
    // left after the folds is therefore exactly the whole writes.
    for (const [store, count] of Object.entries(expected || {})) {
        if (!Number.isFinite(count)) continue;
        const target = row(store);
        target.writtenWhole = Math.max(0, count - target.combined);
    }

    // A failed fold is already named as overwritten, and a store with no expected count has no whole-write
    // figure to name keys against
    for (const target of rows.values()) {
        if (target.writtenWhole === null) {
            target.wholeRecords = [];
            continue;
        }
        const failed = new Set(target.overwrittenRecords.map((record) => record.key));
        target.wholeRecords = target.wholeRecords.filter((record) => !failed.has(record.key));
    }

    if (reported) {
        for (const [store, count] of Object.entries(unchanged)) {
            if (Number.isFinite(count) && count > 0) row(store).unchanged = count;
        }
    }

    const stores = [...rows.values()].sort((a, b) => a.store.localeCompare(b.store));
    const sum = (pick) => stores.reduce((total, store) => total + pick(store), 0);

    return {
        at,
        timing: cleanTiming(timing),
        latched: Number.isFinite(latched) ? latched : null,
        combined: sum((store) => store.combined),
        writtenWhole: sum((store) => store.writtenWhole ?? 0),
        // True when at least one store never reported an expected count, so the
        // whole-write total is a floor rather than the figure
        writtenWholePartial: stores.some((store) => store.writtenWhole === null),
        held: sum((store) => store.held),
        overwritten: sum((store) => store.overwritten),
        unchanged: reported ? sum((store) => store.unchanged ?? 0) : null,
        stores,
    };
}

/**
 * @param {number} count - How many
 * @param {string} word - Singular
 * @returns {string} `1 record` / `2 records`
 */
function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The one line the pull toast carries.
 *
 * Only the outcomes that happened are named: a pull with nothing held should
 * not spend a clause saying so, and a zero next to "held unreadable" reads as a
 * warning that did not fire rather than as an absence.
 *
 * @param {Object|null} summary - From {@link buildPullSummary}
 * @returns {string} A sentence, or '' when there is no summary
 */
export function formatPullSummaryLine(summary) {
    if (!summary) return '';

    const parts = [];
    if (summary.combined > 0) parts.push(`${plural(summary.combined, 'record')} combined`);
    if (summary.writtenWhole > 0) {
        parts.push(`${summary.writtenWholePartial ? 'at least ' : ''}${summary.writtenWhole} written whole`);
    }
    if (summary.held > 0) parts.push(`${summary.held} held unreadable`);
    if (summary.unchanged > 0) parts.push(`${summary.unchanged} already the same`);

    return parts.length ? `Pull applied: ${parts.join(', ')}.` : 'Pull applied: no records changed.';
}

/**
 * One store's counts, for the panel and for anything rendering the summary as text.
 *
 * @param {PullStoreSummary} store - One row of the summary
 * @returns {string} e.g. `settings: 1 combined, 3 written whole, 1 held, 12 unchanged`
 */
export function formatPullStoreLine(store) {
    if (!store) return '';
    const parts = [`${store.combined} combined`];
    parts.push(store.writtenWhole === null ? 'written whole unknown' : `${store.writtenWhole} written whole`);
    parts.push(`${store.held} held`);
    if (store.overwritten > 0) parts.push(`${store.overwritten} overwritten`);
    parts.push(
        store.unchanged === null || store.unchanged === undefined ? 'unchanged unknown' : `${store.unchanged} unchanged`
    );
    return `${store.store}: ${parts.join(', ')}`;
}

/**
 * Keep this pull's summary until the next one, or until the character changes.
 * @param {Object|null} summary - From {@link buildPullSummary}
 * @returns {void}
 */
export function rememberPullSummary(summary) {
    lastSummary = summary || null;
}

/**
 * @returns {Object|null} The last pull's summary this session, or null
 */
export function lastPullSummary() {
    return lastSummary;
}

/**
 * Forget it. Called on a character switch: the summary describes what this
 * device downloaded, and carrying it across a switch would attach one
 * character's pull to another character's screen.
 * @returns {void}
 */
export function clearPullSummary() {
    lastSummary = null;
}

export default {
    UNCHANGED_UNKNOWN,
    countRows,
    beginPullTiming,
    finishPullTiming,
    longestStallDuring,
    buildPullSummary,
    formatPullSummaryLine,
    formatPullStoreLine,
    rememberPullSummary,
    lastPullSummary,
    clearPullSummary,
};
