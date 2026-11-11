/**
 * Saved rosters (Configure's Save party): every loaded player, you included, kept under a key of their own. The
 * parties record the Party tab keeps is never written by them, and a build from before rosters (3.84.0) reads that
 * record exactly as it did; the evidence test shows why rosters could not share it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ values: new Map(), failNext: false, writes: [] }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (db.values.has(key) ? structuredClone(db.values.get(key)) : fallback),
        update: async (key, mutate) => {
            db.writes.push(key);
            if (db.failNext) {
                db.failNext = false;
                return null;
            }
            const current = db.values.has(key) ? structuredClone(db.values.get(key)) : undefined;
            const next = mutate(current);
            if (next === undefined) return { written: false, value: current };
            db.values.set(key, structuredClone(next));
            return { written: true, value: structuredClone(next) };
        },
    },
}));

const {
    SAVED_PARTIES_KEY,
    SAVED_ROSTERS_KEY,
    MAX_SAVED_ROSTERS,
    MAX_ROSTER_PLAYERS,
    saveParty,
    saveRoster,
    renameRoster,
    removeRoster,
    loadSavedRosters,
    loadSavedParties,
    normalizeSavedParties,
    normalizeSavedRosters,
    mergeSavedParties,
    mergeSavedRosters,
    usableMembers,
} = await import('./party-saved.js');
const {
    cleanTeammateName,
    keepMostRecent,
    normalizeAuraOptions,
    normalizeTombstones,
    unionTombstones,
    TOMBSTONE_MAX_AGE_MS,
} = await import('./party-roster.js');
const { isLiveSafeKey, mergeForKey } = await import('../../utils/sync-merge-registry.js');

/*
 * The saved-parties read and fold exactly as 3.84.0 shipped them (party-saved.js at 01b6f86f1), frozen here so the
 * older-build tests keep meaning what they say after this module changes.
 */
const OLD_CHOICES = ['try', 'always', 'never'];
function oldNormalizeSavedParties(value, now = Date.now()) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.parties)) {
        return { savedAt: 0, parties: [], removed: {} };
    }
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
                choice: OLD_CHOICES.includes(member.choice) ? member.choice : 'always',
                auras: normalizeAuraOptions(member.auras),
                includeAsBuilt: member.includeAsBuilt !== false,
                gameMode: typeof member.gameMode === 'string' && member.gameMode ? member.gameMode : null,
            });
            if (members.length >= 4) break;
        }
        parties.push({
            id: party.id,
            name: cleanTeammateName(party.name) || 'Party',
            members,
            addedAt: Number(party.addedAt) || 0,
            updatedAt: Number(party.updatedAt) || 0,
        });
        if (parties.length >= 40) break;
    }
    return { savedAt: Number(value.savedAt) || 0, parties, removed };
}
function oldMergeSavedParties(local, incoming) {
    const now = Date.now();
    const a = oldNormalizeSavedParties(local, now);
    const b = oldNormalizeSavedParties(incoming, now);
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
        40
    );
    return { savedAt: Math.max(a.savedAt, b.savedAt), parties, removed };
}

function dto(magic = 100) {
    return {
        hrid: 'player3',
        debuffOnLevelGap: 0.12,
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel: magic,
        equipment: { '/equipment_types/main_hand': { hrid: '/items/rippling_trident', enhancementLevel: 10 } },
        food: [{ itemHrid: '/items/spaceberry_cake' }, null, null],
        drinks: [null, null, null],
        abilities: [{ abilityHrid: '/abilities/mystic_aura', level: 30 }, null, null, null, null],
        houseRooms: { '/house_rooms/archery_range': 4 },
    };
}

// Five players, two of them named alike, with different builds
const five = () => [
    { name: 'Me', dto: dto(150), gameMode: 'standard' },
    { name: 'Ann', dto: dto(101) },
    { name: 'Ann', dto: dto(102) },
    { name: 'Bo', dto: dto(103) },
    { name: 'Cy', dto: dto(104) },
];

beforeEach(() => {
    db.values = new Map();
    db.failNext = false;
    db.writes = [];
});

describe('saving a roster', () => {
    test('five players, same-named ones too, come back in order with their builds', async () => {
        const result = await saveRoster('  Full   crew ', five());
        expect(result).toMatchObject({ ok: true, name: 'Full crew', duplicate: false, skipped: [] });
        const [roster] = (await loadSavedRosters()).parties;
        expect(roster.members.map((m) => [m.name, m.dto.magicLevel])).toEqual([
            ['Me', 150],
            ['Ann', 101],
            ['Ann', 102],
            ['Bo', 103],
            ['Cy', 104],
        ]);
        expect(roster.members[0].gameMode).toBe('standard');
        // The per-party fields go (the slot, the level-gap debuff the editor recomputes); the build stays
        expect(roster.members[1].dto.hrid).toBeUndefined();
        expect(roster.members[1].dto.debuffOnLevelGap).toBeUndefined();
        expect(roster.members[1].dto.food[0]).toEqual({ itemHrid: '/items/spaceberry_cake' });
        expect(usableMembers(roster).members).toHaveLength(MAX_ROSTER_PLAYERS);
    });

    test('a single player is a roster too', async () => {
        expect((await saveRoster('Solo', [{ name: 'Me', dto: dto() }])).ok).toBe(true);
        expect((await loadSavedRosters()).parties[0].members).toHaveLength(1);
    });

    test('six players, an empty name, or nobody with a build: refused and nothing is written', async () => {
        const six = [...five(), { name: 'Dee', dto: dto() }];
        expect(await saveRoster('Too many', six)).toMatchObject({
            ok: false,
            reason: 'a party holds at most 5 players',
        });
        expect(await saveRoster('   ', five())).toMatchObject({ ok: false, reason: 'give the party a name' });
        const none = await saveRoster('None', [{ name: 'Ghost', dto: { equipment: {} } }]);
        expect(none).toMatchObject({ ok: false, reason: 'no player has a build that can be saved' });
        expect(none.skipped.map((s) => s.name)).toEqual(['Ghost']);
        expect(await saveRoster('Empty', [])).toMatchObject({ ok: false });
        expect(db.writes).toEqual([]);
    });

    test('a player with a bad build is left out and named; the rest are saved', async () => {
        const result = await saveRoster('Most', [...five().slice(0, 4), { name: 'Ghost', dto: { equipment: {} } }]);
        expect(result.ok).toBe(true);
        expect(result.skipped.map((s) => s.name)).toEqual(['Ghost']);
        expect((await loadSavedRosters()).parties[0].members.map((m) => m.name)).toEqual(['Me', 'Ann', 'Ann', 'Bo']);
    });

    test('a repeated name is allowed and says so', async () => {
        await saveRoster('Crew', five());
        const again = await saveRoster('crew', five());
        expect(again).toMatchObject({ ok: true, duplicate: true });
        expect((await loadSavedRosters()).parties).toHaveLength(2);
    });

    test('the cap refuses with a reason and keeps what is saved', async () => {
        for (let i = 0; i < MAX_SAVED_ROSTERS; i++) await saveRoster(`R${i}`, [{ name: 'Me', dto: dto() }]);
        const over = await saveRoster('One more', five());
        expect(over).toMatchObject({ ok: false, reason: `at most ${MAX_SAVED_ROSTERS} parties can be saved here` });
        expect((await loadSavedRosters()).parties).toHaveLength(MAX_SAVED_ROSTERS);
    });

    test('a failed write says not ok and leaves what was stored', async () => {
        await saveRoster('Kept', five());
        db.failNext = true;
        const result = await saveRoster('Lost', five());
        expect(result).toMatchObject({ ok: false, id: null });
        expect((await loadSavedRosters()).parties.map((p) => p.name)).toEqual(['Kept']);
    });

    test('rename and delete; the delete leaves a tombstone a stale copy cannot get past', async () => {
        const { id } = await saveRoster('Crew', five());
        const stale = structuredClone(db.values.get(SAVED_ROSTERS_KEY));
        expect((await renameRoster(id, 'Raid crew')).ok).toBe(true);
        expect((await loadSavedRosters()).parties[0].name).toBe('Raid crew');
        expect(await removeRoster(id)).toMatchObject({ ok: true, found: true });
        expect(await removeRoster(id)).toMatchObject({ found: false });
        const folded = mergeSavedRosters(db.values.get(SAVED_ROSTERS_KEY), stale);
        expect(folded.parties).toEqual([]);
        expect(folded.removed[id]).toBeGreaterThan(0);
    });
});

describe('the parties record the Party tab keeps', () => {
    test('roster saves, renames and deletes never write it, and leave it exactly as it was', async () => {
        await saveParty('Party tab crew', [
            { name: 'Ann', dto: dto() },
            { name: 'Bo', dto: dto() },
        ]);
        const before = structuredClone(db.values.get(SAVED_PARTIES_KEY));
        db.writes = [];
        const { id } = await saveRoster('Crew', five());
        await renameRoster(id, 'New');
        await saveRoster('Other', five());
        await removeRoster(id);
        expect(db.writes.every((key) => key === SAVED_ROSTERS_KEY)).toBe(true);
        expect(db.values.get(SAVED_PARTIES_KEY)).toEqual(before);
        expect((await loadSavedParties()).parties.map((p) => p.name)).toEqual(['Party tab crew']);
    });

    test('an older build (3.84.0) reads and folds the parties record exactly as this one does', async () => {
        await saveParty('Two', [
            { name: 'Ann', dto: dto() },
            { name: 'Ann', dto: dto(101) },
        ]);
        await saveParty(
            'Four',
            [1, 2, 3, 4].map((n) => ({ name: `M${n}`, dto: dto(100 + n), choice: 'try' }))
        );
        await saveRoster('Roster', five());
        const stored = db.values.get(SAVED_PARTIES_KEY);
        const now = Date.now();
        // Every existing party, whole, on the older build
        expect(oldNormalizeSavedParties(stored, now)).toEqual(normalizeSavedParties(stored, now));
        expect(oldNormalizeSavedParties(stored, now).parties.map((p) => [p.name, p.members.length])).toEqual([
            ['Two', 2],
            ['Four', 4],
        ]);
        // An older device folding this one's copy (and the other way round) keeps both parties and agrees on them
        const theirs = { savedAt: 1, parties: [], removed: {} };
        expect(oldMergeSavedParties(theirs, stored).parties).toEqual(mergeSavedParties(theirs, stored).parties);
        expect(oldMergeSavedParties(stored, theirs).parties).toHaveLength(2);
        // The rosters sit in a key the older build has no reader for
        expect(Object.keys(stored)).toEqual(['savedAt', 'parties', 'removed']);
    });

    test('why rosters have their own key: the older read cuts a five-player record to four', () => {
        const record = {
            savedAt: 1,
            parties: [{ id: 'sp-x', name: 'Crew', kind: 'roster', members: five(), addedAt: 1, updatedAt: 1 }],
            removed: {},
        };
        const read = oldNormalizeSavedParties(record);
        expect(read.parties[0].members).toHaveLength(4);
        expect(read.parties[0].kind).toBeUndefined();
        // The roster read keeps all five
        expect(normalizeSavedRosters(record).parties[0].members).toHaveLength(5);
    });

    test('the parties read still stops at four members a party, as before', () => {
        const record = { parties: [{ id: 'sp-x', name: 'P', members: five(), updatedAt: 1 }] };
        expect(normalizeSavedParties(record).parties[0].members).toHaveLength(4);
    });
});

describe('sync', () => {
    test('each key folds with its own merge, both live-safe; the rosters key is not taken for the parties one', () => {
        const record = { savedAt: 1, parties: [{ id: 'x', name: 'X', members: five(), updatedAt: 1 }], removed: {} };
        const empty = { savedAt: 0, parties: [], removed: {} };
        expect(mergeForKey('settings', SAVED_ROSTERS_KEY).merge(empty, record).parties[0].members).toHaveLength(5);
        expect(mergeForKey('settings', SAVED_PARTIES_KEY).merge(empty, record).parties[0].members).toHaveLength(4);
        expect(mergeForKey('settings', SAVED_ROSTERS_KEY).label).toBe('Combat Sim saved rosters');
        expect(isLiveSafeKey('settings', SAVED_ROSTERS_KEY)).toBe(true);
    });

    test('two devices each save one: both kept either way round, five players each', () => {
        const a = {
            savedAt: 10,
            parties: [{ id: 'sr-a', name: 'A', members: five(), addedAt: 10, updatedAt: 10 }],
            removed: {},
        };
        const b = {
            savedAt: 20,
            parties: [{ id: 'sr-b', name: 'B', members: five(), addedAt: 20, updatedAt: 20 }],
            removed: {},
        };
        for (const folded of [mergeSavedRosters(a, b), mergeSavedRosters(b, a)]) {
            expect(folded.parties.map((p) => p.id).sort()).toEqual(['sr-a', 'sr-b']);
            expect(folded.parties.every((p) => p.members.length === 5)).toBe(true);
        }
    });

    test('a later edit of one roster wins; an old tombstone is forgotten', () => {
        const old = { parties: [{ id: 'sr-a', name: 'Old', members: five(), updatedAt: 10 }] };
        const renamed = { parties: [{ id: 'sr-a', name: 'New', members: five(), updatedAt: 20 }] };
        expect(mergeSavedRosters(renamed, old).parties[0].name).toBe('New');
        const ancient = { parties: [], removed: { 'sr-z': Date.now() - TOMBSTONE_MAX_AGE_MS - 1000 } };
        expect(mergeSavedRosters(ancient, { parties: [] }).removed).toEqual({});
    });
});
