/**
 * The panel's stored settings, and the seam through the middle of them.
 *
 * `mooketPanelPrefs` used to hold two unrelated things: where the panel sits,
 * which is one answer for the whole account, and what is pinned to it, which is
 * one answer per character. Saving on either character wrote both, so the iron
 * cow's short list was replaced by the market character's long one every time
 * either of them moved the panel. These tests are about the split holding.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({ id: 'market123', mode: 'standard' }));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const read = (key, store, fallback) => {
        const map = storeFor(store);
        return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
    };
    return {
        storeFor,
        reset: () => stores.clear(),
        ready: Promise.resolve(true),
        get: async (key, store = 'settings', fallback = null) => read(key, store, fallback),
        getJSON: async (key, store = 'settings', fallback = null) => read(key, store, fallback),
        set: async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        setJSON: async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterGameMode: () => character.mode,
        getItemDetails: () => null,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../../core/config.js', () => ({ default: { getSetting: () => false, onSettingChange: () => {} } }));
vi.mock('../../../api/marketplace.js', () => ({ default: { on: () => {}, off: () => {}, marketData: {} } }));
vi.mock('../../../utils/cleanup-registry.js', () => ({
    createCleanupRegistry: () => ({
        registerCleanup: () => {},
        registerInterval: () => {},
        cleanup: () => {},
    }),
}));
vi.mock('../../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('./market-price-store.js', () => ({
    default: { initialize: async () => {}, cleanup: () => {}, ingestSnapshot: () => {}, priceFor: () => null },
}));
vi.mock('./market-history-api.js', () => ({
    default: { connect: () => {}, disconnect: () => {}, fetchHistory: async () => [] },
}));

const { default: panel, splitLegacyWatchlist } = await import('./index.js');
const { _resetAdoptionCache } = await import('../../../utils/character-key.js');

const settings = () => storageMock.storeFor('settings');
const PREFS_KEY = 'mooketPanelPrefs';
const watched = [
    { key: '/items/cheese:0', ask: 120, bid: 100, at: 500 },
    { key: '/items/milk:0', ask: 20, bid: 10, at: 500 },
];

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    character.id = 'market123';
    character.mode = 'standard';
    panel.prefs = { x: 20, y: 120, w: 520, h: 300, days: 7, open: false, locked: false, mode: 'iconPrice' };
    panel.watchlist = [];
});

describe('splitting the watchlist out of the panel prefs', () => {
    test('the watched items move to the character key and leave the prefs alone', async () => {
        settings().set(PREFS_KEY, { x: 40, days: 30, watchlist: watched });

        await panel.loadPrefs();

        expect(panel.watchlist.map((entry) => entry.key)).toEqual(['/items/cheese:0', '/items/milk:0']);
        expect(
            settings()
                .get('mooketWatchlist_market123')
                .map((entry) => entry.key)
        ).toEqual(['/items/cheese:0', '/items/milk:0']);
        // The panel's own geometry stays where it was, and stays global
        expect(settings().get(PREFS_KEY)).toEqual({ x: 40, days: 30 });
        expect(panel.prefs.x).toBe(40);
        expect(panel.prefs.days).toBe(30);
        expect(panel.prefs.watchlist).toBeUndefined();
    });

    test('an iron cow inherits the panel geometry but not the list', async () => {
        character.id = 'iron456';
        character.mode = 'ironcow';
        settings().set(PREFS_KEY, { x: 40, days: 30, watchlist: watched });

        await panel.loadPrefs();

        expect(panel.prefs.x).toBe(40);
        expect(panel.watchlist).toEqual([]);
        expect(settings().get('mooketWatchlist_iron456')).toBeUndefined();
        // Left for the character it belongs to to claim
        expect(
            settings()
                .get('mooketWatchlist')
                .map((entry) => entry.key)
        ).toEqual(['/items/cheese:0', '/items/milk:0']);
    });

    test('saving writes the two halves to their two keys', async () => {
        panel.prefs.x = 99;
        panel.watchlist = watched;

        await panel.savePrefs();

        expect(settings().get(PREFS_KEY).x).toBe(99);
        expect(settings().get(PREFS_KEY).watchlist).toBeUndefined();
        expect(settings().get('mooketWatchlist_market123')).toHaveLength(2);
    });

    test('one character saving no longer overwrites the other list', async () => {
        settings().set('mooketWatchlist_market123', watched);
        settings().set('mooketWatchlist_iron456', [{ key: '/items/log:0' }]);

        character.id = 'iron456';
        character.mode = 'ironcow';
        await panel.loadPrefs();
        panel.prefs.x = 7;
        await panel.savePrefs();

        expect(
            settings()
                .get('mooketWatchlist_iron456')
                .map((entry) => entry.key)
        ).toEqual(['/items/log:0']);
        expect(settings().get('mooketWatchlist_market123')).toHaveLength(2);
        // The one thing they do share
        expect(settings().get(PREFS_KEY).x).toBe(7);
    });

    test('loading as a second character does not carry the first list over', async () => {
        settings().set('mooketWatchlist_market123', watched);
        await panel.loadPrefs();
        expect(panel.watchlist).toHaveLength(2);

        character.id = 'iron456';
        character.mode = 'ironcow';
        await panel.loadPrefs();

        expect(panel.watchlist).toEqual([]);
    });

    test('splitting twice does not clobber a list already moved', async () => {
        settings().set('mooketWatchlist', [{ key: '/items/already:0' }]);

        await splitLegacyWatchlist({ x: 1, watchlist: watched });

        expect(
            settings()
                .get('mooketWatchlist')
                .map((entry) => entry.key)
        ).toEqual(['/items/already:0']);
        expect(settings().get(PREFS_KEY)).toEqual({ x: 1 });
    });

    test('prefs saved after the split are left exactly as they are', async () => {
        settings().set(PREFS_KEY, { x: 40, days: 30 });

        await panel.loadPrefs();

        expect(settings().get(PREFS_KEY)).toEqual({ x: 40, days: 30 });
        expect(settings().has('mooketWatchlist')).toBe(false);
        expect(panel.watchlist).toEqual([]);
    });
});
