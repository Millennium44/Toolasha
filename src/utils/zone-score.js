/**
 * The Combat Sim's All Zones "Score" on its Ladder position scale, shared with the task cards' "Best
 * Score" tier search so a card picks the tier the All Zones table would rank first.
 *
 * Lives in `utils` and is shared by global (rollup.config.js) because the sim (sim bundle) and the task
 * cards (ui bundle) both read it.
 */

/** The metrics the Score blends: XP per hour and profit per day, higher better in both */
export const ZONE_SCORE_METRIC_KEYS = ['totalXP', 'profitDay'];

/**
 * Score rows by ladder position: each row's place in each metric's ladder as a fraction (best 1, worst
 * 0; equal figures share a place), averaged, out of 100. A metric where every row is equal gives every
 * row 1. A missing figure counts as 0.
 *
 * Mutates and returns the rows, adding `score` (a whole number).
 * @param {Array<Object>} rows - Rows carrying the metric keys
 * @param {Array<string>} [keys] - Which metrics to blend
 * @returns {Array<Object>} The same rows
 */
export function ladderScoreRows(rows, keys = ZONE_SCORE_METRIC_KEYS) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return list;
    const fractions = new Map(list.map((row) => [row, []]));
    for (const key of keys) {
        const values = list.map((row) => (Number.isFinite(row[key]) ? row[key] : 0));
        // Best first, duplicates collapsed, so equal figures share a position
        const ladder = [...new Set(values)].sort((a, b) => b - a);
        if (ladder.length < 2) {
            for (const row of list) fractions.get(row).push(1);
            continue;
        }
        list.forEach((row, i) => {
            const place = ladder.indexOf(values[i]);
            fractions.get(row).push(1 - place / (ladder.length - 1));
        });
    }
    for (const row of list) {
        const parts = fractions.get(row);
        row.score = Math.round((100 * parts.reduce((sum, value) => sum + value, 0)) / parts.length);
    }
    return list;
}
