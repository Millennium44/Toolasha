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
    addTeammates,
    renameTeammate,
    removeTeammate,
    replaceTeammateBuild,
    loadRoster,
    normalizeRoster,
    validateTeammateDTO,
    buildFingerprint,
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
        expect(normalizeRoster('junk')).toEqual({ savedAt: 0, entries: [] });
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

describe('sync', () => {
    test('the roster key is live-safe and the later save wins', () => {
        expect(isLiveSafeKey('settings', PARTY_ROSTER_KEY)).toBe(true);
        const older = { savedAt: 1, entries: [] };
        const newer = { savedAt: 2, entries: [{ id: 'x' }] };
        const { merge } = mergeForKey('settings', PARTY_ROSTER_KEY);
        expect(merge(newer, older)).toBe(newer);
        expect(merge(older, newer)).toBe(newer);
    });
});
