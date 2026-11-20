/**
 * Talisman line ranking
 *
 * Test server only. Answers "which talisman lines are worth most for what I do, and which set of talismans should I
 * aim for", for the player's real build:
 *
 * - Combat: each combat line is simulated once, at the target grade, in one belt slot, against the same build with
 *   its talismans taken off (a set replaces whatever is slotted, so a line already worn must not read as worth less).
 *   It runs through the Combat Sim's worker runner with the upgrade advisor's measuring rules: one shared seed, one
 *   worker per sim, its metrics, deltas, error bars and significance verdicts (`computeMetrics`, `computeDeltas`,
 *   `rateDeltaNoisePct`, `significantDeltas`). Other grades are scaled from the simulated one by the grade values,
 *   which is linear for additive lines and only an estimate for the defensive and special ones (marked).
 *   With two or more slots the leading lines are simulated again with a copy in every slot, so a second and third
 *   copy are valued by what they add rather than assumed to add as much as the first. The recommended set is then
 *   checked with one combined sim, beside one sim of the talismans worn now.
 * - Skilling: each skilling line is valued exactly at every grade through the existing profit and experience math
 *   (no sim), with the line riding on the action's equipment Map like slotted talismans do.
 *
 * Line value is `gradeValues[grade - 1] * (1 + talismanPower)`; the sim and the skilling math both apply it from the
 * belt on the build being measured, so the belt's power is never a separate input here.
 */

import { isTestServer } from '../../utils/game-server.js';
import { getBeltSlotCount, getTalismanPower, talismanStatName } from '../../utils/talisman-bonuses.js';
import {
    COMBAT_TALISMAN_TYPE,
    DEFAULT_LINES_PER_TALISMAN,
    buildRecommendedSet,
    isSpecialLine,
    lineCopies,
    lineValuesByGrade,
    newlyUnpricedLineCosts,
    planSet,
    scaleAcrossGrades,
    setOptionsFor,
    sortRows,
    stampSetCosts,
    stampValuePerOrb,
    talismanLimits,
    talismanLines,
    toRerollTargets,
} from '../../utils/talisman-line-sets.js';
import { TALISMAN_MECHANICS, computeTalismanCombat } from './engine/talisman-combat.js';
import { TALISMAN_MODELED_STATS } from './engine/player.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { randomSeed } from './engine/rng.js';
import { profitScale } from './trigger-tuning.js';
import config from '../../core/config.js';

// The shared pieces, re-exported for the readers that know them by this module
export {
    COMBAT_TALISMAN_TYPE,
    SKILLING_TALISMAN_TYPE,
    DEFAULT_MAX_GRADE,
    DEFAULT_LINES_PER_TALISMAN,
    DEFAULT_CAP_GRADE,
    DEFAULT_SET_MODE,
    SET_MODES,
    SKILLING_RANKING_METRICS,
    RANKABLE_SKILLING_TYPES,
    arrangeTalismans,
    buildRecommendedSet,
    isSpecialLine,
    lineCopies,
    lineFeeds,
    lineValuesByGrade,
    newlyUnpricedLineCosts,
    scaleAcrossGrades,
    skillingStatsRead,
    sortRows,
    splitSkillingLines,
    runSkillingLineRanking,
    talismanLimits,
    talismanLines,
    toRerollTargets,
} from '../../utils/talisman-line-sets.js';

/** The sim player's belt slot key (`dto.equipment`), not the item location the live equipment Map uses */
export const SIM_BELT_TYPE = '/equipment_types/belt';

/** How many of the leading combat lines are simulated again with a copy in every slot */
export const COPIES_SHORTLIST = 6;

/** Groups whose effect is not linear in the line's value (divide-by-(1+x), thresholds, survival) */
const NONLINEAR_GROUPS = new Set(['/talisman_modifier_groups/defense', '/talisman_modifier_groups/special']);

/**
 * What a combat ranking can be measured by: the upgrade advisor's metrics, as rates per hour.
 * `rate` reads a `computeMetrics` record; `delta` is the key in its `computeDeltas`, noise and verdict records.
 */
export const COMBAT_RANKING_METRICS = [
    { key: 'dps', label: 'DPS', rate: (m) => m.dps, lowerIsBetter: false },
    { key: 'xp', label: 'EXP/hr', rate: (m) => m.xpPerHour, lowerIsBetter: false },
    { key: 'profit', label: 'Profit/hr', rate: (m) => m.profitPerHour, lowerIsBetter: false },
    { key: 'encounters', label: 'Encounters/hr', rate: (m) => m.encountersPerHour, lowerIsBetter: false },
    { key: 'deaths', label: 'Deaths/hr', rate: (m) => m.deathsPerHour, lowerIsBetter: true },
    // A weighted average of the % gains in EXP/hr, Profit/hr and DPS (see `balancedScore`); no rate of its own
    { key: 'balanced', label: 'Balanced', rate: () => 0, lowerIsBetter: false, balanced: true },
];

/** Balanced weights unless the player sets them: equal */
export const DEFAULT_BALANCE_WEIGHTS = Object.freeze({ xp: 1, profit: 1, dps: 1 });

/**
 * How much of a significant rise in deaths/hr (in %) comes off the Balanced score: one equal share, as if deaths were a
 * fourth metric. A rise within its error bar takes nothing off; a significant one also flags the line.
 */
export const DEATHS_PENALTY_SHARE = 1 / 3;

/**
 * A profit error bar in the units of `deltas.profit`. The noise is a percentage of `profitScale` (the larger of
 * revenue, cost and |profit|), but the delta is a percentage of the baseline's NET profit, which near break-even is
 * far smaller, so the same gold is a much bigger percentage of it. Rescaled the way the upgrade advisor's
 * `rowErrorPct` does. A zero baseline has no percentage: its delta is the 0/100 convention, so the bar spans all of
 * it (finite, so the row still reaches the close-call picker).
 *
 * @param {number} noisePct - `noise.profit`, percent of the profit scale
 * @param {Object} baseline - The baseline's metrics
 * @returns {number} Percent of |baseline net profit| (before the significance multiplier)
 */
export function profitNoiseOfNetPct(noisePct, baseline) {
    const noise = Number(noisePct);
    if (!Number.isFinite(noise)) return 0;
    const net = Math.abs(Number(baseline?.profitPerHour) || 0);
    if (!(net > 0)) return 100;
    const scale = profitScale({
        profit: baseline?.profitPerHour,
        revenue: baseline?.revenuePerHour,
        cost: baseline?.costPerHour,
    });
    return (noise * scale) / net;
}

/**
 * Weights as finite non-negative numbers; all zero (or none) falls back to equal.
 * @param {Object} weights
 * @returns {{xp: number, profit: number, dps: number}}
 */
export function normalizeBalanceWeights(weights) {
    const out = {};
    for (const key of ['xp', 'profit', 'dps']) {
        const value = Number(weights?.[key]);
        out[key] = Number.isFinite(value) && value > 0 ? value : 0;
    }
    return out.xp + out.profit + out.dps > 0 ? out : { ...DEFAULT_BALANCE_WEIGHTS };
}

/**
 * The Balanced score of one measurement: the weighted average of the % gains in EXP/hr, Profit/hr and DPS, less a
 * share of a significant rise in deaths/hr.
 *
 * Profit's % is taken on the gold moving through the fight (the larger of revenue, cost and |profit| per hour, the
 * upgrade advisor's `profitScale`), not on net profit, which can be near zero; that is also the scale its error bar
 * is sized on.
 *
 * Error bar: the components come from the same fights, so their errors are not independent. They are added as if
 * fully correlated, `Σ wᵢ·zσᵢ`, which can only overstate the error (never understate it), so a Balanced verdict of
 * "significant" is a conservative one.
 *
 * @param {Object} m - `{deltas, noise, change, baseline, significantBy}` from one measurement
 * @param {Object} weights
 * @returns {{valuePct: number, errPct: number, significant: boolean, deathsRise: boolean}}
 */
export function balancedScore({ deltas, noise, change, baseline, significantBy }, weights) {
    const w = normalizeBalanceWeights(weights);
    const total = w.xp + w.profit + w.dps;
    const scale = Math.max(
        Math.abs(Number(baseline?.profitPerHour) || 0),
        Number(baseline?.revenuePerHour) || 0,
        Number(baseline?.costPerHour) || 0
    );
    const parts = {
        xp: Number(deltas?.xp) || 0,
        profit: scale > 0 ? ((Number(change?.profit) || 0) / scale) * 100 : 0,
        dps: Number(deltas?.dps) || 0,
    };
    let score = 0;
    let err = 0;
    for (const key of ['xp', 'profit', 'dps']) {
        score += (w[key] / total) * parts[key];
        err += (w[key] / total) * Z * (Number(noise?.[key]) || 0);
    }
    const deathsRise = Boolean(significantBy?.deaths) && Number(deltas?.deaths) > 0;
    if (deathsRise) {
        score -= DEATHS_PENALTY_SHARE * deltas.deaths;
        err += DEATHS_PENALTY_SHARE * Z * (Number(noise?.deaths) || 0);
    }
    return { valuePct: score, errPct: err, significant: Math.abs(score) > err, deathsRise };
}

/**
 * @param {string} key
 * @param {Array<Object>} [metrics]
 * @returns {Object} The metric definition (the first one for an unknown key)
 */
export function rankingMetric(key, metrics = COMBAT_RANKING_METRICS) {
    // The combat list's own reader: the shared one defaults to the skilling list
    return metrics.find((m) => m.key === key) || metrics[0];
}

/**
 * Whether a line's effect is far from linear in its value, so grades scaled from the simulated one are rougher.
 * @param {Object} detail - Modifier detail
 * @returns {boolean}
 */
export function isNonlinearLine(detail) {
    return NONLINEAR_GROUPS.has(detail?.groupHrid) || isMechanicLine(detail);
}

/**
 * @param {Object} detail - Modifier detail
 * @returns {boolean} A talisman-only mechanic (Echo, Fortify, Overkill, Shatter, Smite)
 */
export function isMechanicLine(detail) {
    // By the stat it feeds, as the engine sorts them, not by the group label
    return (detail?.keys || []).some((key) => TALISMAN_MECHANICS.includes(talismanStatName(key)));
}

/**
 * Which combat lines the sim reads, checked on the main thread with the run's own game data and belt: a line is
 * valued when its stat lands in a modeled stat or a mechanic. A line whose stat the engine does not read would
 * otherwise come back from its sim as "no effect", which is a wrong answer rather than a zero.
 *
 * Also checks the scale: the engine's value for the line must be `gradeValue * (1 + power)`.
 *
 * @param {Array<Object>} lines - Combat modifier details
 * @param {{hrid: string, enhancementLevel?: number}} belt - The sim DTO's belt
 * @param {Object} gameData - The run's payload (`talismansEnabled`, maps, enhancement table)
 * @param {number} grade
 * @returns {{valued: Array<Object>, notValued: Array<{detail: Object, reason: string}>, power: number}}
 */
export function checkCombatLines(lines, belt, gameData, grade) {
    const power = getTalismanPower(
        { itemHrid: belt?.hrid, enhancementLevel: belt?.enhancementLevel || 0 },
        gameData?.itemDetailMap,
        gameData?.enhancementLevelTotalBonusMultiplierTable
    );
    const valued = [];
    const notValued = [];
    for (const detail of lines) {
        const out = computeTalismanCombat({
            talismans: lineCopies(detail.hrid, grade, 1),
            belt,
            gameData,
            modeledStats: TALISMAN_MODELED_STATS,
        });
        const expected = (detail.gradeValues[grade - 1] ?? NaN) * (1 + power);
        const read = { ...out.stats, ...out.mechanics };
        const names = (detail.keys || []).map(talismanStatName);
        if (names.some((n) => n in out.unmodeled)) {
            notValued.push({ detail, reason: 'the sim does not model this stat' });
        } else if (names.length === 0 || names.some((n) => !(n in read))) {
            notValued.push({ detail, reason: 'the sim did not pick this line up' });
        } else if (names.some((n) => Math.abs(read[n] - expected) > 1e-9 * Math.max(1, Math.abs(expected)))) {
            notValued.push({ detail, reason: 'the sim read this line at another value' });
        } else {
            valued.push(detail);
        }
    }
    return { valued, notValued, power };
}

/**
 * Whether a combat ranking can run for this build, and with what belt.
 * @param {Object} params
 * @param {Object|null} params.gameData - `buildGameDataPayload()`
 * @param {Object|null} params.playerDTO - The player measured
 * @param {string|null} params.zoneHrid
 * @returns {{ok: boolean, reason?: string, message?: string, belt?: Object, slots?: number, power?: number}}
 */
export function combatRankingReadiness({ gameData, playerDTO, zoneHrid }) {
    if (!isTestServer() || !gameData?.talismansEnabled) {
        return { ok: false, reason: 'live', message: 'Talismans exist on the test server only.' };
    }
    if (
        !gameData.talismanModifierDetailMap ||
        !talismanLines(gameData.talismanModifierDetailMap, COMBAT_TALISMAN_TYPE).length
    ) {
        return { ok: false, reason: 'no_tables', message: 'The game data has no talisman lines.' };
    }
    if (!playerDTO) return { ok: false, reason: 'no_player', message: 'No player data. Configure a simulation first.' };
    if (!zoneHrid) return { ok: false, reason: 'no_zone', message: 'Select a zone in the Configure tab first.' };
    const zone = gameData.actionDetailMap?.[zoneHrid];
    if (zone && zone.type && zone.type !== '/action_types/combat') {
        return { ok: false, reason: 'not_combat', message: 'Pick a combat zone or a dungeon in the Configure tab.' };
    }
    const belt = playerDTO.equipment?.[SIM_BELT_TYPE];
    const slots = belt?.hrid ? getBeltSlotCount({ itemHrid: belt.hrid }, gameData.itemDetailMap) : 0;
    if (!belt?.hrid || slots === 0) {
        return {
            ok: false,
            reason: 'no_belt',
            message: 'This build wears no Talisman Belt. Put one on (in the game, or in the Configure editor) first.',
        };
    }
    const power = getTalismanPower(
        { itemHrid: belt.hrid, enhancementLevel: belt.enhancementLevel || 0 },
        gameData.itemDetailMap,
        gameData.enhancementLevelTotalBonusMultiplierTable
    );
    return { ok: true, belt, slots, power };
}

/**
 * How many sims a combat ranking runs: the baseline, one per valued line, the copies of the shortlist (two or more
 * slots), the combined check and the current talismans.
 * @param {Object} params
 * @param {number} params.lineCount - Valued lines
 * @param {number} [params.specialCount] - How many of them are Special lines (left out of the copies runs)
 * @param {number} params.slots
 * @param {boolean} params.hasCurrent - Talismans are worn now
 * @param {number} [params.shortlist]
 * @returns {number}
 */
export function estimateCombatRankingSims({
    lineCount,
    slots,
    hasCurrent,
    shortlist = COPIES_SHORTLIST,
    specialCount = 0,
}) {
    // A Special line has one copy that counts, so it is never simulated with a copy in every slot
    const copies = slots > 1 ? Math.min(shortlist, Math.max(0, lineCount - specialCount)) : 0;
    return 1 + lineCount + copies + 1 + (hasCurrent ? 1 : 0);
}

/**
 * The worn talismans that count on this belt (slots it has, lines it reads).
 * @param {Array<Object>|null} talismans - `dto.talismans`
 * @param {number} slots
 * @returns {Array<Object>}
 */
export function wornTalismans(talismans, slots) {
    return (Array.isArray(talismans) ? talismans : []).filter(
        (t) =>
            Number.isInteger(t?.slotIndex) &&
            t.slotIndex >= 1 &&
            t.slotIndex <= slots &&
            Array.isArray(t.modifiers) &&
            t.modifiers.length > 0
    );
}

/** 95% error bar, in standard errors (the upgrade advisor's `SIGNIFICANCE_Z`) */
const Z = 1.96;

/** Most lines one close-call round re-measures (the upgrade advisor's `RESIM_MAX_ROWS`) */
export const CLOSE_CALL_MAX_ROWS = 8;

/**
 * The lines whose place the recommended set depends on and the first pass could not settle: the set's members whose
 * error bar reaches its cut line (or zero), and the lines left out whose error bar reaches it. The cut line sits
 * halfway between the last line in and the first line out (never below zero: a line is only taken for a gain).
 * Closest to the cut first, at most {@link CLOSE_CALL_MAX_ROWS}. Handed to the upgrade advisor's close-call re-sim
 * (`resimCloseCallRows`) as its picker, so a re-measured line that separated drops out of the next round.
 *
 * @param {Array<Object>} rows - Ranking rows (`valuePct`, `errPct`, `noEffect`)
 * @param {Object} options
 * @param {number} options.slots
 * @param {number} options.grade
 * @param {number} [options.linesPerTalisman]
 * @param {number} [options.max]
 * @returns {Array<Object>} The close rows (the same objects)
 */
export function talismanCloseCalls(
    rows,
    {
        slots,
        grade,
        linesPerTalisman = DEFAULT_LINES_PER_TALISMAN,
        maxSpecialPerTalisman = Infinity,
        max = CLOSE_CALL_MAX_ROWS,
    }
) {
    const ranked = (rows || [])
        .filter((r) => r && !r.noEffect && Number.isFinite(r.valuePct) && Number.isFinite(r.errPct))
        .sort((a, b) => b.valuePct - a.valuePct);
    if (ranked.length === 0) return [];
    const set = buildRecommendedSet(ranked, { slots, grade, linesPerTalisman, maxSpecialPerTalisman });
    const members = new Set((set?.members || []).map((m) => m.hrid));
    const inside = ranked.filter((r) => members.has(r.hrid));
    const outside = ranked.filter((r) => !members.has(r.hrid));
    const lastIn = inside.length ? inside[inside.length - 1].valuePct : null;
    const firstOut = outside.length ? outside[0].valuePct : null;
    const cut = Math.max(0, lastIn != null && firstOut != null ? (lastIn + firstOut) / 2 : (lastIn ?? firstOut ?? 0));
    const close = [
        ...inside.filter((r) => r.valuePct - r.errPct <= cut),
        ...outside.filter((r) => r.valuePct + r.errPct >= cut && r.valuePct + r.errPct > 0),
    ];
    return close
        .sort((a, b) => Math.abs(a.valuePct - cut) / (a.errPct || 1) - Math.abs(b.valuePct - cut) / (b.errPct || 1))
        .slice(0, max);
}

/**
 * How much of a ranking is within noise.
 * @param {Array<Object>} rows
 * @returns {{measured: number, withinNoise: number, mostlyNoise: boolean}} Lines with an effect, and how many of them
 *   did not clear their error bar
 */
export function noiseSummary(rows) {
    const measured = (rows || []).filter((r) => !r.noEffect);
    const withinNoise = measured.filter((r) => !r.significant).length;
    return {
        measured: measured.length,
        withinNoise,
        mostlyNoise: measured.length > 0 && withinNoise * 2 > measured.length,
    };
}

/**
 * Up to `limit` items at a time, results in input order. Stops handing out work after a failure.
 * @param {Array} items
 * @param {Function} run - `(item, index) => Promise`
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function mapLanes(items, run, limit) {
    const results = new Array(items.length);
    let next = 0;
    let failure = null;
    const lane = async () => {
        while (failure === null) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await run(items[index], index);
            } catch (error) {
                failure = error;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
    if (failure) throw failure;
    return results;
}

/**
 * The metric-free half of a measurement: one sim against a baseline of the same length. Everything here is the same
 * whatever the ranking is ranked by, so a ranking can be scored again under another metric without a new sim.
 * `baselineMetrics` is the baseline this sim was set against (a close-call round's is longer than the first pass's),
 * which the score reads for the profit scale.
 *
 * @param {Object} params
 * @param {Object} params.deps - `{computeDeltas, rateDeltaNoisePct, significantDeltas}`
 * @param {string} params.playerHrid
 * @param {number|null} params.seed
 * @param {Object} result - The sim result
 * @param {Object} metrics - `computeMetrics` of `result`
 * @param {{result: Object, metrics: Object}} against - The baseline sim and its metrics
 * @returns {Object} `{metrics, deltas, noise, significantBy, change, costUnpriced?, deathsRise, noEffect, baselineMetrics}`
 */
export function measureRaw({ deps, playerHrid, seed }, result, metrics, against) {
    const deltas = deps.computeDeltas(against.metrics, metrics);
    const noise = deps.rateDeltaNoisePct(against.result, result, playerHrid);
    const significantBy = deps.significantDeltas(deltas, noise, {
        baseline: against.metrics,
        upgraded: metrics,
        deathCounts: { baseline: against.result?.deaths?.[playerHrid], upgraded: result?.deaths?.[playerHrid] },
    });
    const change = {};
    for (const m of COMBAT_RANKING_METRICS) {
        change[m.key] = (m.rate(metrics) || 0) - (m.rate(against.metrics) || 0);
    }
    // A profit gain (alone or inside Balanced) that rests on a running cost counted as free is a ceiling, so it is
    // never "significant": the row says so, and the set marks it
    const costUnpriced = newlyUnpricedLineCosts(against.metrics, metrics);
    // A significant rise in deaths/hr flags the line whatever it is ranked by
    const deathsRise = Boolean(significantBy?.deaths) && Number(deltas?.deaths) > 0;
    return {
        metrics,
        deltas,
        noise,
        significantBy,
        change,
        ...(costUnpriced.length ? { costUnpriced } : {}),
        deathsRise,
        // Same seed and nothing moved: the line does nothing for this build here
        noEffect: seed != null && COMBAT_RANKING_METRICS.every((m) => change[m.key] === 0),
        baselineMetrics: against.metrics,
    };
}

/**
 * The metric-dependent half: what a measurement is worth by a metric (and the Balanced weights).
 *
 * @param {Object} measured - {@link measureRaw}'s record (a ranking row, a combined or current record keeps it)
 * @param {Object} metric - A COMBAT_RANKING_METRICS entry
 * @param {Object} [balanceWeights]
 * @returns {{value: number, valuePct: number, errPct: number, significant: boolean}}
 */
export function scoreMeasurement(measured, metric, balanceWeights) {
    const { deltas, noise, change, significantBy, costUnpriced } = measured;
    const baseline = measured.baselineMetrics;
    const profitDriven =
        Boolean(costUnpriced?.length) &&
        (metric.balanced ? normalizeBalanceWeights(balanceWeights).profit > 0 : metric.key === 'profit');
    if (metric.balanced) {
        const score = balancedScore({ deltas, noise, change, baseline, significantBy }, balanceWeights);
        return {
            value: score.valuePct,
            valuePct: score.valuePct,
            errPct: score.errPct,
            significant: score.significant && !profitDriven,
        };
    }
    const good = metric.lowerIsBetter ? -change[metric.key] : change[metric.key];
    const goodPct = metric.lowerIsBetter ? -deltas[metric.key] : deltas[metric.key];
    return {
        value: good,
        valuePct: goodPct,
        errPct:
            metric.key === 'profit'
                ? Z * profitNoiseOfNetPct(noise?.profit, baseline)
                : Z * (Number(noise?.[metric.key]) || 0),
        significant: Boolean(significantBy?.[metric.key]) && !profitDriven,
    };
}

/**
 * A measurement scored again under another metric (a new record; the input is not touched).
 * @param {Object} measured
 * @param {Object} metric
 * @param {Object} [balanceWeights]
 * @returns {Object}
 */
export function rescoreMeasurement(measured, metric, balanceWeights) {
    return { ...measured, ...scoreMeasurement(measured, metric, balanceWeights) };
}

/**
 * A ranking row scored again under another metric: its score, its per-grade figures and its copies run. The orb figures
 * (`orbCost`, `perOrb`, `orbLimits`) were worked out from the old values and are dropped, to be stamped again.
 *
 * @param {Object} row - A row from a finished ranking
 * @param {Object} metric
 * @param {Object} balanceWeights
 * @param {number} grade - The grade the ranking simulated
 * @returns {Object} A new row
 */
export function rescoreRow(row, metric, balanceWeights, grade) {
    const scored = rescoreMeasurement(row, metric, balanceWeights);
    const out = {
        ...scored,
        byGrade: scaleAcrossGrades(scored.value, row.detail, grade),
        byGradePct: scaleAcrossGrades(scored.valuePct, row.detail, grade),
    };
    delete out.orbCost;
    delete out.perOrb;
    delete out.orbLimits;
    if (row.copies) {
        out.copies = rescoreMeasurement(row.copies, metric, balanceWeights);
        out.copiesValue = out.copies.value;
    }
    return out;
}

/**
 * The measuring rules of a paired comparison, shared by the ranking and the belt advisor: a sim's metrics at the run's
 * prices and sale tax, and one sim against a baseline of the same length (changes per hour, error bars, verdicts, the
 * Balanced score, profit that rests on a cost counted as free).
 *
 * @param {Object} params
 * @param {Object} params.deps - `{computeMetrics, computeDeltas, rateDeltaNoisePct, significantDeltas}`
 * @param {Object} params.gameData - The run's payload
 * @param {string} params.playerHrid
 * @param {Map} params.priceCache - The run's seeded sim price cache
 * @param {number|null} params.saleTaxRate
 * @param {Object} params.metric - A COMBAT_RANKING_METRICS entry
 * @param {Object} params.balanceWeights
 * @param {number|null} params.seed - The shared seed (null: every sim is an independent sample)
 * @returns {{metricsOf: Function, measureAgainst: Function}} `metricsOf(result, hours)`;
 *   `measureAgainst(result, {result, metrics, hours})`
 */
export function createMeasurer({ deps, gameData, playerHrid, priceCache, saleTaxRate, metric, balanceWeights, seed }) {
    const metricsOf = (result, simHours) =>
        deps.computeMetrics(result, gameData, playerHrid, simHours, {
            priceCache,
            ...(saleTaxRate != null ? { saleTaxRate } : {}),
        });

    /**
     * One sim against a bare baseline of the same length (the first pass's, or a close-call round's): per-metric
     * changes per hour, error bars and verdicts. Rates per hour from runs of different lengths estimate the same
     * change, so a re-measured row replaces its first figures as they are. Two steps: what the fight measured
     * ({@link measureRaw}, independent of the metric) and what it is worth by the metric ({@link scoreMeasurement}).
     */
    const measureAgainst = (result, against) => {
        const metrics = metricsOf(result, against.hours);
        const raw = measureRaw({ deps, playerHrid, seed }, result, metrics, against);
        return { ...raw, ...scoreMeasurement(raw, metric, balanceWeights) };
    };
    return { metricsOf, measureAgainst };
}

/**
 * A sim runner for one ranking: the roster as the ranking read it, with one player's talismans replaced.
 *
 * @param {Object} context - `{deps, gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, seed}`
 * @param {Object} flags
 * @param {Function} flags.stopped - `() => boolean`: Stop was pressed
 * @param {Function} flags.onCancelled - Another simulation cancelled this one
 * @returns {Function} `async (talismans, simHours = hours) => result|null` (null: stopped or cancelled)
 */
function createSimulator(
    { deps, gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, seed },
    { stopped, onCancelled }
) {
    /** The roster with this player's talismans replaced (a fresh copy each call) */
    const rosterWith = (talismans) => {
        const roster = JSON.parse(JSON.stringify(playerDTOs));
        roster[playerIndex].talismans = talismans;
        return roster;
    };
    return async (talismans, simHours = hours) => {
        try {
            return await deps.runSimulation(
                {
                    gameData,
                    playerDTOs: rosterWith(talismans),
                    zoneHrid,
                    difficultyTier,
                    hours: simHours,
                    communityBuffs,
                    seed,
                    taskDamageMode: TASK_DAMAGE_OFF,
                },
                null,
                // Never preempt: nothing else may run while this does, and a preempt would stop whatever runs
                // in another panel
                { preempt: false, workers: 1 }
            );
        } catch (error) {
            if (stopped()) return null;
            if (/cancel/i.test(String(error?.message))) {
                onCancelled();
                return null;
            }
            throw error;
        }
    };
}

/**
 * A set as a comparable text: the slots, and each slot's lines and grades (order of the lines does not matter, the
 * sim sums them).
 * @param {{talismans: Array<Object>}|null} set
 * @returns {string}
 */
export function setSignature(set) {
    const rows = (set?.talismans || [])
        .map((t) => [t.slotIndex, (t.modifiers || []).map((m) => `${m.hrid}@${m.grade}`).sort()])
        .sort((a, b) => a[0] - b[0]);
    return JSON.stringify(rows);
}

/**
 * The stage a ranking and a rebuild share: plan the set from the rows, work out the orb figures, and check the set with
 * a combined measurement. The caller decides what "check" is (a new sim, or a stored measurement scored again).
 *
 * `rows` are stamped in place (`orbCost`, `perOrb`, `orbLimits`): the caller hands rows it owns.
 *
 * @param {Array<Object>} rows
 * @param {Object} o
 * @param {number} o.slots
 * @param {number} o.grade - The grade simulated
 * @param {Object} o.setOptions - `setOptionsFor`
 * @param {number} o.budget
 * @param {number} o.linesPerTalisman
 * @param {Object|null} o.orbs - The orb solver
 * @param {Function} o.report - `(description)`
 * @param {Function} o.stopped - `() => boolean`
 * @param {Function} o.check - `async (set) => measurement|null` (null: stopped)
 * @returns {Promise<{stopped: Object}|{plan: Object, set: Object|null, combined: Object|null}>} `stopped` is what a
 *   stopped result carries (`set`, `stage`)
 */
async function planAndCheckSet(rows, o) {
    const { slots, grade, setOptions, budget, linesPerTalisman, orbs, report, stopped, check } = o;
    report('Talisman lines: building the set');
    const plan = await planSet(rows, {
        mode: setOptions.mode,
        slots,
        simGrade: grade,
        capGrade: setOptions.grade,
        budget,
        typeHrid: COMBAT_TALISMAN_TYPE,
        orbs,
        linesPerTalisman,
    });
    if (plan.reason === 'cancelled' || stopped()) return { stopped: { stage: 'orbs' } };
    const set = plan.set;
    if (orbs) {
        report('Talisman lines: expected orbs');
        const perOrb = await stampValuePerOrb(rows, { grade: setOptions.grade, typeHrid: COMBAT_TALISMAN_TYPE, orbs });
        if (!perOrb || !(await stampSetCosts(set, { typeHrid: COMBAT_TALISMAN_TYPE, orbs })) || stopped()) {
            return { stopped: { set, stage: 'orbs' } };
        }
    }
    let combined = null;
    if (set) {
        report('Talisman lines: checking the recommended set');
        combined = await check(set);
        if (!combined || stopped()) return { stopped: { set } };
    }
    return { plan, set, combined };
}

/**
 * Score a finished ranking again, and build its set again, without simulating the lines: the rows keep what the sims
 * measured (see {@link measureRaw}), so a new metric or Balanced weights re-score them, and a new set mode, cap or budget
 * plans another set from them. The set is then checked: with one combined sim when it differs from the one that was
 * simulated, else by scoring the stored combined measurement again. The talismans worn now are scored again from their
 * stored measurement. Never touches `previous`: it returns a new result, or says why it did not.
 *
 * What is NOT redone: the close-call re-sims and the copies shortlist were chosen under the metric the ranking ran
 * with (`rebuilt.ranWith`), so a different metric may have chosen others. Grade, zone, tier, hours, build and roster
 * need a new ranking.
 *
 * @param {Object} previous - A finished result of {@link runCombatLineRanking} (or of a rebuild)
 * @param {Object} controls - `{metricKey, balanceWeights, setMode, capGrade, budget}`
 * @param {Function} onProgress - `{current, total, description}`
 * @param {Object} deps - As {@link runCombatLineRanking}'s, with `orbs`
 * @param {Object} [options] - `{abortSignal: () => boolean}`
 * @returns {Promise<Object>} `{status: 'done', ...result}`, `{status: 'stopped', stage?, cancelledElsewhere}` or
 *   `{status: 'refused', message}`
 */
export async function rebuildCombatLineRanking(previous, controls, onProgress, deps, options = {}) {
    const ctx = previous?.rebuild;
    if (previous?.status !== 'done' || !ctx || !Array.isArray(previous.rows) || !previous.baseline) {
        return {
            status: 'refused',
            ok: false,
            reason: 'no_context',
            message: 'This ranking cannot be rebuilt. Rank again.',
        };
    }
    if (previous.rows.some((r) => !r.baselineMetrics) || (previous.current && !previous.current.baselineMetrics)) {
        return {
            status: 'refused',
            ok: false,
            reason: 'no_context',
            message: 'This ranking cannot be rebuilt. Rank again.',
        };
    }
    const { abortSignal } = options;
    let cancelledElsewhere = false;
    const stopped = () => cancelledElsewhere || Boolean(abortSignal?.());
    const {
        metricKey,
        balanceWeights = DEFAULT_BALANCE_WEIGHTS,
        setMode = 'practical',
        capGrade = 3,
        budget = 0,
    } = controls;
    const metric = rankingMetric(metricKey);
    const weights = metric.balanced ? normalizeBalanceWeights(balanceWeights) : null;
    const { maxGrade } = talismanLimits(ctx.gameData?.talismanInfo);
    const setOptions = setOptionsFor(setMode, { simGrade: previous.grade, capGrade: Math.min(maxGrade, capGrade) });
    const sameWeights =
        Boolean(weights) &&
        Boolean(previous.balanceWeights) &&
        ['xp', 'profit', 'dps'].every((k) => weights[k] === previous.balanceWeights[k]);
    const rescored = metric.key !== previous.metricKey || (Boolean(metric.balanced) && !sameWeights);

    // New rows: the previous ones are never touched, so a stopped rebuild leaves the ranking as it was
    const rows = previous.rows.map((row) => {
        if (rescored) return rescoreRow(row, metric, weights, previous.grade);
        const copy = { ...row };
        delete copy.orbCost;
        delete copy.perOrb;
        delete copy.orbLimits;
        return copy;
    });

    let current = 0;
    const total = 1;
    const report = (description) => onProgress?.({ current, total, description });
    const simulate = createSimulator(
        { deps, ...ctx, hours: previous.hours },
        {
            stopped,
            onCancelled: () => {
                cancelledElsewhere = true;
            },
        }
    );
    const { measureAgainst } = createMeasurer({
        deps,
        gameData: ctx.gameData,
        playerHrid: previous.playerHrid,
        priceCache: ctx.priceCache,
        saleTaxRate: ctx.saleTaxRate,
        metric,
        balanceWeights: weights,
        seed: ctx.seed,
    });
    const againstBaseline = { result: ctx.baselineResult, metrics: previous.baseline, hours: previous.hours };
    const sameAsSimmed = (set) =>
        Boolean(previous.set && previous.combined) && setSignature(set) === setSignature(previous.set);
    let simmed = false;
    const outcome = await planAndCheckSet(rows, {
        slots: previous.slots,
        grade: previous.grade,
        setOptions,
        budget,
        linesPerTalisman: ctx.linesPerTalisman,
        orbs: deps.orbs || null,
        report,
        stopped,
        check: async (set) => {
            // The same set as the one that was simulated: its measurement stands, scored by the new metric
            if (sameAsSimmed(set)) return rescoreMeasurement(previous.combined, metric, weights);
            report('Talisman lines: checking the new set (1 sim)');
            const result = await simulate(set.talismans);
            if (!result || stopped()) return null;
            current++;
            simmed = true;
            return measureAgainst(result, againstBaseline);
        },
    });
    if (outcome.stopped) {
        return { status: 'stopped', stage: outcome.stopped.stage || 'check', cancelledElsewhere };
    }
    const { plan, set, combined } = outcome;
    const currentSet = previous.current ? rescoreMeasurement(previous.current, metric, weights) : null;
    report('Talisman lines: done');
    return {
        ...previous,
        status: 'done',
        metricKey: metric.key,
        balanceWeights: weights,
        setMode: setOptions.mode,
        setGrade: setOptions.grade,
        budget,
        rows: sortRows(rows),
        set,
        combined,
        current: currentSet,
        sims: previous.sims + (simmed ? 1 : 0),
        noise: noiseSummary(rows),
        setReason: plan.reason ?? null,
        cheapest: plan.cheapest ?? null,
        rerollTargets: toRerollTargets(set),
        // Said in the header: what this result is, and what it could not redo
        rebuilt: {
            rescored,
            simmed,
            setChanged: setSignature(set) !== setSignature(previous.set),
            // The metric (and weights) the line sims, close-call re-sims and copies shortlist were chosen under
            ranWith: ctx.ranWith,
            // The close-call re-sims were picked around the run's set (mode, cap, Special limit)
            setDiffers: Boolean(
                ctx.ranWith.setMode !== undefined &&
                (setOptions.mode !== ctx.ranWith.setMode || setOptions.grade !== ctx.ranWith.setGrade)
            ),
            metricDiffers: Boolean(
                metric.key !== ctx.ranWith.metricKey ||
                (metric.balanced &&
                    ['xp', 'profit', 'dps'].some((k) => weights[k] !== (ctx.ranWith.balanceWeights?.[k] ?? NaN)))
            ),
        },
    };
}

/**
 * Rank the combat lines for one player in one zone and tier, then build and check a set.
 *
 * @param {Object} params
 * @param {Array<Object>} params.playerDTOs - The roster as the run starts (not mutated)
 * @param {number} params.playerIndex
 * @param {string|null} params.selfHrid - The live character's hrid, for the sale tax
 * @param {string} params.zoneHrid
 * @param {number} params.difficultyTier
 * @param {number} params.hours
 * @param {Object} params.communityBuffs
 * @param {number} params.grade - Grade simulated and aimed for
 * @param {string} params.metricKey - A COMBAT_RANKING_METRICS key
 * @param {Object} [params.balanceWeights] - `{xp, profit, dps}` for the Balanced metric
 * @param {string} [params.setMode] - 'practical' (default: one Special per talisman, grades capped), 'ideal' or
 *   'budget' (needs `deps.orbs`)
 * @param {number} [params.capGrade] - The Practical and Budget cap (default 3)
 * @param {number} [params.budget] - Budget per talisman, in the orb solver's reference orbs
 * @param {boolean} [params.resimCloseCalls] - Re-measure the lines near the set's cut line for longer (the Upgrade tab's
 *   "Re-sim close calls"), through `deps.resimCloseCallRows`
 * @param {Function} onProgress - `{current, total, description}`
 * @param {Object} deps - The advisor's machinery, passed in so this module does not pull the advisor's whole
 *   import graph into its tests: `{buildGameDataPayload, runSimulation, computeMetrics, computeDeltas,
 *   rateDeltaNoisePct, significantDeltas, seedSimPriceCache, saleTaxRateOf, concurrency, resimCloseCallRows?}`
 * @param {Object} [options] - `{abortSignal: () => boolean, now}`
 * @returns {Promise<Object>} `{status: 'done'|'stopped'|'refused', ...}`
 */
export async function runCombatLineRanking(params, onProgress, deps, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        selfHrid = null,
        zoneHrid,
        difficultyTier,
        hours,
        communityBuffs,
        grade: requestedGrade,
        metricKey,
        resimCloseCalls = false,
        balanceWeights = DEFAULT_BALANCE_WEIGHTS,
        setMode = 'practical',
        capGrade = 3,
        budget = 0,
    } = params;
    const { abortSignal, now = () => Date.now() } = options;
    const startedAt = now();
    // A cancel from elsewhere (the Lab panel's Stop, a preempting run) ends this run like its own Stop: the lines
    // already measured are kept, and the result says it was cut short
    let cancelledElsewhere = false;
    const stopped = () => cancelledElsewhere || Boolean(abortSignal?.());
    const gameData = deps.buildGameDataPayload();
    const playerDTO = playerDTOs?.[playerIndex] || null;
    const ready = combatRankingReadiness({ gameData, playerDTO, zoneHrid });
    if (!ready.ok) return { status: 'refused', ...ready };

    const { maxGrade, linesPerTalisman } = talismanLimits(gameData.talismanInfo);
    const grade = Math.min(maxGrade, Math.max(1, Math.floor(requestedGrade) || maxGrade));
    const metric = rankingMetric(metricKey);
    const setOptions = setOptionsFor(setMode, { simGrade: grade, capGrade: Math.min(maxGrade, capGrade) });
    const lines = talismanLines(gameData.talismanModifierDetailMap, COMBAT_TALISMAN_TYPE);
    const { valued, notValued, power } = checkCombatLines(lines, ready.belt, gameData, grade);
    if (valued.length === 0) {
        return {
            status: 'refused',
            ok: false,
            reason: 'not_applied',
            message: 'The sim did not apply any talisman line for this belt. Nothing was run.',
        };
    }

    const playerHrid = playerDTO.hrid;
    const isSelf = selfHrid != null && playerHrid === selfHrid;
    const saleTaxRate = deps.saleTaxRateOf(playerDTO, isSelf);
    const seed = config.getSettingValue('combatSim_sharedSeed', true) ? randomSeed() : null;
    const priceCache = new Map();
    deps.seedSimPriceCache(priceCache, gameData, {
        zoneHrid,
        ...(saleTaxRate != null ? { saleTaxRate } : {}),
        consumableHrids: [...(playerDTO.food || []), ...(playerDTO.drinks || [])].map((i) => i?.hrid),
    });

    const worn = wornTalismans(playerDTO.talismans, ready.slots);
    let total = estimateCombatRankingSims({
        lineCount: valued.length,
        specialCount: valued.filter(isSpecialLine).length,
        slots: ready.slots,
        hasCurrent: worn.length > 0,
    });
    let current = 0;
    const report = (description) => onProgress?.({ current, total, description });

    const simulate = createSimulator(
        { deps, gameData, playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, seed },
        {
            stopped,
            onCancelled: () => {
                cancelledElsewhere = true;
            },
        }
    );

    // What every ending carries, so a run stopped at any point draws its belt, power and slots
    const base = {
        grade,
        metricKey: metric.key,
        power,
        slots: ready.slots,
        belt: ready.belt,
        notValued,
        of: valued.length,
        setMode: setOptions.mode,
        setGrade: setOptions.grade,
        budget,
        balanceWeights: metric.balanced ? normalizeBalanceWeights(balanceWeights) : null,
        // Whose build this ranks: Improve mine and Aim for this are for the live character's own talismans only
        playerHrid,
        isSelf,
    };
    const stoppedResult = (rows, extra = {}) => ({
        status: 'stopped',
        ...base,
        rows: sortRows(rows),
        measured: rows.length,
        cancelledElsewhere,
        ...extra,
    });

    report('Talisman lines: baseline without talismans');
    const baselineResult = await simulate([]);
    if (!baselineResult || stopped()) return stoppedResult([]);
    current++;
    // The progress line's time estimate starts from here: the baseline runs alone, the lines run in lanes
    report('Talisman lines: measuring each line');
    const { metricsOf, measureAgainst } = createMeasurer({
        deps,
        gameData,
        playerHrid,
        priceCache,
        saleTaxRate,
        metric,
        balanceWeights,
        seed,
    });
    const baseline = metricsOf(baselineResult, hours);
    base.baseline = baseline;
    // Profit built on unpriced drops or consumables counts them at zero: a floor, said with the figures
    base.unpriced = Array.isArray(baseline?.unpriced) ? baseline.unpriced : [];

    const measure = (result, against = { result: baselineResult, metrics: baseline, hours }) =>
        measureAgainst(result, against);

    /** A ranking row for one line from one measurement */
    const lineRow = (detail, measured) => ({
        hrid: detail.hrid,
        name: detail.name,
        detail,
        // The close-call re-sim keys what it re-measured by this
        candidate: detail,
        mechanic: isMechanicLine(detail),
        special: isSpecialLine(detail),
        nonlinear: isNonlinearLine(detail),
        lineValues: lineValuesByGrade(detail, power),
        ...measured,
        byGrade: scaleAcrossGrades(measured.value, detail, grade),
        byGradePct: scaleAcrossGrades(measured.valuePct, detail, grade),
    });

    const lanes = Math.max(1, deps.concurrency());
    const rows = (
        await mapLanes(
            valued,
            async (detail) => {
                if (stopped()) return null;
                const result = await simulate(lineCopies(detail.hrid, grade, 1));
                if (!result || stopped()) return null;
                current++;
                report(`Talisman lines: ${detail.name}`);
                return lineRow(detail, measure(result));
            },
            lanes
        )
    ).filter(Boolean);

    if (stopped() || rows.length < valued.length) return stoppedResult(rows);

    // Close calls: the lines the set's cut depends on, again at 2x then 4x the hours against a baseline of the same
    // length, until they separate, through the upgrade advisor's own re-sim (its rounds, time budget and Stop)
    let resim = null;
    if (resimCloseCalls && typeof deps.resimCloseCallRows === 'function') {
        const pickClose = (list) =>
            talismanCloseCalls(list, {
                slots: ready.slots,
                grade: setOptions.grade,
                linesPerTalisman,
                maxSpecialPerTalisman: setOptions.maxSpecialPerTalisman,
            });
        resim = await deps.resimCloseCallRows(rows, {
            firstPassMs: Math.max(0, now() - startedAt),
            firstPassSims: rows.length + 1,
            hours,
            now,
            abortSignal: stopped,
            lanes,
            pickClose,
            onRoundStart: (close, multiplier) => {
                total += close.length + 1;
                report(`Talisman lines: close calls, ${close.length} lines again at ${multiplier}× hours`);
            },
            runRound: async (close, multiplier) => {
                const simHours = hours * multiplier;
                const longResult = await simulate([], simHours);
                if (!longResult || stopped()) return null;
                current++;
                const against = { result: longResult, metrics: metricsOf(longResult, simHours), hours: simHours };
                const measured = await mapLanes(
                    close,
                    async (row) => {
                        if (stopped()) return null;
                        const result = await simulate(lineCopies(row.hrid, grade, 1), simHours);
                        if (!result || stopped()) return null;
                        current++;
                        report(`Talisman lines: close call at ${simHours} h: ${row.name}`);
                        return lineRow(row.detail, measure(result, against));
                    },
                    lanes
                );
                if (stopped() || measured.some((r) => !r)) return null;
                return measured;
            },
        });
        if (stopped()) return stoppedResult(rows, { resim });
    }

    // Copies: the leading lines again with one in every slot, so later copies are valued by what they add
    if (ready.slots > 1) {
        const leaders = sortRows(rows)
            .filter((r) => r.value > 0 && !r.special)
            .sort((a, b) => Number(b.significant) - Number(a.significant) || b.value - a.value)
            .slice(0, COPIES_SHORTLIST);
        total += leaders.length - Math.min(COPIES_SHORTLIST, valued.length - valued.filter(isSpecialLine).length);
        const measured = await mapLanes(
            leaders,
            async (row) => {
                if (stopped()) return null;
                const result = await simulate(lineCopies(row.hrid, grade, ready.slots));
                if (!result || stopped()) return null;
                current++;
                report(`Talisman lines: ${row.name} ×${ready.slots}`);
                row.copies = measure(result);
                row.copiesValue = row.copies.value;
                return row;
            },
            lanes
        );
        if (stopped() || measured.some((r) => !r)) return stoppedResult(rows);
    }

    // The set the mode asks for; Budget, value per orb and the set's orb costs need the orb solver
    const outcome = await planAndCheckSet(rows, {
        slots: ready.slots,
        grade,
        setOptions,
        budget,
        linesPerTalisman,
        orbs: deps.orbs || null,
        report,
        stopped,
        check: async (set) => {
            const result = await simulate(set.talismans);
            if (!result || stopped()) return null;
            current++;
            return measure(result);
        },
    });
    if (outcome.stopped) return stoppedResult(rows, outcome.stopped);
    const { plan, set, combined } = outcome;
    if (!set) total--;
    let currentSet = null;
    if (worn.length > 0) {
        report('Talisman lines: your talismans now');
        const result = await simulate(worn);
        if (!result || stopped()) return stoppedResult(rows, { set, combined });
        current++;
        currentSet = { talismans: worn, ...measure(result) };
    }
    report('Talisman lines: done');
    return {
        status: 'done',
        ...base,
        rows: sortRows(rows),
        set,
        combined,
        current: currentSet,
        sims: current,
        hours,
        paired: seed != null,
        resim,
        noise: noiseSummary(rows),
        setReason: plan.reason ?? null,
        cheapest: plan.cheapest ?? null,
        rerollTargets: toRerollTargets(set),
        // What a rebuild from these rows (a new metric, a new set mode) needs and the result does not carry
        rebuild: {
            gameData,
            playerDTOs,
            playerIndex,
            zoneHrid,
            difficultyTier,
            communityBuffs,
            seed,
            priceCache,
            saleTaxRate,
            baselineResult,
            linesPerTalisman,
            // The metric the line sims, close-call re-sims and copies shortlist were chosen under
            ranWith: {
                metricKey: metric.key,
                balanceWeights: base.balanceWeights,
                setMode: setOptions.mode,
                setGrade: setOptions.grade,
            },
        },
    };
}
