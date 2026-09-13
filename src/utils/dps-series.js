/**
 * Damage per second over time, from cumulative totals read on a timer.
 *
 * The run-side tracker keeps totals, not a history: it can say who has done
 * how much since the run began and nothing about when. A graph needs the when,
 * so this keeps fixed-width time buckets and fills them from the difference
 * between one reading of the totals and the next. Reading totals rather than
 * hooking the tracker's tick keeps the tracker untouched and means a missed
 * reading loses nothing — the next one carries the difference.
 *
 * The shape is KikiMeter's (ZhuLiMoon, MIT): 2-second buckets, a five-minute
 * recent window beside the whole session, a 16-second trailing average, and a
 * boss flag per bucket. The arithmetic here is Toolasha's.
 *
 * ## A late reading is spread, not stacked
 *
 * A background tab's timers are throttled to about once a minute. The damage
 * done in that minute arrives in one reading, and filed into one bucket it
 * draws as a spike thirty times the real rate. So a reading's difference is
 * shared evenly across every bucket since the previous reading.
 *
 * ## The first reading is a baseline
 *
 * Totals already standing when sampling began have no time attached, so they
 * are not drawn as if done in the first two seconds. A series reset because the
 * tracker itself reset starts from zero instead — there the totals really did
 * begin with the series.
 */

/** Bucket width */
export const BUCKET_MS = 2000;

/** Five minutes of buckets, for the recent window */
export const RECENT_BUCKETS = 150;

/** About an hour of buckets; older ones are dropped */
export const MAX_BUCKETS = 1900;

/** The trailing average, in buckets: sixteen seconds */
export const SMOOTH_BUCKETS = 8;

/**
 * An empty series.
 * @param {Object} [options] - Shape
 * @param {number} [options.bucketMs] - Bucket width
 * @param {number} [options.maxBuckets] - Most buckets kept
 * @param {boolean} [options.fromZero] - Whether totals begin at zero with this series
 * @returns {Object} A series
 */
export function newDpsSeries({ bucketMs = BUCKET_MS, maxBuckets = MAX_BUCKETS, fromZero = false } = {}) {
    return {
        bucketMs,
        maxBuckets,
        fromZero,
        startAt: null,
        lastIndex: -1,
        buckets: [],
        totals: {},
        names: {},
    };
}

/**
 * A bucket, created on demand.
 * @param {Object} series - The series
 * @param {number} index - Bucket index
 * @returns {Object} `{damage: {key: number}, party: number, boss: boolean}`
 */
function bucketAt(series, index) {
    while (series.buckets.length <= index) series.buckets.push({ damage: {}, party: 0, boss: false });
    return series.buckets[index];
}

/**
 * Fold one reading of the cumulative totals into the series.
 *
 * @param {Object} series - From {@link newDpsSeries}, mutated
 * @param {number} at - When the reading was taken (ms)
 * @param {Array<{key: string, name?: string, damage: number}>} rows - Cumulative damage per player
 * @param {Object} [options] - Context
 * @param {boolean} [options.boss] - Whether a boss was being fought when the reading was taken
 */
export function noteTotals(series, at, rows, { boss = false } = {}) {
    if (!series || !Number.isFinite(at)) return;
    if (series.startAt === null) series.startAt = at;

    const index = Math.floor((at - series.startAt) / series.bucketMs);
    if (index < series.lastIndex) return;

    const first = series.lastIndex < 0;
    const from = first ? index : Math.min(index, series.lastIndex + 1);
    const span = index - from + 1;

    for (let i = from; i <= index; i++) {
        const bucket = bucketAt(series, i);
        bucket.boss = bucket.boss || Boolean(boss);
    }

    for (const row of rows || []) {
        const key = String(row?.key ?? '');
        if (!key) continue;
        if (row.name) series.names[key] = row.name;

        const total = Number(row.damage) || 0;
        const previous = series.totals[key];
        series.totals[key] = total;

        const baseline = previous === undefined ? (first && !series.fromZero ? null : 0) : previous;
        if (baseline === null) continue;

        const delta = total - baseline;
        if (!(delta > 0)) continue;
        const share = delta / span;
        for (let i = from; i <= index; i++) {
            const bucket = series.buckets[i];
            bucket.damage[key] = (bucket.damage[key] || 0) + share;
            bucket.party += share;
        }
    }

    series.lastIndex = index;

    const excess = series.buckets.length - series.maxBuckets;
    if (excess > 0) {
        series.buckets.splice(0, excess);
        series.startAt += excess * series.bucketMs;
        series.lastIndex -= excess;
    }
}

/**
 * The series as points to draw.
 *
 * The bucket still filling is left out — half a bucket reads as a dip that is
 * not there — and buckets between the last reading and now are drawn as zero,
 * so an idle stretch after a fight falls to the floor rather than holding the
 * last rate (KikiMeter's `advanceBuckets`).
 *
 * @param {Object} series - From {@link newDpsSeries}
 * @param {Object} [options] - What to draw
 * @param {number} [options.now] - Clock
 * @param {'recent'|'session'} [options.window] - Five minutes, or everything kept
 * @param {number} [options.smooth] - Trailing average in buckets
 * @param {number} [options.maxPoints] - Longer windows are averaged down to this
 * @returns {{startAt: number, bucketMs: number, points: Array<Object>, keys: string[], names: Object}|null}
 *   Points carry `t` (ms from `startAt`), `party` and `players` (dps) and `boss`; null before
 *   two whole buckets exist. `keys` are ordered by damage in the window, most first.
 */
export function seriesView(
    series,
    { now = Date.now(), window = 'recent', smooth = SMOOTH_BUCKETS, maxPoints = 300 } = {}
) {
    if (!series || series.startAt === null) return null;

    const end = Math.floor((now - series.startAt) / series.bucketMs) - 1;
    if (end < 1) return null;
    const begin = window === 'session' ? 0 : Math.max(0, end - RECENT_BUCKETS + 1);

    const seconds = series.bucketMs / 1000;
    const read = (i) => series.buckets[i] || { damage: {}, party: 0, boss: false };

    const windowDamage = {};
    for (let i = begin; i <= end; i++) {
        for (const [key, damage] of Object.entries(read(i).damage)) {
            windowDamage[key] = (windowDamage[key] || 0) + damage;
        }
    }
    const keys = Object.keys(windowDamage).sort((a, b) => windowDamage[b] - windowDamage[a]);

    const raw = [];
    for (let i = begin; i <= end; i++) {
        const lo = Math.max(0, i - Math.max(1, smooth) + 1);
        const count = i - lo + 1;
        let party = 0;
        const players = {};
        for (let j = lo; j <= i; j++) {
            const bucket = read(j);
            party += bucket.party;
            for (const key of keys) players[key] = (players[key] || 0) + (bucket.damage[key] || 0);
        }
        for (const key of keys) players[key] = players[key] / count / seconds;
        raw.push({ t: i * series.bucketMs, party: party / count / seconds, players, boss: read(i).boss });
    }

    const factor = Math.max(1, Math.ceil(raw.length / Math.max(2, maxPoints)));
    const points = [];
    for (let i = 0; i < raw.length; i += factor) {
        const group = raw.slice(i, i + factor);
        const players = {};
        for (const key of keys) players[key] = group.reduce((sum, point) => sum + point.players[key], 0) / group.length;
        points.push({
            t: group[0].t,
            party: group.reduce((sum, point) => sum + point.party, 0) / group.length,
            players,
            boss: group.some((point) => point.boss),
        });
    }

    return { startAt: series.startAt, bucketMs: series.bucketMs * factor, points, keys, names: { ...series.names } };
}
