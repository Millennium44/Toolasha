/**
 * Talisman core advisor
 *
 * Test server only. Answers "is adding the next line to one of my worn talismans with a core worth it, against what the
 * core costs?". No sim and no new measurement: the next line is a draw, and every outcome of it is valued from the rows
 * the Talisman lines ranking already measured.
 *
 * The draw (measured, see MEASURED_ODDS.freshLineGrades): a line added by a core is G1-G3 only, whatever the core (the
 * Reforging curve cut at G3), and its type is drawn by the game data's modifier `weight` among the types the talisman
 * type can roll that the talisman does not already hold (it never holds one type twice). Types the ranking has no row
 * for keep their share of the draw and count for nothing, so the expectation never divides over the valued types only.
 *
 * Value of an outcome: the ranking row's value for that line at that grade. A type already worn on another talisman
 * adds its later-copy marginal (`lineMarginals`), not its first-copy value. A row measured against a bare belt is the
 * line on its own; the figure here is what the line adds to the set worn now only as far as lines are additive.
 *
 * Cost: the cores the game data asks for that line (`talismanInfo.addModifierInputMap`), at the market Buy price under
 * the profit pricing mode (the same quote a belt gets). Only a live quote or the player's own price counts. A missing
 * quote makes the row unpriced: no gain per cost, sorted last. Nothing is estimated and nothing is priced from the
 * Tester shop.
 *
 * Not included: what the extra line does to the orbs the other lines need later.
 *
 * Stateless: everything is passed in.
 */

import { isTestServer } from '../../utils/game-server.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { MEASURED_ODDS, gradeOdds } from '../../utils/talisman-reroll-solver.js';
import { lineMarginals, talismanLimits, talismanLines, valueAtGrade } from '../../utils/talisman-line-sets.js';
import { quoteBelt, sortBeltRows } from './talisman-belt-advisor.js';

/** The cost basis the shared rate and sort helpers read */
export const CORE_BASIS = 'market';

/** A row leaning mostly on rows within the ranking's noise is not a real gain */
const NOISE_SHARE = 0.5;

/**
 * The talisman type of a record: its own field, else the type its lines belong to (a sim DTO's talisman carries
 * slot and lines only).
 * @param {Object} talisman
 * @param {Object} modifierDetailMap
 * @returns {string|null}
 */
export function talismanTypeOf(talisman, modifierDetailMap) {
    if (talisman?.talismanTypeHrid) return talisman.talismanTypeHrid;
    for (const m of talisman?.modifiers || []) {
        const type = modifierDetailMap?.[m?.hrid]?.talismanTypeHrid;
        if (type) return type;
    }
    return null;
}

/**
 * What the core for one added line costs. Never zero for a missing quote or a missing entry.
 * @param {Object} info - talismanInfo
 * @param {Object} itemDetailMap
 * @param {number} lineNumber - The line being added (2, 3, 4)
 * @param {Function} [priceInfo] - getItemPriceInfo-shaped; injectable for tests
 * @returns {{price: number|null, reason?: string, itemHrid?: string, count?: number, unit?: number}}
 */
export function nextLineCost(info, itemDetailMap, lineNumber, priceInfo = getItemPriceInfo) {
    const input = info?.addModifierInputMap?.[lineNumber] ?? info?.addModifierInputMap?.[String(lineNumber)];
    const count = Number(input?.count);
    if (!input?.itemHrid || !(count > 0)) {
        return { price: null, reason: `The game data does not say what line ${lineNumber} costs.` };
    }
    const name = itemDetailMap?.[input.itemHrid]?.name || input.itemHrid.replace('/items/', '');
    const unit = quoteBelt(input.itemHrid, 0, 'buy', priceInfo);
    if (unit === null) {
        return {
            price: null,
            reason: `No market listing for ${count} × ${name}.`,
            itemHrid: input.itemHrid,
            count,
        };
    }
    return { price: unit * count, itemHrid: input.itemHrid, count, unit };
}

/**
 * The quotes the cores would be priced at now, for a stale check (a price moving makes a drawn check out of date).
 * @param {Object} info - talismanInfo
 * @param {Object} itemDetailMap
 * @param {Function} [priceInfo]
 * @returns {Object<string, number|null>} Core item hrid to its unit quote
 */
export function coreQuoteKey(info, itemDetailMap, priceInfo = getItemPriceInfo) {
    const out = {};
    for (const line of Object.keys(info?.addModifierInputMap || {})) {
        const cost = nextLineCost(info, itemDetailMap, Number(line), priceInfo);
        if (cost.itemHrid) out[cost.itemHrid] = cost.unit ?? null;
    }
    return out;
}

/**
 * Value the next line of one talisman.
 *
 * @param {Object} params
 * @param {Object} params.talisman - `{modifiers: [{hrid, grade}]}`
 * @param {Array<Object>} params.others - The other worn talismans of this type
 * @param {Map<string, Object>} params.rowsByHrid - Ranking rows by line hrid
 * @param {Array<Object>} params.pool - Every line the talisman type can roll (game data details)
 * @param {number[]} params.odds - P(grade) for G1..G3
 * @param {number} params.slots - The belt's slots
 * @returns {Object} `{value, significantValue, pUseful, best, unvaluedShare, ...marks}`
 */
function valueNextLine({ talisman, others, rowsByHrid, pool, odds, slots }) {
    const held = new Set((talisman.modifiers || []).map((m) => m.hrid));
    const rollable = pool.filter((d) => Number(d.weight) > 0 && !held.has(d.hrid));
    const total = rollable.reduce((sum, d) => sum + Number(d.weight), 0);
    const out = {
        value: 0,
        significantValue: 0,
        pUseful: 0,
        best: null,
        unvaluedShare: 0,
        unrealShare: 0,
        mechanicGain: 0,
        assumedGain: 0,
        rollable: rollable.length,
    };
    if (!(total > 0)) return out;
    for (const detail of rollable) {
        const pType = Number(detail.weight) / total;
        const row = rowsByHrid.get(detail.hrid);
        if (!row) {
            out.unvaluedShare += pType;
            continue;
        }
        if (row.gainUnreal) out.unrealShare += pType;
        const elsewhere = others.filter((t) => (t.modifiers || []).some((m) => m.hrid === detail.hrid)).length;
        for (let g = 1; g <= odds.length; g++) {
            const chance = pType * odds[g - 1];
            const first = valueAtGrade(row, g);
            let gain;
            let assumed = false;
            if (first > 0) {
                const { marginals, assumed: guessed } = lineMarginals(row, Math.max(slots, elsewhere + 1), g);
                gain = marginals[elsewhere] ?? 0;
                assumed = guessed && elsewhere > 0;
            } else {
                // A line that costs the build something still rolls: the core adds whatever it draws
                gain = first;
            }
            out.value += chance * gain;
            if (row.significant !== false) out.significantValue += chance * gain;
            if (gain > 0) {
                out.pUseful += chance;
                if (row.mechanic || row.nonlinear) out.mechanicGain += chance * gain;
                if (assumed) out.assumedGain += chance * gain;
                if (!out.best || gain > out.best.value) {
                    out.best = { hrid: detail.hrid, name: detail.name || row.name, grade: g, value: gain, chance };
                }
            }
        }
    }
    return out;
}

/**
 * Value adding the next line to every worn talisman of one type with room for it.
 *
 * @param {Object} params
 * @param {Array<Object>} params.talismans - Worn talismans (slot already within the belt): `{id?, slotIndex,
 *   talismanTypeHrid?, modifiers}`
 * @param {Object} params.ranking - A finished ranking result: `{status, rows, power, slots, grade, notValued?}`
 * @param {number} params.power - The belt's Talisman Power now
 * @param {string} params.typeHrid - The section's talisman type
 * @param {Object} params.gameData - init client data (`talismanInfo`, `talismanModifierDetailMap`, `itemDetailMap`)
 * @param {Function} [params.priceInfo]
 * @returns {Object} `{status: 'done'|'refused', reason?, message?, rows, ...}`
 */
export function adviseCores({ talismans, ranking, power, typeHrid, gameData, priceInfo = getItemPriceInfo }) {
    if (!isTestServer()) {
        return { status: 'refused', reason: 'live', message: 'Talismans exist on the test server only.', rows: [] };
    }
    const detailMap = gameData?.talismanModifierDetailMap || {};
    const info = gameData?.talismanInfo || {};
    const itemDetailMap = gameData?.itemDetailMap || {};
    const { linesPerTalisman } = talismanLimits(info);

    const mine = (talismans || []).filter((t) => talismanTypeOf(t, detailMap) === typeHrid);
    if (mine.length === 0) {
        return {
            status: 'refused',
            reason: 'no_talisman',
            message: 'No talisman of this type is worn in the belt, so there is no line to add. Slot one first.',
            rows: [],
        };
    }
    const open = mine.filter((t) => (t.modifiers || []).length < linesPerTalisman);
    if (open.length === 0) {
        return {
            status: 'refused',
            reason: 'all_full',
            message: `Every worn talisman of this type already has ${linesPerTalisman} lines: no core can add another.`,
            rows: [],
        };
    }
    if (!ranking || ranking.status !== 'done' || !Array.isArray(ranking.rows) || ranking.rows.length === 0) {
        const partial = ranking?.status === 'stopped';
        return {
            status: 'refused',
            reason: 'no_ranking',
            message: partial
                ? 'The ranking stopped early, so its rows are not all there. Rank again, then check the cores.'
                : 'Run the ranking first: the cores are valued from its rows.',
            rows: [],
        };
    }
    if (Number.isFinite(ranking.power) && Math.abs(ranking.power - power) > 1e-9) {
        return {
            status: 'refused',
            reason: 'other_belt',
            message: 'The ranking was run with another belt than the one worn now. Rank again, then check the cores.',
            rows: [],
        };
    }

    const odds = gradeOdds(Math.min(Number(gameData?.talismanInfo?.maxGrade) || 6, MEASURED_ODDS.freshLineGrades.cap));
    const rowsByHrid = new Map(ranking.rows.map((r) => [r.hrid, r]));
    const pool = talismanLines(detailMap, typeHrid);
    const slots = Number(ranking.slots) || mine.length;
    const nameOf = (hrid) => detailMap[hrid]?.name || hrid;

    const rows = open.map((talisman) => {
        const lineNumber = (talisman.modifiers || []).length + 1;
        const others = mine.filter((t) => t !== talisman);
        const v = valueNextLine({ talisman, others, rowsByHrid, pool, odds, slots });
        const significant = !(v.value > 0) || v.significantValue >= v.value * NOISE_SHARE;
        return {
            key: `${talisman.id ?? ''}@${talisman.slotIndex}`,
            id: talisman.id ?? null,
            slotIndex: talisman.slotIndex,
            lineNumber,
            lines: (talisman.modifiers || []).map((m) => ({ hrid: m.hrid, grade: m.grade, name: nameOf(m.hrid) })),
            value: v.value,
            significant,
            pUseful: v.pUseful,
            best: v.best,
            rollable: v.rollable,
            unvaluedShare: v.unvaluedShare,
            unrealShare: v.unrealShare,
            mechanicShare: v.value > 0 ? v.mechanicGain / v.value : 0,
            assumedShare: v.value > 0 ? v.assumedGain / v.value : 0,
            costs: { [CORE_BASIS]: nextLineCost(info, itemDetailMap, lineNumber, priceInfo) },
        };
    });
    return {
        status: 'done',
        rows: sortBeltRows(rows, CORE_BASIS),
        metricKey: ranking.metricKey,
        grade: ranking.grade,
        power,
        slots,
        odds,
    };
}
