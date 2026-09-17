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
 * The snapshot's row for one particular zone at one particular tier.
 *
 * For the surfaces that compare a *measured* run against what the sim promised
 * for the same place — same shape as {@link bestSoloZone} so a caller can hold
 * either. Tiers must match exactly, with an unstated tier read as 0 on both
 * sides: tier 2 of a zone is a different fight from tier 0, and quoting one
 * against a run in the other would be a comparison of nothing. A row without a
 * finite `profitPerHour` is no answer, not an answer of zero.
 *
 * `encountersPerHour` and `loadout` are the same kind of answer. Snapshots are
 * persisted per character and runs written by earlier builds carry neither, so
 * both read as `null` when absent — never as a rate of zero, which would tell a
 * caller a fight takes forever, and never as a loadout that matches nothing.
 * A caller wanting a duration must check for `null` and say it has no reading.
 *
 * @param {Object|null} snapshot - From {@link loadAllZonesSnapshot}
 * @param {string} zoneHrid - The zone being measured, e.g. `/actions/combat/fly`
 * @param {number} [difficultyTier] - Its difficulty tier
 * @returns {{zoneName: string, zoneHrid: string, difficultyTier: number,
 *   profitPerHour: number, xpPerHour: number|null, encountersPerHour: number|null,
 *   savedAt: number|null, fingerprint: string|null,
 *   loadout: {source: string, name: string|null}|null}|null}
 *   The row, or null when the snapshot has none
 */
export function zoneFromSnapshot(snapshot, zoneHrid, difficultyTier = 0) {
    if (!zoneHrid) return null;

    const zones = Array.isArray(snapshot?.zones) ? snapshot.zones : [];
    const zone = zones.find(
        (entry) => entry?.zoneHrid === zoneHrid && (entry.difficultyTier ?? 0) === (difficultyTier ?? 0)
    );
    if (!zone || !Number.isFinite(zone.profitPerHour)) return null;

    return {
        zoneName: zone.zoneName || zone.zoneHrid,
        zoneHrid: zone.zoneHrid,
        difficultyTier: zone.difficultyTier ?? 0,
        profitPerHour: zone.profitPerHour,
        xpPerHour: Number.isFinite(zone.xpPerHour) ? zone.xpPerHour : null,
        // A rate of zero would read as "this fight never ends"; a run that
        // predates the field has no reading at all, and says so
        encountersPerHour:
            Number.isFinite(zone.encountersPerHour) && zone.encountersPerHour > 0 ? zone.encountersPerHour : null,
        savedAt: snapshot.savedAt ?? null,
        fingerprint: snapshot.fingerprint ?? null,
        loadout: snapshotLoadout(snapshot),
    };
}

/**
 * The gear a stored run was configured from, or nothing if it did not say.
 *
 * The provenance half of a stored rate, following the precedent in
 * `features/planner/combat-rates.js`: a figure taken in the past is quoted with
 * its age (`savedAt`) and with enough about the gear for a reader to decide
 * whether it still applies. An all-zones run has no `characterLoadoutID` to
 * record — the simulator is configured from the editor's DTOs or from what the
 * character is wearing, and the editor only remembers the loadout it applied by
 * name — so what is stored is `{source, name}`: whether
 * the run came from a named loadout, from a hand-edited editor, or from worn
 * gear, and which loadout it started from when there was one.
 *
 * The consequence for a reader is worth stating plainly: with `source:
 * 'loadout'` a name can be compared against the loadout a queued action names,
 * and a mismatch means the rate is for other gear. With `'editor'`, `'worn'` or
 * a missing field there is no name to compare, and the only gear evidence is
 * `fingerprint` — which is opaque and produced inside the simulator bundle, so
 * a reader outside it can tell that two runs differ but not whether a run
 * matches any particular loadout.
 *
 * @param {Object|null} snapshot - From {@link loadAllZonesSnapshot}
 * @returns {{source: string, name: string|null}|null} Provenance, or null when
 *   the snapshot predates the field
 */
export function snapshotLoadout(snapshot) {
    const loadout = snapshot?.loadout;
    if (!loadout || typeof loadout !== 'object') return null;
    return { source: loadout.source || 'unknown', name: loadout.name || null };
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

// ---------------------------------------------------------------------------
// Single-zone rates
//
// A zone simulated on its own, in one particular loadout, from a queued fight's
// "sim 24h" button. Kept apart from the all-zones snapshot on purpose: that
// snapshot is one run in one set of gear, and its `loadout` and `fingerprint`
// describe every row in it. Writing a zone simulated in other gear into it
// would put two runs under one label, and every reader of the snapshot — the
// ranked list, the planner, the dungeon board — would quote the mixed figure
// as the run it says it is. Merging only when the gear matched was rejected
// too: the snapshot's gear evidence is a loadout *name* and an opaque
// fingerprint made inside the simulator, so "matches" cannot be decided
// honestly from here, and a merged row would still carry the other run's age.
//
// So: one small map per character, keyed by zone, tier and the server's
// loadout id (the id every queued action carries, so a row finds its own rate
// without comparing names). Each entry states its own age, hours and gear.
// ---------------------------------------------------------------------------

/** Where single-zone rates are kept, per character, in the same store as the snapshot */
export const ZONE_SIM_RATES_KEY = 'zoneSimRates';

/** How many single-zone rates are kept; the oldest go first */
export const ZONE_SIM_RATES_LIMIT = 100;

/**
 * The key one zone, tier and loadout is filed under.
 * @param {string} zoneHrid - e.g. `/actions/combat/fly`
 * @param {number} [difficultyTier=0] - Its tier
 * @param {number|string} [loadoutId=0] - The server's loadout id; 0 for "no loadout" (worn gear)
 * @returns {string} The key
 */
export function zoneSimRateKey(zoneHrid, difficultyTier = 0, loadoutId = 0) {
    return `${zoneHrid}|${Number(difficultyTier) || 0}|${String(loadoutId || 0)}`;
}

/**
 * A comparable signature of what a stored loadout puts on and uses.
 *
 * Taken when a single-zone run starts and again when its rate is read, so a
 * loadout edited in between is caught: same id, different gear, and the rate
 * says so. Item and ability hrids only, sorted — enhancement levels are left
 * out because a "highest owned" loadout's stored level is a stale reading, not
 * what it wears.
 *
 * @param {Object|null} snapshot - A loadout snapshot (`equipment`, `abilities`, `food`, `drinks`)
 * @returns {string|null} The signature, or null with no snapshot
 */
export function loadoutSignature(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const hrids = (list, field) =>
        (Array.isArray(list) ? list : [])
            .map((entry) => entry?.[field] || '')
            .filter(Boolean)
            .sort()
            .join(',');
    return [
        hrids(snapshot.equipment, 'itemHrid'),
        hrids(snapshot.abilities, 'abilityHrid'),
        hrids(snapshot.food, 'itemHrid'),
        hrids(snapshot.drinks, 'itemHrid'),
    ].join('|');
}

/**
 * Every single-zone rate stored for the character now logged in.
 * @returns {Promise<Object>} `{[key]: entry}`, empty when there are none
 */
export async function loadZoneSimRates() {
    try {
        const saved = await storage.getJSON(characterKey(ZONE_SIM_RATES_KEY), ALL_ZONES_SNAPSHOT_STORE, null);
        return saved && typeof saved.rates === 'object' && saved.rates !== null ? saved.rates : {};
    } catch (error) {
        console.error('[AllZonesSnapshot] Reading single-zone rates failed:', error);
        return {};
    }
}

/**
 * Store one single-zone rate, replacing any for the same zone, tier and loadout.
 *
 * The storage key is passed in, resolved when the run *started*: a run takes
 * a while, and a character switch inside it must not file one character's rate
 * under another's key.
 *
 * @param {string} storageKey - `characterKey(ZONE_SIM_RATES_KEY)` captured before the run
 * @param {Object} entry - `{zoneHrid, difficultyTier, loadoutId, encountersPerHour, savedAt, ...}`
 * @returns {Promise<boolean>} Whether it was stored
 */
export async function saveZoneSimRate(storageKey, entry) {
    try {
        if (!storageKey || !entry?.zoneHrid) return false;
        const saved = await storage.getJSON(storageKey, ALL_ZONES_SNAPSHOT_STORE, null);
        const rates = { ...(saved && typeof saved.rates === 'object' && saved.rates !== null ? saved.rates : {}) };
        rates[zoneSimRateKey(entry.zoneHrid, entry.difficultyTier, entry.loadoutId)] = entry;

        const keys = Object.keys(rates);
        if (keys.length > ZONE_SIM_RATES_LIMIT) {
            keys.sort((a, b) => (rates[a]?.savedAt || 0) - (rates[b]?.savedAt || 0));
            for (const key of keys.slice(0, keys.length - ZONE_SIM_RATES_LIMIT)) delete rates[key];
        }
        return await storage.setJSON(storageKey, { version: 1, rates }, ALL_ZONES_SNAPSHOT_STORE, true);
    } catch (error) {
        console.error('[AllZonesSnapshot] Saving a single-zone rate failed:', error);
        return false;
    }
}

/**
 * The stored single-zone rate for one zone, tier and loadout, if it is usable.
 *
 * Same rule as {@link zoneFromSnapshot}: a missing or non-positive rate is no
 * answer, never a rate of zero.
 *
 * @param {Object|null} rates - From {@link loadZoneSimRates}
 * @param {string} zoneHrid - The zone
 * @param {number} [difficultyTier=0] - Its tier
 * @param {number|string} [loadoutId=0] - The loadout the fight uses
 * @returns {{zoneHrid: string, difficultyTier: number, loadoutId: string, loadoutName: string|null,
 *   signature: string|null, encountersPerHour: number, profitPerHour: number|null,
 *   xpPerHour: number|null, hours: number|null, savedAt: number|null}|null}
 */
export function zoneSimRateFor(rates, zoneHrid, difficultyTier = 0, loadoutId = 0) {
    if (!rates || !zoneHrid) return null;
    const entry = rates[zoneSimRateKey(zoneHrid, difficultyTier, loadoutId)];
    if (!entry || !(Number.isFinite(entry.encountersPerHour) && entry.encountersPerHour > 0)) return null;
    const finite = (value) => (Number.isFinite(value) ? value : null);
    return {
        zoneHrid: entry.zoneHrid,
        difficultyTier: Number(entry.difficultyTier) || 0,
        loadoutId: String(entry.loadoutId || 0),
        loadoutName: entry.loadoutName || null,
        signature: entry.signature ?? null,
        encountersPerHour: entry.encountersPerHour,
        profitPerHour: finite(entry.profitPerHour),
        xpPerHour: finite(entry.xpPerHour),
        hours: finite(entry.hours),
        savedAt: finite(entry.savedAt),
    };
}
