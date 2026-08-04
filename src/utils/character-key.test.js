import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockDataManager = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    currentGameMode: 'standard',
    currentName: 'Millennium',
    getCurrentCharacterId: vi.fn(() => mockDataManager.currentCharacterId),
    getCurrentCharacterGameMode: vi.fn(() => mockDataManager.currentGameMode),
    getCurrentCharacterName: vi.fn(() => mockDataManager.currentName),
}));

const mockStorage = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset() {
            stores.clear();
        },
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            storeFor(storeName).set(key, value);
            return true;
        }),
        delete: vi.fn(async (key, storeName = 'settings') => {
            storeFor(storeName).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (storeName = 'settings') => Array.from(storeFor(storeName).keys())),
    };
});

vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/storage.js', () => ({ default: mockStorage }));

import { characterKey, readScoped, writeScoped, _resetAdoptionCache } from './character-key.js';

describe('characterKey', () => {
    beforeEach(() => {
        mockDataManager.currentCharacterId = 'market123';
    });

    it('suffixes the base with the current character id', () => {
        expect(characterKey('watchlist')).toBe('watchlist_market123');
    });

    it('falls back to default before login', () => {
        mockDataManager.currentCharacterId = null;
        expect(characterKey('watchlist')).toBe('watchlist_default');
    });
});

describe('readScoped', () => {
    beforeEach(() => {
        mockStorage.reset();
        mockDataManager.currentCharacterId = 'market123';
        mockDataManager.currentGameMode = 'standard';
        mockDataManager.currentName = 'Millennium';
        _resetAdoptionCache();
    });

    it('returns the scoped value when present', async () => {
        mockStorage.storeFor('settings').set('watchlist_market123', ['a']);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist')).toEqual(['a']);
    });

    it('returns the default when neither key exists', async () => {
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
    });

    it('adopts the legacy value onto a standard character and deletes it', async () => {
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').get('watchlist_market123')).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist')).toBe(false);
    });

    it('never adopts onto a character with a test name', async () => {
        mockDataManager.currentCharacterId = 'test999';
        mockDataManager.currentName = 'MillenniumTest';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
    });

    it('never adopts onto a character with no networth history while another has some', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2, 3]);
        mockDataManager.currentCharacterId = 'freshAlt';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
    });

    it('a solo character with the only networth series still adopts', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist')).toBe(false);
    });

    it('never adopts onto a legacy iron cow either', async () => {
        mockDataManager.currentCharacterId = 'legacy456';
        mockDataManager.currentGameMode = 'legacy_ironcow';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
    });

    it('never adopts onto an iron cow and leaves the legacy value in place', async () => {
        mockDataManager.currentCharacterId = 'iron456';
        mockDataManager.currentGameMode = 'ironcow';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist_iron456')).toBe(false);
    });

    it('adopts only on the character with the longest networth series', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2, 3]);
        mockStorage.storeFor('networthHistory').set('networth_alt789', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);

        mockDataManager.currentCharacterId = 'alt789';
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);

        mockDataManager.currentCharacterId = 'market123';
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist')).toBe(false);
    });

    it('still picks the longest series once it is stored as monthly records', async () => {
        // Neither character has a `networth_<id>` key any more
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-07', [1, 2]);
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-08', [3]);
        mockStorage.storeFor('networthHistory').set('networthSeries_alt789_2026-08', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);

        mockDataManager.currentCharacterId = 'alt789';
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);

        mockDataManager.currentCharacterId = 'market123';
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
    });

    it('compares a split series against an unsplit one', async () => {
        // One character migrated, one not — the comparison has to span both
        mockStorage.storeFor('networthHistory').set('networth_alt789', [1, 2, 3, 4]);
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-08', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);

        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
    });

    it('ignores non-series networth keys when picking the adopter', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2]);
        mockStorage.storeFor('networthHistory').set('networth_exclusions_market123', ['x']);
        mockStorage.storeFor('networthHistory').set('networthDetail_market123_1', {});
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
    });

    it('discard mode deletes the legacy value and starts clean', async () => {
        mockStorage.storeFor('settings').set('simCache', { stale: true });
        expect(await readScoped('simCache', 'settings', null, { migrate: 'discard' })).toBeNull();
        expect(mockStorage.storeFor('settings').has('simCache')).toBe(false);
        expect(mockStorage.storeFor('settings').has('simCache_market123')).toBe(false);
    });

    it('does not adopt before a character id is known', async () => {
        mockDataManager.currentCharacterId = null;
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
    });
});

describe('writeScoped', () => {
    beforeEach(() => {
        mockStorage.reset();
        mockDataManager.currentCharacterId = 'market123';
    });

    it('writes under the scoped key', async () => {
        await writeScoped('watchlist', ['a']);
        expect(mockStorage.storeFor('settings').get('watchlist_market123')).toEqual(['a']);
    });
});
