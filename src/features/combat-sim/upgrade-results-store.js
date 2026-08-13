/**
 * Upgrade-results persistence
 *
 * An upgrade analysis is a run people wait on — sometimes minutes — and a reload
 * three seconds later used to throw it all away. This keeps the last result set
 * so it is still there after a refresh, until the next run replaces it.
 *
 * Opt-in, because the full result set is a sizeable blob and not everyone wants
 * it living in the database. Character-scoped, because one character's gear
 * ranking is meaningless for another; stored in the `combatExport` store beside
 * the all-zones snapshot rather than in a new object store (a new store forces an
 * IndexedDB version bump). Shared by both the Combat and Lab simulators — each
 * passes its own key.
 */

import config from '../../core/config.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

const STORE = 'combatExport';
const SETTING = 'combatSim_rememberUpgradeResults';

/** Whether the user opted into remembering upgrade results. */
export function rememberUpgradeResultsEnabled() {
    return Boolean(config.getSetting(SETTING));
}

/**
 * Persist an upgrade analysis result for this character, if the option is on.
 * @param {string} key - Unscoped storage key (distinct per sim)
 * @param {Object} results - The runUpgradeAnalysis return ({ baseline, results, ... })
 * @param {Object} [meta] - Extra fields to store alongside (e.g. a label)
 * @returns {Promise<void>}
 */
export async function saveUpgradeResults(key, results, meta = {}) {
    if (!rememberUpgradeResultsEnabled()) return;
    if (!results?.results?.length) return;
    try {
        await writeScoped(key, { data: results, savedAt: Date.now(), ...meta }, STORE, true);
    } catch (error) {
        console.error('[UpgradeResultsStore] Persisting upgrade results failed:', error);
    }
}

/**
 * Load this character's last upgrade analysis, if the option is on and one was
 * saved. Discards any legacy global value rather than adopting another
 * character's gear ranking.
 * @param {string} key - Unscoped storage key (distinct per sim)
 * @returns {Promise<{data: Object, savedAt: number}|null>}
 */
export async function loadUpgradeResults(key) {
    if (!rememberUpgradeResultsEnabled()) return null;
    try {
        const payload = await readScoped(key, STORE, null, { migrate: 'discard' });
        if (!payload?.data?.results?.length) return null;
        return payload;
    } catch (error) {
        console.error('[UpgradeResultsStore] Loading upgrade results failed:', error);
        return null;
    }
}
