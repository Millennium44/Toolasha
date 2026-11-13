/**
 * Labyrinth stock target
 *
 * How many torches, shrouds, beacons and crates the player keeps stocked for the Labyrinth: a
 * per-run need, times a chosen number of runs, less what the inventory already holds. The
 * Consumables panel's Labyrinth block and the entry screen's "Buy missing supplies" button both
 * size their shortfall here, so the two can never disagree about what is short.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { readScoped } from '../../utils/character-key.js';
import { measuredRuns, observedUse } from './labyrinth-run-ledger-math.js';

/** The client's base carry caps, standing in only until characterInfo states the real ones. */
export const BASE_CAPS = { torch: 100, shroud: 4, beacon: 5 };
export const CAP_FIELD = { torch: 'labyrinthTorchCap', shroud: 'labyrinthShroudCap', beacon: 'labyrinthBeaconCap' };
export const CRATE_SLOTS = ['teaCrateItemHrid', 'coffeeCrateItemHrid', 'foodCrateItemHrid'];

/** The Consumables panel's default run target (`consumablesLabRuns`, 'settings' store). */
export const DEFAULT_LAB_RUNS = 5;

/**
 * The carry capacity of one supply: characterInfo states the final figure (upgrades applied),
 * the base cap stands in only before that payload arrives.
 * @param {Object|undefined} info - characterData.characterInfo
 * @param {string} kind - torch | shroud | beacon
 * @returns {number}
 */
export function labCapacity(info, kind) {
    const stated = Number(info?.[CAP_FIELD[kind]]);
    return stated > 0 ? stated : BASE_CAPS[kind];
}

/**
 * What one run consumes of a supply: the average of the last five measured runs, or the full
 * capacity under the 'capacity' basis, and until a run has said.
 * @param {string} kind - torch | shroud | beacon
 * @param {number} capacity - What a run can carry
 * @param {Array<Object>} ledgerRuns - Run-ledger records, newest first
 * @param {string} basis - 'measured' | 'capacity'
 * @returns {{perRun: number, observedRuns: number}}
 */
export function labPerRunNeed(kind, capacity, ledgerRuns, basis) {
    // The last five measured runs, not the last five records: an excluded record would otherwise
    // take a slot from a real run
    const ledger = measuredRuns(ledgerRuns).slice(0, 5);
    const used = basis === 'capacity' ? [] : observedUse(ledger, kind);
    const perRun = used.length ? Math.ceil(used.reduce((sum, n) => sum + n, 0) / used.length) : capacity;
    return { perRun, observedRuns: used.length };
}

/**
 * How many of an item to buy to cover `runs` runs.
 * @param {number} perRun - One run's need
 * @param {number} runs - The run target
 * @param {number} held - What the inventory holds
 * @returns {number} Never negative
 */
export function labShortfall(perRun, runs, held) {
    return Math.max(0, Math.ceil(perRun * runs) - held);
}

/**
 * The stored stock target, read from storage exactly as the Consumables panel loads it, so it is
 * the same with the panel closed, or never opened.
 * Rejects when storage cannot be read: a caller must not turn that into a zero need.
 * @returns {Promise<{runs: number, ledgerRuns: Array<Object>, basis: string}>}
 */
export async function readLabStockTarget() {
    const runs = Number(await storage.get('consumablesLabRuns', 'settings', DEFAULT_LAB_RUNS)) || DEFAULT_LAB_RUNS;
    const ledger = await readScoped('labyrinthRunLedger', 'labyrinth', []);
    const basis = config.getSettingValue('consumables_labPerRunBasis', 'measured') || 'measured';
    return { runs, ledgerRuns: Array.isArray(ledger) ? ledger : [], basis };
}
