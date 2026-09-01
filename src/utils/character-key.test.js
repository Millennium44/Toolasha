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

const mockConsent = vi.hoisted(() => ({
    target: null,
    getAdoptionTargetId: vi.fn(async () => mockConsent.target),
    requestAdoptionConsent: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../core/storage.js', () => ({ default: mockStorage }));
vi.mock('./adoption-consent.js', () => mockConsent);

import { characterKey, readScoped, readScopedFrom, writeScoped, _resetAdoptionCache } from './character-key.js';

/** Let the fire-and-forget consent request settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The recommendedId the (single) consent request carried. */
async function recommendedId() {
    await vi.waitFor(() => expect(mockConsent.requestAdoptionConsent).toHaveBeenCalled());
    return mockConsent.requestAdoptionConsent.mock.calls[0][0]?.recommendedId ?? null;
}

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
        mockConsent.target = null;
        mockConsent.requestAdoptionConsent.mockClear();
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

    it('adopts only once the user confirmed this character, then deletes the legacy copy', async () => {
        mockConsent.target = 'market123';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').get('watchlist_market123')).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist')).toBe(false);
        expect(mockConsent.requestAdoptionConsent).not.toHaveBeenCalled();
    });

    it('does not adopt under a key the character has moved on from', async () => {
        // The scoped key is built at the top of `readScoped`, two storage reads
        // before the adoption decides anything. A switch in between made the
        // key and the consenting character two different characters: the legacy
        // value was moved under the DEPARTING character's key and the bare copy
        // deleted, so neither character had it where they would look for it.
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        mockConsent.target = 'alt789';
        // The switch lands while the legacy key is being read
        mockStorage.get
            .mockImplementationOnce(async () => null)
            .mockImplementationOnce(async (key) => {
                mockDataManager.currentCharacterId = 'alt789';
                return mockStorage.storeFor('settings').get(key) ?? null;
            });

        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
        expect(mockStorage.storeFor('settings').has('watchlist_market123')).toBe(false);
        expect(mockStorage.storeFor('settings').has('watchlist_alt789')).toBe(false);
    });

    it('leaves the legacy value for the chosen character when someone else was picked', async () => {
        mockConsent.target = 'other456';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
        await settle();
        expect(mockConsent.requestAdoptionConsent).not.toHaveBeenCalled();
    });

    it('undecided: keeps the legacy value, asks, and recommends the main character', async () => {
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
        expect(await recommendedId()).toBe('market123');
    });

    it('never recommends an iron cow', async () => {
        mockDataManager.currentCharacterId = 'iron456';
        mockDataManager.currentGameMode = 'ironcow';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(await recommendedId()).toBeNull();
        expect(mockStorage.storeFor('settings').has('watchlist_iron456')).toBe(false);
    });

    it('never recommends a legacy iron cow either', async () => {
        mockDataManager.currentCharacterId = 'legacy456';
        mockDataManager.currentGameMode = 'legacy_ironcow';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(await recommendedId()).toBeNull();
    });

    it('never recommends a character with a test name', async () => {
        mockDataManager.currentCharacterId = 'test999';
        mockDataManager.currentName = 'MillenniumTest';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(await recommendedId()).toBeNull();
    });

    it('never recommends a character with no networth history while another has some', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2, 3]);
        mockDataManager.currentCharacterId = 'freshAlt';
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(await recommendedId()).toBeNull();
    });

    it('recommends a solo character owning the only networth series', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(await recommendedId()).toBe('market123');
    });

    it('recommends only the character with the longest networth series', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2, 3]);
        mockStorage.storeFor('networthHistory').set('networth_alt789', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);

        mockDataManager.currentCharacterId = 'alt789';
        await readScoped('watchlist', 'settings', []);
        expect(await recommendedId()).toBeNull();

        mockConsent.requestAdoptionConsent.mockClear();
        _resetAdoptionCache();
        mockDataManager.currentCharacterId = 'market123';
        await readScoped('watchlist', 'settings', []);
        expect(await recommendedId()).toBe('market123');
    });

    it('still measures the series once it is stored as monthly records', async () => {
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-07', [1, 2]);
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-08', [3]);
        mockStorage.storeFor('networthHistory').set('networthSeries_alt789_2026-08', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        await readScoped('watchlist', 'settings', []);
        expect(await recommendedId()).toBe('market123');
    });

    it('compares a split series against an unsplit one', async () => {
        mockStorage.storeFor('networthHistory').set('networth_alt789', [1, 2, 3, 4]);
        mockStorage.storeFor('networthHistory').set('networthSeries_market123_2026-08', [1]);
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        await readScoped('watchlist', 'settings', []);
        expect(await recommendedId()).toBeNull();
    });

    it('ignores non-series networth keys when recommending', async () => {
        mockStorage.storeFor('networthHistory').set('networth_market123', [1, 2]);
        mockStorage.storeFor('networthHistory').set('networth_exclusions_market123', ['x']);
        mockStorage.storeFor('networthHistory').set('networthDetail_market123_1', {});
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        await readScoped('watchlist', 'settings', []);
        expect(await recommendedId()).toBe('market123');
    });

    it('discard mode deletes the legacy value without asking anyone', async () => {
        mockStorage.storeFor('settings').set('simCache', { stale: true });
        expect(await readScoped('simCache', 'settings', null, { migrate: 'discard' })).toBeNull();
        expect(mockStorage.storeFor('settings').has('simCache')).toBe(false);
        expect(mockStorage.storeFor('settings').has('simCache_market123')).toBe(false);
        await settle();
        expect(mockConsent.requestAdoptionConsent).not.toHaveBeenCalled();
    });

    it('does nothing before a character id is known', async () => {
        mockDataManager.currentCharacterId = null;
        mockStorage.storeFor('settings').set('watchlist', ['legacy']);
        expect(await readScoped('watchlist', 'settings', [])).toEqual([]);
        expect(mockStorage.storeFor('settings').get('watchlist')).toEqual(['legacy']);
        await settle();
        expect(mockConsent.requestAdoptionConsent).not.toHaveBeenCalled();
    });
});

describe('readScopedFrom', () => {
    /** The map a `storage.getMany` for one base would return. */
    const batch = (entries) => new Map(Object.entries(entries));

    beforeEach(() => {
        mockStorage.reset();
        mockDataManager.currentCharacterId = 'market123';
        mockDataManager.currentGameMode = 'standard';
        mockDataManager.currentName = 'Millennium';
        mockConsent.target = null;
        mockConsent.requestAdoptionConsent.mockClear();
        _resetAdoptionCache();
    });

    it('takes the scoped value out of the batch without reading storage again', async () => {
        const values = batch({ taskCapCoinThreshold_market123: 80000, taskCapCoinThreshold: 40000 });
        mockStorage.get.mockClear();
        expect(await readScopedFrom('taskCapCoinThreshold', values, 'settings', 320000)).toBe(80000);
        expect(mockStorage.get).not.toHaveBeenCalled();
    });

    it('keeps a stored false rather than falling through to the legacy value', async () => {
        const values = batch({ taskCapProtection_market123: false, taskCapProtection: true });
        expect(await readScopedFrom('taskCapProtection', values, 'settings', false)).toBe(false);
    });

    it('returns the default when the batch has neither key', async () => {
        expect(await readScopedFrom('taskCapCoinThreshold', batch({}), 'settings', 320000)).toBe(320000);
    });

    it('leaves the legacy value alone for an alt, which gets the default', async () => {
        mockConsent.target = 'other456';
        mockStorage.storeFor('settings').set('taskCapCoinThreshold', 40000);
        const values = batch({ taskCapCoinThreshold_market123: null, taskCapCoinThreshold: 40000 });
        expect(await readScopedFrom('taskCapCoinThreshold', values, 'settings', 320000)).toBe(320000);
        expect(mockStorage.storeFor('settings').get('taskCapCoinThreshold')).toBe(40000);
    });

    it('adopts the legacy value for the chosen character and deletes the bare key', async () => {
        mockConsent.target = 'market123';
        mockStorage.storeFor('settings').set('taskCapCoinThreshold', 40000);
        const values = batch({ taskCapCoinThreshold_market123: null, taskCapCoinThreshold: 40000 });
        expect(await readScopedFrom('taskCapCoinThreshold', values, 'settings', 320000)).toBe(40000);
        expect(mockStorage.storeFor('settings').get('taskCapCoinThreshold_market123')).toBe(40000);
        expect(mockStorage.storeFor('settings').has('taskCapCoinThreshold')).toBe(false);
    });

    it('asks who owns the data while the choice is undecided', async () => {
        const values = batch({ taskCapCoinThreshold: 40000 });
        expect(await readScopedFrom('taskCapCoinThreshold', values, 'settings', 320000)).toBe(320000);
        expect(await recommendedId()).toBe('market123');
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
