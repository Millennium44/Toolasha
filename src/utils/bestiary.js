/**
 * The Bestiary's arithmetic, and what a zone is worth to it.
 *
 * The game keeps a kill count per monster and pays Bestiary points for it on
 * powers of ten: the first kill is worth 1 point, the tenth 2 more, the
 * hundredth 3 more, and so on — `calculatePointsFromCount` in the client,
 * copied here as {@link pointsFromCount}. Points feed the Bestiary milestones
 * (chests) and the "Hunter" achievements.
 *
 * A zone's worth, then, is how many of those thresholds its monsters cross per
 * hour of fighting there, which is the kill rate the simulator already
 * measures (`simResult.deaths[monsterHrid]`) against the counts the Bestiary
 * tab holds (`monsters_updated`, captured by the data manager). Nothing here
 * reads the game; everything is an argument, so the optimizer is a table of
 * pure functions and the panel decides what to draw.
 */

/** The prefix the simulator's monster units carry in `deaths` */
const MONSTER_PREFIX = '/monsters/';

/**
 * Points a kill count has earned: one per power of ten reached, weighted by
 * its rank — 1 for the first kill, +2 at 10, +3 at 100, +4 at 1,000 …
 * @param {number} count - Monsters defeated
 * @returns {number}
 */
export function pointsFromCount(count) {
    const n = Math.floor(Number(count) + 1e-9);
    if (!(n >= 1)) return 0;
    let points = 0;
    let threshold = 1;
    let step = 1;
    while (n >= threshold && threshold < 1e14) {
        points += step;
        threshold *= 10;
        step += 1;
    }
    return points;
}

/**
 * The next kill count worth a point: the first power of ten past `count`.
 * @param {number} count - Monsters defeated
 * @returns {number} 1 for an unmet monster, else 10, 100, …
 */
export function nextPointCount(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    let threshold = 1;
    while (threshold <= n && threshold < 1e14) threshold *= 10;
    return threshold;
}

/**
 * Kills per hour by monster, off a simulation result.
 * @param {Object} simResult - From the simulator (`deaths` keyed by unit hrid)
 * @param {number} simHours - The run's length in hours
 * @returns {Object} monsterHrid → kills/hour
 */
export function monsterKillsPerHour(simResult, simHours) {
    const out = {};
    const hours = Number(simHours) > 0 ? Number(simHours) : 0;
    if (!hours) return out;
    for (const [hrid, deaths] of Object.entries(simResult?.deaths || {})) {
        if (!String(hrid).startsWith(MONSTER_PREFIX)) continue;
        const n = Number(deaths) || 0;
        if (n > 0) out[hrid] = n / hours;
    }
    return out;
}

/**
 * The Bestiary counts as the game sends them, keyed by monster.
 * @param {Array<{monsterHrid: string, count: number}>} monsters - `monsters_updated.monsters`
 * @returns {Object} monsterHrid → count
 */
export function countsByMonster(monsters) {
    const out = {};
    for (const entry of monsters || []) {
        if (!entry?.monsterHrid) continue;
        out[entry.monsterHrid] = Math.max(0, Math.floor(Number(entry.count) || 0));
    }
    return out;
}

/**
 * What fighting a zone does for the Bestiary over a horizon.
 *
 * For each monster the zone kills: the count it would reach in `hours` at the
 * simulated rate, the points that crossing earns, and how long the first of
 * those points takes. A monster the zone kills but the Bestiary has no row
 * for counts from zero — which is exactly the case the Bestiary pays most for.
 *
 * @param {Object} input
 * @param {Object} input.killsPerHour - monsterHrid → kills/hour (see {@link monsterKillsPerHour})
 * @param {Object} input.counts - monsterHrid → defeated so far (see {@link countsByMonster})
 * @param {number} [input.hours=24] - Horizon
 * @returns {{pointsGained: number, pointsPerDay: number, firstPointHours: number|null,
 *   monsters: Array<{monsterHrid: string, count: number, killsPerHour: number, nextAt: number,
 *   hoursToNext: number, pointsGained: number}>}}
 */
export function zoneBestiaryOutlook({ killsPerHour = {}, counts = {}, hours = 24 } = {}) {
    const horizon = Number(hours) > 0 ? Number(hours) : 24;
    const monsters = [];
    let pointsGained = 0;
    let firstPointHours = null;

    for (const [hrid, rate] of Object.entries(killsPerHour)) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        const count = Math.max(0, Math.floor(Number(counts[hrid]) || 0));
        const reached = count + perHour * horizon;
        const gained = pointsFromCount(reached) - pointsFromCount(count);
        const nextAt = nextPointCount(count);
        const hoursToNext = (nextAt - count) / perHour;
        if (firstPointHours === null || hoursToNext < firstPointHours) firstPointHours = hoursToNext;
        pointsGained += gained;
        monsters.push({ monsterHrid: hrid, count, killsPerHour: perHour, nextAt, hoursToNext, pointsGained: gained });
    }

    monsters.sort((a, b) => a.hoursToNext - b.hoursToNext);
    return {
        pointsGained,
        pointsPerDay: (pointsGained / horizon) * 24,
        firstPointHours,
        monsters,
    };
}
