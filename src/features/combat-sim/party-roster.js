/**
 * The Party Finder's teammate roster: named teammate builds (sim player DTOs) the
 * composition sweep tries alongside you.
 *
 * Account-wide, not per character: a teammate is someone you might group with on any
 * of your characters, and nothing in their build belongs to one of yours. Stored as one
 * record in `settings` under a `combatSim` key, so the sync's owned-prefix list already
 * carries it.
 *
 * Sync: the record syncs whole and the later save wins (`laterSavedAtWins`). A roster is
 * a curated list, like any other setting — two devices that each edit it before syncing
 * keep the later device's list. Every write here is a read-merge-write in one
 * transaction (`storage.update`), so two tabs editing at once each land their change on
 * the other's, and the Party Finder tab re-reads the record when a pull writes it, so
 * the key is registered live-safe.
 */

import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { stableStringify } from '../../utils/stable-stringify.js';
import { laterSavedAtWins } from './sim-sync-keys.js';

/** Storage key, global (not character-scoped) */
export const PARTY_ROSTER_KEY = 'combatSimPartyRoster';
const STORE = 'settings';

/** Most teammates the roster holds; a party of 5 from 40 is already ~100k compositions */
export const MAX_ROSTER_SIZE = 40;

/** Most aura options one teammate carries */
export const MAX_AURA_OPTIONS = 8;

/** Longest teammate name kept */
const MAX_NAME_LENGTH = 40;

/** Combat skill levels every sim player DTO carries */
const COMBAT_LEVEL_KEYS = [
    'staminaLevel',
    'intelligenceLevel',
    'attackLevel',
    'meleeLevel',
    'defenseLevel',
    'rangedLevel',
    'magicLevel',
];

/**
 * Fields stripped from a build kept as a teammate: the slot it sat in, the level-gap penalty of the party it was
 * loaded with (recomputed for every composition), and your own task board (a teammate's tasks are not yours).
 */
const PER_PARTY_FIELDS = ['hrid', 'debuffOnLevelGap', 'taskMonsterHrids', 'taskMonsterRemaining'];

/**
 * An empty roster.
 * @returns {{savedAt: number, entries: Array}}
 */
function emptyRoster() {
    return { savedAt: 0, entries: [] };
}

/**
 * Trim and bound a teammate name.
 * @param {*} name
 * @returns {string} '' when nothing usable is left
 */
export function cleanTeammateName(name) {
    return String(name ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
}

/**
 * Whether a value is shaped like a sim player DTO the engine can run.
 * @param {*} dto
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateTeammateDTO(dto) {
    if (!dto || typeof dto !== 'object' || Array.isArray(dto)) return { ok: false, reason: 'not a player build' };
    if (!dto.equipment || typeof dto.equipment !== 'object' || Array.isArray(dto.equipment)) {
        return { ok: false, reason: 'no equipment map' };
    }
    for (const key of COMBAT_LEVEL_KEYS) {
        if (!Number.isFinite(dto[key])) return { ok: false, reason: `no ${key.replace('Level', '')} level` };
    }
    for (const list of ['food', 'drinks', 'abilities']) {
        if (dto[list] !== undefined && !Array.isArray(dto[list])) return { ok: false, reason: `bad ${list} list` };
    }
    return { ok: true };
}

/**
 * A copy of a build as the roster keeps it — see {@link PER_PARTY_FIELDS}.
 * @param {Object} dto - Sim player DTO
 * @returns {Object}
 */
export function sanitizeTeammateDTO(dto) {
    const copy = structuredClone(dto);
    for (const field of PER_PARTY_FIELDS) delete copy[field];
    return copy;
}

/**
 * The identity of a build, regardless of the slot or party it came from: two entries with the same fingerprint
 * simulate the same player.
 * @param {Object} dto
 * @returns {string}
 */
export function buildFingerprint(dto) {
    if (!dto || typeof dto !== 'object') return '';
    const rest = { ...dto };
    for (const field of PER_PARTY_FIELDS) delete rest[field];
    return stableStringify(rest);
}

/**
 * A teammate's aura options as stored: each `{hrid, level}` with an ability hrid and a whole level of at least 1,
 * one per hrid (the last level given wins), at most {@link MAX_AURA_OPTIONS}. Whether a hrid is an aura, still
 * exists or has a level the game allows is judged against the game data when a sweep is planned, not here — the
 * roster outlives a game patch.
 * @param {*} value
 * @returns {Array<{hrid: string, level: number}>}
 */
export function normalizeAuraOptions(value) {
    if (!Array.isArray(value)) return [];
    const byHrid = new Map();
    for (const option of value) {
        const hrid = typeof option?.hrid === 'string' ? option.hrid : '';
        const level = Math.floor(Number(option?.level));
        if (!hrid.startsWith('/abilities/') || !Number.isFinite(level) || level < 1) continue;
        byHrid.delete(hrid);
        byHrid.set(hrid, { hrid, level });
    }
    return [...byHrid.values()].slice(0, MAX_AURA_OPTIONS);
}

/**
 * A stored value read as a roster: anything malformed drops out rather than reaching the sweep.
 * @param {*} value - What storage holds
 * @returns {{savedAt: number, entries: Array<{id: string, name: string, dto: Object, source: string,
 *   addedAt: number, updatedAt: number, auras: Array<{hrid: string, level: number}>, includeAsBuilt: boolean}>}}
 *   `auras` are the aura options the sweep tries the teammate with; `includeAsBuilt` says whether it also tries
 *   them as built (always true when they have no aura options)
 */
export function normalizeRoster(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return emptyRoster();
    const seen = new Set();
    const entries = [];
    for (const entry of value.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
        if (!validateTeammateDTO(entry.dto).ok) continue;
        seen.add(entry.id);
        entries.push({
            id: entry.id,
            name: cleanTeammateName(entry.name) || 'Teammate',
            dto: entry.dto,
            source: typeof entry.source === 'string' ? entry.source : 'editor',
            addedAt: Number(entry.addedAt) || 0,
            updatedAt: Number(entry.updatedAt) || 0,
            auras: normalizeAuraOptions(entry.auras),
            includeAsBuilt: entry.includeAsBuilt !== false,
        });
        if (entries.length >= MAX_ROSTER_SIZE) break;
    }
    return { savedAt: Number(value.savedAt) || 0, entries };
}

let idCounter = 0;

/**
 * A fresh entry id.
 * @returns {string}
 */
function newEntryId() {
    idCounter += 1;
    return `tm-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Read the roster.
 * @returns {Promise<ReturnType<typeof normalizeRoster>>}
 */
export async function loadRoster() {
    try {
        return normalizeRoster(await storage.get(PARTY_ROSTER_KEY, STORE, null));
    } catch (error) {
        console.error('[PartyRoster] Failed to read the roster:', error);
        return emptyRoster();
    }
}

/**
 * Apply one change to the stored roster in a single read-merge-write.
 * @param {(roster: ReturnType<typeof normalizeRoster>, now: number) => {write: boolean}} change - Mutates the
 *   roster and returns an outcome; `write: false` leaves storage alone
 * @returns {Promise<{ok: boolean, roster: ReturnType<typeof normalizeRoster>, outcome: Object|null}>} `ok` false
 *   when the write failed (nothing changed on disk; `roster` is then what was last read)
 */
async function mutateRoster(change) {
    let outcome = null;
    let computed = null;
    const now = Date.now();
    try {
        const result = await storage.update(
            PARTY_ROSTER_KEY,
            (current) => {
                const roster = normalizeRoster(current);
                outcome = change(roster, now) ?? { write: false };
                if (!outcome.write) {
                    computed = roster;
                    return undefined;
                }
                // Never earlier than what is stored: the later save wins a sync, and this one is the latest
                roster.savedAt = Math.max(now, (Number(current?.savedAt) || 0) + 1);
                computed = roster;
                return roster;
            },
            STORE
        );
        if (!result) return { ok: false, roster: await loadRoster(), outcome };
        return { ok: true, roster: normalizeRoster(result.value ?? computed), outcome };
    } catch (error) {
        console.error('[PartyRoster] Failed to save the roster:', error);
        return { ok: false, roster: await loadRoster(), outcome: null };
    }
}

/**
 * Add teammates.
 * @param {Array<{name: string, dto: Object, source?: string}>} items
 * @returns {Promise<{ok: boolean, roster: Object, added: Array<string>, rejected: Array<{name: string,
 *   reason: string}>}>} `added` holds the new entries' ids
 */
export async function addTeammates(items) {
    const list = Array.isArray(items) ? items : [];
    const result = await mutateRoster((roster, now) => {
        const added = [];
        const rejected = [];
        for (const item of list) {
            const name = cleanTeammateName(item?.name) || 'Teammate';
            const valid = validateTeammateDTO(item?.dto);
            if (!valid.ok) {
                rejected.push({ name, reason: valid.reason });
                continue;
            }
            if (roster.entries.length >= MAX_ROSTER_SIZE) {
                rejected.push({ name, reason: `the roster holds at most ${MAX_ROSTER_SIZE}` });
                continue;
            }
            const id = newEntryId();
            roster.entries.push({
                id,
                name,
                dto: sanitizeTeammateDTO(item.dto),
                source: item.source || 'editor',
                addedAt: now,
                updatedAt: now,
                auras: [],
                includeAsBuilt: true,
            });
            added.push(id);
        }
        return { write: added.length > 0, added, rejected };
    });
    const { added = [], rejected = [] } = result.outcome || {};
    return { ok: result.ok, roster: result.roster, added: result.ok ? added : [], rejected };
}

/**
 * Rename a teammate.
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean}>}
 */
export async function renameTeammate(id, name) {
    const clean = cleanTeammateName(name);
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        if (!clean || entry.name === clean) return { write: false, found: true };
        entry.name = clean;
        entry.updatedAt = now;
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

/**
 * Replace a teammate's build, keeping their name and id.
 * @param {string} id
 * @param {Object} dto
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean, reason?: string}>}
 */
export async function replaceTeammateBuild(id, dto) {
    const valid = validateTeammateDTO(dto);
    if (!valid.ok) return { ok: false, roster: await loadRoster(), found: false, reason: valid.reason };
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        entry.dto = sanitizeTeammateDTO(dto);
        entry.updatedAt = now;
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

/**
 * Set the aura options a teammate is tried with.
 * @param {string} id
 * @param {Array<{hrid: string, level: number}>} auras - Replaces the whole list
 * @param {boolean} includeAsBuilt - Also try them as built
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean}>}
 */
export async function setTeammateAuras(id, auras, includeAsBuilt) {
    const clean = normalizeAuraOptions(auras);
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        entry.auras = clean;
        entry.includeAsBuilt = includeAsBuilt !== false;
        entry.updatedAt = now;
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

/**
 * Remove a teammate.
 * @param {string} id
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean}>}
 */
export async function removeTeammate(id) {
    const result = await mutateRoster((roster) => {
        const before = roster.entries.length;
        roster.entries = roster.entries.filter((e) => e.id !== id);
        const found = roster.entries.length !== before;
        return { write: found, found };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

// Live-safe: the Party Finder tab re-reads the record when a pull writes it, and every write is a read-merge-write
// of storage, never the tab's in-memory copy put back
registerSyncMerge({
    store: STORE,
    base: PARTY_ROSTER_KEY,
    merge: laterSavedAtWins,
    label: 'Combat Sim party finder roster',
    liveSafe: true,
});
