/**
 * The performance limits of the simulators, read at the moment they are used.
 *
 * Three of them are player settings (device-local, see `DEVICE_LOCAL_SETTING_IDS`): how many simulations
 * an analysis runs at once, how long the close-call re-sims may run, and (Lab only) the run size above
 * which a whole-run analysis shortens each simulation. Every reader falls back to the default when the
 * stored value is missing, a non-number or a boolean, so a settings store that has not loaded (or a test
 * double that answers `false`) never turns a limit into 0.
 */

import config from '../../core/config.js';

export const MAX_CONCURRENT_SIMS_KEY = 'combatSim_maxConcurrentSims';
export const RESIM_MAX_MINUTES_KEY = 'combatSim_resimMaxMinutes';
export const ALL_FIGHTS_SIM_BUDGET_KEY = 'labSim_allFightsSimBudget';

export const DEFAULT_MAX_CONCURRENT_SIMS = 6;
export const MIN_MAX_CONCURRENT_SIMS = 1;
export const MAX_MAX_CONCURRENT_SIMS = 32;
export const DEFAULT_RESIM_MAX_MINUTES = 10;

/**
 * Read a numeric setting, clamped; the default when it is not a usable number.
 * @param {string} key - Setting id
 * @param {number} fallback - Default
 * @param {number} min - Lowest allowed value
 * @param {number} [max=Infinity] - Highest allowed value
 * @returns {number}
 */
export function readNumberSetting(key, fallback, min, max = Infinity) {
    let raw;
    try {
        raw = config.getSetting?.(key);
    } catch {
        raw = undefined;
    }
    const usable = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '');
    const value = usable ? Number(raw) : NaN;
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

/**
 * Most simulations an analysis may run at once (before the "ignore caps" setting).
 * @returns {number} Whole number, 1 to 32
 */
export function maxConcurrentSims() {
    return Math.floor(
        readNumberSetting(
            MAX_CONCURRENT_SIMS_KEY,
            DEFAULT_MAX_CONCURRENT_SIMS,
            MIN_MAX_CONCURRENT_SIMS,
            MAX_MAX_CONCURRENT_SIMS
        )
    );
}

/**
 * Longest the close-call re-sim phase may run, in milliseconds.
 * @returns {number} Infinity when the setting is 0 (no time cap)
 */
export function resimMaxBudgetMs() {
    const minutes = readNumberSetting(RESIM_MAX_MINUTES_KEY, DEFAULT_RESIM_MAX_MINUTES, 0);
    return minutes > 0 ? minutes * 60 * 1000 : Infinity;
}

/**
 * Sims a whole-run Lab analysis plans before it shortens each simulation.
 * @param {number} [fallback=0] - Value when unset
 * @returns {number} 0 = never shorten
 */
export function allFightsSimBudgetSetting(fallback = 0) {
    return Math.floor(readNumberSetting(ALL_FIGHTS_SIM_BUDGET_KEY, fallback, 0));
}
