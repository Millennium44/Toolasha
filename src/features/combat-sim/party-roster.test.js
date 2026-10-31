/**
 * The Party Finder roster: what it keeps of a build, how it refuses bad ones, and that every change is a
 * read-merge-write that never loses another tab's entry.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({ value: undefined, failNext: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => (db.value === undefined ? fallback : structuredClone(db.value)),
        update: async (_key, mutate) => {
            if (db.failNext) {
                db.failNext = false;
                return null;
            }
            const next = mutate(db.value === undefined ? undefined : structuredClone(db.value), db.value !== undefined);
            if (next === undefined) return { written: false, value: db.value };
            db.value = structuredClone(next);
            return { written: true, value: structuredClone(next) };
        },
    },
}));

const {
    PARTY_ROSTER_KEY,
    MAX_ROSTER_SIZE,
    MAX_SAVED_BUILDS,
    saveBuild,
    renameBuild,
    removeBuild,
    uniqueBuildName,
    addTeammates,
    renameTeammate,
    removeTeammate,
    replaceTeammateBuild,
    loadRoster,
    normalizeRoster,
    validateTeammateDTO,
    buildFingerprint,
    setTeammateAuras,
    normalizeAuraOptions,
    MAX_AURA_OPTIONS,
    TOMBSTONE_MAX_AGE_MS,
    mergeRoster,
} = await import('./party-roster.js');
const { isLiveSafeKey, mergeForKey } = await import('../../utils/sync-merge-registry.js');

/** A build in the shape `buildPlayerDTO` produces */
function dto(overrides = {}) {
    return {
        hrid: 'player2',
        debuffOnLevelGap: 0.1,
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel: 95,
        equipment: {
            '/equipment_types/main_hand': { hrid: '/items/rippling_trident', enhancementLevel: 10 },
            '/equipment_types/body': { hrid: '/items/royal_water_robe_top', enhancementLevel: 5 },
        },
        food: [{ hrid: '/items/star_fruit_yogurt', triggers: null }, null, null],
        drinks: [{ hrid: '/items/super_magic_coffee', triggers: null }, null, null],
        abilities: [null, { hrid: '/abilities/water_strike', level: 50, triggers: null }, null, null, null],
        houseRooms: {},
        taskMonsterHrids: ['/monsters/jerry'],
        taskMonsterRemaining: { '/monsters/jerry': 10 },
        ...overrides,
    };
}

beforeEach(() => {
    db.value = undefined;
    db.failNext = false;
});

describe('validateTeammateDTO', () => {
    test('accepts a real build and refuses what the engine cannot run', () => {
        expect(validateTeammateDTO(dto()).ok).toBe(true);
        expect(validateTeammateDTO(null).ok).toBe(false);
        expect(validateTeammateDTO({ ...dto(), equipment: null }).ok).toBe(false);
        expect(validateTeammateDTO({ ...dto(), magicLevel: undefined }).reason).toMatch(/magic/);
        expect(validateTeammateDTO({ ...dto(), food: 'x' }).ok).toBe(false);
    });
});

describe('adding teammates', () => {
    test('keeps the build without its slot, party level gap or your task board', async () => {
        const result = await addTeammates([{ name: '  Fire   Mage ', dto: dto(), source: 'import' }]);
        expect(result.ok).toBe(true);
        expect(result.added).toHaveLength(1);
        const [entry] = (await loadRoster()).entries;
        expect(entry.name).toBe('Fire Mage');
        expect(entry.source).toBe('import');
        expect(entry.dto.hrid).toBeUndefined();
        expect(entry.dto.debuffOnLevelGap).toBeUndefined();
        expect(entry.dto.taskMonsterHrids).toBeUndefined();
        expect(entry.dto.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(10);
    });

    test('two teammates with the same name stay two entries with their own ids', async () => {
        await addTeammates([
            { name: 'Bob', dto: dto() },
            { name: 'Bob', dto: dto({ magicLevel: 100 }) },
        ]);
        const { entries } = await loadRoster();
        expect(entries.map((e) => e.name)).toEqual(['Bob', 'Bob']);
        expect(new Set(entries.map((e) => e.id)).size).toBe(2);
    });

    test('refuses a broken build by name and keeps the good ones', async () => {
        const result = await addTeammates([
            { name: 'Good', dto: dto() },
            { name: 'Broken', dto: { equipment: {} } },
        ]);
        expect(result.added).toHaveLength(1);
        expect(result.rejected).toEqual([{ name: 'Broken', reason: expect.any(String) }]);
    });

    test('nothing valid: nothing written, every rejection reported', async () => {
        const result = await addTeammates([{ name: 'Broken', dto: 7 }]);
        expect(result.added).toEqual([]);
        expect(result.rejected).toHaveLength(1);
        expect(db.value).toBeUndefined();
    });

    test(`stops at ${MAX_ROSTER_SIZE} and says why`, async () => {
        const many = Array.from({ length: MAX_ROSTER_SIZE + 2 }, (_, i) => ({ name: `T${i}`, dto: dto() }));
        const result = await addTeammates(many);
        expect(result.added).toHaveLength(MAX_ROSTER_SIZE);
        expect(result.rejected).toHaveLength(2);
        expect(result.rejected[0].reason).toMatch(String(MAX_ROSTER_SIZE));
    });

    test('a failed write reports not-ok and adds nothing', async () => {
        db.failNext = true;
        const result = await addTeammates([{ name: 'A', dto: dto() }]);
        expect(result.ok).toBe(false);
        expect(result.added).toEqual([]);
        expect((await loadRoster()).entries).toEqual([]);
    });

    test('lands on top of an entry another tab wrote in the meantime', async () => {
        await addTeammates([{ name: 'Mine', dto: dto() }]);
        // Another tab appends directly to storage
        db.value.entries.push({ ...db.value.entries[0], id: 'other-tab', name: 'Theirs' });
        await addTeammates([{ name: 'Mine too', dto: dto() }]);
        expect((await loadRoster()).entries.map((e) => e.name)).toEqual(['Mine', 'Theirs', 'Mine too']);
    });

    test('every save stamps a savedAt later than the stored one', async () => {
        db.value = { savedAt: Date.now() + 60_000, entries: [] };
        const before = db.value.savedAt;
        await addTeammates([{ name: 'A', dto: dto() }]);
        expect(db.value.savedAt).toBeGreaterThan(before);
    });
});

describe('editing teammates', () => {
    test('rename, replace build and remove act on the id, not the name', async () => {
        const { added } = await addTeammates([
            { name: 'Bob', dto: dto() },
            { name: 'Bob', dto: dto() },
        ]);
        await renameTeammate(added[1], 'Bob (tank)');
        await replaceTeammateBuild(added[0], dto({ magicLevel: 120 }));
        let { entries } = await loadRoster();
        expect(entries.map((e) => e.name)).toEqual(['Bob', 'Bob (tank)']);
        expect(entries[0].dto.magicLevel).toBe(120);
        expect(entries[1].dto.magicLevel).toBe(95);

        const removed = await removeTeammate(added[0]);
        expect(removed.found).toBe(true);
        ({ entries } = await loadRoster());
        expect(entries.map((e) => e.name)).toEqual(['Bob (tank)']);
    });

    test('an unknown id or a blank name changes nothing', async () => {
        const { added } = await addTeammates([{ name: 'Bob', dto: dto() }]);
        const before = structuredClone(db.value);
        expect((await renameTeammate('nope', 'X')).found).toBe(false);
        await renameTeammate(added[0], '   ');
        expect((await removeTeammate('nope')).found).toBe(false);
        expect(db.value).toEqual(before);
    });

    test('replacing with a broken build is refused', async () => {
        const { added } = await addTeammates([{ name: 'Bob', dto: dto() }]);
        const result = await replaceTeammateBuild(added[0], { equipment: {} });
        expect(result.ok).toBe(false);
        expect((await loadRoster()).entries[0].dto.magicLevel).toBe(95);
    });
});

describe('normalizeRoster', () => {
    test('drops malformed, duplicate-id and invalid entries rather than reaching the sweep', () => {
        const good = { id: 'a', name: 'A', dto: dto() };
        const roster = normalizeRoster({
            savedAt: 5,
            entries: [good, { ...good }, { id: 'b', name: 'B', dto: {} }, null, { name: 'no id', dto: dto() }],
        });
        expect(roster.entries.map((e) => e.id)).toEqual(['a']);
        expect(normalizeRoster('junk')).toEqual({ savedAt: 0, entries: [], builds: [], removed: {} });
    });
});

describe('buildFingerprint', () => {
    test('the same build from two slots or parties is one fingerprint; a different level is not', () => {
        expect(buildFingerprint(dto({ hrid: 'player1', debuffOnLevelGap: 0 }))).toBe(
            buildFingerprint(dto({ hrid: 'player3', debuffOnLevelGap: 0.2 }))
        );
        expect(buildFingerprint(dto())).not.toBe(buildFingerprint(dto({ magicLevel: 96 })));
    });
});

describe('sync: merged per teammate, deletions remembered', () => {
    const NOW = Date.now();
    const e = (id, name, updatedAt, extra = {}) => ({
        id,
        name,
        dto: dto(),
        source: 'editor',
        addedAt: 1,
        updatedAt,
        auras: [],
        includeAsBuilt: true,
        ...extra,
    });
    const merge = (local, incoming) => mergeForKey('settings', PARTY_ROSTER_KEY).merge(local, incoming);

    test('the roster key is live-safe', () => {
        expect(isLiveSafeKey('settings', PARTY_ROSTER_KEY)).toBe(true);
    });

    test('two devices that each added a teammate keep both', () => {
        const mine = { savedAt: NOW, entries: [e('a', 'Ann', NOW)], removed: {} };
        const theirs = { savedAt: NOW - 5, entries: [e('b', 'Bob', NOW - 5)], removed: {} };
        expect(merge(mine, theirs).entries.map((x) => x.name)).toEqual(['Ann', 'Bob']);
        expect(merge(theirs, mine).entries.map((x) => x.name)).toEqual(['Bob', 'Ann']);
    });

    test('one renames, the other edits auras: the later change to that teammate wins, the rest of each kept', () => {
        // The renaming device saved last (it also added Bob), but its change to Ann is the older one
        const renamed = { savedAt: NOW, entries: [e('a', 'Ann (tank)', NOW - 10), e('b', 'Bob', NOW)], removed: {} };
        const auras = [{ hrid: '/abilities/fierce_aura', level: 20 }];
        const edited = { savedAt: NOW - 5, entries: [e('a', 'Ann', NOW - 5, { auras })], removed: {} };
        for (const merged of [merge(renamed, edited), merge(edited, renamed)]) {
            const ann = merged.entries.find((x) => x.id === 'a');
            expect(ann.auras).toEqual(auras);
            expect(merged.entries.map((x) => x.id).sort()).toEqual(['a', 'b']);
        }
    });

    test('a teammate deleted on one device does not come back from the other device’s stale copy', () => {
        // The stale device saved later (it added Cy), still holding Ann as she was before the delete
        const stale = {
            savedAt: NOW,
            entries: [e('a', 'Ann', NOW - 100), e('b', 'Bob', NOW - 100), e('c', 'Cy', NOW)],
        };
        const deleted = { savedAt: NOW - 50, entries: [e('b', 'Bob', NOW - 100)], removed: { a: NOW - 50 } };
        for (const merged of [merge(stale, deleted), merge(deleted, stale)]) {
            expect(merged.entries.map((x) => x.id).sort()).toEqual(['b', 'c']);
            expect(merged.removed.a).toBe(NOW - 50);
        }
    });

    test('a teammate changed after the deletion is kept', () => {
        const deleted = { savedAt: NOW - 50, entries: [], removed: { a: NOW - 50 } };
        const edited = { savedAt: NOW, entries: [e('a', 'Ann', NOW)] };
        expect(merge(deleted, edited).entries.map((x) => x.id)).toEqual(['a']);
    });

    test(`tombstones older than ${TOMBSTONE_MAX_AGE_MS / 86400000} days are forgotten`, () => {
        const old = NOW - TOMBSTONE_MAX_AGE_MS - 1000;
        const merged = merge({ savedAt: 1, entries: [], removed: { a: old, b: NOW } }, { savedAt: 1, entries: [] });
        expect(Object.keys(merged.removed)).toEqual(['b']);
    });

    test('the cap applies to the teammates left, not to the deleted ones', () => {
        const many = Array.from({ length: MAX_ROSTER_SIZE }, (_, i) => e(`m${i}`, `M${i}`, NOW - 100));
        const local = { savedAt: NOW, entries: many.slice(1), removed: { m0: NOW } };
        // The other device never saw the deletion and has room for one more of its own
        const incoming = { savedAt: NOW, entries: [...many.slice(0, MAX_ROSTER_SIZE - 1), e('new', 'New', NOW)] };
        const merged = merge(local, incoming);
        expect(merged.entries).toHaveLength(MAX_ROSTER_SIZE);
        expect(merged.entries.some((x) => x.id === 'm0')).toBe(false);
        expect(merged.entries.some((x) => x.id === 'new')).toBe(true);
    });

    test('deleting here leaves a tombstone in storage', async () => {
        const { added } = await addTeammates([{ name: 'Ann', dto: dto() }]);
        await removeTeammate(added[0]);
        expect(db.value.removed[added[0]]).toBeGreaterThan(0);
        expect((await loadRoster()).entries).toEqual([]);
    });
});

describe('aura options on a teammate', () => {
    test('new teammates start with none, tried as built', async () => {
        await addTeammates([{ name: 'Ann', dto: dto() }]);
        const [entry] = (await loadRoster()).entries;
        expect(entry.auras).toEqual([]);
        expect(entry.includeAsBuilt).toBe(true);
    });

    test('saved with the entry, one per aura, whole levels of at least 1', async () => {
        const { added } = await addTeammates([{ name: 'Ann', dto: dto() }]);
        await setTeammateAuras(
            added[0],
            [
                { hrid: '/abilities/fierce_aura', level: 20 },
                { hrid: '/abilities/fierce_aura', level: 25.7 },
                { hrid: '/abilities/mystic_aura', level: 0 },
                { hrid: 'not-an-ability', level: 5 },
            ],
            false
        );
        const [entry] = (await loadRoster()).entries;
        expect(entry.auras).toEqual([{ hrid: '/abilities/fierce_aura', level: 25 }]);
        expect(entry.includeAsBuilt).toBe(false);
    });

    test(`at most ${MAX_AURA_OPTIONS}, and an unknown teammate changes nothing`, async () => {
        const { added } = await addTeammates([{ name: 'Ann', dto: dto() }]);
        const many = Array.from({ length: MAX_AURA_OPTIONS + 3 }, (_, i) => ({ hrid: `/abilities/a${i}`, level: 1 }));
        await setTeammateAuras(added[0], many, true);
        expect((await loadRoster()).entries[0].auras).toHaveLength(MAX_AURA_OPTIONS);
        expect(normalizeAuraOptions('junk')).toEqual([]);
        expect((await setTeammateAuras('nope', [], true)).found).toBe(false);
    });
});

describe('a build missing the lists the engine reads', () => {
    test('is saved with the empty shapes the adapter starts from', async () => {
        const bare = dto();
        delete bare.food;
        delete bare.drinks;
        delete bare.abilities;
        delete bare.houseRooms;
        const result = await addTeammates([{ name: 'Bare', dto: bare }]);
        expect(result.added).toHaveLength(1);
        const [entry] = (await loadRoster()).entries;
        expect(entry.dto.food).toEqual([null, null, null]);
        expect(entry.dto.drinks).toEqual([null, null, null]);
        expect(entry.dto.abilities).toEqual([null, null, null, null, null]);
        expect(entry.dto.houseRooms).toEqual({});
    });

    test('one stored that way is filled in when read', async () => {
        const bare = dto();
        delete bare.abilities;
        delete bare.houseRooms;
        db.value = { savedAt: 1, entries: [{ id: 'x', name: 'Old', dto: bare, updatedAt: 1 }] };
        const [entry] = (await loadRoster()).entries;
        expect(entry.dto.abilities).toHaveLength(5);
        expect(entry.dto.houseRooms).toEqual({});
    });

    test('house rooms that are not a map are refused with a reason', () => {
        expect(validateTeammateDTO({ ...dto(), houseRooms: [] })).toEqual({ ok: false, reason: 'bad house rooms' });
    });
});

describe('teammate game mode', () => {
    test('the mode given at save time is kept; an older entry without one reads as unknown', async () => {
        const { roster } = await addTeammates([
            { name: 'Cow', dto: dto(), gameMode: 'ironcow' },
            { name: 'Plain', dto: dto() },
        ]);
        expect(roster.entries.map((e) => e.gameMode)).toEqual(['ironcow', null]);
        const old = normalizeRoster({ entries: [{ id: 'x', name: 'Old', dto: dto(), updatedAt: 1 }] });
        expect(old.entries[0].gameMode).toBeNull();
    });

    test('a build that carries its own mode supplies it', async () => {
        const { roster } = await addTeammates([{ name: 'Cow', dto: dto({ gameMode: 'legacy_ironcow' }) }]);
        expect(roster.entries[0].gameMode).toBe('legacy_ironcow');
    });

    test('replacing a build keeps the saved mode unless the new one says otherwise', async () => {
        const { roster } = await addTeammates([{ name: 'Cow', dto: dto(), gameMode: 'ironcow' }]);
        const id = roster.entries[0].id;
        expect((await replaceTeammateBuild(id, dto())).roster.entries[0].gameMode).toBe('ironcow');
        expect((await replaceTeammateBuild(id, dto(), 'standard')).roster.entries[0].gameMode).toBe('standard');
    });

    test('the mode survives a cross-device merge, whichever copy wins', () => {
        const entry = (over) => ({ id: 'a', name: 'A', dto: dto(), addedAt: 1, updatedAt: 1, ...over });
        const local = { savedAt: 1, entries: [entry({ gameMode: 'ironcow', updatedAt: 5 })] };
        const incoming = {
            savedAt: 2,
            entries: [entry({ gameMode: 'standard', updatedAt: 9 }), entry({ id: 'b', gameMode: 'ironcow' })],
        };
        const merged = mergeRoster(local, incoming);
        expect(merged.entries.map((e) => [e.id, e.gameMode])).toEqual([
            ['a', 'standard'],
            ['b', 'ironcow'],
        ]);
        expect(mergeRoster(incoming, local).entries.find((e) => e.id === 'a').gameMode).toBe('standard');
    });
});

describe('saved builds', () => {
    test('save keeps the build without per-party fields, and the mode', async () => {
        const saved = await saveBuild('Tank', dto(), 'ironcow');
        expect(saved.ok).toBe(true);
        expect(saved.name).toBe('Tank');
        const [build] = saved.roster.builds;
        expect(build).toMatchObject({ id: saved.id, name: 'Tank', gameMode: 'ironcow' });
        expect(build.id.startsWith('sb-')).toBe(true);
        expect(build.dto.hrid).toBeUndefined();
        expect(build.dto.taskMonsterHrids).toBeUndefined();
        // A mode the build carries wins over the one given
        const own = await saveBuild('Mage', dto({ gameMode: 'standard' }), 'ironcow');
        expect(own.roster.builds[1].gameMode).toBe('standard');
        // Not a roster teammate
        expect(own.roster.entries).toEqual([]);
    });

    test('persistence round trip: what is written is what loadRoster reads back', async () => {
        await saveBuild('Tank', dto());
        await saveBuild('Healer', dto({ magicLevel: 120 }));
        expect(db.value.builds.map((b) => b.name)).toEqual(['Tank', 'Healer']);
        const loaded = await loadRoster();
        expect(loaded.builds.map((b) => [b.name, b.dto.magicLevel])).toEqual([
            ['Tank', 95],
            ['Healer', 120],
        ]);
        expect(normalizeRoster(JSON.parse(JSON.stringify(db.value))).builds).toHaveLength(2);
    });

    test('a roster written before saved builds existed reads as having none', async () => {
        db.value = { savedAt: 1, entries: [] };
        expect((await loadRoster()).builds).toEqual([]);
        // and a save lands next to the old teammates, leaving them alone
        db.value = { savedAt: 1, entries: [{ id: 'a', name: 'Ann', dto: dto(), addedAt: 1, updatedAt: 1 }] };
        const saved = await saveBuild('Tank', dto());
        expect(saved.roster.entries.map((e) => e.id)).toEqual(['a']);
        expect(saved.roster.builds).toHaveLength(1);
    });

    test('names are unique: Tank, Tank (2), Tank (3), whatever the case', async () => {
        const names = [];
        for (const n of ['Tank', 'Tank', 'tank', ' Tank  ']) names.push((await saveBuild(n, dto())).name);
        expect(names).toEqual(['Tank', 'Tank (2)', 'tank (3)', 'Tank (4)']);
        expect(uniqueBuildName('x'.repeat(60), [{ id: 'z', name: 'x'.repeat(40) }])).toHaveLength(40);
        expect(uniqueBuildName('x'.repeat(60), [{ id: 'z', name: 'x'.repeat(40) }])).toMatch(/ \(2\)$/);
        expect(uniqueBuildName('   ', [])).toBe('');
    });

    test('a blank name is saved as "Build"; a build the engine cannot run is refused', async () => {
        expect((await saveBuild('  ', dto())).name).toBe('Build');
        const bad = await saveBuild('Bad', { ...dto(), equipment: null });
        expect(bad.ok).toBe(false);
        expect(bad.reason).toMatch(/equipment/);
        expect(db.value.builds).toHaveLength(1);
    });

    test('the list is capped', async () => {
        db.value = {
            savedAt: 1,
            entries: [],
            builds: Array.from({ length: MAX_SAVED_BUILDS }, (_, i) => ({
                id: `sb-${i}`,
                name: `B${i}`,
                dto: dto(),
                addedAt: 1,
                updatedAt: 1,
            })),
        };
        const full = await saveBuild('One more', dto());
        expect(full.ok).toBe(false);
        expect(full.reason).toMatch(/at most 40/);
        expect(db.value.builds).toHaveLength(MAX_SAVED_BUILDS);
    });

    test('rename keeps the name unique; renaming to your own name changes nothing', async () => {
        const a = await saveBuild('Tank', dto());
        const b = await saveBuild('Healer', dto());
        const clash = await renameBuild(b.id, 'tank');
        expect(clash.name).toBe('tank (2)');
        const same = await renameBuild(a.id, 'TANK');
        expect(same.name).toBe('TANK');
        const noop = await renameBuild(a.id, '   ');
        expect(noop.found).toBe(true);
        expect(noop.roster.builds.find((x) => x.id === a.id).name).toBe('TANK');
        expect((await renameBuild('sb-gone', 'X')).found).toBe(false);
    });

    test('delete leaves a tombstone that beats a stale copy', async () => {
        const a = await saveBuild('Tank', dto());
        const stale = JSON.parse(JSON.stringify(db.value));
        const removed = await removeBuild(a.id);
        expect(removed.found).toBe(true);
        expect(removed.roster.builds).toEqual([]);
        expect(db.value.removed[a.id]).toBeGreaterThan(stale.builds[0].updatedAt);
        expect(mergeRoster(db.value, stale).builds).toEqual([]);
        expect(mergeRoster(stale, db.value).builds).toEqual([]);
        expect((await removeBuild(a.id)).found).toBe(false);
    });

    test('a sync merge keeps both devices builds and the later rename of one', () => {
        const build = (id, name, updatedAt) => ({ id, name, dto: dto(), addedAt: 1, updatedAt });
        const local = { savedAt: 1, entries: [], builds: [build('sb-a', 'Tank', 5)] };
        const incoming = { savedAt: 2, entries: [], builds: [build('sb-a', 'Tank!', 9), build('sb-b', 'Healer', 3)] };
        const merged = mergeRoster(local, incoming);
        expect(merged.builds.map((b) => [b.id, b.name])).toEqual([
            ['sb-a', 'Tank!'],
            ['sb-b', 'Healer'],
        ]);
    });

    test('adding a saved build as a teammate goes through the roster add path', async () => {
        const saved = await saveBuild('Tank', dto({ gameMode: 'standard' }));
        const build = saved.roster.builds[0];
        const added = await addTeammates([
            { name: build.name, dto: build.dto, source: 'saved build', gameMode: build.gameMode },
        ]);
        expect(added.roster.entries).toHaveLength(1);
        expect(added.roster.entries[0]).toMatchObject({
            name: 'Tank',
            source: 'saved build',
            gameMode: 'standard',
            auras: [],
            includeAsBuilt: true,
        });
        // The saved build stays, and can be added again
        expect(added.roster.builds).toHaveLength(1);
    });

    test('a failed write saves nothing and says so', async () => {
        db.failNext = true;
        const failed = await saveBuild('Tank', dto());
        expect(failed.ok).toBe(false);
        expect(failed.id).toBeNull();
        expect(db.value).toBeUndefined();
    });
});
