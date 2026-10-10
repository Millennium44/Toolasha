/**
 * Combat Zone Bottleneck
 *
 * Given the combat tasks that can be fought in one zone and that zone's combat-sim result,
 * finds the monster whose tasks take longest to finish (the "bottleneck") and the number of
 * fights needed in the zone to clear every task there: the player keeps fighting at the zone's
 * natural spawn mix until the slowest-progressing task is done.
 *
 * Shared by the per-task "zone mode" summary (task-profit-display.js) and the Task Statistics
 * "Zone Task Progress" section, so both always agree.
 */

/** Simulated hours the callers run each zone for; the sim's counters are divided by this. */
export const ZONE_SIM_HOURS = 1;

/**
 * Fights (encounters) the sim cleared per hour. One encounter spawns several monsters, so
 * summing deaths overcounts by the average wave size; the deaths sum is kept as a fallback
 * for sim results that predate the encounter counter.
 * @param {Object} simResult - Combat sim result
 * @param {number} [simHours] - Hours the sim covered
 * @returns {number}
 */
export function fightsPerHour(simResult, simHours = ZONE_SIM_HOURS) {
    if ((simResult?.encounters ?? 0) > 0) return simResult.encounters / simHours;
    return Object.values(simResult?.deaths || {}).reduce((sum, v) => sum + v, 0);
}

/**
 * @param {Array<{hrid: string, name: string, remaining: number, taskCount: number}>} monsterEntries
 *   One entry per task monster in the zone. Duplicate tasks for the same monster must already
 *   be summed into `remaining` (each kill progresses only one task at a time).
 * @param {Object} simResult - Sim result for this zone (`deaths`: monsterHrid -> kills over the run,
 *   optional `encounters`).
 * @param {number} [simHours] - Hours the sim covered
 * @returns {{hoursNeeded: number, fightsNeeded: number, bottleneckHrid: string, bottleneckName: string,
 *   bottleneckTaskCount: number}|null} Null when there are no entries. `hoursNeeded` and
 *   `fightsNeeded` are Infinity when the bottleneck monster was never killed in the sim.
 */
export function computeZoneBottleneck(monsterEntries, simResult, simHours = ZONE_SIM_HOURS) {
    let bottleneck = null;
    let bottleneckHours = -Infinity;
    for (const entry of monsterEntries) {
        const killsPerHour = (simResult?.deaths?.[entry.hrid] ?? 0) / simHours;
        const hoursNeeded = killsPerHour > 0 ? entry.remaining / killsPerHour : Infinity;
        if (!bottleneck || hoursNeeded > bottleneckHours) {
            bottleneck = entry;
            bottleneckHours = hoursNeeded;
        }
    }
    if (!bottleneck) return null;

    const fightsNeeded = Number.isFinite(bottleneckHours)
        ? Math.round(fightsPerHour(simResult, simHours) * bottleneckHours)
        : Infinity;

    return {
        hoursNeeded: bottleneckHours,
        fightsNeeded,
        bottleneckHrid: bottleneck.hrid,
        bottleneckName: bottleneck.name,
        bottleneckTaskCount: bottleneck.taskCount ?? 1,
    };
}
