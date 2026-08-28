/**
 * Tests for guild shrine level persistence.
 *
 * The two maps are matched by shape rather than by message type, because which
 * message carries them is not something this client gets to know — so the
 * extraction is checked against the top level, the nested guild object, and the
 * case that matters most: a message that carries one map and not the other,
 * which must not be read as the other having gone to zero.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map(), getJSON: null, setJSON: null }));

vi.mock('./storage.js', () => ({
    default: {
        getJSON: (key, storeName, fallback) => store.getJSON(key, storeName, fallback),
        setJSON: (key, value, storeName) => store.setJSON(key, value, storeName),
    },
}));

const {
    guildShrineStorageKey,
    extractGuildShrineData,
    loadGuildShrineLevels,
    saveGuildShrineLevels,
    buffMapBelongsTo,
    mapSize,
} = await import('./guild-shrine-store.js');

beforeEach(() => {
    store.data = new Map();
    store.getJSON = vi.fn(async (key, _storeName, fallback) => (store.data.has(key) ? store.data.get(key) : fallback));
    store.setJSON = vi.fn(async (key, value) => {
        store.data.set(key, value);
        return true;
    });
});

describe('extracting shrine levels from a message', () => {
    test('reads both maps from the top level', () => {
        const found = extractGuildShrineData({
            type: 'guild_updated',
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 4 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
        });

        expect(found.characterGuildBuffMap['/guild_buffs/force_combat'].level).toBe(4);
        expect(found.guildBuildingLevelMap['/guild_shrines/force']).toBe(6);
    });

    test('reads them off a nested guild object too', () => {
        const found = extractGuildShrineData({
            type: 'guild_updated',
            guild: { id: 'g1', guildBuildingLevelMap: { '/guild_shrines/tempo': 3 } },
        });

        expect(found.guildBuildingLevelMap['/guild_shrines/tempo']).toBe(3);
        expect(found.guildId).toBe('g1');
    });

    test('a map the message does not carry is undefined, not empty', () => {
        // The difference decides whether the caller overwrites what it already
        // knows, so it has to survive extraction
        const found = extractGuildShrineData({ characterGuildBuffMap: { a: { level: 1 } } });
        expect(found.guildBuildingLevelMap).toBeUndefined();
    });

    test('an explicitly empty map is reported as empty', () => {
        const found = extractGuildShrineData({ guildBuildingLevelMap: {} });
        expect(found.guildBuildingLevelMap).toEqual({});
    });

    test('a message carrying neither returns nothing at all', () => {
        expect(extractGuildShrineData({ type: 'items_updated', endCharacterItems: [] })).toBeNull();
        expect(extractGuildShrineData(null)).toBeNull();
        expect(extractGuildShrineData('nonsense')).toBeNull();
    });

    test('an array is not mistaken for a map', () => {
        expect(extractGuildShrineData({ characterGuildBuffMap: [] })).toBeNull();
    });

    test('a battle tick leaves without touching anything', () => {
        // This runs against every message on the socket, so the shape that
        // arrives several times a second has to cost a handful of property reads
        const tick = { type: 'battle_updated', players: [{ currentHitpoints: 400 }] };
        expect(extractGuildShrineData(tick)).toBeNull();
    });
});

describe('saving and loading', () => {
    test('a round trip returns the levels and when they were captured', async () => {
        await saveGuildShrineLevels('char-1', {
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 4 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
            guildId: 'g1',
            capturedAt: 1_700_000_000_000,
        });

        const record = await loadGuildShrineLevels('char-1');
        expect(record.characterGuildBuffMap['/guild_buffs/force_combat'].level).toBe(4);
        expect(record.guildBuildingLevelMap['/guild_shrines/force']).toBe(6);
        expect(record.capturedAt).toBe(1_700_000_000_000);
        expect(record.guildId).toBe('g1');
    });

    test('records are keyed per character, so alts do not share a reading', async () => {
        expect(guildShrineStorageKey('char-1')).not.toBe(guildShrineStorageKey('char-2'));
        await saveGuildShrineLevels('char-1', { guildBuildingLevelMap: { '/guild_shrines/force': 6 } });
        expect(await loadGuildShrineLevels('char-2')).toBeNull();
    });

    test('an empty reading is not written over a real one', async () => {
        expect(await saveGuildShrineLevels('char-1', { characterGuildBuffMap: {}, guildBuildingLevelMap: {} })).toBe(
            false
        );
        expect(store.setJSON).not.toHaveBeenCalled();
    });

    test('a storage failure is survivable', async () => {
        store.getJSON = vi.fn(async () => {
            throw new Error('IndexedDB is having a day');
        });
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await loadGuildShrineLevels('char-1')).toBeNull();
        spy.mockRestore();
    });

    test('map sizes tolerate anything that is not a map', () => {
        expect(mapSize({ a: 1 })).toBe(1);
        expect(mapSize(null)).toBe(0);
        expect(mapSize([1, 2])).toBe(0);
    });
});

describe('buffMapBelongsTo', () => {
    test('a map whose rows name this character is owned', () => {
        expect(buffMapBelongsTo({ a: { characterID: 32030, level: 3 } }, 32030)).toBe(true);
        expect(buffMapBelongsTo({ a: { characterID: '32030', level: 3 } }, 32030)).toBe(true);
    });

    test('a row naming another character disowns the whole map', () => {
        expect(buffMapBelongsTo({ a: { characterID: 30404, level: 11 } }, 32030)).toBe(false);
    });

    test('rows with no owner, an empty map, or an unknown character cast no vote', () => {
        expect(buffMapBelongsTo({ a: { level: 3 } }, 32030)).toBe(true);
        expect(buffMapBelongsTo({}, 32030)).toBe(true);
        expect(buffMapBelongsTo(null, 32030)).toBe(true);
        expect(buffMapBelongsTo({ a: { characterID: 30404 } }, null)).toBe(true);
    });
});
