/**
 * Percentile zone fight estimates
 *
 * A zone's "fights to clear every task here" figure (the task card zone summary and the Task
 * Statistics "Zone Task Progress" rows) used to quote the expected count: remaining kills of the
 * bottleneck monster divided by its kills per fight. Kill counts are random, so that is the count
 * you have finished by about half the time, and it falls furthest short on a rare bottleneck
 * monster. The displayed figure is now a quantile of the fights needed — the count after which
 * the bottleneck's remaining kills have landed with the chosen probability
 * (`taskCombatEstimatePercentile`) — with the median on hover.
 *
 * The quantile comes from the same exact engine the fight-count pre-fills use
 * (`fightsForKillConfidence`, utils/fight-confidence.js), including its spawn-slot model for a
 * zone whose monster can fill more than one slot of a fight. This module only shapes the
 * *displayed* figure; it never feeds a pre-fill. Go on a task card and a click on a zone row
 * still pad the *mean* count with `padFightCount` and their own `combatFightConfidence` plus the
 * flat `taskCombatGoBuffer` floor, so the two never compound: both start from the unpadded mean.
 */

import config from '../../core/config.js';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { fightsForKillConfidence } from '../../utils/fight-confidence.js';
import { formatKMB, timeReadable } from '../../utils/formatters.js';
import { fightsPerHour as simFightsPerHour, ZONE_SIM_HOURS } from './task-zone-bottleneck.js';

/** The coverages the setting offers, in percent */
export const ZONE_ESTIMATE_PERCENTS = [50, 80, 90, 95];

const FALLBACK_PERCENT = 90;

/**
 * The chosen coverage, in percent. Anything unrecognized reads as the schema default.
 * @returns {number} One of {@link ZONE_ESTIMATE_PERCENTS}
 */
export function getZoneEstimatePercent() {
    const fallback = Number(getSettingDefinition('taskCombatEstimatePercentile')?.default ?? FALLBACK_PERCENT);
    const raw = Number(config.getSettingValue('taskCombatEstimatePercentile', String(fallback)));
    if (ZONE_ESTIMATE_PERCENTS.includes(raw)) return raw;
    return ZONE_ESTIMATE_PERCENTS.includes(fallback) ? fallback : FALLBACK_PERCENT;
}

/**
 * The displayed fight estimate for a zone's bottleneck.
 *
 * Falls back to the mean — `percent: null` — when there is nothing random to take a quantile
 * of: a deterministic kill count (a boss, which arrives on a fixed wave), an unknown kill rate,
 * or a bottleneck that can never be cleared.
 *
 * @param {Object} input
 * @param {number} input.meanFights - Expected fights (the bottleneck's `fightsNeeded`)
 * @param {number} input.meanHours - Expected hours (the bottleneck's `hoursNeeded`)
 * @param {number} input.fightsPerHour - Fights the sim cleared per hour
 * @param {number} input.killsNeeded - Bottleneck kills still wanted
 * @param {number|null} input.killsPerFight - Bottleneck kills per fight
 * @param {number|null} [input.slotsPerFight] - Monster slots per fight (`maxSpawnCount`), if known
 * @param {boolean} [input.deterministic] - The bottleneck's kill count is fixed (a boss)
 * @param {number} input.percent - Coverage, in percent
 * @returns {{fightsNeeded: number, hoursNeeded: number, percent: number|null,
 *   medianFightsNeeded: number|null, medianHoursNeeded: number|null}}
 */
export function zoneFightEstimate({
    meanFights,
    meanHours,
    fightsPerHour,
    killsNeeded,
    killsPerFight,
    slotsPerFight = null,
    deterministic = false,
    percent,
}) {
    const mean = {
        fightsNeeded: meanFights,
        hoursNeeded: meanHours,
        percent: null,
        medianFightsNeeded: null,
        medianHoursNeeded: null,
    };
    if (deterministic || !Number.isFinite(meanFights) || !Number.isFinite(meanHours)) return mean;
    if (!(Number(killsPerFight) > 0) || !(Number(fightsPerHour) > 0) || !(Number(killsNeeded) > 0)) return mean;

    const quantile = (confidencePercent) =>
        fightsForKillConfidence({ killsNeeded, killsPerFight, slotsPerFight, confidencePercent });
    const fights = quantile(percent);
    const median = quantile(50);
    if (!Number.isFinite(fights) || !Number.isFinite(median)) return mean;

    return {
        fightsNeeded: fights,
        hoursNeeded: fights / fightsPerHour,
        percent,
        medianFightsNeeded: median,
        medianHoursNeeded: median / fightsPerHour,
    };
}

/**
 * The displayed estimate for a whole zone: the largest per-monster requirement.
 *
 * The mean bottleneck (`computeZoneBottleneck`) is the monster with the largest *expected* time,
 * but a rare monster can average fewer fights than a common one and still need more of them to
 * reach the chosen coverage. So each task monster gets its own quantile (the same engine as
 * {@link zoneFightEstimate}) and the largest one is shown. That maximum is a lower bound on the
 * zone's joint coverage, not the joint percentile itself: every monster is only covered at
 * `percent` on its own, and the kills of different monsters in one fight are not independent
 * of each other. A monster with nothing random to quantile (a boss, an unknown kill rate)
 * contributes its mean.
 *
 * @param {Object} input
 * @param {Array<{hrid: string, name: string, remaining: number, taskCount?: number}>} input.monsterEntries -
 *   The same entries `computeZoneBottleneck` takes
 * @param {Object} input.simResult - Sim result for the zone
 * @param {number} [input.simHours] - Hours the sim covered
 * @param {number|null} [input.slotsPerFight] - Monster slots per fight (`maxSpawnCount`), if known
 * @param {(hrid: string) => boolean} [input.isBoss] - Whether a monster arrives on a fixed wave
 * @param {number} input.percent - Coverage, in percent
 * @returns {{fightsNeeded: number, hoursNeeded: number, percent: number|null, medianFightsNeeded: number|null,
 *   medianHoursNeeded: number|null, limiting: {hrid: string, name: string, taskCount: number}}|null}
 *   Null when there are no entries. `limiting` is the monster that sets the figure (the one the
 *   median hint belongs to). Ties keep the earlier entry.
 */
export function zoneBottleneckEstimate({
    monsterEntries,
    simResult,
    simHours = ZONE_SIM_HOURS,
    slotsPerFight = null,
    isBoss = () => false,
    percent,
}) {
    const fph = simFightsPerHour(simResult, simHours);
    let best = null;
    for (const entry of monsterEntries) {
        const killsPerHour = (simResult?.deaths?.[entry.hrid] ?? 0) / simHours;
        const meanHours = killsPerHour > 0 ? entry.remaining / killsPerHour : Infinity;
        const meanFights = Number.isFinite(meanHours) ? Math.round(fph * meanHours) : Infinity;
        const estimate = zoneFightEstimate({
            meanFights,
            meanHours,
            fightsPerHour: fph,
            killsNeeded: entry.remaining,
            killsPerFight: fph > 0 && killsPerHour > 0 ? killsPerHour / fph : null,
            slotsPerFight,
            deterministic: Boolean(isBoss(entry.hrid)),
            percent,
        });
        if (!best || estimate.hoursNeeded > best.hoursNeeded) {
            best = { ...estimate, limiting: { hrid: entry.hrid, name: entry.name, taskCount: entry.taskCount ?? 1 } };
        }
    }
    return best;
}

/**
 * @param {number|null} percent - Coverage the figure was taken at, or null for the mean
 * @returns {string} " (90%)", or '' for the mean
 */
export function formatPercentSuffix(percent) {
    return Number.isFinite(percent) ? ` (${percent}%)` : '';
}

/**
 * A small circled "?" whose tooltip gives the median next to the main figure.
 * @param {{percent: number|null, medianFightsNeeded: number|null, medianHoursNeeded: number|null}} estimate
 * @returns {HTMLElement|null} Null when the main figure is the mean or already the median
 */
export function createMedianHint(estimate) {
    if (!estimate || !Number.isFinite(estimate.percent) || estimate.percent === 50) return null;
    if (!Number.isFinite(estimate.medianFightsNeeded) || !Number.isFinite(estimate.medianHoursNeeded)) return null;

    const hint = document.createElement('span');
    hint.className = 'mwi-zone-estimate-hint';
    hint.textContent = '?';
    hint.title =
        `Planning for ${estimate.percent}% confidence. ` +
        `Median (50%): ~${formatKMB(estimate.medianFightsNeeded)} fights | ` +
        `${timeReadable(Math.round(estimate.medianHoursNeeded * 3600))}`;
    // The zone row opens its zone on click; hovering for the hint must not need a click
    hint.addEventListener('click', (e) => e.stopPropagation());
    hint.style.cssText =
        'display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; ' +
        'margin-left: 4px; border: 1px solid currentColor; border-radius: 50%; font-size: 9px; line-height: 1; ' +
        'cursor: help; opacity: 0.8;';
    return hint;
}
