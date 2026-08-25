/**
 * The daily net worth calendar.
 *
 * The gold sources panel answers "where did the gold come from"; this answers
 * the cheaper question next to it — "which days were good ones" — over a couple
 * of months at a glance, one cell per day.
 *
 * ## What a cell is allowed to say
 *
 * A cell is the day's *measured* change: the last snapshot of that day against
 * the last snapshot of the previous day with a snapshot. Three things follow
 * from that, and all three are deliberate:
 *
 * - A day nothing was recorded on is **no data**, drawn dim, and is never drawn
 *   as a flat zero. "You did not play" and "you played and came out even" are
 *   different statements and a zero would tell the second one.
 * - The first day of the history has nothing before it to subtract, so it is no
 *   data too, however many snapshots it holds. A lone snapshot measures a
 *   balance, not a change.
 * - When the previous close is more than one day back, the whole change across
 *   the silence lands on the later day and the cell is marked. Spreading it
 *   evenly over the quiet days would invent play that did not happen, and
 *   dropping it would lose real gold; marking it is the only honest option
 *   left, and the mark is what stops the marked day being read as one day's
 *   work.
 *
 * The arithmetic here is pure and takes the series as an argument, so the panel
 * can draw a calendar in a test with no IndexedDB.
 */

/** How many weeks the grid covers */
export const CALENDAR_WEEKS = 8;

/** Grid weeks start on Sunday, as the game's own week does */
const WEEK_START_DAY = 0;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar day a timestamp falls on, in the reader's own timezone.
 *
 * `toISOString().slice(0, 10)` buckets by UTC day, which for anyone west of
 * Greenwich splits an evening across two cells and mislabels both. This is the
 * same keying the calibration daily series uses; a day here means the day the
 * user experienced, not the day Greenwich did.
 *
 * @param {number} timestamp - Epoch ms
 * @returns {string} `YYYY-MM-DD`
 */
export function localDayKey(timestamp) {
    const date = new Date(timestamp);
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
 * Rounded rather than floored because a DST boundary makes one of the days 23
 * or 25 hours long, and a floor turns that into an off-by-one gap.
 *
 * @param {string} from - Earlier day id
 * @param {string} to - Later day id
 * @returns {number} Whole days, or NaN
 */
export function daysApart(from, to) {
    const a = localDayStart(from);
    const b = localDayStart(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
    return Math.round((b - a) / DAY_MS);
}

/**
 * The day id `offset` days after `dayId`.
 * @param {string} dayId - `YYYY-MM-DD`
 * @param {number} offset - Days, may be negative
 * @returns {string} Day id
 */
export function shiftDay(dayId, offset) {
    const start = localDayStart(dayId);
    if (!Number.isFinite(start)) return dayId;
    const date = new Date(start);
    date.setDate(date.getDate() + offset);
    return localDayKey(date.getTime());
}

/**
 * The net worth measured at the end of each local day.
 *
 * The last snapshot of a day is that day's close. Days the player never logged
 * in on are simply absent — they are not carried forward from the day before,
 * because a carried close would manufacture a zero-change day.
 *
 * @param {Array<Object>} series - Snapshots `{t, total}`, any order
 * @returns {Array<{day: string, t: number, total: number, samples: number}>} Oldest first
 */
export function dailyLocalCloses(series) {
    const byDay = new Map();

    for (const point of Array.isArray(series) ? series : []) {
        if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.total)) continue;
        const day = localDayKey(point.t);
        const held = byDay.get(day);
        if (!held) {
            byDay.set(day, { day, t: point.t, total: point.total, samples: 1 });
            continue;
        }
        held.samples += 1;
        if (point.t >= held.t) {
            held.t = point.t;
            held.total = point.total;
        }
    }

    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Per-day measured changes, keyed by local day.
 *
 * Only days that have a close *and* an earlier close to subtract get an entry;
 * everything else is absent, which the grid draws as no data.
 *
 * @param {Array<Object>} series - Snapshots `{t, total}`
 * @returns {Map<string, {delta: number, gapDays: number, spansGap: boolean, samples: number, total: number}>} Deltas
 */
export function dailyDeltas(series) {
    const closes = dailyLocalCloses(series);
    const deltas = new Map();

    for (let i = 1; i < closes.length; i += 1) {
        const current = closes[i];
        const previous = closes[i - 1];
        const gapDays = daysApart(previous.day, current.day);
        deltas.set(current.day, {
            delta: current.total - previous.total,
            gapDays,
            spansGap: Number.isFinite(gapDays) && gapDays > 1,
            samples: current.samples,
            total: current.total,
        });
    }

    return deltas;
}

/**
 * Best day, worst day, and how the window split between up and down.
 * @param {Array<Object>} cells - Cells with `delta`
 * @returns {{best: Object|null, worst: Object|null, positive: number, negative: number, measured: number}} Summary
 */
export function summarise(cells) {
    let best = null;
    let worst = null;
    let positive = 0;
    let negative = 0;
    let measured = 0;

    for (const cell of cells || []) {
        if (!cell || !Number.isFinite(cell.delta)) continue;
        measured += 1;
        if (cell.delta > 0) positive += 1;
        else if (cell.delta < 0) negative += 1;
        if (best === null || cell.delta > best.delta) best = cell;
        if (worst === null || cell.delta < worst.delta) worst = cell;
    }

    return { best, worst, positive, negative, measured };
}

/**
 * The whole grid: the last `weeks` weeks of days, oldest first, padded out to
 * whole weeks so the columns line up under their weekday.
 *
 * @param {Array<Object>} series - Snapshots `{t, total}`
 * @param {Object} [options] - Overrides
 * @param {number} [options.now] - Clock, injectable for tests
 * @param {number} [options.weeks] - How many weeks to cover
 * @returns {{cells: Array<Object>, weeks: Array<Array<Object|null>>, summary: Object, maxMagnitude: number}} The grid
 */
export function buildNetworthCalendar(series, { now = Date.now(), weeks = CALENDAR_WEEKS } = {}) {
    const deltas = dailyDeltas(series);
    const today = localDayKey(now);
    const span = Math.max(1, Math.round(weeks)) * 7;

    // Pad the start back to the week boundary so every column is a whole week
    let first = shiftDay(today, -(span - 1));
    const firstWeekday = new Date(localDayStart(first)).getDay();
    const pad = (firstWeekday - WEEK_START_DAY + 7) % 7;
    first = shiftDay(first, -pad);

    const cells = [];
    for (let day = first; daysApart(day, today) >= 0; day = shiftDay(day, 1)) {
        const measured = deltas.get(day) || null;
        cells.push({
            day,
            weekday: new Date(localDayStart(day)).getDay(),
            delta: measured ? measured.delta : null,
            gapDays: measured ? measured.gapDays : null,
            spansGap: Boolean(measured?.spansGap),
            isToday: day === today,
        });
    }

    const grid = [];
    for (let i = 0; i < cells.length; i += 7) {
        const week = cells.slice(i, i + 7);
        while (week.length < 7) week.push(null);
        grid.push(week);
    }

    let maxMagnitude = 0;
    for (const cell of cells)
        if (Number.isFinite(cell.delta)) maxMagnitude = Math.max(maxMagnitude, Math.abs(cell.delta));

    return { cells, weeks: grid, summary: summarise(cells), maxMagnitude };
}
