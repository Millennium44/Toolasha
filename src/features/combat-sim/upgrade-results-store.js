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
import storage from '../../core/storage.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { fromCurrentBuild, scriptVersion } from '../../utils/script-version.js';

const STORE = 'combatExport';
const SETTING = 'combatSim_rememberUpgradeResults';

/**
 * Whether a result is a Combat Sim run whose Ability order pass finished, even with no rows ("Nothing to
 * reorder"). A stopped pass does not count: it measured nothing worth replacing an older record for.
 * @param {Object|null|undefined} results - The runUpgradeAnalysis return
 * @returns {boolean}
 */
function finishedOrderPass(results) {
    return Boolean(results?.abilityOrder?.ran) && !results.abilityOrder.stopped;
}

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
    // An order-only Lab run has no table, only the Ability order section carried in `meta`
    // A completed section with no groups ("Nothing to reorder") counts: it must replace an older record
    // A Combat Sim order-only run that found nothing carries its stamp instead, and replaces an older record the same way
    if (!results?.results?.length && !Array.isArray(meta.orderSection?.groups) && !finishedOrderPass(results)) return;
    try {
        await writeScoped(
            key,
            { data: results, savedAt: Date.now(), ...meta, scriptVersion: scriptVersion() },
            STORE,
            true
        );
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
        if (!fromCurrentBuild(payload)) return null;
        if (
            !payload?.data?.results?.length &&
            !Array.isArray(payload?.orderSection?.groups) &&
            !finishedOrderPass(payload?.data)
        )
            return null;
        return payload;
    } catch (error) {
        console.error('[UpgradeResultsStore] Loading upgrade results failed:', error);
        return null;
    }
}

/**
 * Forget this character's remembered upgrade analysis, so the panel opens
 * clean instead of restoring an old run. Reversible only by running Analyze
 * again — there is no undo, so callers should ask before clearing.
 * @param {string} key - Unscoped storage key (distinct per sim)
 * @returns {Promise<void>}
 */
export async function clearUpgradeResults(key) {
    try {
        // A dated empty record, not a delete and not null: a deleted key is still in the gist and a pull
        // would write the old run back, and a pull skips folding a key this device holds as null, so a
        // null lost to the gist's older run too. Dated, the clear is the later save and wins the fold
        // (`laterSavedAtWins`); it carries no results, so it loads as nothing
        await storage.set(characterKey(key), { savedAt: Date.now(), cleared: true }, STORE, true);
    } catch (error) {
        console.error('[UpgradeResultsStore] Clearing upgrade results failed:', error);
    }
}
