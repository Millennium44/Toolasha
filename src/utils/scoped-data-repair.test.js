import { describe, it, expect, beforeEach, vi } from 'vitest';

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
    };
});

vi.mock('../core/storage.js', () => ({ default: mockStorage }));

import { moveScopedData, ADOPTED_BASES } from './scoped-data-repair.js';

describe('moveScopedData', () => {
    beforeEach(() => {
        mockStorage.reset();
    });

    it('moves a wrongly adopted value to the right character and deletes the source', async () => {
        mockStorage.storeFor('settings').set('watchlist_testChar', ['a', 'b']);
        mockStorage.storeFor('rerollSpending').set('taskRerollData_testChar', { t1: 2 });

        const result = await moveScopedData('testChar', 'marketChar');

        expect(mockStorage.storeFor('settings').get('watchlist_marketChar')).toEqual(['a', 'b']);
        expect(mockStorage.storeFor('settings').has('watchlist_testChar')).toBe(false);
        expect(mockStorage.storeFor('rerollSpending').get('taskRerollData_marketChar')).toEqual({ t1: 2 });
        expect(result.moved).toHaveLength(2);
        expect(result.skipped).toHaveLength(0);
    });

    it('never clobbers data the destination already owns', async () => {
        mockStorage.storeFor('settings').set('watchlist_testChar', ['stolen']);
        mockStorage.storeFor('settings').set('watchlist_marketChar', ['mine']);

        const result = await moveScopedData('testChar', 'marketChar');

        expect(mockStorage.storeFor('settings').get('watchlist_marketChar')).toEqual(['mine']);
        expect(mockStorage.storeFor('settings').get('watchlist_testChar')).toEqual(['stolen']);
        expect(result.skipped).toEqual(['settings:watchlist_testChar']);
    });

    it('dry run reports the moves without making them', async () => {
        mockStorage.storeFor('settings').set('treasureTally_testChar', { chests: 5 });

        const result = await moveScopedData('testChar', 'marketChar', { dryRun: true });

        expect(result.moved).toHaveLength(1);
        expect(mockStorage.storeFor('settings').has('treasureTally_testChar')).toBe(true);
        expect(mockStorage.storeFor('settings').has('treasureTally_marketChar')).toBe(false);
    });

    it('rejects a missing or identical pair of ids', async () => {
        await expect(moveScopedData('same', 'same')).rejects.toThrow();
        await expect(moveScopedData('', 'x')).rejects.toThrow();
    });

    it('leaves genuinely per-character history bases out of the move list', () => {
        const allBases = Object.values(ADOPTED_BASES).flat();
        for (const base of ['networth', 'networthSeries', 'xpHistory', 'lootLog', 'lootLogRec', 'tradeHistory']) {
            expect(allBases).not.toContain(base);
        }
    });
});
