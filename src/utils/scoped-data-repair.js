/**
 * Repair tool for per-character data that was adopted by the wrong character.
 *
 * The adopt-once migration moves legacy global values under the scoped key of
 * the first eligible character to log in. When that character was the wrong
 * one (a test character, an alt), the data is not lost — it sits under that
 * character's keys. This moves every adopt-class base from one character id to
 * another, skipping keys the destination already owns.
 *
 * Console use: `Toolasha.debug.moveScopedData('<fromId>', '<toId>')`, with
 * `{ dryRun: true }` to list the moves without making them.
 */
import storage from '../core/storage.js';

/**
 * Every base that migrates with 'adopt' semantics, by object store.
 *
 * Deliberately excludes genuinely per-character history (networth, XP, loot
 * log, alchemy sessions) — those were recorded under their own character and
 * moving them would falsify the record.
 */
export const ADOPTED_BASES = {
    settings: [
        'watchlist',
        'equipmentSavings',
        'housesUntracked',
        'alchemyItemPins',
        'inventorySort',
        'consumablesSettings',
        'philoCalculatorSettings',
        'mooketWatchlist',
        'treasureTally',
        'treasureSettings',
        'labyrinthRoomLogs',
        'dungeonTracker_uiState',
        'taskEstimateMode',
        'taskIconFilters',
        'panelOpenState',
        'overlayPanel',
        'combatSimUpgradeModes',
        'enhancementTracker_sessions',
        'enhancementTracker_currentSession',
        'labSimUpgradeMode',
        'labSimUpgradeDimensions',
        'labSimUpgradeScope',
        'labSimSkillingLoadouts',
        'labSimComparisonRuns',
        'labSimComparisonBaseline',
        'goalPlannerGoals',
        'goalPlannerSnapshot',
    ],
    combatStats: ['combatSessionHistory'],
    rerollSpending: ['taskRerollData', 'taskRerollHistory'],
    marketListings: ['marketListingTimestamps'],
    combatExport: ['allZonesSnapshot'],
};

/**
 * Move every adopt-class scoped value from one character to another.
 *
 * A key is moved only when the source has it and the destination does not —
 * a destination value means that character has its own state, and clobbering
 * it would repeat the original accident in the other direction.
 *
 * @param {string} fromId - Character id currently holding the data
 * @param {string} toId - Character id that should hold it
 * @param {{dryRun?: boolean}} [options] - dryRun lists moves without acting
 * @returns {Promise<{moved: string[], skipped: string[], missing: number}>}
 *   Store-qualified keys moved and skipped-for-conflict, and how many bases
 *   had nothing to move
 */
export async function moveScopedData(fromId, toId, options = {}) {
    const { dryRun = false } = options;
    const moved = [];
    const skipped = [];
    let missing = 0;

    if (!fromId || !toId || fromId === toId) {
        throw new Error('[ScopedDataRepair] moveScopedData needs two different character ids');
    }

    for (const [storeName, bases] of Object.entries(ADOPTED_BASES)) {
        for (const base of bases) {
            const fromKey = `${base}_${fromId}`;
            const toKey = `${base}_${toId}`;
            const value = await storage.get(fromKey, storeName, null);
            if (value === null) {
                missing += 1;
                continue;
            }
            const existing = await storage.get(toKey, storeName, null);
            if (existing !== null) {
                skipped.push(`${storeName}:${fromKey}`);
                continue;
            }
            if (!dryRun) {
                await storage.set(toKey, value, storeName, true);
                await storage.delete(fromKey, storeName);
            }
            moved.push(`${storeName}:${fromKey} → ${toKey}`);
        }
    }

    const verb = dryRun ? 'would move' : 'moved';
    console.log(
        `[ScopedDataRepair] ${verb} ${moved.length} keys from ${fromId} to ${toId}` +
            (skipped.length ? `; skipped ${skipped.length} (destination already has data)` : ''),
        { moved, skipped }
    );
    return { moved, skipped, missing };
}
