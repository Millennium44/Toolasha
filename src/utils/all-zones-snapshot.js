/**
 * All-zones snapshot
 *
 * Where a finished all-zones sim run is kept, and how it is read back.
 *
 * Extracted from `combat-sim-ui.js` so the surfaces that only *read* the
 * snapshot — the profit panel comparing a dungeon to your best solo zone, the
 * pinned actions page, the planner — do not have to import the whole simulator
 * UI to get two string constants and a loader. Stateless, so the production
 * bundle split can hold a copy on each side without anything diverging.
 */

import storage from '../core/storage.js';
import { characterKey, readScoped } from './character-key.js';

/** Where a finished all-zones run is kept, for anything that ranks zones later */
export const ALL_ZONES_SNAPSHOT_KEY = 'allZonesSnapshot';

/**
 * The store it goes in.
 *
 * `combatExport` rather than a new store: it already holds what the combat sim
 * produces for other features to read, and adding an object store means a
 * database version bump every consumer pays for.
 */
export const ALL_ZONES_SNAPSHOT_STORE = 'combatExport';

/**
 * Write a snapshot out, immediately.
 *
 * Immediate rather than debounced: a run people wait ten minutes for is exactly
 * the thing a reload three seconds later must not lose.
 *
 * @param {Object} snapshot - From `buildAllZonesSnapshot`
 * @returns {Promise<boolean>} Whether it was stored
 */
export async function saveAllZonesSnapshot(snapshot) {
    try {
        return await storage.setJSON(characterKey(ALL_ZONES_SNAPSHOT_KEY), snapshot, ALL_ZONES_SNAPSHOT_STORE, true);
    } catch (error) {
        console.error('[AllZonesSnapshot] Saving the all-zones snapshot failed:', error);
        return false;
    }
}

/**
 * The last all-zones run, if there is one.
 * @returns {Promise<Object|null>} Snapshot, or null when nothing usable is stored
 */
export async function loadAllZonesSnapshot() {
    try {
        // Discard any legacy global snapshot: a sim run against another
        // character's gear is actively misleading, so no adoption.
        const saved = await readScoped(ALL_ZONES_SNAPSHOT_KEY, ALL_ZONES_SNAPSHOT_STORE, null, { migrate: 'discard' });
        return saved && Array.isArray(saved.zones) ? saved : null;
    } catch (error) {
        console.error('[AllZonesSnapshot] Reading the all-zones snapshot failed:', error);
        return null;
    }
}

/**
 * The snapshot's most profitable zone, dungeons excluded.
 *
 * The comparison this feeds is "what would my time earn solo instead", and a
 * dungeon is not an *instead* — it is the thing being compared. Exclusion is by
 * the caller's predicate because game data lives with the caller; a zone the
 * predicate cannot classify is kept, since most zones are not dungeons.
 *
 * @param {Object|null} snapshot - From {@link loadAllZonesSnapshot}
 * @param {Object} [options] - `{isDungeonZone}`
 * @param {Function} [options.isDungeonZone] - `(zoneHrid) => boolean`
 * @returns {{zoneName: string, zoneHrid: string, difficultyTier: number,
 *   profitPerHour: number, savedAt: number|null, fingerprint: string|null}|null}
 */
export function bestSoloZone(snapshot, { isDungeonZone } = {}) {
    const zones = Array.isArray(snapshot?.zones) ? snapshot.zones : [];
    let best = null;

    for (const zone of zones) {
        if (!Number.isFinite(zone?.profitPerHour)) continue;
        if (typeof isDungeonZone === 'function' && isDungeonZone(zone.zoneHrid) === true) continue;
        if (!best || zone.profitPerHour > best.profitPerHour) best = zone;
    }
    if (!best) return null;

    return {
        zoneName: best.zoneName || best.zoneHrid,
        zoneHrid: best.zoneHrid,
        difficultyTier: best.difficultyTier ?? 0,
        profitPerHour: best.profitPerHour,
        savedAt: snapshot.savedAt ?? null,
        fingerprint: snapshot.fingerprint ?? null,
    };
}
