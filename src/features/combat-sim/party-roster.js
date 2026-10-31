/**
 * The Party Finder's teammate roster: named teammate builds (sim player DTOs) the
 * composition sweep tries alongside you.
 *
 * Account-wide, not per character: a teammate is someone you might group with on any
 * of your characters, and nothing in their build belongs to one of yours. Stored as one
 * record in `settings` under a `combatSim` key, so the sync's owned-prefix list already
 * carries it.
 *
 * Saved builds ride in the same record (`builds`): named copies of your own builds (any editor player, or the
 * live character) kept to be added as teammates later, with their own `sb-` ids. They merge and tombstone exactly
 * as teammates do (one `removed` map holds both: ids never collide), so no new storage key is needed and the
 * owned-prefix registration above already covers them.
 *
 * Sync: merged per teammate (`mergeRoster`). Entries are matched by id and the later
 * `updatedAt` wins each one, so two devices that add different teammates keep both, and an
 * edit on one device is not undone by the other's older copy. A delete leaves a tombstone
 * (`removed: {id: deletedAt}`, the convention `custom-tabs-data.js` uses) that beats any copy
 * of that teammate last changed before it, so a stale device cannot bring a deleted teammate
 * back; tombstones are forgotten after {@link TOMBSTONE_MAX_AGE_MS}. Every write here is a
 * read-merge-write in one transaction (`storage.update`), so two tabs editing at once each
 * land their change on the other's, and the Party Finder tab re-reads the record when a pull
 * writes it, so the key is registered live-safe.
 */

import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import { stableStringify } from '../../utils/stable-stringify.js';

/** Storage key, global (not character-scoped) */
export const PARTY_ROSTER_KEY = 'combatSimPartyRoster';
const STORE = 'settings';

/** Most teammates the roster holds; a party of 5 from 40 is already ~100k compositions */
export const MAX_ROSTER_SIZE = 40;

/** Most aura options one teammate carries */
export const MAX_AURA_OPTIONS = 8;

/** Most saved builds the record holds */
export const MAX_SAVED_BUILDS = 40;

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
    return { savedAt: 0, entries: [], builds: [], removed: {} };
}

/**
 * How long a deletion is remembered: long enough for the slowest device to catch up, as `custom-tabs-data.js`
 * reasons it. After that a device still holding the teammate would bring them back.
 */
export const TOMBSTONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A roster's tombstones, malformed and expired ones dropped.
 * @param {*} removed
 * @param {number} now
 * @returns {Object<string, number>} id → deletedAt
 */
function normalizeTombstones(removed, now) {
    const out = {};
    if (!removed || typeof removed !== 'object' || Array.isArray(removed)) return out;
    for (const [id, at] of Object.entries(removed)) {
        const when = Number(at);
        if (!id || !Number.isFinite(when) || when <= 0 || now - when > TOMBSTONE_MAX_AGE_MS) continue;
        out[id] = when;
    }
    return out;
}

/**
 * Union two tombstone maps, the later deletion winning per id.
 * @param {Object<string, number>} a
 * @param {Object<string, number>} b
 * @returns {Object<string, number>}
 */
function unionTombstones(a, b) {
    const out = { ...a };
    for (const [id, at] of Object.entries(b)) if (!(id in out) || at > out[id]) out[id] = at;
    return out;
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
 * A saved build's name made unique among the others: "Tank", then "Tank (2)", "Tank (3)". Compared without regard
 * to case, so "tank" and "Tank" are not both kept.
 * @param {*} name
 * @param {Array<{id: string, name: string}>} builds - The saved builds
 * @param {string} [exceptId] - A build being renamed does not clash with itself
 * @returns {string} '' when nothing usable is left of the name
 */
export function uniqueBuildName(name, builds, exceptId = null) {
    const base = cleanTeammateName(name);
    if (!base) return '';
    const taken = new Set(
        (Array.isArray(builds) ? builds : []).filter((b) => b.id !== exceptId).map((b) => b.name.toLowerCase())
    );
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) {
        const suffix = ` (${n})`;
        const candidate = `${base.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
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
        if (dto[list] != null && !Array.isArray(dto[list])) return { ok: false, reason: `bad ${list} list` };
    }
    if (dto.houseRooms != null && (typeof dto.houseRooms !== 'object' || Array.isArray(dto.houseRooms))) {
        return { ok: false, reason: 'bad house rooms' };
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
    return withEmptySlots(copy);
}

/**
 * A build with every list the engine reads present: `Player.createFromDTO` maps `food`, `drinks` and
 * `abilities` and reads `houseRooms` unguarded, so a build (an old export, a hand-made one) missing one fails
 * there. Missing ones are filled with the empty shapes `buildPlayerDTO` starts from — three food and drink slots,
 * five ability slots, no rooms; ones present are left as they are. Mutates and returns `dto`.
 * @param {Object} dto
 * @returns {Object}
 */
function withEmptySlots(dto) {
    if (!Array.isArray(dto.food)) dto.food = [null, null, null];
    if (!Array.isArray(dto.drinks)) dto.drinks = [null, null, null];
    if (!Array.isArray(dto.abilities)) dto.abilities = [null, null, null, null, null];
    if (!dto.houseRooms || typeof dto.houseRooms !== 'object' || Array.isArray(dto.houseRooms)) dto.houseRooms = {};
    return dto;
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
 *   addedAt: number, updatedAt: number, auras: Array<{hrid: string, level: number}>, includeAsBuilt: boolean,
 *   gameMode: string|null}>}}
 *   `auras` are the aura options the sweep tries the teammate with; `includeAsBuilt` says whether it also tries
 *   them as built (always true when they have no aura options)
 */
export function normalizeRoster(value, now = Date.now()) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return emptyRoster();
    const removed = normalizeTombstones(value.removed, now);
    const seen = new Set();
    const entries = [];
    for (const entry of value.entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
        if (!validateTeammateDTO(entry.dto).ok) continue;
        // Deleted after it last changed: the deletion stands
        if (removed[entry.id] >= (Number(entry.updatedAt) || 0)) continue;
        seen.add(entry.id);
        entries.push({
            id: entry.id,
            name: cleanTeammateName(entry.name) || 'Teammate',
            dto: withEmptySlots({ ...entry.dto }),
            source: typeof entry.source === 'string' ? entry.source : 'editor',
            addedAt: Number(entry.addedAt) || 0,
            updatedAt: Number(entry.updatedAt) || 0,
            auras: normalizeAuraOptions(entry.auras),
            includeAsBuilt: entry.includeAsBuilt !== false,
            gameMode: typeof entry.gameMode === 'string' && entry.gameMode ? entry.gameMode : null,
        });
        if (entries.length >= MAX_ROSTER_SIZE) break;
    }
    const builds = [];
    const seenBuilds = new Set();
    for (const build of Array.isArray(value.builds) ? value.builds : []) {
        if (!build || typeof build.id !== 'string' || !build.id || seenBuilds.has(build.id)) continue;
        if (!validateTeammateDTO(build.dto).ok) continue;
        if (removed[build.id] >= (Number(build.updatedAt) || 0)) continue;
        seenBuilds.add(build.id);
        builds.push({
            id: build.id,
            name: cleanTeammateName(build.name) || 'Build',
            dto: withEmptySlots({ ...build.dto }),
            addedAt: Number(build.addedAt) || 0,
            updatedAt: Number(build.updatedAt) || 0,
            gameMode: typeof build.gameMode === 'string' && build.gameMode ? build.gameMode : null,
        });
        if (builds.length >= MAX_SAVED_BUILDS) break;
    }
    return { savedAt: Number(value.savedAt) || 0, entries, builds, removed };
}

/**
 * The sync fold: both copies' teammates by id, the later `updatedAt` winning each (a tie to the incoming copy),
 * both copies' tombstones, and every teammate deleted after it last changed dropped. This device's order first,
 * then teammates only the incoming copy has; the size cap applies to the teammates left.
 * @param {*} local - This device's stored roster
 * @param {*} incoming - The other side's
 * @returns {Object} The merged roster
 */
export function mergeRoster(local, incoming) {
    const now = Date.now();
    const a = normalizeRoster(local, now);
    const b = normalizeRoster(incoming, now);
    const removed = unionTombstones(
        normalizeTombstones(local?.removed, now),
        normalizeTombstones(incoming?.removed, now)
    );
    const byId = new Map(a.entries.map((entry) => [entry.id, entry]));
    for (const entry of b.entries) {
        const mine = byId.get(entry.id);
        if (!mine || entry.updatedAt >= mine.updatedAt) byId.set(entry.id, entry);
    }
    const entries = [...byId.values()]
        .filter((entry) => !(removed[entry.id] >= entry.updatedAt))
        .slice(0, MAX_ROSTER_SIZE);
    const buildsById = new Map(a.builds.map((build) => [build.id, build]));
    for (const build of b.builds) {
        const mine = buildsById.get(build.id);
        if (!mine || build.updatedAt >= mine.updatedAt) buildsById.set(build.id, build);
    }
    const builds = [...buildsById.values()]
        .filter((build) => !(removed[build.id] >= build.updatedAt))
        .slice(0, MAX_SAVED_BUILDS);
    return { savedAt: Math.max(a.savedAt, b.savedAt), entries, builds, removed };
}

let idCounter = 0;

/**
 * A fresh entry id.
 * @param {string} [prefix] - 'tm' for a teammate, 'sb' for a saved build
 * @returns {string}
 */
function newEntryId(prefix = 'tm') {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
 * @param {Array<{name: string, dto: Object, source?: string, gameMode?: string}>} items - `gameMode` is the
 *   teammate's game mode when the source knows it and the build does not carry it
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
                gameMode: item.gameMode || item.dto.gameMode || null,
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
 * @param {string} [gameMode] - Their game mode when the source knows it and the build does not carry it; the one
 *   already saved is kept otherwise
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean, reason?: string}>}
 */
export async function replaceTeammateBuild(id, dto, gameMode) {
    const valid = validateTeammateDTO(dto);
    if (!valid.ok) return { ok: false, roster: await loadRoster(), found: false, reason: valid.reason };
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        entry.dto = sanitizeTeammateDTO(dto);
        entry.gameMode = dto.gameMode || gameMode || entry.gameMode || null;
        entry.updatedAt = now;
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

/**
 * Set the aura options a teammate is tried with.
 * @param {string} id
 * @param {Array<{hrid: string, level: number}>|Function} auras - The whole new list, or a change to make to the
 *   stored one: `({auras, includeAsBuilt}) => ({auras, includeAsBuilt})`, run inside the write against what is
 *   stored then, so an edit drawn from an older copy (another tab saved since) is made on the current list
 * @param {boolean} [includeAsBuilt] - Also try them as built (with a list; a change function returns its own)
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean}>}
 */
export async function setTeammateAuras(id, auras, includeAsBuilt) {
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        const next =
            typeof auras === 'function'
                ? auras({ auras: entry.auras.map((o) => ({ ...o })), includeAsBuilt: entry.includeAsBuilt })
                : { auras, includeAsBuilt };
        entry.auras = normalizeAuraOptions(next?.auras);
        entry.includeAsBuilt = next?.includeAsBuilt !== false;
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
    const result = await mutateRoster((roster, now) => {
        const entry = roster.entries.find((e) => e.id === id);
        if (!entry) return { write: false, found: false };
        roster.entries = roster.entries.filter((e) => e.id !== id);
        // Later than its last change, so the deletion beats every copy of it
        roster.removed = { ...roster.removed, [id]: Math.max(now, (entry.updatedAt || 0) + 1) };
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

/**
 * Save a build under a name. The name is made unique among the saved builds ("Tank (2)").
 * @param {string} name
 * @param {Object} dto - Sim player DTO (an editor player's, or the live character's)
 * @param {string} [gameMode] - Its game mode when the build does not carry it
 * @returns {Promise<{ok: boolean, roster: Object, id: string|null, name: string|null, reason?: string}>} `id` and
 *   `name` of the saved build (the name actually kept); `reason` says why nothing was saved
 */
export async function saveBuild(name, dto, gameMode) {
    const valid = validateTeammateDTO(dto);
    if (!valid.ok) return { ok: false, roster: await loadRoster(), id: null, name: null, reason: valid.reason };
    const result = await mutateRoster((roster, now) => {
        if (roster.builds.length >= MAX_SAVED_BUILDS) {
            return { write: false, reason: `at most ${MAX_SAVED_BUILDS} builds can be saved` };
        }
        const kept = uniqueBuildName(name, roster.builds) || uniqueBuildName('Build', roster.builds);
        const id = newEntryId('sb');
        roster.builds.push({
            id,
            name: kept,
            dto: sanitizeTeammateDTO(dto),
            addedAt: now,
            updatedAt: now,
            gameMode: dto.gameMode || gameMode || null,
        });
        return { write: true, id, name: kept };
    });
    const outcome = result.outcome || {};
    return {
        ok: result.ok && Boolean(outcome.id),
        roster: result.roster,
        id: result.ok ? outcome.id || null : null,
        name: result.ok ? outcome.name || null : null,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
}

/**
 * Rename a saved build; the new name is made unique among the others.
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean, name: string|null}>} `name` is the one kept
 */
export async function renameBuild(id, name) {
    const result = await mutateRoster((roster, now) => {
        const build = roster.builds.find((b) => b.id === id);
        if (!build) return { write: false, found: false };
        const kept = uniqueBuildName(name, roster.builds, id);
        if (!kept || kept === build.name) return { write: false, found: true, name: build.name };
        build.name = kept;
        build.updatedAt = now;
        return { write: true, found: true, name: kept };
    });
    return {
        ok: result.ok,
        roster: result.roster,
        found: Boolean(result.outcome?.found),
        name: result.outcome?.name ?? null,
    };
}

/**
 * Delete a saved build, leaving a tombstone so a stale device cannot bring it back.
 * @param {string} id
 * @returns {Promise<{ok: boolean, roster: Object, found: boolean}>}
 */
export async function removeBuild(id) {
    const result = await mutateRoster((roster, now) => {
        const build = roster.builds.find((b) => b.id === id);
        if (!build) return { write: false, found: false };
        roster.builds = roster.builds.filter((b) => b.id !== id);
        roster.removed = { ...roster.removed, [id]: Math.max(now, (build.updatedAt || 0) + 1) };
        return { write: true, found: true };
    });
    return { ok: result.ok, roster: result.roster, found: Boolean(result.outcome?.found) };
}

// Live-safe: the Party Finder tab re-reads the record when a pull writes it, and every write is a read-merge-write
// of storage, never the tab's in-memory copy put back
registerSyncMerge({
    store: STORE,
    base: PARTY_ROSTER_KEY,
    merge: mergeRoster,
    label: 'Combat Sim party finder roster',
    liveSafe: true,
});
