/**
 * Named overlay layouts.
 *
 * The map operations are where the mistakes live — an overwrite that appends
 * instead of replacing, a delete that silently misses because the name had a
 * trailing space — so they are tested directly, and the storage round trip is
 * tested against a map held in memory rather than against IndexedDB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map(), fail: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => {
            if (store.fail) throw new Error('storage is down');
            return store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null;
        },
        setJSON: async (key, value) => {
            if (store.fail) throw new Error('storage is down');
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
    },
}));

const {
    normalizeName,
    layoutNames,
    putLayout,
    removeLayout,
    loadLayouts,
    saveLayout,
    deleteLayout,
    getLayout,
    LAYOUTS_KEY,
    MAX_NAME_LENGTH,
} = await import('./overlay-layouts.js');

/**
 * A stand-in for what `toOPanelConfig` produces.
 * @param {string[]} order - Row keys
 * @returns {Object}
 */
function file(order) {
    return { config: { order }, toolasha: { version: 1, settings: { order } } };
}

beforeEach(() => {
    store.data.clear();
    store.fail = false;
    vi.restoreAllMocks();
});

describe('names', () => {
    test('trimmed, collapsed and capped', () => {
        expect(normalizeName('  Dungeon  ')).toBe('Dungeon');
        expect(normalizeName('Market\t \n runs')).toBe('Market runs');
        expect(normalizeName('x'.repeat(MAX_NAME_LENGTH + 20))).toHaveLength(MAX_NAME_LENGTH);
    });

    test('nothing usable is not a name', () => {
        expect(normalizeName('   ')).toBe('');
        expect(normalizeName(null)).toBe('');
        expect(normalizeName(42)).toBe('');
    });
});

describe('the map', () => {
    test('adding does not touch the map handed in', () => {
        const before = {};
        const after = putLayout(before, 'Dungeon', file(['dps']));

        expect(before).toEqual({});
        expect(layoutNames(after)).toEqual(['Dungeon']);
    });

    test('the same name replaces rather than appends', () => {
        let map = putLayout({}, 'Dungeon', file(['dps']));
        map = putLayout(map, 'Dungeon', file(['coins', 'luck']));

        expect(layoutNames(map)).toEqual(['Dungeon']);
        expect(map.Dungeon.file.config.order).toEqual(['coins', 'luck']);
    });

    test('a name with stray whitespace lands on the same entry', () => {
        let map = putLayout({}, 'Dungeon', file(['dps']));
        map = putLayout(map, '  Dungeon ', file(['luck']));

        expect(layoutNames(map)).toEqual(['Dungeon']);
        expect(removeLayout(map, ' Dungeon')).toEqual({});
    });

    test('an unusable name saves nothing', () => {
        expect(putLayout({}, '   ', file(['dps']))).toEqual({});
        expect(putLayout({}, 'Dungeon', null)).toEqual({});
    });

    test('deleting a name that is not there changes nothing', () => {
        const map = putLayout({}, 'Dungeon', file(['dps']));
        expect(layoutNames(removeLayout(map, 'Market'))).toEqual(['Dungeon']);
    });

    test('names come back sorted', () => {
        let map = putLayout({}, 'Market', file([]));
        map = putLayout(map, 'Dungeon', file([]));
        map = putLayout(map, 'alchemy', file([]));

        expect(layoutNames(map)).toEqual(['alchemy', 'Dungeon', 'Market']);
        expect(layoutNames(null)).toEqual([]);
    });
});

describe('the round trip', () => {
    test('save, list, read back, delete', async () => {
        expect(await loadLayouts()).toEqual({});

        await saveLayout('Dungeon', file(['dps', 'luck']));
        await saveLayout('Market', file(['coins']));

        expect(layoutNames(await loadLayouts())).toEqual(['Dungeon', 'Market']);
        expect((await getLayout('Dungeon')).config.order).toEqual(['dps', 'luck']);
        // Everything lives under the one key rather than a key per layout
        expect([...store.data.keys()]).toEqual([LAYOUTS_KEY]);

        await deleteLayout('Dungeon');
        expect(layoutNames(await loadLayouts())).toEqual(['Market']);
        expect(await getLayout('Dungeon')).toBeNull();
    });

    test('switching between two saved layouts gets each one back whole', async () => {
        await saveLayout('Dungeon', file(['dps', 'luck']));
        await saveLayout('Market', file(['coins', 'marketListings']));

        expect((await getLayout('Market')).toolasha.settings.order).toEqual(['coins', 'marketListings']);
        expect((await getLayout('Dungeon')).toolasha.settings.order).toEqual(['dps', 'luck']);
    });

    test('saving records when it happened', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const map = await saveLayout('Dungeon', file([]));
        expect(map.Dungeon.savedAt).toBe(1_700_000_000_000);
    });

    test('storage falling over reads as no layouts rather than as an error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        store.fail = true;

        await expect(loadLayouts()).resolves.toEqual({});
        await expect(saveLayout('Dungeon', file([]))).resolves.toEqual({});
        await expect(getLayout('Dungeon')).resolves.toBeNull();
    });
});
