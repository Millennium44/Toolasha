/** @vitest-environment happy-dom
 *
 * Collection state, under a key the rest of the script can read.
 *
 * These keys were always per character — `flags:abc123` — so nothing leaked.
 * What went wrong is quieter: everything else in the script scopes a key as
 * `flags_abc123`, and the account view and the settings importer find a
 * character's data by that underscore suffix. A colon meant this feature's data
 * was invisible to both. The rename is per character and needs no adoption
 * question answered, so the only thing worth testing is that nobody loses their
 * favourites to it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ collections: {}, settings: {} }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'market123',
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => 'standard',
    on: () => {},
    off: () => {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_k, d) => d, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getItemPrice: () => null } }));
vi.mock('../../utils/efficiency.js', () => ({ getActionEfficiencyContext: () => ({}) }));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        set: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        delete: async (key, name = 'settings') => {
            delete store[name][key];
            return true;
        },
        getJSON: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        setJSON: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(store[name] || {}),
    },
}));

const { default: collectionFilters } = await import('./collection-filters.js');

beforeEach(() => {
    store.collections = {};
    store.settings = {};
    mockDataManager.characterId = 'market123';
    collectionFilters._renamedFor = null;
    collectionFilters._filtersEnabled = true;
    collectionFilters._favoritesEnabled = true;
});

describe('the colon keys becoming underscore keys', () => {
    test('a character keeps everything it had', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.collections['collections:market123'] = { '/items/milk': 12 };
        store.collections['showUncollected:market123'] = true;
        store.collections['collectionsUpdatedAt:market123'] = 1700;

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ '/items/milk': true });
        expect(collectionFilters.collections).toEqual({ '/items/milk': 12 });
        expect(collectionFilters.showUncollected).toBe(true);
        expect(collectionFilters.collectionsLastUpdated).toBe(1700);
    });

    test('under the suffix the rest of the script recognises', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };

        await collectionFilters._load();

        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true });
        expect(store.collections['favorites:market123']).toBeUndefined();
    });

    test('and nobody inherits anybody else’s', async () => {
        // Colon keys were already per character, so this is a rename and not an
        // adoption — the iron cow takes its own and only its own
        store.collections['favorites:market123'] = { '/items/milk': true };
        store.collections['favorites:iron456'] = { '/items/log': true };
        mockDataManager.characterId = 'iron456';

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ '/items/log': true });
        expect(store.collections.favorites_iron456).toEqual({ '/items/log': true });
        expect(store.collections.favorites_market123).toBeUndefined();
        expect(store.collections['favorites:market123']).toEqual({ '/items/milk': true });
    });

    test('an already-renamed key is not overwritten by a stale colon key', async () => {
        store.collections['favorites:market123'] = { stale: true };
        store.collections.favorites_market123 = { fresh: true };

        await collectionFilters._load();

        expect(collectionFilters.favorites).toEqual({ fresh: true });
        expect(store.collections['favorites:market123']).toBeUndefined();
    });

    test('a character with nothing stored is not a problem', async () => {
        await expect(collectionFilters._load()).resolves.toBeUndefined();

        expect(collectionFilters.favorites).toEqual({});
    });

    test('saving after the rename writes the underscore key', async () => {
        store.collections['favorites:market123'] = { '/items/milk': true };
        await collectionFilters._load();

        collectionFilters.favorites['/items/log'] = true;
        await collectionFilters._saveFavorites();

        expect(store.collections.favorites_market123).toEqual({ '/items/milk': true, '/items/log': true });
    });
});
