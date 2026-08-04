/**
 * Labyrinth Live Readout
 *
 * Two things the readout on the attempt bar needs and neither the sockets nor
 * the DOM should be asked for: which room the fight in progress is actually in,
 * and how sure a number has to be before it is shown as a number.
 *
 * Both are pure. The room identity is parsed out of the action-name the game
 * already writes ("Labyrinth - Mimic Lv.245"), which is present from the first
 * tick of the fight whether or not the labyrinth tab has ever been opened —
 * that availability is the whole point, since the sim-backed estimate cannot
 * run without knowing what it is simulating.
 */

import { formatLiveClearChance } from './labyrinth-live-combat.js';

/** Width of a provisional band, in percentage points */
export const BAND_WIDTH_PCT = 25;

/**
 * How far past a band's edge the estimate must move before the band changes.
 *
 * Without it a chance sitting on 50 flaps between two bands as blows land,
 * which is the same flicker in coarser clothing.
 */
export const BAND_MARGIN_PCT = 4;

/**
 * The monster and level the action bar says this fight is against.
 *
 * The header is the one description of the current room that exists before the
 * labyrinth panel has rendered anything: `pathData` and `roomData` both arrive
 * on a `labyrinth_updated` message, and a page reloaded in the middle of a
 * fight gets neither until the next room is entered.
 *
 * @param {string} text - Contents of the Header_actionName element
 * @returns {{name: string, level: number}|null} null when this is not a
 *   labyrinth combat row, or carries no level
 */
export function parseLabyrinthActionName(text) {
    const raw = String(text || '');
    if (!/labyrinth/i.test(raw)) return null;

    // "Labyrinth - Mimic Lv.245", with anything this script appended stripped
    const level = /Lv\.\s*(\d+)/i.exec(raw);
    if (!level) return null;

    const afterDash =
        raw
            .split(/\s[-–—]\s/)
            .slice(1)
            .join(' - ') || raw;
    const name = afterDash
        .replace(/Lv\.\s*\d+.*$/i, '')
        .replace(/[[·|].*$/, '')
        .trim();
    if (!name) return null;

    return { name, level: Math.max(0, Math.floor(Number(level[1]) || 0)) };
}

/**
 * Turn a monster's display name into its hrid.
 *
 * Matched case- and punctuation-insensitively because the header is written
 * for people: "Ent Ancient" and "ent_ancient" are the same monster and only one
 * of them is in the data.
 *
 * @param {string} name - Display name
 * @param {Object|null} monsterDetailMap - initClientData.combatMonsterDetailMap
 * @returns {string|null}
 */
export function monsterHridByName(name, monsterDetailMap) {
    const wanted = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
    if (!wanted || !monsterDetailMap) return null;
    for (const [hrid, detail] of Object.entries(monsterDetailMap)) {
        const candidate = String(detail?.name || '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        if (candidate && candidate === wanted) return hrid;
    }
    return null;
}

/**
 * How much of a new provisional reading is taken on board.
 *
 * Low, because the readings it smooths are noisy for a reason that averaging
 * genuinely fixes: the extrapolation divides by health lost, and health arrives
 * in lumps, so consecutive readings are samples around a rate rather than
 * measurements of a changing one. A mean of those samples is a better estimate
 * of the rate than the latest of them, not a prettier one.
 */
export const SMOOTHING_WEIGHT = 0.3;

/**
 * Fold a new provisional reading into the running one.
 *
 * Only ever applied to the provisional branch. A replayed figure is a
 * measurement of this fight from this moment and is shown as it comes; an
 * extrapolation that has earned confidence is already averaged over a long
 * enough window not to need this.
 *
 * @param {number|null} previous - Running value, null to start
 * @param {number} next - Latest reading, 0..1
 * @param {number} [weight] - Share of the new reading
 * @returns {number}
 */
export function smoothChance(previous, next, weight = SMOOTHING_WEIGHT) {
    if (!Number.isFinite(previous)) return next;
    return previous + weight * (next - previous);
}

/**
 * The band a provisional chance falls in, sticking to the one it is already in.
 *
 * @param {number} clearChance - 0..1
 * @param {{lo: number, hi: number}|null} [previous] - Band currently on screen
 * @returns {{lo: number, hi: number}} Percentage points
 */
export function bandFor(clearChance, previous = null) {
    const pct = Math.min(100, Math.max(0, clearChance * 100));
    if (previous && pct >= previous.lo - BAND_MARGIN_PCT && pct <= previous.hi + BAND_MARGIN_PCT) {
        return previous;
    }
    const lo = Math.min(100 - BAND_WIDTH_PCT, Math.floor(pct / BAND_WIDTH_PCT) * BAND_WIDTH_PCT);
    return { lo, hi: lo + BAND_WIDTH_PCT };
}

/**
 * What the attempt bar should read, and where the number came from.
 *
 * The order is deliberate. A replay of *this* fight through the same simulator
 * the room tab uses is the best answer available and is shown as a figure. An
 * extrapolation off two health bars is shown as a figure only once the fight
 * has supplied enough evidence to earn one; before that it is shown as a band,
 * because a point estimate that moves twenty points between two blows is not a
 * more precise claim than a band, it is a less honest one.
 *
 * @param {Object} args
 * @param {Object|null} args.estimate - estimateLiveClearChance result
 * @param {Object|null} [args.replay] - { clearChance } when a fresh replay is in hand
 * @param {{lo: number, hi: number}|null} [args.previousBand] - For band stickiness
 * @param {number|null} [args.previousSmoothed] - Running provisional value
 * @returns {{text: string, source: string, band: {lo: number, hi: number}|null, smoothed: number|null}}
 *   source is 'replay' | 'measured' | 'provisional' | 'none'
 */
export function liveClearDisplay({ estimate, replay = null, previousBand = null, previousSmoothed = null }) {
    const nothing = { band: null, smoothed: null };
    if (replay && Number.isFinite(replay.clearChance)) {
        return { text: `Clear ${(replay.clearChance * 100).toFixed(0)}%`, source: 'replay', ...nothing };
    }
    if (!estimate || estimate.clearChance === null) return { text: '', source: 'none', ...nothing };
    if (estimate.confident) {
        return { text: formatLiveClearChance(estimate), source: 'measured', ...nothing };
    }
    const smoothed = smoothChance(previousSmoothed, estimate.clearChance);
    const band = bandFor(smoothed, previousBand);
    return { text: `Clear ${band.lo}–${band.hi}%?`, source: 'provisional', band, smoothed };
}
