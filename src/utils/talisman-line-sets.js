/**
 * Talisman line sets
 *
 * Test server only. The pieces of the talisman line ranking that do not depend on the Combat Sim, shared by the Combat
 * Sim's "Talisman lines" section (combat bundle) and the Skilling Optimizer's "Talismans" section (actions bundle):
 *
 * - talisman tables and limits, grade scaling, laying a chosen set of lines out as real talismans;
 * - the set modes: Practical (the default: at most one Special-group line per talisman, a grade cap, G3 unless
 *   chosen), Ideal (the simulated grade, no limit on different Specials) and Budget (the most value whose expected orb cost per talisman
 *   fits a budget), plus value per orb and "Improve mine" over the talismans the player owns;
 * - the skilling ranking (exact figures from the profit and experience math, no sim).
 *
 * Stateless: every function works on what it is handed. Orb costs come from an `OrbCostSolver`
 * (talisman-orb-costs.js), which the caller makes and owns.
 *
 * Line value is `gradeValues[grade - 1] * (1 + talismanPower)`; every figure here is measured from the build's own
 * belt, so the belt's power is never a separate input.
 */

import { isTestServer } from './game-server.js';
import {
    BELT_LOCATION,
    attachTalismanBonuses,
    computeTalismanBonuses,
    getBeltSlotCount,
    SPECIAL_GROUP,
    getTalismanPower,
    isSpecialModifierDetail,
    talismanBonusesOf,
    talismanStatName,
} from './talisman-bonuses.js';
import { GATHERING_TYPES, PRODUCTION_TYPES } from './profit-constants.js';

/** Talisman types (`talismanTypeDetailMap`) */
export const COMBAT_TALISMAN_TYPE = '/talisman_types/combat';
export const SKILLING_TALISMAN_TYPE = '/talisman_types/skilling';

export { SPECIAL_GROUP };

/** Highest grade, and lines per talisman, when the game data does not say (`talismanInfo`) */
export const DEFAULT_MAX_GRADE = 6;
export const DEFAULT_LINES_PER_TALISMAN = 4;

/** The set modes; Practical is the default */
export const SET_MODES = [
    { key: 'practical', label: 'Practical' },
    { key: 'ideal', label: 'Ideal' },
    { key: 'budget', label: 'Budget' },
];
export const DEFAULT_SET_MODE = 'practical';

/** Practical sets aim no higher than this grade unless the player picks another */
export const DEFAULT_CAP_GRADE = 3;

/** Most talismans "Improve mine" looks at */
export const IMPROVE_MAX_TALISMANS = 20;

/** Options "Improve mine" shows */
export const IMPROVE_TOP = 5;

/** What a skilling ranking can be measured by */
export const SKILLING_RANKING_METRICS = [
    { key: 'profit', label: 'Profit/hr', rate: (m) => m.profitPerHour, lowerIsBetter: false },
    { key: 'xp', label: 'EXP/hr', rate: (m) => m.xpPerHour, lowerIsBetter: false },
];

/**
 * @param {string} key
 * @param {Array<Object>} metrics
 * @returns {Object} The metric definition (the first one for an unknown key)
 */
export function rankingMetric(key, metrics = SKILLING_RANKING_METRICS) {
    return metrics.find((m) => m.key === key) || metrics[0];
}

/**
 * Highest grade and lines per talisman, from `talismanInfo` when the payload carries it.
 * @param {Object|null} talismanInfo
 * @returns {{maxGrade: number, linesPerTalisman: number}}
 */
export function talismanLimits(talismanInfo) {
    const maxGrade = Number.isInteger(talismanInfo?.maxGrade) && talismanInfo.maxGrade > 0 ? talismanInfo.maxGrade : 0;
    const lines =
        Number.isInteger(talismanInfo?.maxModifierCount) && talismanInfo.maxModifierCount > 0
            ? talismanInfo.maxModifierCount
            : 0;
    return {
        maxGrade: maxGrade || DEFAULT_MAX_GRADE,
        linesPerTalisman: lines || DEFAULT_LINES_PER_TALISMAN,
    };
}

/**
 * The lines one talisman type can roll, in the game's order.
 * @param {Object|null} modifierDetailMap - `talismanModifierDetailMap`
 * @param {string} typeHrid
 * @returns {Array<Object>}
 */
export function talismanLines(modifierDetailMap, typeHrid) {
    return Object.values(modifierDetailMap || {})
        .filter((d) => d && d.talismanTypeHrid === typeHrid && Array.isArray(d.gradeValues) && d.gradeValues.length)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0) || String(a.hrid).localeCompare(String(b.hrid)));
}

/**
 * A Special-group line, read from the game data's `groupHrid` (the 0.1-weight lines a talisman can hold one of in a
 * Practical set).
 * @param {Object} detail
 * @returns {boolean}
 */
export function isSpecialLine(detail) {
    return isSpecialModifierDetail(detail);
}

/**
 * A value measured at one grade, carried to every grade by the grade values (the belt's power is the same factor on
 * every grade, so it cancels).
 * @param {number} measured
 * @param {Object} detail
 * @param {number} fromGrade
 * @returns {number[]} One value per grade; empty when the grade value is zero or missing
 */
export function scaleAcrossGrades(measured, detail, fromGrade) {
    const values = detail?.gradeValues || [];
    const base = values[fromGrade - 1];
    if (!Number.isFinite(base) || base === 0 || !Number.isFinite(measured)) return [];
    return values.map((v) => (measured * v) / base);
}

/**
 * The scaled stat a line gives at each grade with this power, as the game computes it.
 * @param {Object} detail
 * @param {number} power
 * @returns {number[]}
 */
export function lineValuesByGrade(detail, power) {
    return (detail?.gradeValues || []).map((v) => v * (1 + power));
}

/**
 * The sets a line could be measured in: one copy, or one copy in each of the first `copies` slots.
 * @param {string} hrid
 * @param {number} grade
 * @param {number} copies
 * @returns {Array<{slotIndex: number, modifiers: Array<{hrid: string, grade: number}>}>}
 */
export function lineCopies(hrid, grade, copies = 1) {
    return Array.from({ length: Math.max(1, copies) }, (_, i) => ({ slotIndex: i + 1, modifiers: [{ hrid, grade }] }));
}

/**
 * Lay a chosen multiset of lines out as talismans: no line twice on one talisman, at most `linesPerTalisman` each.
 *
 * Round robin over the list grouped by line, in the order lines first appear: copies of one line sit next to each
 * other and there are at most `slots` of them, so they land on different talismans. A caller that puts the Special
 * lines first (and takes at most `slots` of them) gets at most one per talisman, since the first `slots` places go to
 * different talismans.
 *
 * @param {Array<{hrid: string, grade: number}>} picks
 * @param {number} slots
 * @param {number} [linesPerTalisman]
 * @returns {Array<{slotIndex: number, modifiers: Array<{hrid: string, grade: number}>}>} 1-based, empties left out
 */
export function arrangeTalismans(picks, slots, linesPerTalisman = DEFAULT_LINES_PER_TALISMAN) {
    const count = Math.max(0, Math.floor(slots));
    if (count === 0) return [];
    const order = new Map();
    for (const pick of picks) if (!order.has(pick.hrid)) order.set(pick.hrid, order.size);
    const sorted = [...picks].sort((a, b) => order.get(a.hrid) - order.get(b.hrid));
    const talismans = Array.from({ length: count }, (_, i) => ({ slotIndex: i + 1, modifiers: [] }));
    let placed = 0;
    for (const pick of sorted) {
        if (placed >= count * linesPerTalisman) break;
        const target = talismans[placed % count];
        if (target.modifiers.some((m) => m.hrid === pick.hrid)) continue;
        target.modifiers.push({ hrid: pick.hrid, grade: pick.grade });
        placed++;
    }
    return talismans.filter((t) => t.modifiers.length > 0);
}

/** A hair of difference between two sampled runs' per-hour spend of an unpriced item is not "more" of it */
const UNPRICED_MORE_TOLERANCE = 0.02;

/**
 * The tolerance for exact figures (the skilling calculator, not a sampled sim): only floating-point round-off. Any
 * real rise in an unpriced input's use is a cost counted as free, however small.
 */
export const EXACT_UNPRICED_TOLERANCE = 1e-9;

/**
 * The running costs (food, drinks, dungeon keys) a line's run counted at zero that the baseline's did not, or spends
 * more of: profit built on them is a ceiling, not a figure (the real spend only lowers it).
 * @param {Object} baseline - `computeMetrics` of the bare baseline
 * @param {Object} measured - `computeMetrics` of the run with the line
 * @returns {string[]} Names of the unpriced running costs the line adds to; empty when it adds none
 */
export function newlyUnpricedLineCosts(baseline, measured, tolerance = UNPRICED_MORE_TOLERANCE) {
    const already = new Set(baseline?.unpricedCost || []);
    const baseRates = baseline?.unpricedCostRates || {};
    const rates = measured?.unpricedCostRates || {};
    return (measured?.unpricedCost || []).filter((name) => {
        if (!already.has(name)) return true;
        const before = baseRates[name];
        const after = rates[name];
        // Unpriced in both runs but spent more of: the extra is free too. An unknown rate cannot clear it
        if (!Number.isFinite(before) || !Number.isFinite(after)) return true;
        return after > before * (1 + tolerance);
    });
}

/**
 * A row's value at a grade: the per-grade figure when the row has one (measured, or scaled from the simulated
 * grade), else its measured value.
 * @param {Object|undefined} row
 * @param {number} grade
 * @returns {number}
 */
export function valueAtGrade(row, grade) {
    if (!row) return 0;
    // A gain resting on an input counted as free is not a real gain: no set, plan or per-orb figure may build on it
    if (row.gainUnreal) return 0;
    const at = row.byGrade?.[grade - 1];
    return Number.isFinite(at) ? at : Number(row.value) || 0;
}

/**
 * What each copy of a line adds at a grade, first copy first. A row measured with a copy in every slot
 * (`copiesValue`, at the simulated grade) values later copies by what they added, scaled to the grade like the
 * first; a line whose later copies add more than the first (synergy) has every copy at the average; a row never
 * measured that way is assumed linear (`assumed`). A Special line has one copy only: a second copy of the same
 * Special adds nothing (measured 2026-11-13), whatever a copies run read.
 * @param {Object} row
 * @param {number} slots
 * @param {number} grade
 * @returns {{marginals: number[], assumed: boolean}}
 */
export function lineMarginals(row, slots, grade) {
    const v = valueAtGrade(row, grade);
    const count = Math.max(1, Math.floor(slots) || 1);
    if (!(v > 0)) return { marginals: [], assumed: false };
    if (count === 1 || row.special) return { marginals: [v], assumed: false };
    if (Number.isFinite(row.copiesValue) && row.value) {
        const copies = row.copiesValue * (v / row.value);
        const later = (copies - v) / (count - 1);
        return {
            marginals: later > v ? Array(count).fill(copies / count) : [v, ...Array(count - 1).fill(later)],
            assumed: false,
        };
    }
    return { marginals: Array(count).fill(v), assumed: true };
}

/**
 * How a set mode builds its set: the grade it aims for and how many Special lines a talisman may hold.
 * @param {string} mode
 * @param {Object} params
 * @param {number} params.simGrade - Grade the ranking measured at
 * @param {number} params.capGrade - The Practical cap
 * @returns {{mode: string, grade: number, maxSpecialPerTalisman: number}}
 */
export function setOptionsFor(mode, { simGrade, capGrade }) {
    if (mode === 'ideal') return { mode, grade: simGrade, maxSpecialPerTalisman: Infinity };
    return {
        mode: mode === 'budget' ? 'budget' : 'practical',
        grade: Math.max(1, Math.floor(capGrade) || DEFAULT_CAP_GRADE),
        maxSpecialPerTalisman: 1,
    };
}

/**
 * Choose the recommended set from measured per-line values (the Ideal and Practical modes).
 *
 * A multiset of lines with at most `slots` copies of a line, `slots * linesPerTalisman` lines in all and at most
 * `slots * maxSpecialPerTalisman` Special lines; every such multiset fits the belt (see {@link arrangeTalismans},
 * Specials laid out first). Greedy by the value each copy adds at `grade` ({@link lineMarginals}). Lines that
 * cleared their error bar are taken before lines that did not, and only copies that add something are taken.
 *
 * @param {Array<Object>} rows - `{hrid, name, value, byGrade?, copiesValue?, significant, special?}`, values in the
 *   ranking's good direction
 * @param {Object} options
 * @param {number} options.slots
 * @param {number} options.grade - Grade the set aims for
 * @param {number} [options.linesPerTalisman]
 * @param {number} [options.maxSpecialPerTalisman] - Infinity for no limit
 * @returns {Object|null}
 */
export function buildRecommendedSet(
    rows,
    { slots, grade, linesPerTalisman = DEFAULT_LINES_PER_TALISMAN, maxSpecialPerTalisman = Infinity }
) {
    const count = Math.max(0, Math.floor(slots || 0));
    if (count === 0) return null;
    const copies = [];
    for (const row of rows || []) {
        const { marginals, assumed } = lineMarginals(row, count, grade);
        marginals.forEach((marginal, copy) => {
            if (marginal > 0) copies.push({ row, copy, marginal, assumed: assumed && copy > 0 });
        });
    }
    copies.sort(
        (a, b) =>
            Number(Boolean(b.row.significant)) - Number(Boolean(a.row.significant)) ||
            b.marginal - a.marginal ||
            a.copy - b.copy
    );
    const limit = count * linesPerTalisman;
    const specialLimit = count * maxSpecialPerTalisman;
    const taken = new Map();
    let lines = 0;
    let specials = 0;
    let predicted = 0;
    for (const entry of copies) {
        if (lines >= limit) break;
        const have = taken.get(entry.row.hrid)?.copies || 0;
        // A later copy only after the earlier ones
        if (entry.copy !== have) continue;
        if (entry.row.special && specials >= specialLimit) continue;
        const member = taken.get(entry.row.hrid) || {
            hrid: entry.row.hrid,
            name: entry.row.name,
            copies: 0,
            value: 0,
            significant: Boolean(entry.row.significant),
            special: Boolean(entry.row.special),
            assumedLinear: false,
            // A gain that rests on a running cost counted as free: marked, never presented as a figure
            ...(entry.row.costUnpriced?.length ? { costUnpriced: entry.row.costUnpriced } : {}),
        };
        member.copies++;
        member.value += entry.marginal;
        member.assumedLinear = member.assumedLinear || entry.assumed;
        taken.set(entry.row.hrid, member);
        predicted += entry.marginal;
        lines++;
        if (entry.row.special) specials++;
    }
    if (taken.size === 0) return null;
    // Specials first, so each lands on its own talisman
    const members = [...taken.values()].sort((a, b) => Number(b.special) - Number(a.special));
    const picks = members.flatMap((m) => Array.from({ length: m.copies }, () => ({ hrid: m.hrid, grade })));
    const talismans = arrangeTalismans(picks, count, linesPerTalisman);
    return {
        talismans,
        members,
        predicted,
        lineCount: picks.length,
        grade,
        withinNoise: members.filter((m) => !m.significant).length,
    };
}

/**
 * The set as reroll targets: per talisman, the lines it should carry and the lowest grade that counts.
 * @param {{talismans: Array<Object>}|null} set
 * @returns {Array<Array<{hrid: string, minGrade: number}>>}
 */
export function toRerollTargets(set) {
    return (set?.talismans || []).map((t) => t.modifiers.map((m) => ({ hrid: m.hrid, minGrade: m.grade })));
}

/**
 * Rows best first, by value in the ranking's direction.
 * @param {Array<Object>} rows
 * @returns {Array<Object>}
 */
export function sortRows(rows) {
    return [...rows].sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name)));
}

/**
 * The lines a talisman could aim for at a grade, best value first (measured lines before lines within noise), with the
 * Special lines apart.
 * @param {Array<Object>} rows
 * @param {Function} valueOf - `(row) => value` at the grade
 * @returns {{plain: Array<Object>, special: Array<Object>}}
 */
function rankedForGrade(rows, valueOf) {
    const ranked = rows
        .filter((r) => valueOf(r) > 0)
        .sort(
            (a, b) =>
                Number(Boolean(b.significant)) - Number(Boolean(a.significant)) ||
                valueOf(b) - valueOf(a) ||
                String(a.hrid).localeCompare(String(b.hrid))
        );
    return { plain: ranked.filter((r) => !r.special), special: ranked.filter((r) => r.special) };
}

/**
 * The target shapes one talisman can aim for at one grade: the best k plain lines, and the best Special with the
 * best k - 1 plain lines (at most one Special per talisman), for k = 1..maxLines.
 * @param {{plain: Array<Object>, special: Array<Object>}} ranked
 * @param {number} maxLines
 * @returns {Array<Array<Object>>} Picks, smallest first within each kind
 */
function targetShapes(ranked, maxLines) {
    const shapes = [];
    for (const withSpecial of [false, true]) {
        if (withSpecial && ranked.special.length === 0) continue;
        const kind = [];
        for (let k = 1; k <= maxLines; k++) {
            const pick = withSpecial ? [ranked.special[0], ...ranked.plain.slice(0, k - 1)] : ranked.plain.slice(0, k);
            if (pick.length < k) break;
            kind.push(pick);
        }
        shapes.push(kind);
    }
    return shapes;
}

/**
 * Budget mode: for each belt slot in turn, the talisman target (lines and one grade at or under the cap, at most one
 * Special) with the most value whose expected orb cost from a fresh talisman fits the budget; later talismans value
 * a repeated line by what its next copy adds.
 *
 * Candidate limit: per talisman, per grade from the cap down to G1, the best 1-4 plain lines and the best Special
 * with the best 0-3 plain lines (8 shapes a grade). A solve's cost depends only on that shape, so the whole plan is
 * at most 8 solves a grade (cached), and a shape over budget stops its larger siblings. The solver's own limit
 * (`maxSolves`) and Stop end it early.
 *
 * @param {Array<Object>} rows
 * @param {Object} params
 * @param {number} params.slots
 * @param {number} params.capGrade
 * @param {number} params.budget - Per talisman, in the solver's reference orbs
 * @param {string} params.typeHrid
 * @param {Object} params.orbs - OrbCostSolver
 * @param {number} [params.linesPerTalisman]
 * @returns {Promise<{set: Object|null, reason?: string, cheapest: number}>}
 */
export async function planBudgetSet(
    rows,
    { slots, capGrade, budget, typeHrid, orbs, linesPerTalisman = DEFAULT_LINES_PER_TALISMAN }
) {
    const count = Math.max(0, Math.floor(slots || 0));
    let cheapest = Infinity;
    let cheapestIsUpperBound = false;
    // Targets over the budget whose cost is only the solver's upper bound: they are not taken (fitting cannot be
    // shown), and the panel says they may fit
    let overUpperBound = 0;
    if (count === 0 || !orbs) return { set: null, reason: 'no_orbs', cheapest };
    const taken = new Map();
    const talismans = [];
    for (let slot = 1; slot <= count; slot++) {
        let best = null;
        for (let grade = Math.max(1, capGrade); grade >= 1; grade--) {
            const valueOf = (row) => lineMarginals(row, count, grade).marginals[taken.get(row.hrid) || 0] || 0;
            for (const kind of targetShapes(rankedForGrade(rows, valueOf), linesPerTalisman)) {
                for (const pick of kind) {
                    const cost = await orbs.freshCost(
                        typeHrid,
                        pick.map((r) => ({ hrid: r.hrid, minGrade: grade }))
                    );
                    if (orbs.stopped()) return { set: null, reason: 'cancelled', cheapest };
                    if (!cost) continue;
                    if (cost.orbs < cheapest) {
                        cheapest = cost.orbs;
                        cheapestIsUpperBound = Boolean(cost.upperBound);
                    }
                    // More lines cost more: the rest of this kind is over budget too. An upper bound over the
                    // budget may truly fit, but is not counted as fitting
                    if (!(cost.orbs <= budget)) {
                        if (cost.upperBound) overUpperBound++;
                        break;
                    }
                    const value = pick.reduce((sum, r) => sum + valueOf(r), 0);
                    if (
                        !best ||
                        value > best.value + 1e-12 ||
                        (Math.abs(value - best.value) <= 1e-12 && cost.orbs < best.cost.orbs)
                    ) {
                        best = { pick, grade, value, cost };
                    }
                }
            }
        }
        if (!best) break;
        talismans.push({
            slotIndex: slot,
            modifiers: best.pick.map((r) => ({ hrid: r.hrid, grade: best.grade })),
            value: best.value,
            cost: best.cost,
        });
        for (const row of best.pick) taken.set(row.hrid, (taken.get(row.hrid) || 0) + 1);
    }
    if (talismans.length === 0) {
        return {
            set: null,
            reason: orbs.limited ? 'limited' : Number.isFinite(cheapest) ? 'budget' : 'no_value',
            cheapest,
            cheapestIsUpperBound,
            overUpperBound,
        };
    }
    const members = [];
    for (const t of talismans) {
        for (const m of t.modifiers) {
            const row = rows.find((r) => r.hrid === m.hrid);
            const member = members.find((x) => x.hrid === m.hrid);
            if (member) member.copies++;
            else
                members.push({
                    hrid: m.hrid,
                    name: row?.name,
                    copies: 1,
                    significant: Boolean(row?.significant),
                    special: Boolean(row?.special),
                });
        }
    }
    const predicted = talismans.reduce((sum, t) => sum + t.value, 0);
    return {
        set: {
            talismans,
            members,
            predicted,
            lineCount: talismans.reduce((sum, t) => sum + t.modifiers.length, 0),
            budget,
            slots: count,
            slotsFilled: talismans.length,
            // The solve cap cut the plan short: the slots left empty were never planned, not found unaffordable
            limited: Boolean(orbs.limited),
            overUpperBound,
            withinNoise: members.filter((m) => !m.significant).length,
        },
        cheapest,
        cheapestIsUpperBound,
        overUpperBound,
    };
}

/**
 * Value per orb on every line that adds something: its value at `grade` over the expected orbs to get that one line
 * at that grade on a fresh talisman.
 * @param {Array<Object>} rows - Stamped in place (`orbCost`, `perOrb`)
 * @param {Object} params - `{grade, typeHrid, orbs}`
 * @returns {Promise<boolean>} false when stopped
 */
export async function stampValuePerOrb(rows, { grade, typeHrid, orbs }) {
    for (const row of rows) {
        const value = valueAtGrade(row, grade);
        if (!(value > 0)) continue;
        const cost = await orbs.freshCost(typeHrid, [{ hrid: row.hrid, minGrade: grade }]);
        if (orbs.stopped()) return false;
        if (cost && cost.orbs > 0) {
            row.orbCost = cost.orbs;
            row.perOrb = value / cost.orbs;
            // An upper-bound cost makes this value per orb a floor
            row.orbLimits = cost.upperBound ? cost.limits : null;
        }
    }
    return true;
}

/**
 * Expected orbs for each talisman of a set, from fresh.
 * @param {Object|null} set - Stamped in place (`talismans[i].cost`)
 * @param {Object} params - `{typeHrid, orbs}`
 * @returns {Promise<boolean>} false when stopped
 */
export async function stampSetCosts(set, { typeHrid, orbs }) {
    for (const talisman of set?.talismans || []) {
        if (talisman.cost) continue;
        talisman.cost = await orbs.freshCost(
            typeHrid,
            talisman.modifiers.map((m) => ({ hrid: m.hrid, minGrade: m.grade }))
        );
        if (orbs.stopped()) return false;
    }
    return true;
}

/**
 * "Improve mine": from the talismans the player owns (worn or not) of this type, the next targets with the most value
 * per orb. A target is the best lines at one grade at or under the cap (at most one Special, no more lines than the
 * talisman has); its gain is the target lines' value less what the talisman's lines are worth now (lines the target
 * leaves out are counted at nothing, so the gain is a floor); its cost is the solver's expected orbs from the
 * talisman's current lines (a pending roll included). Each talisman is valued on its own, as a first copy.
 *
 * Solves are what take the time, so the search goes grade by grade (G1 up) and target size by size across every
 * talisman at once (a solve of one shape serves every talisman with as many lines), and stops growing a kind of target
 * as soon as one more line lowers the best value per orb: a bigger target costs disproportionately more. A target is
 * not costed at all when it cannot reach the shown list: reaching it also reaches the same lines at a lower grade, and
 * the same lines less the last, so either of those costs (already worked out) is a floor on its cost, and its gain over
 * that floor is a ceiling on its value per orb.
 *
 * @param {Array<Object>} rows
 * @param {Object} params
 * @param {Array<Object>} params.owned - `characterTalismans`
 * @param {string} params.typeHrid
 * @param {number} params.capGrade
 * @param {Object} params.orbs - OrbCostSolver
 * @param {number} [params.linesPerTalisman]
 * @param {number} [params.top]
 * @returns {Promise<Object>} `{status: 'done'|'nothing'|'none_owned'|'none_of_type'|'cancelled', options, ...}`
 */
export async function planImprovements(
    rows,
    { owned, typeHrid, capGrade, orbs, linesPerTalisman = DEFAULT_LINES_PER_TALISMAN, top = IMPROVE_TOP }
) {
    const all = Array.isArray(owned) ? owned.filter((t) => t && Array.isArray(t.modifiers)) : [];
    if (all.length === 0) return { status: 'none_owned', options: [] };
    const mine = all.filter((t) => t.talismanTypeHrid === typeHrid && t.modifiers.length > 0);
    if (mine.length === 0) return { status: 'none_of_type', options: [], otherCount: all.length };
    const byHrid = new Map(rows.map((r) => [r.hrid, r]));
    const considered = mine.slice(0, IMPROVE_MAX_TALISMANS).map((talisman) => ({
        talisman,
        current: talisman.modifiers.reduce((sum, m) => sum + valueAtGrade(byHrid.get(m.hrid), m.grade), 0),
        maxLines: Math.min(talisman.modifiers.length, linesPerTalisman),
    }));
    const widest = Math.max(...considered.map((c) => c.maxLines));
    const options = [];
    // Costs (or floors) already worked out, per talisman, lines and grade: floors for harder targets of the same one
    const known = new Map();
    const keyOf = (id, pick, grade) => `${id}|${pick.map((r) => r.hrid).join(',')}|${grade}`;
    const floorCost = (id, pick, grade) => {
        let floor = 0;
        for (let g = 1; g < grade; g++) floor = Math.max(floor, known.get(keyOf(id, pick, g)) || 0);
        if (pick.length > 1) floor = Math.max(floor, known.get(keyOf(id, pick.slice(0, -1), grade)) || 0);
        return floor;
    };
    /** The value per orb a new option must beat to be shown */
    const bar = () => {
        if (options.length < top) return -Infinity;
        return rankOptions(options, top)[top - 1].perOrb;
    };
    for (let grade = 1; grade <= Math.max(1, capGrade); grade++) {
        const valueOf = (row) => valueAtGrade(row, grade);
        for (const kind of targetShapes(rankedForGrade(rows, valueOf), widest)) {
            let bestBefore = -Infinity;
            for (const pick of kind) {
                const targets = pick.map((r) => ({ hrid: r.hrid, minGrade: grade }));
                const value = pick.reduce((sum, r) => sum + valueOf(r), 0);
                let best = -Infinity;
                for (const { talisman, current, maxLines } of considered) {
                    if (pick.length > maxLines) continue;
                    const gain = value - current;
                    if (!(gain > 0)) continue;
                    // Cannot make the shown list: not worth a solve
                    const floor = floorCost(talisman.id, pick, grade);
                    if (floor > 0 && gain / floor <= bar()) {
                        // Kept as this target's floor: a larger target of it starts from there
                        known.set(keyOf(talisman.id, pick, grade), floor);
                        continue;
                    }
                    const cost = await orbs.ownedCost(talisman, targets);
                    if (orbs.stopped()) return { status: 'cancelled', options: rankOptions(options, top) };
                    // Only an exact cost is a floor for harder targets: an upper bound may be above the truth
                    if (cost && Number.isFinite(cost.orbs) && !cost.upperBound) {
                        known.set(keyOf(talisman.id, pick, grade), cost.orbs);
                    }
                    if (!cost || cost.status === 'met' || !(cost.orbs > 0)) continue;
                    const perOrb = gain / cost.orbs;
                    best = Math.max(best, perOrb);
                    options.push({
                        talisman,
                        targets,
                        gain,
                        cost,
                        perOrb,
                        withinNoise: pick.filter((r) => !r.significant).length,
                    });
                }
                // One more line made no talisman a better buy (or none could make the list): bigger targets of this
                // kind will not either
                if (pick.length > 1 && (best < bestBefore || best === -Infinity)) break;
                bestBefore = Math.max(bestBefore, best);
            }
        }
    }
    const ranked = rankOptions(options, top);
    return {
        status: ranked.length ? 'done' : 'nothing',
        options: ranked,
        considered: considered.length,
        ofType: mine.length,
        limited: Boolean(orbs.limited),
    };
}

function rankOptions(options, top) {
    return [...options].sort((a, b) => b.perOrb - a.perOrb || b.gain - a.gain).slice(0, top);
}

/**
 * Build the set a mode asks for. Practical and Ideal are greedy over the measured values; Budget needs the orb solver.
 * @param {Array<Object>} rows
 * @param {Object} params - `{mode, slots, simGrade, capGrade, budget, typeHrid, orbs, linesPerTalisman}`
 * @returns {Promise<{set: Object|null, reason?: string, cheapest?: number, options: Object}>}
 */
export async function planSet(rows, params) {
    const options = setOptionsFor(params.mode, params);
    if (options.mode === 'budget') {
        if (!params.orbs) return { set: null, reason: 'no_orbs', options };
        const plan = await planBudgetSet(rows, {
            slots: params.slots,
            capGrade: options.grade,
            budget: params.budget,
            typeHrid: params.typeHrid,
            orbs: params.orbs,
            linesPerTalisman: params.linesPerTalisman,
        });
        return { ...plan, options };
    }
    const set = buildRecommendedSet(rows, {
        slots: params.slots,
        grade: options.grade,
        linesPerTalisman: params.linesPerTalisman,
        maxSpecialPerTalisman: options.maxSpecialPerTalisman,
    });
    return { set, options };
}

// ---------------------------------------------------------------------------------------------------------------
// Skilling
// ---------------------------------------------------------------------------------------------------------------

/** The skilling action types this ranking values (the profit calculators cover these) */
export const RANKABLE_SKILLING_TYPES = [...GATHERING_TYPES, ...PRODUCTION_TYPES];

/**
 * The stat names (and buff types) the skilling math reads for an action type: the gear stats the speed, efficiency,
 * rare find, essence find and experience parsers read, gathering quantity for gathering, Processing for gathering
 * and Gourmet for production. A line feeding none of them does nothing for this action.
 *
 * Kept by hand beside the parsers (equipment-parser.js, experience-parser.js, efficiency.js): a stat added there
 * must be added here too. `combat-sim/talisman-line-ranking.reads.test.js` checks every name listed here is read; it cannot
 * see one the parsers read that is missing here.
 * @param {string} actionTypeHrid
 * @returns {Set<string>}
 */
export function skillingStatsRead(actionTypeHrid) {
    const skill = String(actionTypeHrid || '').replace('/action_types/', '');
    const read = new Set([
        `${skill}Speed`,
        'skillingSpeed',
        `${skill}Efficiency`,
        'skillingEfficiency',
        `${skill}RareFind`,
        'skillingRareFind',
        `${skill}EssenceFind`,
        'skillingEssenceFind',
        `${skill}Experience`,
        'skillingExperience',
    ]);
    if (GATHERING_TYPES.includes(actionTypeHrid)) {
        read.add('gatheringQuantity');
        read.add('/buff_types/processing');
    }
    if (PRODUCTION_TYPES.includes(actionTypeHrid)) read.add('/buff_types/gourmet');
    return read;
}

/**
 * The names a line feeds: stat names for stat lines, buff type hrids for buff lines.
 * @param {Object} detail
 * @returns {string[]}
 */
export function lineFeeds(detail) {
    const isBuff = detail?.targetHrid === '/talisman_modifier_targets/buff';
    return (detail?.keys || []).map((k) => (isBuff ? k : talismanStatName(k)));
}

/**
 * Skilling lines split by whether this action's math reads them.
 * @param {Array<Object>} lines
 * @param {string} actionTypeHrid
 * @returns {{applicable: Array<Object>, other: Array<Object>}}
 */
export function splitSkillingLines(lines, actionTypeHrid) {
    const read = skillingStatsRead(actionTypeHrid);
    const applicable = [];
    const other = [];
    for (const detail of lines) (lineFeeds(detail).some((n) => read.has(n)) ? applicable : other).push(detail);
    return { applicable, other };
}

/**
 * Rank the skilling lines for one action: exact values at every grade, then the set the mode asks for (Ideal and
 * Practical: an exact greedy at the set's grade; Budget: the orb-budget plan, then evaluated exactly), value per orb
 * and the set's orb costs when an orb solver is handed in.
 *
 * @param {Object} params
 * @param {string} params.actionHrid
 * @param {number} params.grade - Grade the table centers on, and the Ideal set's grade
 * @param {string} params.metricKey - 'profit' or 'xp'
 * @param {string} [params.setMode] - 'practical' (default), 'ideal' or 'budget'
 * @param {number} [params.capGrade]
 * @param {number} [params.budget]
 * @param {Object} deps
 * @param {Function} deps.getGameData
 * @param {Function} deps.resolveContext - `(actionTypeHrid) => {equipment: Map, drinks: Array}`
 * @param {Function} deps.evaluate - `async (actionHrid, {equipment, drinks}) => {profitPerHour, xpPerHour,
 *   revenuePerHour, hasMissingPrices}|null`
 * @param {Object} [deps.orbs] - OrbCostSolver, for Budget and value per orb
 * @param {Function} [deps.yieldNow]
 * @param {Object} [options] - `{abortSignal}`
 * @returns {Promise<Object>}
 */
export async function runSkillingLineRanking(params, deps, options = {}) {
    const {
        actionHrid,
        grade: requestedGrade,
        metricKey,
        setMode = DEFAULT_SET_MODE,
        capGrade = DEFAULT_CAP_GRADE,
        budget = 0,
    } = params;
    const stopped = () => Boolean(options.abortSignal?.());
    const gameData = deps.getGameData();
    if (!isTestServer())
        return { status: 'refused', reason: 'live', message: 'Talismans exist on the test server only.' };
    const modifierDetailMap = gameData?.talismanModifierDetailMap;
    const lines = talismanLines(modifierDetailMap, SKILLING_TALISMAN_TYPE);
    if (!lines.length)
        return { status: 'refused', reason: 'no_tables', message: 'The game data has no talisman lines.' };
    const action = gameData.actionDetailMap?.[actionHrid];
    if (!action) return { status: 'refused', reason: 'no_action', message: 'Pick an action.' };
    if (!RANKABLE_SKILLING_TYPES.includes(action.type)) {
        return {
            status: 'refused',
            reason: 'unsupported',
            message: 'Only gathering and production actions are ranked (not Alchemy or Enhancing).',
        };
    }
    const resolved = deps.resolveContext(action.type);
    // One snapshot of the gear (with the talisman share it carries) and drinks for the whole run: a gear change or a
    // loadout save mid-run must not move the baseline under the lines. Prices are read live, as each figure is worked out
    const context = resolved?.equipment
        ? {
              equipment: attachTalismanBonuses(new Map(resolved.equipment), talismanBonusesOf(resolved.equipment)),
              drinks: [...(resolved.drinks || [])],
          }
        : resolved;
    const belt = context?.equipment?.get?.(BELT_LOCATION) || null;
    const slots = getBeltSlotCount(belt, gameData.itemDetailMap);
    if (!belt?.itemHrid || slots === 0) {
        return {
            status: 'refused',
            reason: 'no_belt',
            message: 'The gear this action runs with has no Talisman Belt. Put one on first.',
        };
    }
    const power = getTalismanPower(belt, gameData.itemDetailMap, gameData.enhancementLevelTotalBonusMultiplierTable);
    const { maxGrade, linesPerTalisman } = talismanLimits(gameData.talismanInfo);
    const grade = Math.min(maxGrade, Math.max(1, Math.floor(requestedGrade) || maxGrade));
    const metric = rankingMetric(metricKey, SKILLING_RANKING_METRICS);
    const { applicable, other } = splitSkillingLines(lines, action.type);
    if (applicable.length === 0) {
        return { status: 'refused', reason: 'no_lines', message: 'No talisman line affects this action.' };
    }
    const setOptions = setOptionsFor(setMode, { simGrade: grade, capGrade: Math.min(maxGrade, capGrade) });

    const base = {
        actionHrid,
        actionName: action.name,
        grade,
        metricKey: metric.key,
        power,
        slots,
        belt,
        otherLines: other,
        setMode: setOptions.mode,
        setGrade: setOptions.grade,
        budget,
    };
    let evaluations = 0;
    // Any figure the run read with an output's price missing: its profit is a floor, and so is everything compared with
    // it. A figure that does not say which side is missing (`outputsUnpriced`) is read as the output
    let anyMissing = false;
    // Any figure with an input (material, drink) counted as free: its profit is overstated, never a floor
    let anyUnpricedInputs = false;
    const outputMissing = (figures) => Boolean(figures?.hasMissingPrices) && figures.outputsUnpriced !== false;
    const noteMissing = (figures) => {
        if (outputMissing(figures)) anyMissing = true;
        if (figures?.unpricedCost?.length) anyUnpricedInputs = true;
        return figures;
    };
    const yieldNow = deps.yieldNow || (() => new Promise((resolve) => setTimeout(resolve, 0)));
    /** The action's figures with these talismans in the belt (and only these) */
    const evaluateWith = async (talismans) => {
        if (++evaluations % 4 === 0) await yieldNow();
        const bonuses = computeTalismanBonuses({
            talismans,
            belt,
            itemDetailMap: gameData.itemDetailMap,
            modifierDetailMap,
            enhancementTable: gameData.enhancementLevelTotalBonusMultiplierTable,
        });
        const equipment = attachTalismanBonuses(new Map(context.equipment), bonuses);
        return noteMissing(await deps.evaluate(actionHrid, { equipment, drinks: context.drinks }));
    };
    const read = (figures) => (figures ? metric.rate(figures) || 0 : NaN);

    const bare = await evaluateWith([]);
    if (!bare) return { status: 'refused', reason: 'no_figures', message: 'This action has no figures to rank by.' };
    // No revenue at all with prices missing is every output unpriced (the market not loaded yet), not an action
    // that earns nothing: every line would read as "no effect"
    if (metric.key === 'profit' && bare.hasMissingPrices && !(bare.revenuePerHour > 0)) {
        return {
            status: 'refused',
            reason: 'no_prices',
            message: 'No prices for this action yet (market data not loaded?). Try again, or rank by EXP/hr.',
        };
    }
    const bareValue = read(bare);
    const stoppedResult = (rows, extra = {}) => ({
        hasMissingPrices: anyMissing,
        hasUnpricedInputs: anyUnpricedInputs,
        status: 'stopped',
        ...base,
        rows: sortRows(rows),
        measured: rows.length,
        of: applicable.length,
        ...extra,
    });
    const rows = [];
    for (const detail of applicable) {
        if (stopped()) return stoppedResult(rows);
        const byGrade = [];
        let missing = false;
        const unpriced = new Set();
        for (let g = 1; g <= detail.gradeValues.length; g++) {
            const figures = await evaluateWith(lineCopies(detail.hrid, g, 1));
            byGrade.push(read(figures) - bareValue);
            missing = missing || outputMissing(figures);
            // Inputs this line makes the action spend more of, counted as free (as the combat ranking does)
            for (const name of newlyUnpricedLineCosts(bare, figures, EXACT_UNPRICED_TOLERANCE)) unpriced.add(name);
        }
        const costUnpriced = [...unpriced];
        // A profit gain resting on an input counted as free is a ceiling, not a gain: no set or plan builds on it
        const gainUnreal = metric.key === 'profit' && costUnpriced.length > 0;
        rows.push({
            hrid: detail.hrid,
            name: detail.name,
            detail,
            special: isSpecialLine(detail),
            lineValues: lineValuesByGrade(detail, power),
            byGrade,
            value: byGrade[grade - 1] ?? 0,
            significant: true,
            noEffect: byGrade.every((v) => v === 0),
            hasMissingPrices: missing,
            ...(costUnpriced.length ? { costUnpriced, gainUnreal } : {}),
        });
    }

    let set = null;
    let setValue = bareValue;
    let budgetPlan = null;
    if (setOptions.mode === 'budget') {
        budgetPlan = await planSet(rows, {
            mode: 'budget',
            slots,
            simGrade: grade,
            capGrade: setOptions.grade,
            budget,
            typeHrid: SKILLING_TALISMAN_TYPE,
            orbs: deps.orbs,
            linesPerTalisman,
        });
        if (budgetPlan.reason === 'cancelled' || stopped()) return stoppedResult(rows, { stage: 'orbs' });
        set = budgetPlan.set;
        if (set) setValue = read(await evaluateWith(set.talismans));
    } else {
        // Exact greedy: each step adds the copy that raises the set's figure most, laid out as real talismans
        const setGrade = setOptions.grade;
        const picks = [];
        const limit = slots * linesPerTalisman;
        const specialLimit = slots * setOptions.maxSpecialPerTalisman;
        const candidates = rows.filter((r) => valueAtGrade(r, setGrade) > 0);
        const layout = (list) => {
            const specialsFirst = [...list].sort((a, b) => Number(b.special) - Number(a.special));
            return arrangeTalismans(specialsFirst, slots, linesPerTalisman);
        };
        while (picks.length < limit && candidates.length) {
            if (stopped()) return stoppedResult(rows);
            let best = null;
            const specialsTaken = picks.filter((p) => p.special).length;
            for (const row of candidates) {
                // A Special line counts once however many copies are worn
                if (picks.filter((p) => p.hrid === row.hrid).length >= (row.special ? 1 : slots)) continue;
                if (row.special && specialsTaken >= specialLimit) continue;
                const trial = [...picks, { hrid: row.hrid, grade: setGrade, special: row.special }];
                const value = read(await evaluateWith(layout(trial)));
                if (value - setValue > 1e-9 && (!best || value > best.value)) best = { row, value };
            }
            if (!best) break;
            picks.push({ hrid: best.row.hrid, grade: setGrade, special: best.row.special });
            setValue = best.value;
        }
        if (picks.length) {
            const members = [];
            for (const pick of picks) {
                const member = members.find((m) => m.hrid === pick.hrid);
                if (member) member.copies++;
                else
                    members.push({
                        hrid: pick.hrid,
                        name: rows.find((r) => r.hrid === pick.hrid)?.name,
                        copies: 1,
                        significant: true,
                        special: pick.special,
                    });
            }
            // Predicted the naive way (each copy worth its single-line value), beside the exact figure for the set
            const predicted = members.reduce(
                (sum, m) =>
                    sum +
                    m.copies *
                        valueAtGrade(
                            rows.find((r) => r.hrid === m.hrid),
                            setGrade
                        ),
                0
            );
            set = { talismans: layout(picks), members, predicted, lineCount: picks.length, grade: setGrade };
        }
    }
    if (deps.orbs) {
        if (
            !(await stampValuePerOrb(rows, {
                grade: setOptions.grade,
                typeHrid: SKILLING_TALISMAN_TYPE,
                orbs: deps.orbs,
            }))
        )
            return stoppedResult(rows, { set, stage: 'orbs' });
        if (!(await stampSetCosts(set, { typeHrid: SKILLING_TALISMAN_TYPE, orbs: deps.orbs })))
            return stoppedResult(rows, { set, stage: 'orbs' });
    }
    // The talismans the action's gear carries now: the context's own Map, untouched
    const worn = noteMissing(await deps.evaluate(actionHrid, { equipment: context.equipment, drinks: context.drinks }));
    if (set) {
        set.hasMissingPrices = anyMissing;
        set.hasUnpricedInputs = anyUnpricedInputs;
    }
    return {
        status: 'done',
        ...base,
        bare,
        rows: sortRows(rows),
        set,
        setReason: budgetPlan?.reason ?? null,
        cheapest: budgetPlan?.cheapest ?? null,
        // Exact: the set's own evaluation
        combined: set ? { value: setValue - bareValue } : null,
        current: worn ? { value: read(worn) - bareValue } : null,
        evaluations: evaluations + 1,
        hasMissingPrices: anyMissing,
        hasUnpricedInputs: anyUnpricedInputs,
        rerollTargets: toRerollTargets(set),
    };
}
