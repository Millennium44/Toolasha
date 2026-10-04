/**
 * The game's count-to-points ladder, shared by the Bestiary and the Collections
 * log: both run the client's `calculatePointsFromCount` — 1 point at a count of
 * 1, +2 at 10, +3 at 100, +4 at 1,000, and so on up to 1e14. A Collections row
 * of 331 Umbral Hoods is 1 + 2 + 3 = 6 points, as the game's tooltip shows.
 *
 * Pure functions with no imports and no module state, so a copy in each bundle
 * that reaches it is only weight.
 */

/** The ladder's last rung: the client stops counting past this */
const POINTS_CAP = 1e14;

/**
 * Points a count has earned: one per power of ten reached, weighted by its
 * rank — 1 for the first, +2 at 10, +3 at 100, +4 at 1,000 …
 * @param {number} count - Monsters defeated, or items collected
 * @returns {number}
 */
export function pointsFromCount(count) {
    const n = Math.floor(Number(count) + 1e-9);
    if (!(n >= 1)) return 0;
    let points = 0;
    let threshold = 1;
    let step = 1;
    while (n >= threshold && threshold < POINTS_CAP) {
        points += step;
        threshold *= 10;
        step += 1;
    }
    return points;
}

/**
 * The next count worth a point: the first power of ten past `count`.
 * @param {number} count - Monsters defeated, or items collected
 * @returns {number} 1 for a count of 0, else 10, 100, …
 */
export function nextPointCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    let threshold = 1;
    while (threshold <= n && threshold < POINTS_CAP) threshold *= 10;
    return threshold;
}
