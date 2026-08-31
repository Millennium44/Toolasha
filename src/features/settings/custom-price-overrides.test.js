/**
 * custom-price-overrides: the override map a user typed in survives a read
 * that could not be made, and is never written blind.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const marketAPIMock = vi.hoisted(() => ({ scheduleNotify: vi.fn() }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../api/marketplace.js', () => ({ default: marketAPIMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    getCustomPrice,
    getCustomPriceOverrides,
    getCustomPriceOverridesAsync,
    setCustomPriceOverride,
    removeCustomPriceOverride,
    initCustomPriceOverrides,
    resetCustomPriceOverridesCache,
    flushCustomPriceOverrideWrites,
} = await import('./custom-price-overrides.js');

const KEY = 'Toolasha_customPriceOverrides';
const stored = () => storageMock.storeFor('settings').get(KEY);
const seed = (map) => storageMock.storeFor('settings').set(KEY, map);

beforeEach(() => {
    storageMock.reset();
    resetCustomPriceOverridesCache();
    marketAPIMock.scheduleNotify.mockClear();
});

describe('custom price overrides', () => {
    test('reads back what was stored, under the bare key it has always used', async () => {
        seed({ '/items/milk:0': { buy: 10, sell: 12 } });
        await initCustomPriceOverrides();
        expect(getCustomPrice('/items/milk', 0, 'buy')).toBe(10);
        expect(getCustomPrice('/items/milk', 0, 'sell')).toBe(12);
        expect(getCustomPrice('/items/milk', 1, 'sell')).toBeNull();
    });

    test('the sync getter returns empty until loaded, then the map', async () => {
        seed({ '/items/milk:0': { sell: 12 } });
        expect(getCustomPriceOverrides()).toEqual({});
        expect(await getCustomPriceOverridesAsync()).toEqual({ '/items/milk:0': { sell: 12 } });
        expect(getCustomPriceOverrides()).toEqual({ '/items/milk:0': { sell: 12 } });
    });

    test('setting and clearing an override writes at once', async () => {
        await setCustomPriceOverride('/items/milk', 0, 10, null);
        expect(stored()).toEqual({ '/items/milk:0': { buy: 10 } });
        await setCustomPriceOverride('/items/milk', 0, null, '');
        expect(stored()).toEqual({});
        await setCustomPriceOverride('/items/milk', 0, 1, 2);
        await removeCustomPriceOverride('/items/milk', 0);
        expect(stored()).toEqual({});
    });

    test('a load that cannot be made is not cached as an empty map', async () => {
        seed({ '/items/milk:0': { sell: 12 } });
        storageMock.unavailable = true;
        // Empty for now, not wrong — and tried again next time rather than
        // remembered as empty
        expect(await getCustomPriceOverridesAsync()).toEqual({});
        storageMock.unavailable = false;
        expect(await getCustomPriceOverridesAsync()).toEqual({ '/items/milk:0': { sell: 12 } });
    });

    test('a write over a store that cannot be read is skipped, and what is stored stays', async () => {
        seed({ '/items/milk:0': { sell: 12 } });
        storageMock.unavailable = true;
        await setCustomPriceOverride('/items/cheese', 0, 5, null);
        storageMock.unavailable = false;
        expect(stored()).toEqual({ '/items/milk:0': { sell: 12 } });
        // The user still sees what they typed
        expect(getCustomPrice('/items/cheese', 0, 'buy')).toBe(5);
    });

    test('a write before the map was read back loses no stored override', async () => {
        seed({ '/items/milk:0': { sell: 12 } });
        storageMock.unavailable = true;
        await getCustomPriceOverridesAsync();
        storageMock.unavailable = false;

        await setCustomPriceOverride('/items/cheese', 0, 5, null);
        await flushCustomPriceOverrideWrites();
        expect(stored()).toEqual({ '/items/milk:0': { sell: 12 }, '/items/cheese:0': { buy: 5 } });
        // And the cache caught up with what the store had
        expect(getCustomPrice('/items/milk', 0)).toBe(12);
    });

    test('after a readable load a cleared override stays cleared', async () => {
        seed({ '/items/milk:0': { sell: 12 }, '/items/cheese:0': { buy: 5 } });
        await initCustomPriceOverrides();
        await removeCustomPriceOverride('/items/milk', 0);
        expect(stored()).toEqual({ '/items/cheese:0': { buy: 5 } });
    });

    test('an edit tells the price listeners, so consumers redraw without waiting for a market event', async () => {
        await setCustomPriceOverride('/items/milk', 0, 10, null);
        expect(marketAPIMock.scheduleNotify).toHaveBeenCalledTimes(1);
        await removeCustomPriceOverride('/items/milk', 0);
        expect(marketAPIMock.scheduleNotify).toHaveBeenCalledTimes(2);
    });

    test('an edit whose write could not land still notifies — the in-memory map already changed', async () => {
        storageMock.unavailable = true;
        await setCustomPriceOverride('/items/cheese', 0, 5, null);
        expect(getCustomPrice('/items/cheese', 0, 'buy')).toBe(5);
        expect(marketAPIMock.scheduleNotify).toHaveBeenCalledTimes(1);
    });

    test('once storage is back, the next write lands', async () => {
        storageMock.unavailable = true;
        await setCustomPriceOverride('/items/milk', 0, 10, null);
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        await setCustomPriceOverride('/items/cheese', 0, 5, null);
        expect(stored()).toEqual({ '/items/milk:0': { buy: 10 }, '/items/cheese:0': { buy: 5 } });
    });
});
