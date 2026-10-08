/**
 * The retention window of the per-day recorders, told to sync.
 *
 * The combat-loot, item-flow, chest-opening and production-income recorders
 * keep one row per local day and drop the rows older than their
 * `RETENTION_DAYS` whenever they save. A key whose rows are all gone is
 * deleted, and absence is not a deletion to sync: the gist kept the key, and
 * every pull wrote it back, to be pruned again by the next save and written
 * back by the next pull — a "Reload now" toast after every exchange, for good.
 *
 * The rule here is the recorders' own: a key is kept while it can still hold a
 * row from the last `RETENTION_DAYS` days. The reference is the local day (the
 * recorders' `localDayId(Date.now() - …)`), capped at the newest key in the
 * union so an idle or clock-skewed device never prunes more than its owner
 * would. Keys are chunked by UTC date of the row's local midnight, which can
 * be one day before the row's day east of UTC, so a key's latest possible row
 * is the day after its date (and for a month key, the day after its last day).
 * That makes the rule at most a day more lenient than the recorders' pruning,
 * never stricter: it never deletes a row a recorder would keep.
 *
 * @module features/networth/day-row-retention
 */

import { registerSyncRetention } from '../../utils/sync-merge-registry.js';
import { localDayId } from './gold-sources.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days since the epoch of a `YYYY-MM-DD` id.
 * @param {string} id - Local day id
 * @returns {number} Whole days
 */
function dayNumber(id) {
    const [year, month, day] = String(id).split('-').map(Number);
    return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/**
 * The recorders' own pruning, as a function of one chunk's rows: a row older than the window is dropped
 * (`localDayId(now - days)` is the floor, as in each recorder's `_save`). A fold of two copies of a chunk runs
 * through this, so the day rows of a month chunk the key rule keeps (the one straddling the window) are not
 * handed back by the gist either.
 * @param {number} days - The recorder's `RETENTION_DAYS`
 * @param {() => number} [now] - The clock, for tests
 * @returns {(rows: Array<{d: string}>) => Array<{d: string}>} The pruner
 */
export function pruneDayRows(days, now = () => Date.now()) {
    return (rows) => {
        const floor = localDayId(now() - days * DAY_MS);
        return rows.filter((row) => row?.d >= floor);
    };
}

/**
 * Register the retention rule for one per-day recorder family.
 * @param {Object} options - The family
 * @param {string} options.store - Object store the keys live in
 * @param {string} options.recordPrefix - The recorder's key prefix (keys are `<prefix>_<charId>_<chunk>`)
 * @param {number} options.days - The recorder's `RETENTION_DAYS`
 * @param {'day'|'month'} options.granularity - How wide a chunk key is (`YYYY-MM-DD` or `YYYY-MM`)
 * @param {() => number} [options.now] - The clock, for tests
 * @returns {() => void} Unregister, mostly for tests
 */
export function registerDayRowRetention({ store, recordPrefix, days, granularity, now = () => Date.now() }) {
    const dayPart = granularity === 'day' ? String.raw`-(\d{2})` : '';
    const pattern = new RegExp(String.raw`^${recordPrefix}_([0-9a-zA-Z]+)_(\d{4})-(\d{2})` + dayPart + '$');
    return registerSyncRetention({
        store,
        prefix: `${recordPrefix}_`,
        parse: (key) => {
            const match = pattern.exec(key);
            if (!match) return null;
            const year = Number(match[2]);
            const month = Number(match[3]);
            const first = Math.round(Date.UTC(year, month - 1, granularity === 'day' ? Number(match[4]) : 1) / DAY_MS);
            const last = granularity === 'day' ? first : Math.round(Date.UTC(year, month, 0) / DAY_MS);
            return { group: match[1], order: first, end: last + 1 };
        },
        maxAge: { span: days, now: () => dayNumber(localDayId(now())) },
    });
}
