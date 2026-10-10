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
        'taskCapProtection',
        'taskCapCoinThreshold',
        'taskCapCowbellThreshold',
        'panelOpenState',
        'overlayPanel',
        // The v2 layout record, which is what a current build actually reads —
        // `overlay-panel.js` adopt-migrates both keys, and listing only the
        // pre-v2 one meant the restore-after-decision trap above was
        // unrepairable for the layout every live build stores
        'overlayPanelV2',
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
 * Bases that travel with another, by object store: `{store: {primary: companion}}`.
 *
 * The enhancement sessions' tombstones are the deletion metadata of that
 * sessions map and mean nothing apart from it, so they are moved or claimed
 * with it — and left alone when the sessions are (a destination conflict),
 * never moved by themselves. Not listed in {@link ADOPTED_BASES}, so no loop
 * visits them twice.
 */
export const COMPANION_BASES = {
    settings: { enhancementTracker_sessions: 'enhancementTracker_sessionTombstones' },
};

/** Bases whose bare and scoped arrays are merged (deduped by id) rather than overwritten. */
const MERGE_BASES = new Set(['marketListingTimestamps']);

/**
 * Force-complete adoption: hand every bare legacy value to one character,
 * OVERWRITING that character's scoped copy.
 *
 * This exists for the restore-after-decision trap: a backup restore brings
 * the bare legacy keys back, but stale (often empty) scoped keys written
 * during the broken period shadow them — `readScoped` prefers a scoped value
 * that exists, so adoption never re-fires. Overwriting is the point here;
 * use {@link moveScopedData} when the destination's data must be preserved.
 *
 * @param {string} toId - Character id that inherits every bare legacy value
 * @param {{dryRun?: boolean}} [options] - dryRun lists claims without acting
 * @returns {Promise<{claimed: string[]}>} Store-qualified keys claimed
 */
export async function claimLegacyData(toId, options = {}) {
    const { dryRun = false } = options;
    const claimed = [];

    if (!toId) {
        throw new Error('[ScopedDataRepair] claimLegacyData needs a character id');
    }

    for (const [storeName, bases] of Object.entries(ADOPTED_BASES)) {
        for (const base of bases) {
            const bare = await storage.get(base, storeName, null);
            if (bare === null) continue;

            let value = bare;
            if (MERGE_BASES.has(base)) {
                const scoped = await storage.get(`${base}_${toId}`, storeName, null);
                if (Array.isArray(bare) && Array.isArray(scoped)) {
                    const seen = new Set(bare.map((entry) => entry?.id));
                    value = bare.concat(scoped.filter((entry) => entry && !seen.has(entry.id)));
                }
            }

            if (!dryRun) {
                await storage.set(`${base}_${toId}`, value, storeName, true);
                await storage.delete(base, storeName);
            }
            claimed.push(`${storeName}:${base}`);

            const companion = COMPANION_BASES[storeName]?.[base];
            const bareCompanion = companion ? await storage.get(companion, storeName, null) : null;
            if (bareCompanion !== null) {
                if (!dryRun) {
                    await storage.set(`${companion}_${toId}`, bareCompanion, storeName, true);
                    await storage.delete(companion, storeName);
                }
                claimed.push(`${storeName}:${companion}`);
            } else if (companion && !dryRun) {
                // No bare tombstones came with the backup, so the destination's own stay in place and would
                // keep hiding a restored session it had deleted. Drop only the ids the restored map holds.
                const graves = await storage.get(`${companion}_${toId}`, storeName, null);
                if (graves && typeof graves === 'object' && value && typeof value === 'object') {
                    const kept = { ...graves };
                    for (const id of Object.keys(value)) delete kept[id];
                    if (Object.keys(kept).length !== Object.keys(graves).length) {
                        await storage.set(`${companion}_${toId}`, kept, storeName, true);
                    }
                }
            }
        }
    }

    const verb = dryRun ? 'would claim' : 'claimed';
    console.log(`[ScopedDataRepair] ${verb} ${claimed.length} legacy keys for ${toId}`, { claimed });
    return { claimed };
}

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

            const companion = COMPANION_BASES[storeName]?.[base];
            if (companion) {
                const companionFrom = `${companion}_${fromId}`;
                const companionTo = `${companion}_${toId}`;
                const companionValue = await storage.get(companionFrom, storeName, null);
                if (companionValue !== null) {
                    if (!dryRun) {
                        await storage.set(companionTo, companionValue, storeName, true);
                        await storage.delete(companionFrom, storeName);
                    }
                    moved.push(`${storeName}:${companionFrom} → ${companionTo}`);
                }
            }
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
