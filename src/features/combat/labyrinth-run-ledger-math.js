/**
 * Labyrinth run ledger - the pure arithmetic.
 *
 * Grid sizes, torch plans, preserve chances, observed burn and the sparkline,
 * split out of `labyrinth-run-ledger.js` so importers in other bundles can use
 * them directly. The ledger module constructs a stateful singleton that one
 * library owns; a bundle that loads after it reaches that INSTANCE through the
 * shared global, which has none of these functions. Nothing here holds state.
 */

import dataManager from '../../core/data-manager.js';

/**
 * The grid width of a floor — 4×4 on floor 1, one wider per floor, 8×8 from
 * floor 5 on (the game guide's own table).
 * @param {number} floor - 1-based floor number
 * @returns {number}
 */
export function gridSize(floor) {
    const f = Math.max(1, Math.floor(Number(floor) || 1));
    return Math.min(3 + f, 8);
}

/** Rooms a full clear of a floor enters — the whole grid. */
export function roomsFullClear(floor) {
    const g = gridSize(floor);
    return g * g;
}

/** Rooms a rush across a floor enters — the shortest corner-to-corner path. */
export function roomsRush(floor) {
    const g = gridSize(floor);
    return 2 * g - 1;
}

/**
 * Rooms a run enters: floors at or under the rush floor are crossed by the
 * shortest path, floors above it are fully cleared.
 *
 * ("Rush for exit up to floor N" — the game's own setting — rushes the early
 * floors and clears the rest, which is the shape this sums.)
 *
 * @param {number} rushFloor - Floors 1..rushFloor are rushed; 0 rushes none
 * @param {number} deepestFloor - The last floor the run reaches
 * @returns {number} Rooms entered
 */
export function roomsForPlan(rushFloor, deepestFloor) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const rush = Math.max(0, Math.floor(Number(rushFloor) || 0));
    let rooms = 0;
    for (let floor = 1; floor <= deepest; floor++) {
        rooms += floor <= rush ? roomsRush(floor) : roomsFullClear(floor);
    }
    return rooms;
}

/**
 * The chance a torch is handed back on use, read off the item's own text.
 *
 * The game states it in the description — "20% chance to preserve" on an
 * expert torch — and nowhere else this codebase has found in the data, so the
 * description is parsed. A torch with no such sentence preserves nothing.
 *
 * @param {string} itemHrid - The torch
 * @param {Object} [itemDetailMap] - Game data; read from the client by default
 * @returns {number} 0..1
 */
export function preserveChance(itemHrid, itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap) {
    const text = String(itemDetailMap?.[itemHrid]?.description || '');
    const match = text.match(/(\d+(?:\.\d+)?)\s*%\s*chance\s+to\s+preserve/i);
    if (!match) return 0;
    const pct = Number(match[1]);
    return Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
}

/**
 * Torches a run costs: one per room entered, less the share the torch tier
 * hands back.
 *
 * @param {number} rushFloor - Floors 1..rushFloor are rushed; 0 rushes none
 * @param {number} deepestFloor - The last floor the run reaches
 * @param {number} [preserve=0] - Chance a use is preserved, 0..1
 * @returns {number} Expected torches spent, whole
 */
export function torchesForPlan(rushFloor, deepestFloor, preserve = 0) {
    const keep = Number.isFinite(preserve) ? Math.min(1, Math.max(0, preserve)) : 0;
    return Math.ceil(roomsForPlan(rushFloor, deepestFloor) * (1 - keep));
}

/**
 * The advisor's table: what a run to `deepestFloor` costs in torches at each
 * candidate rush floor, beside the capacity, so "can I rush less?" is a read
 * rather than a calculation.
 *
 * @param {number} deepestFloor - The floor runs actually reach
 * @param {number} torchCap - What a run can carry
 * @param {number} [preserve=0] - The torch tier's preserve chance, 0..1
 * @returns {Array<{rushFloor: number, torches: number, fits: boolean}>}
 */
export function rushFloorTable(deepestFloor, torchCap, preserve = 0) {
    const deepest = Math.max(1, Math.floor(Number(deepestFloor) || 1));
    const cap = Math.max(0, Math.floor(Number(torchCap) || 0));
    const rows = [];
    for (let rush = 0; rush <= deepest; rush++) {
        const torches = torchesForPlan(rush, deepest, preserve);
        rows.push({ rushFloor: rush, torches, fits: cap > 0 ? torches <= cap : false });
    }
    return rows;
}

/**
 * What recorded runs actually spent of one supply, for every run that knows
 * it. Newest first, as the ledger is.
 *
 * This is the figure the grid math only estimates — it has the real rush
 * floor, the rooms actually entered, and the preserves actually rolled in it.
 *
 * Prefers the run's `spent` figure — the sum of sighting-to-sighting
 * *decreases*, accumulated as the run was watched (see `foldSighting`) —
 * over `start - left`. The labyrinth shop sells more of all three supplies
 * for points earned mid-run, so `left` does not fall monotonically: a run
 * that buys back up partway through has `start - left` net against the
 * purchase, reading as spending less than it did, sometimes negative. `spent`
 * only counts falls, so a mid-run top-up cannot erase the drops that came
 * before it. Older records carry no `spent` field and fall back to
 * `start - left`, which is exactly `spent` would have been for a run that
 * never bought back in.
 *
 * @param {Array<Object>} runs - Ledger records
 * @param {string} kind - 'torch' | 'shroud' | 'beacon'
 * @returns {number[]}
 */
export function observedUse(runs, kind) {
    const out = [];
    for (const run of runs || []) {
        // A run first seen mid-way (a reload, a tab opened late) has its
        // "start" set to wherever it was seen, so its spend is a floor, not a
        // measurement — averaging those in is how 350-torch runs read as 106.
        // Only runs watched from the door count. Records from before the flag
        // existed cannot say which they were, so they do not count either. A
        // run closed by inference is excluded for the mirror-image reason: its
        // end was never seen, so its spend is a floor at the other end.
        if (run?.startTrusted !== true) continue;
        // A run closed by inference was never watched to its end, so its spend
        // is a lower bound in the same way an untrusted start is
        if (run?.endedByInference === true) continue;
        const spent = Number(run?.spent?.[kind]);
        if (Number.isFinite(spent)) {
            out.push(Math.max(0, spent));
            continue;
        }
        const start = Number(run?.start?.[kind]);
        const left = Number(run?.left?.[kind]);
        if (!Number.isFinite(start) || !Number.isFinite(left)) continue;
        out.push(Math.max(0, start - left));
    }
    return out;
}

/**
 * What the trusted runs burned of one supply, as one summary.
 *
 * `observedUse` already answers "what did each run spend"; this is the reading
 * a supply row wants beside it — how many runs are actually behind the average,
 * and the spread they cover. The average is what the panel plans at, and an
 * average over two runs and an average over twenty deserve to be told apart.
 *
 * Untrusted runs are excluded by `observedUse` itself, so a run joined mid-way
 * cannot drag the average down (a 350-torch run first seen on floor 3 reads as
 * 106, which is the mistake this whole flag exists to prevent).
 *
 * @param {Array<Object>} runs - Ledger records
 * @param {string} kind - 'torch' | 'shroud' | 'beacon'
 * @returns {{runs: number, total: number, average: number, min: number, max: number}|null}
 *   Null when no trusted run has anything to say about this supply
 */
export function burnSummary(runs, kind) {
    const used = observedUse(runs, kind);
    if (!used.length) return null;
    const total = used.reduce((sum, n) => sum + n, 0);
    return {
        runs: used.length,
        total,
        average: total / used.length,
        min: Math.min(...used),
        max: Math.max(...used),
    };
}

/**
 * Torches per floor, run by run — the trend that survives a change of plan.
 *
 * Raw torch spend is not comparable between runs: a run that stopped on floor 3
 * and a run that reached floor 7 spent wildly different amounts for exactly the
 * same play. Dividing by the deepest floor reached takes the run's length out
 * of the figure and leaves the thing worth watching — whether a floor is
 * getting cheaper or dearer to cross.
 *
 * Only runs watched from the door *and* seen to end count, for the reason
 * `observedUse` gives: a run first seen mid-way has a start of "wherever we
 * came in", and a run closed by inference has an end of "wherever we last
 * looked", so both its spend and its per-floor rate are floors rather than
 * measurements.
 *
 * @param {Array<Object>} runs - Ledger records, newest first as the ledger keeps them
 * @returns {Array<{perFloor: number, torches: number, floor: number, endedAt: number}>}
 *   Newest first, the ledger's own order
 */
export function torchesPerFloor(runs) {
    const out = [];
    for (const run of runs || []) {
        if (run?.startTrusted !== true) continue;
        if (run?.endedByInference === true) continue;
        const floor = Math.floor(Number(run?.floor) || 0);
        if (floor < 1) continue;
        const spent = Number(run?.spent?.torch);
        const start = Number(run?.start?.torch);
        const left = Number(run?.left?.torch);
        let torches = null;
        if (Number.isFinite(spent)) torches = Math.max(0, spent);
        else if (Number.isFinite(start) && Number.isFinite(left)) torches = Math.max(0, start - left);
        if (torches === null) continue;
        out.push({ perFloor: torches / floor, torches, floor, endedAt: Number(run?.endedAt) || 0 });
    }
    return out;
}

/** The eight heights a text sparkline can draw, lowest first */
const SPARK_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * A series as one string of block characters.
 *
 * Text rather than an SVG or a canvas because of where it goes: one line in the
 * Consumables panel's supply block, beside numbers, at the panel's own font
 * size. A chart there would be a chart nobody asked for, and a charts library
 * for eight glyphs would be a dependency nobody asked for either.
 *
 * A flat series is drawn flat — every bar mid-height — rather than having its
 * noise magnified to full scale, which is the standard sparkline trap: a run
 * of 40, 40, 41 must not read as a doubling.
 *
 * @param {number[]} values - The series, in the order it should be drawn
 * @returns {string} One glyph per value; empty when there is nothing to draw
 */
export function sparkText(values) {
    const series = (values || []).map(Number).filter((n) => Number.isFinite(n));
    if (!series.length) return '';
    const low = Math.min(...series);
    const high = Math.max(...series);
    const span = high - low;
    // A flat line sits in the middle: it has a level but no shape
    if (span <= 0) return SPARK_BARS[3].repeat(series.length);
    return series
        .map(
            (value) =>
                SPARK_BARS[Math.min(SPARK_BARS.length - 1, Math.floor(((value - low) / span) * SPARK_BARS.length))]
        )
        .join('');
}
