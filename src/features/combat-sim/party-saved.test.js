/**
 * Saved parties: the record is its own key (so an older build, which normalizes the roster record down to the fields
 * it knows, cannot drop it), every change is a read-merge-write, and a sync fold keeps what both devices added.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ value: undefined, failNext: false, keys: [] }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => (db.value === undefined ? fallback : structuredClone(db.value)),
        update: async (key, mutate) => {
            db.keys.push(key);
            if (db.failNext) {
                db.failNext = false;
                return null;
            }
            const next = mutate(db.value === undefined ? undefined : structuredClone(db.value));
            if (next === undefined) return { written: false, value: db.value };
            db.value = structuredClone(next);
            return { written: true, value: structuredClone(next) };
        },
    },
}));

const {
    SAVED_PARTIES_KEY,
    MAX_SAVED_PARTIES,
    MAX_PARTY_MEMBERS,
    saveParty,
    renameParty,
    removeParty,
    loadSavedParties,
    normalizeSavedParties,
    mergeSavedParties,
    usableMembers,
    evictedPartiesByCap,
} = await import('./party-saved.js');
const { normalizeRoster, PARTY_ROSTER_KEY, TOMBSTONE_MAX_AGE_MS } = await import('./party-roster.js');
const { isLiveSafeKey, mergeForKey } = await import('../../utils/sync-merge-registry.js');

function dto(magic = 100) {
    return {
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel: magic,
        equipment: { '/equipment_types/main_hand': { hrid: '/items/rippling_trident', enhancementLevel: 10 } },
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null, null],
        houseRooms: {},
    };
}

const member = (name, extra = {}) => ({ name, dto: dto(), ...extra });

beforeEach(() => {
    db.value = undefined;
    db.failNext = false;
    db.keys = [];
});

describe('saving, renaming, deleting', () => {
    test('a party keeps its members with their pick and aura options', async () => {
        const result = await saveParty('  Dungeon   crew ', [
            member('Ann', {
                choice: 'try',
                auras: [{ hrid: '/abilities/mystic_aura', level: 30 }],
                includeAsBuilt: false,
            }),
            member('Bo'),
        ]);
        expect(result).toMatchObject({ ok: true, name: 'Dungeon crew', duplicate: false });
        const [party] = (await loadSavedParties()).parties;
        expect(party.members.map((m) => [m.name, m.choice])).toEqual([
            ['Ann', 'try'],
            ['Bo', 'always'],
        ]);
        expect(party.members[0].auras).toEqual([{ hrid: '/abilities/mystic_aura', level: 30 }]);
        expect(party.members[0].includeAsBuilt).toBe(false);
        // Written to its own key, never the roster's
        expect(db.keys).toEqual([SAVED_PARTIES_KEY]);
    });

    test('an empty name is refused and nothing is written', async () => {
        const result = await saveParty('   ', [member('Ann')]);
        expect(result).toMatchObject({ ok: false, reason: 'give the party a name' });
        expect(db.value).toBeUndefined();
    });

    test('nobody saveable is refused; a member with a bad build is skipped, never saved blank', async () => {
        const bad = { name: 'Broken', dto: { equipment: {} } };
        const refused = await saveParty('Crew', [bad]);
        expect(refused.ok).toBe(false);
        expect(refused.skipped.map((s) => s.name)).toEqual(['Broken']);
        const partial = await saveParty('Crew', [member('Ann'), bad]);
        expect(partial.ok).toBe(true);
        expect(partial.skipped.map((s) => s.name)).toEqual(['Broken']);
        expect(db.value.parties[0].members.map((m) => m.name)).toEqual(['Ann']);
    });

    test('more than four members is refused', async () => {
        const five = Array.from({ length: MAX_PARTY_MEMBERS + 1 }, (_, i) => member(`P${i}`));
        const result = await saveParty('Too many', five);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/at most 4/);
    });

    test('a repeated name is allowed and says so', async () => {
        await saveParty('Crew', [member('Ann')]);
        const second = await saveParty('crew', [member('Bo')]);
        expect(second).toMatchObject({ ok: true, duplicate: true });
        expect((await loadSavedParties()).parties).toHaveLength(2);
    });

    test('the cap refuses with a clear reason and keeps what is saved', async () => {
        db.value = {
            savedAt: 1,
            removed: {},
            parties: Array.from({ length: MAX_SAVED_PARTIES }, (_, i) => ({
                id: `sp-${i}`,
                name: `P${i}`,
                members: [member('Ann')],
                addedAt: 1,
                updatedAt: 1,
            })),
        };
        const result = await saveParty('One more', [member('Bo')]);
        expect(result).toMatchObject({ ok: false, reason: `at most ${MAX_SAVED_PARTIES} parties can be saved` });
        expect(db.value.parties).toHaveLength(MAX_SAVED_PARTIES);
    });

    test('a failed write says not ok and the list on disk is untouched', async () => {
        await saveParty('Crew', [member('Ann')]);
        db.failNext = true;
        const result = await saveParty('Other', [member('Bo')]);
        expect(result.ok).toBe(false);
        expect(db.value.parties.map((p) => p.name)).toEqual(['Crew']);
    });

    test('a rename on a device whose clock is behind still stamps later than the stored copy', async () => {
        const ahead = Date.now() + 10 * 60 * 1000;
        db.value = {
            savedAt: 1,
            removed: {},
            parties: [{ id: 'sp-1', name: 'Crew', members: [member('Ann')], addedAt: 1, updatedAt: ahead }],
        };
        await renameParty('sp-1', 'Raid');
        expect(db.value.parties[0].updatedAt).toBe(ahead + 1);
    });

    test('rename keeps the members; delete leaves a tombstone', async () => {
        const { id } = await saveParty('Crew', [member('Ann')]);
        const renamed = await renameParty(id, 'Raid');
        expect(renamed).toMatchObject({ ok: true, found: true });
        expect(db.value.parties[0]).toMatchObject({ name: 'Raid' });
        expect(db.value.parties[0].members).toHaveLength(1);
        expect((await renameParty('nope', 'x')).found).toBe(false);
        const removed = await removeParty(id);
        expect(removed).toMatchObject({ ok: true, found: true });
        expect(db.value.parties).toEqual([]);
        expect(db.value.removed[id]).toBeGreaterThan(0);
    });
});

describe('old-record compatibility and rollback', () => {
    test('the roster record is untouched by saved parties, and an older roster reader ignores the new key', async () => {
        expect(SAVED_PARTIES_KEY).not.toBe(PARTY_ROSTER_KEY);
        expect(SAVED_PARTIES_KEY.startsWith('combatSim')).toBe(true);
        // What an older build does with a roster record: normalize to the fields it knows. A roster with no
        // parties field reads exactly as before
        const roster = normalizeRoster({ savedAt: 3, entries: [], builds: [], removed: {} });
        expect(Object.keys(roster).sort()).toEqual(['builds', 'entries', 'removed', 'savedAt']);
    });

    test('a record with unknown or missing fields reads as parties, a malformed one as none', () => {
        expect(normalizeSavedParties(null).parties).toEqual([]);
        expect(normalizeSavedParties({ parties: 'x' }).parties).toEqual([]);
        const read = normalizeSavedParties({
            parties: [
                { id: 'sp-1', name: 'A', members: [{ name: 'Ann', dto: dto() }], futureField: 1 },
                { id: '' },
                null,
            ],
        });
        expect(read.parties.map((p) => p.id)).toEqual(['sp-1']);
        expect(read.parties[0].members[0].choice).toBe('always');
    });

    test('a member whose build the engine cannot run is kept in the record and left out where it is used', async () => {
        db.value = {
            savedAt: 1,
            removed: {},
            parties: [
                {
                    id: 'sp-1',
                    name: 'Crew',
                    members: [member('Ann'), { name: 'Odd', dto: { equipment: {} } }],
                    addedAt: 1,
                    updatedAt: 1,
                },
            ],
        };
        const [party] = (await loadSavedParties()).parties;
        expect(party.members.map((m) => m.name)).toEqual(['Ann', 'Odd']);
        const { members, skipped } = usableMembers(party);
        expect(members.map((m) => m.name)).toEqual(['Ann']);
        expect(skipped).toEqual(['Odd']);
        // A write of another party does not lose the odd member
        await saveParty('Other', [member('Bo')]);
        expect(db.value.parties.find((p) => p.id === 'sp-1').members.map((m) => m.name)).toEqual(['Ann', 'Odd']);
    });
});

describe('sync fold', () => {
    const party = (id, name, updatedAt, members = [member('Ann')]) => ({ id, name, members, addedAt: 1, updatedAt });
    const record = (parties, removed = {}, savedAt = 1) => ({ savedAt, parties, removed });

    test('is registered live-safe', () => {
        expect(isLiveSafeKey('settings', SAVED_PARTIES_KEY)).toBe(true);
        expect(mergeForKey('settings', SAVED_PARTIES_KEY).merge).toBeTypeOf('function');
    });

    test('two devices each add one: both are kept, either way round', () => {
        const a = record([party('sp-a', 'A', 10)]);
        const b = record([party('sp-b', 'B', 20)]);
        expect(
            mergeSavedParties(a, b)
                .parties.map((p) => p.id)
                .sort()
        ).toEqual(['sp-a', 'sp-b']);
        expect(
            mergeSavedParties(b, a)
                .parties.map((p) => p.id)
                .sort()
        ).toEqual(['sp-a', 'sp-b']);
    });

    test('the later edit of one party wins', () => {
        const merged = mergeSavedParties(record([party('sp-a', 'Old', 10)]), record([party('sp-a', 'New', 20)]));
        expect(merged.parties.map((p) => p.name)).toEqual(['New']);
        const other = mergeSavedParties(record([party('sp-a', 'New', 20)]), record([party('sp-a', 'Old', 10)]));
        expect(other.parties.map((p) => p.name)).toEqual(['New']);
    });

    test('a delete beats an older copy and a newer edit beats the delete', () => {
        const now = Date.now();
        const deleted = record([], { 'sp-a': now }, 5);
        const stale = record([party('sp-a', 'A', now - 1000)]);
        expect(mergeSavedParties(stale, deleted).parties).toEqual([]);
        expect(mergeSavedParties(deleted, stale).parties).toEqual([]);
        const edited = record([party('sp-a', 'A', now + 1000)]);
        expect(mergeSavedParties(deleted, edited).parties.map((p) => p.id)).toEqual(['sp-a']);
    });

    test('old tombstones are forgotten', () => {
        const old = Date.now() - TOMBSTONE_MAX_AGE_MS - 1000;
        expect(mergeSavedParties(record([], { 'sp-a': old }), record([])).removed).toEqual({});
    });

    test('two full devices keep the same most recent ones, and the evicted are named', () => {
        const mk = (prefix, base) =>
            record(
                Array.from({ length: MAX_SAVED_PARTIES }, (_, i) => party(`${prefix}${i}`, `${prefix}${i}`, base + i))
            );
        const a = mk('a', 1000);
        const b = mk('b', 100000);
        const ab = mergeSavedParties(a, b);
        const ba = mergeSavedParties(b, a);
        expect(ab.parties).toHaveLength(MAX_SAVED_PARTIES);
        expect(ab.parties.map((p) => p.id).sort()).toEqual(ba.parties.map((p) => p.id).sort());
        expect(evictedPartiesByCap(a, ab)).toHaveLength(MAX_SAVED_PARTIES);
    });
});
