/**
 * Daily experience checkpoints.
 *
 * One reading per series per local day, kept forever.
 *
 * ## Why this is not the XP tracker
 *
 * `features/skills/xp-tracker.js` already keeps a series of experience readings
 * — and deliberately throws away everything older than a week, thins the last
 * ten minutes to two points, and collapses runs of equal experience. Those
 * rules are what make a *rate* cheap to compute and are load-bearing for its
 * cross-device merge, which replays the union through the same thinning. They
 * also make it structurally incapable of answering "how much did I gain this
 * month": the answer left the array six days ago.
 *
 * Widening that window is the obvious move and the wrong one. It would change
 * the shape of a record two devices merge by replaying, and a merge whose
 * replay rules moved is a merge whose output depends on which build wrote it.
 * So this is a second, much smaller series beside it: one entry per series per
 * day, never thinned, never compacted.
 *
 * ## What an entry means, and what it never means
 *
 * `{d, k, xp, level}` — the day (local, `YYYY-MM-DD`), the series key, and the
 * experience and level *as they stood at the moment the checkpoint was taken*.
 * It is a reading, not a total for the day: the gain attributed to day D is
 * `xp(D+1) - xp(D)`.
 *
 * **Nothing is ever backfilled.** The history starts on the first day this ran,
 * and a checkpoint reconstructed from the XP tracker's thinned week would be a
 * fabrication — the tracker's own compaction has already moved the timestamps
 * it would be read from. Every surface built on this says which day the history
 * starts, because that is the difference between "you gained nothing in March"
 * and "there was nothing recording in March".
 *
 * **A day with no play still gets a checkpoint**, and it records the same
 * experience as the day before. That flat entry is the truth — the account did
 * not move — and it must not be mistaken for a missing day and dropped, because
 * it is exactly what stops an idle stretch being averaged out of a rate.
 *
 * ## Storage
 *
 * `utils/chunked-history.js`, one record per calendar month, so a day's write
 * touches this month and nothing else. Retention is unbounded by maintainer
 * decision: the entries are tiny (four short fields), and the whole point is
 * the long window.
 */

import storage from '../core/storage.js';
import { createChunkedHistory, timeChunkId } from './chunked-history.js';

/** Milliseconds in an hour, for turning a day span into a rate */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The local calendar day a timestamp falls in.
 *
 * Local rather than UTC because the question these answer is "what did I gain
 * this month", and a month is the user's own calendar. The chunk a record
 * lives in is still UTC (`timeChunkId`) — a chunk id is an address, not a date.
 *
 * @param {number} t - Milliseconds since the epoch
 * @returns {string} `YYYY-MM-DD`
 */
export function localDayKey(t) {
    const date = new Date(Number.isFinite(t) ? t : 0);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Local midnight at the start of a day id.
 * @param {string} dayId - `YYYY-MM-DD`
 * @returns {number} Epoch ms, or NaN when the id is not one
 */
export function localDayStart(dayId) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayId || ''));
    if (!match) return NaN;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/**
 * How many calendar days apart two day ids are.
 *
 * Rounded rather than floored: a clocks-go-back day is twenty-five hours long,
 * and a floor turns that into an off-by-one.
 *
 * @param {string} from - Earlier day id
 * @param {string} to - Later day id
 * @returns {number} Whole days, or NaN when either id is not one
 */
export function dayDiff(from, to) {
    const a = localDayStart(from);
    const b = localDayStart(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    return Math.round((b - a) / (24 * HOUR_MS));
}

/**
 * Which month record a checkpoint belongs to.
 * @param {string} dayId - Local day id
 * @returns {string} Chunk id
 */
function chunkOfDay(dayId) {
    return timeChunkId(localDayStart(dayId), 'month');
}

/**
 * One series' checkpoints, oldest first.
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} seriesKey - Which series
 * @returns {Array<Object>} Its checkpoints
 */
export function seriesOf(entries, seriesKey) {
    return (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry && entry.k === seriesKey && typeof entry.d === 'string')
        .sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * The first day this series was ever recorded.
 *
 * Every surface that reports a gain has to be able to say this, because a small
 * number means "you gained little" and "nothing was watching" equally well, and
 * only the start date tells them apart.
 *
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} seriesKey - Which series
 * @returns {string|null} Local day id, or null when nothing is recorded
 */
export function historyStart(entries, seriesKey) {
    return seriesOf(entries, seriesKey)[0]?.d ?? null;
}

/**
 * What a series gained from its first checkpoint on or after a day.
 *
 * Measured against a live experience total rather than the last checkpoint, so
 * today's play counts today rather than tomorrow. `since` is the day the
 * measurement actually starts from — which is the first checkpoint at or after
 * `fromDay`, not `fromDay` itself, whenever the history is younger than the
 * window asked for.
 *
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} seriesKey - Which series
 * @param {string} fromDay - Local day id the window opens on
 * @param {number} currentXp - Experience as it stands now
 * @returns {{gained: number, since: string}|null} Null when the window holds no
 *   checkpoint, or when the live total is not a number
 */
export function gainedSince(entries, seriesKey, fromDay, currentXp) {
    if (!Number.isFinite(currentXp)) return null;
    const series = seriesOf(entries, seriesKey);
    const anchor = series.find((entry) => entry.d >= fromDay && Number.isFinite(entry.xp));
    if (!anchor) return null;
    // Clamped at zero: experience cannot fall, so a negative is a reading from
    // somewhere else — a different character, a restored backup — and reporting
    // it as a loss would be inventing one
    return { gained: Math.max(0, currentXp - anchor.xp), since: anchor.d };
}

/**
 * The rate a long window of checkpoints measures, and how idle that window was.
 *
 * A per-hour figure from a fortnight of checkpoints is only honest beside the
 * count of days that actually recorded a gain: three days of fighting spread
 * over fourteen is a real measurement of a fortnight and a badly misleading
 * measurement of an hour of fighting. Both numbers come back so no caller can
 * show one without the other.
 *
 * Idle days are counted in the elapsed time on purpose — they are true zeros,
 * not gaps. A day the script did not run at all is one interval however long it
 * lasted, so a week away counts once towards `daysWithGain` and seven times
 * towards `days`; the label is conservative in the direction that warns.
 *
 * @param {Array<Object>} entries - Every checkpoint held
 * @param {string} seriesKey - Which series
 * @param {number} [minDays] - Shortest window worth reporting
 * @returns {{experiencePerHour: number, days: number, daysWithGain: number, gained: number,
 *   from: string, to: string}|null} Null when the window is too short or nothing was gained
 */
export function checkpointRate(entries, seriesKey, minDays = 3) {
    const series = seriesOf(entries, seriesKey).filter((entry) => Number.isFinite(entry.xp));
    if (series.length < 2) return null;

    const first = series[0];
    const last = series[series.length - 1];
    const days = dayDiff(first.d, last.d);
    if (!Number.isFinite(days) || days < minDays) return null;

    const gained = last.xp - first.xp;
    if (!(gained > 0)) return null;

    let daysWithGain = 0;
    for (let i = 1; i < series.length; i++) {
        if (series[i].xp > series[i - 1].xp) daysWithGain++;
    }
    if (daysWithGain === 0) return null;

    // Real elapsed milliseconds rather than `days * 24h`, so the two clock
    // changes a long window contains do not each add or lose an hour of rate
    const elapsedHours = (localDayStart(last.d) - localDayStart(first.d)) / HOUR_MS;
    if (!(elapsedHours > 0)) return null;

    return { experiencePerHour: gained / elapsedHours, days, daysWithGain, gained, from: first.d, to: last.d };
}

/**
 * A checkpoint series persisted per character.
 *
 * @param {Object} options - Wiring
 * @param {string} options.storeName - Object store the records live in
 * @param {string} options.prefix - Record key prefix, e.g. `skillCheckpointRec`
 * @param {Function} options.legacyKey - `(charId) => string`, the pre-split single key
 * @param {string} options.label - Module name for log lines
 * @returns {DailyCheckpoints} The store
 */
export function createDailyCheckpoints(options) {
    return new DailyCheckpoints(options);
}

class DailyCheckpoints {
    constructor({ storeName, prefix, legacyKey, label = 'DailyCheckpoints' }) {
        this.label = label;
        this._store = createChunkedHistory({
            storeName,
            prefix,
            legacyKey,
            groupOf: (entry) => chunkOfDay(entry?.d),
            compare: (a, b) => String(a?.d || '').localeCompare(String(b?.d || '')) || comparePart(a?.k, b?.k),
            // A checkpoint is identified by its day and its series and nothing
            // else. The default deep-equality identity would let a device that
            // wrote 4,000 xp for Monday and one that wrote 4,100 both survive a
            // merge, and the day would then have two truths
            identityOf: (entry) => `${entry?.d}|${entry?.k}`,
            label,
        });

        /** The entries as they stand, which is the truth between debounced writes */
        this._entries = [];
        /** Whose entries those are */
        this._charId = null;
        /** The read in flight, so concurrent recordings wait on one of them */
        this._loading = null;
        /**
         * Bumped whenever the character changes. Anything read under an old
         * generation belongs to whoever left, and adopting it would file their
         * days under the arriving character's key.
         */
        this._generation = 0;
    }

    /**
     * Every checkpoint held for a character, oldest first.
     *
     * A save hands the chunked store the whole list as the truth and deletes
     * every record the list does not mention, so nothing may write before this
     * has landed. Concurrent callers share the one read rather than racing two.
     *
     * @param {string} charId - Whose checkpoints
     * @returns {Promise<Array<Object>>} The entries
     */
    async load(charId) {
        if (!charId) return [];
        if (this._charId === charId && !this._loading) return [...this._entries];

        const generation = this._generation;

        if (!this._loading) {
            this._charId = charId;
            this._loading = (async () => {
                const entries = await this._store.load(charId);
                // The character switched while the read was in flight: these
                // are the departing character's days, and `forget()` has
                // already cleared the fields this would otherwise refill
                if (this._generation !== generation) return;
                this._entries = entries;
            })();
        }

        try {
            await this._loading;
        } finally {
            if (this._generation === generation) this._loading = null;
        }
        return this._generation === generation ? [...this._entries] : [];
    }

    /** @returns {Array<Object>} The entries in memory, without a read */
    peek() {
        return [...this._entries];
    }

    /** @returns {string|null} Whose entries are in memory */
    characterId() {
        return this._charId;
    }

    /**
     * Write today's checkpoint for every series that has not got one yet.
     *
     * Once per day per series, which is what makes this safe to call from any
     * event that happens to fire — an init, a levelling message, a panel
     * opening. A series that already has today's entry is left exactly as it
     * was rather than updated: the checkpoint is a reading taken at a moment,
     * and moving that moment forward through the day would shrink the window
     * every gain is measured over.
     *
     * @param {string} charId - Whose checkpoints
     * @param {Array<{k: string, xp: number, level: number}>} samples - Readings
     * @param {number} [now] - Clock, injectable for tests
     * @returns {Promise<number>} How many checkpoints were written
     */
    async recordToday(charId, samples, now = Date.now()) {
        if (!charId || !Array.isArray(samples) || samples.length === 0) return 0;
        // Nothing below can be stored, and a read of the whole history is not
        // free for a write that will be refused
        if (storage.isQuotaExceeded?.()) return 0;

        const generation = this._generation;
        await this.load(charId);
        // The character switched while the entries were being read; these
        // readings belong to whoever left
        if (this._generation !== generation || this._charId !== charId) return 0;

        const day = localDayKey(now);
        const have = new Set(this._entries.filter((entry) => entry?.d === day).map((entry) => entry.k));

        const added = [];
        for (const sample of samples) {
            if (!sample?.k || !Number.isFinite(sample.xp)) continue;
            if (have.has(sample.k)) continue;
            have.add(sample.k);
            added.push({
                d: day,
                k: sample.k,
                xp: sample.xp,
                level: Number.isFinite(sample.level) ? sample.level : 0,
            });
        }
        if (added.length === 0) return 0;

        this._entries = this._entries.concat(added);
        // Not awaited: the write is debounced, so its promise resolves when the
        // timer fires rather than when the data lands, and the entrypoint's
        // `flushAll()` on unload is what makes the last one stick
        this._store.save(charId, this._entries, { changedChunks: chunkOfDay(day) });
        return added.length;
    }

    /** Forget the departing character's entries, so they are never written under the arriving one's key. */
    forget() {
        this._generation += 1;
        this._entries = [];
        this._charId = null;
        this._loading = null;
        this._store.forget();
    }
}

/**
 * Order two series keys, tolerating a missing one.
 * @param {*} a - Left key
 * @param {*} b - Right key
 * @returns {number} Comparator result
 */
function comparePart(a, b) {
    return String(a || '').localeCompare(String(b || ''));
}

export default { createDailyCheckpoints, localDayKey, localDayStart, dayDiff };
