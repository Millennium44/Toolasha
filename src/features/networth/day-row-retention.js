/**
 * The retention window of the per-day recorders, told to sync.
 *
 * The combat-loot, item-flow, chest-opening and production-income recorders
 * keep one row per local day and drop the rows older than their
 * `RETENTION_DAYS` whenever they save (`localDayId(now - days)` is the floor,
 * `row.d >= floor` survives). A key whose rows are all gone is deleted, and
 * absence is not a deletion to sync: the gist kept the key, and every pull
 * wrote it back, to be pruned again by the next save and written back by the
 * next pull, a "Reload now" toast after every exchange, for good.
 *
 * The rule here is the recorders' own. A key is kept while it can still hold
 * a row at or after the recorder's floor, computed exactly as the recorder
 * computes it (same clock, same local-day function, so DST and every time zone
 * agree). "Can still hold" is exact: a chunk key is the UTC date of the row's
 * local midnight, so the latest row a key can hold is found by running the
 * recorder's own chunking over the candidate days, not by assuming an offset
 * (east of UTC a key's rows run a day past its date, west of UTC they do not).
 * The floor is capped at the newest key in the character's union minus the
 * window, so an idle character's history, which the recorder never prunes
 * while it is not recording, is left alone.
 *
 * @module features/networth/day-row-retention
 */

import { registerSyncRetention } from '../../utils/sync-merge-registry.js';
import { timeChunkId } from '../../utils/chunked-history.js';
import { localDayId, dayStart } from './gold-sources.js';

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
 * Day id of a day number.
 * @param {number} days - Days since the epoch
 * @returns {string} `YYYY-MM-DD`
 */
function dayId(days) {
    return new Date(days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The recorders' own pruning, as a function of rows a pull is about to take from the gist: a row older than
 * the window is left out (`localDayId(now - days)` is the floor, as in each recorder's `_save`). Applied to
 * the gist-only rows alone, never to what this device holds: this device's rows are its owner's to prune, and
 * a character that has not recorded for a while still has history from before the floor that its own last
 * prune left in place (the key rule judges that by the character's newest key, which a fold cannot see). So a
 * pull stops taking back what the recorder pruned without ever deleting a row it holds.
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
    /**
     * The latest local day whose row the recorder would file under this chunk id.
     * @param {string} chunk - `YYYY-MM-DD` or `YYYY-MM`
     * @param {number} firstDay - Day number of the chunk's UTC start
     * @param {number} lastDay - Day number of the chunk's UTC end
     * @returns {number} Day number
     */
    const latestRowDay = (chunk, firstDay, lastDay) => {
        // A row's chunk is the UTC date of its local midnight, so a row sits at most a day or so from the
        // chunk's dates either way; ask the recorder's own chunking rather than assume the offset
        for (let day = lastDay + 2; day >= firstDay - 2; day--) {
            if (timeChunkId(dayStart(dayId(day)), granularity) === chunk) return day;
        }
        return lastDay;
    };
    /**
     * The earliest local day whose row the recorder would file under this chunk id.
     * @param {string} chunk - `YYYY-MM-DD` or `YYYY-MM`
     * @param {number} firstDay - Day number of the chunk's UTC start
     * @param {number} lastDay - Day number of the chunk's UTC end
     * @returns {number} Day number
     */
    const earliestRowDay = (chunk, firstDay, lastDay) => {
        for (let day = firstDay - 2; day <= lastDay + 2; day++) {
            if (timeChunkId(dayStart(dayId(day)), granularity) === chunk) return day;
        }
        return firstDay;
    };
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
            const chunk = granularity === 'day' ? `${match[2]}-${match[3]}-${match[4]}` : `${match[2]}-${match[3]}`;
            return {
                group: match[1],
                order: first,
                start: earliestRowDay(chunk, first, last),
                end: latestRowDay(chunk, first, last),
            };
        },
        maxAge: {
            // The recorder's floor, from the same clock and the same local-day function. A character whose
            // newest key cannot reach today is idle, and its recorder last pruned on some day of that key —
            // possibly its first, for a month key — so the cut never passes that key's EARLIEST possible
            // row less the window; an active character's own prune runs today and the cut is the recorder's
            floor: (newestEnd, newestStart) => {
                const recorderFloor = dayNumber(localDayId(now() - days * DAY_MS));
                if (newestEnd >= dayNumber(localDayId(now()))) return recorderFloor;
                // The recorder's floor is `localDayId(saveTime - days * DAY_MS)`, a wall-clock subtraction. Calendar
                // arithmetic on day numbers is one day stricter than it across a spring DST change, so take the
                // floor of the earliest save that could have filed the newest key's first row: its day's start
                const earliestSave = dayStart(dayId(newestStart));
                return Math.min(recorderFloor, dayNumber(localDayId(earliestSave - days * DAY_MS)));
            },
        },
    });
}
