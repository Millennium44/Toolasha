/**
 * Saved parties: a whole Party Finder party (the members besides you, each with a build, a Try/Always/Never pick
 * and aura options) kept under a name, to lock in or load into the editor later.
 *
 * Stored and synced the way saved builds are (`party-roster.js`): one account-wide record in `settings`, merged per
 * party by id with the later `updatedAt` winning, deletions as tombstones (`removed: {id: deletedAt}`) that beat any
 * copy last changed before them, and every write a read-merge-write in one `storage.update`.
 *
 * It is a record of its own rather than a new field on the roster record on purpose: a build from before this
 * normalizes the roster record down to the fields it knows and writes that back, so a `parties` field there would
 * be dropped by the first roster write on an older build (and by its sync fold). In its own key an older build never
 * reads or writes it, so rolling back loses nothing; the key sits under the owned `combatSim` prefix, and an older
 * build that sees it pulled has no merge for it, so it only latches the key and asks for a reload.
 *
 * Members are kept even when their build is not one the engine can run (a patch changed the shape, a hand edit):
 * dropping them on read would lose them for good once the record is next written. {@link usableMembers} judges them
 * where they are used, and says which were left out.
 *
 * Saved rosters (the Configure tab's "Save party": every loaded player, you included, up to five) are kept the same
 * way under a key of their own, {@link SAVED_ROSTERS_KEY}, and not as a kind of saved party: a build from before them
 * reads a saved party down to its known fields and at most {@link MAX_PARTY_MEMBERS} members
 * ({@link normalizeSavedParties}) and writes that back on its next change or sync fold, so a five-player roster kept
 * in the parties record would lose a player there, and the copy it cut would win the next fold.
 */

import storage from '../../core/storage.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';
import {
    cleanTeammateName,
    keepMostRecent,
    newEntryId,
    normalizeAuraOptions,
    normalizeTombstones,
    sanitizeTeammateDTO,
    unionTombstones,
    validateTeammateDTO,
} from './party-roster.js';

/** Storage key, global (not character-scoped) */
export const SAVED_PARTIES_KEY = 'combatSimSavedParties';
const STORE = 'settings';

/** Most saved parties the record holds (the same as saved builds) */
export const MAX_SAVED_PARTIES = 40;

/** Most members a saved party holds: a party is five with you */
export const MAX_PARTY_MEMBERS = 4;

/** Storage key of the saved rosters, global (not character-scoped) */
export const SAVED_ROSTERS_KEY = 'combatSimSavedRosters';

/** Most saved rosters the record holds */
export const MAX_SAVED_ROSTERS = 40;

/** Most players a saved roster holds: the whole party, you included */
export const MAX_ROSTER_PLAYERS = 5;

const CHOICES = ['try', 'always', 'never'];

/**
 * An empty record.
 * @returns {{savedAt: number, parties: Array, removed: Object}}
 */
function emptySaved() {
    return { savedAt: 0, parties: [], removed: {} };
}

/**
 * A stored value read as the saved parties: anything malformed drops out.
 * @param {*} value
 * @param {number} [now]
 * @returns {{savedAt: number, parties: Array<{id: string, name: string, members: Array<{name: string, dto: Object,
 *   choice: string, auras: Array, includeAsBuilt: boolean, gameMode: string|null}>, addedAt: number,
 *   updatedAt: number}>, removed: Object<string, number>}}
 */
export function normalizeSavedParties(value, now = Date.now()) {
    return normalizeRecord(value, now, PARTIES);
}

/**
 * {@link normalizeSavedParties} for one of the two records.
 * @param {*} value
 * @param {number} now
 * @param {{maxMembers: number, maxEntries: number, fallbackName: string}} kind
 * @returns {ReturnType<typeof normalizeSavedParties>}
 */
function normalizeRecord(value, now, { maxMembers, maxEntries, fallbackName }) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.parties)) return emptySaved();
    const removed = normalizeTombstones(value.removed, now);
    const seen = new Set();
    const parties = [];
    for (const party of value.parties) {
        if (!party || typeof party.id !== 'string' || !party.id || seen.has(party.id)) continue;
        if (!Array.isArray(party.members)) continue;
        if (removed[party.id] >= (Number(party.updatedAt) || 0)) continue;
        seen.add(party.id);
        const members = [];
        for (const member of party.members) {
            if (!member || typeof member !== 'object' || !member.dto || typeof member.dto !== 'object') continue;
            members.push({
                name: cleanTeammateName(member.name) || 'Teammate',
                dto: member.dto,
                choice: CHOICES.includes(member.choice) ? member.choice : 'always',
                auras: normalizeAuraOptions(member.auras),
                includeAsBuilt: member.includeAsBuilt !== false,
                gameMode: typeof member.gameMode === 'string' && member.gameMode ? member.gameMode : null,
            });
            if (members.length >= maxMembers) break;
        }
        parties.push({
            id: party.id,
            name: cleanTeammateName(party.name) || fallbackName,
            members,
            addedAt: Number(party.addedAt) || 0,
            updatedAt: Number(party.updatedAt) || 0,
        });
        if (parties.length >= maxEntries) break;
    }
    return { savedAt: Number(value.savedAt) || 0, parties, removed };
}

/**
 * The two records kept this way. Each is `{savedAt, parties, removed}` with the same entry shape; a roster's
 * `members` are every player in Configure tab order, you included.
 */
const PARTIES = {
    key: SAVED_PARTIES_KEY,
    maxMembers: MAX_PARTY_MEMBERS,
    maxEntries: MAX_SAVED_PARTIES,
    fallbackName: 'Party',
    idPrefix: 'sp',
    noneToSave: 'no one besides you has a build that can be saved',
    tooMany: `a party holds at most ${MAX_PARTY_MEMBERS} besides you`,
    full: `at most ${MAX_SAVED_PARTIES} parties can be saved`,
};

const ROSTERS = {
    key: SAVED_ROSTERS_KEY,
    maxMembers: MAX_ROSTER_PLAYERS,
    maxEntries: MAX_SAVED_ROSTERS,
    fallbackName: 'Party',
    idPrefix: 'sr',
    noneToSave: 'no player has a build that can be saved',
    tooMany: `a party holds at most ${MAX_ROSTER_PLAYERS} players`,
    full: `at most ${MAX_SAVED_ROSTERS} parties can be saved here`,
};

/**
 * Which record a key names: {@link SAVED_ROSTERS_KEY} the rosters, anything else the parties.
 * @param {string} key
 * @returns {typeof PARTIES}
 */
function kindFor(key) {
    return key === SAVED_ROSTERS_KEY ? ROSTERS : PARTIES;
}

/**
 * A stored value read as the saved rosters: anything malformed drops out.
 * @param {*} value
 * @param {number} [now]
 * @returns {ReturnType<typeof normalizeSavedParties>}
 */
export function normalizeSavedRosters(value, now = Date.now()) {
    return normalizeRecord(value, now, ROSTERS);
}

/**
 * The sync fold: both copies' parties by id, the later `updatedAt` winning each (a tie to the incoming copy), both
 * copies' tombstones, and every party deleted after it last changed dropped; the cap keeps the most recently changed.
 * @param {*} local
 * @param {*} incoming
 * @returns {Object}
 */
export function mergeSavedParties(local, incoming) {
    return mergeRecord(local, incoming, PARTIES);
}

/**
 * {@link mergeSavedParties} for the saved rosters.
 * @param {*} local
 * @param {*} incoming
 * @returns {Object}
 */
export function mergeSavedRosters(local, incoming) {
    return mergeRecord(local, incoming, ROSTERS);
}

/**
 * @param {*} local
 * @param {*} incoming
 * @param {typeof PARTIES} kind
 * @returns {Object}
 */
function mergeRecord(local, incoming, kind) {
    const now = Date.now();
    const a = normalizeRecord(local, now, kind);
    const b = normalizeRecord(incoming, now, kind);
    const removed = unionTombstones(
        normalizeTombstones(local?.removed, now),
        normalizeTombstones(incoming?.removed, now)
    );
    const byId = new Map(a.parties.map((party) => [party.id, party]));
    for (const party of b.parties) {
        const mine = byId.get(party.id);
        if (!mine || party.updatedAt >= mine.updatedAt) byId.set(party.id, party);
    }
    const parties = keepMostRecent(
        [...byId.values()].filter((party) => !(removed[party.id] >= party.updatedAt)),
        kind.maxEntries
    );
    return { savedAt: Math.max(a.savedAt, b.savedAt), parties, removed };
}

/**
 * Names a sync fold took off a full list for want of room (gone without a tombstone from a list now full).
 * @param {{parties: Array}} before
 * @param {{parties: Array, removed: Object}} after
 * @returns {Array<string>}
 */
export function evictedPartiesByCap(before, after) {
    const left = after?.parties || [];
    if (left.length < MAX_SAVED_PARTIES) return [];
    const ids = new Set(left.map((p) => p.id));
    return (before?.parties || []).filter((p) => !ids.has(p.id) && !after?.removed?.[p.id]).map((p) => p.name);
}

/**
 * The members of a saved party (or the players of a saved roster) that can be run, each with a build ready for
 * the engine, and the names left out.
 * @param {{members: Array}} party
 * @returns {{members: Array<Object>, skipped: Array<string>}}
 */
export function usableMembers(party) {
    const members = [];
    const skipped = [];
    for (const member of party?.members || []) {
        if (!validateTeammateDTO(member.dto).ok) {
            skipped.push(member.name);
            continue;
        }
        members.push({ ...member, dto: sanitizeTeammateDTO(member.dto) });
    }
    return { members, skipped };
}

/**
 * @param {typeof PARTIES} kind
 * @returns {Promise<ReturnType<typeof normalizeSavedParties>>}
 */
async function loadRecord(kind) {
    try {
        return normalizeRecord(await storage.get(kind.key, STORE, null), Date.now(), kind);
    } catch (error) {
        console.error('[PartySaved] Failed to read the saved parties:', error);
        return emptySaved();
    }
}

/**
 * Read the saved parties.
 * @returns {Promise<ReturnType<typeof normalizeSavedParties>>}
 */
export function loadSavedParties() {
    return loadRecord(PARTIES);
}

/**
 * Read the saved rosters.
 * @returns {Promise<ReturnType<typeof normalizeSavedParties>>}
 */
export function loadSavedRosters() {
    return loadRecord(ROSTERS);
}

/**
 * Apply one change to the stored record in a single read-merge-write.
 * @param {string} key - {@link SAVED_PARTIES_KEY} or {@link SAVED_ROSTERS_KEY}
 * @param {(saved: ReturnType<typeof normalizeSavedParties>, now: number) => Object} change - Mutates it and returns
 *   an outcome; `write: false` leaves storage alone
 * @returns {Promise<{ok: boolean, saved: ReturnType<typeof normalizeSavedParties>, outcome: Object|null}>}
 */
async function mutateSaved(key, change) {
    const kind = kindFor(key);
    let outcome = null;
    let computed = null;
    const now = Date.now();
    try {
        const result = await storage.update(
            // Written out as the two constants so the sync-ownership scan can read which keys this writes
            key === SAVED_ROSTERS_KEY ? SAVED_ROSTERS_KEY : SAVED_PARTIES_KEY,
            (current) => {
                const saved = normalizeRecord(current, Date.now(), kind);
                outcome = change(saved, now) ?? { write: false };
                computed = saved;
                if (!outcome.write) return undefined;
                // Never earlier than what is stored: the later save wins a sync, and this one is the latest
                saved.savedAt = Math.max(now, (Number(current?.savedAt) || 0) + 1);
                return saved;
            },
            STORE
        );
        if (!result) return { ok: false, saved: await loadRecord(kind), outcome };
        return { ok: true, saved: normalizeRecord(result.value ?? computed, Date.now(), kind), outcome };
    } catch (error) {
        console.error('[PartySaved] Failed to save the parties:', error);
        return { ok: false, saved: await loadRecord(kind), outcome: null };
    }
}

/**
 * @param {string} key - {@link SAVED_PARTIES_KEY} or {@link SAVED_ROSTERS_KEY}
 * @param {string} name
 * @param {Array<Object>} members
 * @returns {Promise<Object>} See {@link saveParty}
 */
async function saveRecordEntry(key, name, members) {
    const kind = kindFor(key);
    const clean = cleanTeammateName(name);
    const fail = async (reason, skipped = []) => ({
        ok: false,
        saved: await loadRecord(kind),
        id: null,
        name: null,
        duplicate: false,
        skipped,
        reason,
    });
    if (!clean) return fail('give the party a name');
    const kept = [];
    const skipped = [];
    for (const member of Array.isArray(members) ? members : []) {
        const memberName = cleanTeammateName(member?.name) || 'Teammate';
        const valid = validateTeammateDTO(member?.dto);
        if (!valid.ok) {
            skipped.push({ name: memberName, reason: valid.reason });
            continue;
        }
        kept.push({
            name: memberName,
            dto: sanitizeTeammateDTO(member.dto),
            choice: CHOICES.includes(member.choice) ? member.choice : 'always',
            auras: normalizeAuraOptions(member.auras),
            includeAsBuilt: member.includeAsBuilt !== false,
            gameMode: member.dto.gameMode || member.gameMode || null,
        });
    }
    if (!kept.length) return fail(kind.noneToSave, skipped);
    if (kept.length > kind.maxMembers) return fail(kind.tooMany, skipped);
    const result = await mutateSaved(key, (saved, now) => {
        if (saved.parties.length >= kind.maxEntries) {
            return { write: false, reason: kind.full };
        }
        const id = newEntryId(kind.idPrefix);
        const duplicate = saved.parties.some((p) => p.name.toLowerCase() === clean.toLowerCase());
        saved.parties.push({ id, name: clean, members: kept, addedAt: now, updatedAt: now });
        return { write: true, id, duplicate };
    });
    const outcome = result.outcome || {};
    return {
        ok: result.ok && Boolean(outcome.id),
        saved: result.saved,
        id: result.ok ? outcome.id || null : null,
        name: result.ok && outcome.id ? clean : null,
        duplicate: Boolean(result.ok && outcome.duplicate),
        skipped,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
    };
}

/**
 * Save a party under a name. Names may repeat; `duplicate` says one did.
 * @param {string} name
 * @param {Array<{name: string, dto: Object, choice?: string, auras?: Array, includeAsBuilt?: boolean,
 *   gameMode?: string}>} members - The players besides you
 * @returns {Promise<{ok: boolean, saved: Object, id: string|null, name: string|null, duplicate: boolean,
 *   skipped: Array<{name: string, reason: string}>, reason?: string}>} `skipped`: members whose build is not one the
 *   engine can run, left out (never saved blank); `reason` says why nothing was saved
 */
export function saveParty(name, members) {
    return saveRecordEntry(SAVED_PARTIES_KEY, name, members);
}

/**
 * Save a whole Configure roster under a name: every player, you included, in tab order. Names may repeat.
 * @param {string} name
 * @param {Array<{name: string, dto: Object, gameMode?: string}>} players - Up to {@link MAX_ROSTER_PLAYERS}
 * @returns {ReturnType<typeof saveParty>}
 */
export function saveRoster(name, players) {
    return saveRecordEntry(SAVED_ROSTERS_KEY, name, players);
}

/**
 * @param {string} key
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ok: boolean, saved: Object, found: boolean, duplicate: boolean}>}
 */
async function renameRecordEntry(key, id, name) {
    const clean = cleanTeammateName(name);
    const result = await mutateSaved(key, (saved, now) => {
        const party = saved.parties.find((p) => p.id === id);
        if (!party) return { write: false, found: false };
        if (!clean || party.name === clean) return { write: false, found: true };
        party.name = clean;
        // Later than its last change even on a clock that is behind, so the rename wins the fold
        party.updatedAt = Math.max(now, (party.updatedAt || 0) + 1);
        const duplicate = saved.parties.some((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase());
        return { write: true, found: true, duplicate };
    });
    return {
        ok: result.ok,
        saved: result.saved,
        found: Boolean(result.outcome?.found),
        duplicate: Boolean(result.ok && result.outcome?.duplicate),
    };
}

/**
 * Rename a saved party (a name another party has is allowed).
 * @param {string} id
 * @param {string} name
 * @returns {Promise<{ok: boolean, saved: Object, found: boolean, duplicate: boolean}>}
 */
export function renameParty(id, name) {
    return renameRecordEntry(SAVED_PARTIES_KEY, id, name);
}

/**
 * Rename a saved roster.
 * @param {string} id
 * @param {string} name
 * @returns {ReturnType<typeof renameParty>}
 */
export function renameRoster(id, name) {
    return renameRecordEntry(SAVED_ROSTERS_KEY, id, name);
}

/**
 * @param {string} key
 * @param {string} id
 * @returns {Promise<{ok: boolean, saved: Object, found: boolean}>}
 */
async function removeRecordEntry(key, id) {
    const result = await mutateSaved(key, (saved, now) => {
        const party = saved.parties.find((p) => p.id === id);
        if (!party) return { write: false, found: false };
        saved.parties = saved.parties.filter((p) => p.id !== id);
        saved.removed = { ...saved.removed, [id]: Math.max(now, (party.updatedAt || 0) + 1) };
        return { write: true, found: true };
    });
    return { ok: result.ok, saved: result.saved, found: Boolean(result.outcome?.found) };
}

/**
 * Delete a saved party, leaving a tombstone so a stale device cannot bring it back.
 * @param {string} id
 * @returns {Promise<{ok: boolean, saved: Object, found: boolean}>}
 */
export function removeParty(id) {
    return removeRecordEntry(SAVED_PARTIES_KEY, id);
}

/**
 * Delete a saved roster, leaving a tombstone.
 * @param {string} id
 * @returns {ReturnType<typeof removeParty>}
 */
export function removeRoster(id) {
    return removeRecordEntry(SAVED_ROSTERS_KEY, id);
}

// Live-safe: the Party Finder tab re-reads the record when a pull writes it, and every write is a read-merge-write
// of storage, never the tab's in-memory copy put back
registerSyncMerge({
    store: STORE,
    base: SAVED_PARTIES_KEY,
    merge: mergeSavedParties,
    label: 'Combat Sim saved parties',
    liveSafe: true,
});

// Live-safe: the Configure tab reads the list from storage each time it is opened and again on each load, and every
// write is a read-merge-write of storage
registerSyncMerge({
    store: STORE,
    base: SAVED_ROSTERS_KEY,
    merge: mergeSavedRosters,
    label: 'Combat Sim saved rosters',
    liveSafe: true,
});
