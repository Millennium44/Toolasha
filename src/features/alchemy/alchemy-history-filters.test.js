/**
 * Characterize the existing filter and sort contract of every history viewer.
 * These cases pass before extraction as well as with the shared helpers.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => true },
}));
vi.mock('./transmute-history-tracker.js', () => ({ transmuteHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./decompose-history-tracker.js', () => ({ decomposeHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./coinify-history-tracker.js', () => ({ coinifyHistoryTracker: { loadSessions: async () => [] } }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    return {
        getItemPrice: () => null,
        getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
        getItemPrices: () => null,
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) => ({
            name: hrid.split('/').pop(),
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');

const NAMES = { '/items/a': 'Zebra', '/items/b': 'Apple', '/items/c': 'Lime', '/items/dust': 'Magic Dust' };
const day = (date, hour = 0, minute = 0, second = 0, ms = 0) =>
    new Date(2026, 10, date, hour, minute, second, ms).getTime();
const session = (id, item, startTime, extra = {}) => ({ id, inputItemHrid: item, startTime, ...extra });
const ids = (sessions) => sessions.map(({ id }) => id);

describe.each([
    ['transmute', transmuteHistoryViewer],
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
])('%s history filtering characterization', (kind, viewer) => {
    let compute;
    beforeEach(() => {
        viewer.sessions = [];
        viewer.filteredSessions = [];
        viewer.profitCache = new Map();
        viewer.filters = { dateFrom: null, dateTo: null, selectedInputItems: [], resultsSearch: '' };
        viewer.sortColumn = 'startTime';
        viewer.sortDirection = 'asc';
        viewer.currentPage = 8;
        viewer.cachedDateRange = { stale: true };
        vi.spyOn(viewer, 'getItemName').mockImplementation((hrid) => NAMES[hrid] || hrid);
        compute = vi
            .spyOn(viewer, 'computeSessionProfit')
            .mockImplementation((entry) => ({ profit: entry.profit ?? 0 }));
    });
    afterEach(() => {
        vi.restoreAllMocks();
        viewer.sessions = [];
        viewer.filteredSessions = [];
        viewer.profitCache.clear();
        viewer.filters = { dateFrom: null, dateTo: null, selectedInputItems: [], resultsSearch: '' };
    });

    test('empty input clears the page and date-range cache without creating profit entries', () => {
        viewer.applyFilters();
        expect(viewer.filteredSessions).toEqual([]);
        expect(viewer.filteredSessions).not.toBe(viewer.sessions);
        expect(viewer.currentPage).toBe(1);
        expect(viewer.cachedDateRange).toBeNull();
        expect(compute).not.toHaveBeenCalled();
    });

    test('date bounds include both endpoints of the local end day without mutating filters', () => {
        const from = new Date(2026, 10, 9);
        const to = new Date(2026, 10, 10);
        viewer.filters.dateFrom = from;
        viewer.filters.dateTo = to;
        viewer.sessions = [
            session('before', '/items/a', day(8, 23, 59, 59, 999)),
            session('first', '/items/a', day(9)),
            session('last', '/items/a', day(10, 23, 59, 59, 999)),
            session('after', '/items/a', day(11)),
        ];
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['first', 'last']);
        expect(from.getTime()).toBe(day(9));
        expect(to.getTime()).toBe(day(10));
        expect(compute).toHaveBeenCalledTimes(4);
    });

    test('selects exact input identities, preserving separate sessions and enhancement levels', () => {
        viewer.sessions = [
            session('a1', '/items/a', day(9), { enhancementLevel: 0 }),
            session('a2', '/items/a', day(9), { enhancementLevel: 5 }),
            session('a3', '/items/a', day(9), { enhancementLevel: 10 }),
            session('other', '/items/a_refined', day(9)),
            session('b', '/items/b', day(9)),
        ];
        viewer.filters.selectedInputItems = ['/items/a', '/items/a'];
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['a1', 'a2', 'a3']);
        expect(viewer.sessions).toHaveLength(5);
        viewer.filters.selectedInputItems = ['/items/c'];
        viewer.applyFilters();
        expect(viewer.filteredSessions).toEqual([]);
        expect(compute).toHaveBeenCalledTimes(5);
    });

    test('results search uses trimmed, case-insensitive displayed names only where supported', () => {
        viewer.sessions = [
            session('found', '/items/a', day(9), { results: { '/items/dust': { count: 3 } } }),
            session('absent', '/items/b', day(9)),
            session('empty', '/items/c', day(9), { results: {} }),
        ];
        viewer.filters.resultsSearch = '  MAGIC dUsT  ';
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(kind === 'coinify' ? ['found', 'absent', 'empty'] : ['found']);
        viewer.filters.resultsSearch = '  ';
        viewer.applyFilters();
        expect(viewer.filteredSessions).toHaveLength(3);
    });

    test('orders input items by displayed names in both directions without changing source order', () => {
        viewer.sessions = [
            session('z', '/items/a', day(9)),
            session('a', '/items/b', day(9)),
            session('l', '/items/c', day(9)),
        ];
        viewer.sortColumn = 'inputItemHrid';
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['a', 'l', 'z']);
        viewer.sortDirection = 'desc';
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['z', 'l', 'a']);
        expect(ids(viewer.sessions)).toEqual(['z', 'a', 'l']);
    });

    test('profit ordering reuses cached figures and preserves stable zero-value ties', () => {
        viewer.sessions = [
            session('zero', '/items/a', day(9), { profit: 0 }),
            session('negative', '/items/b', day(9), { profit: -20 }),
            session('cached', '/items/c', day(9), { profit: 999 }),
            session('missing', '/items/a', day(9)),
        ];
        viewer.profitCache.set('cached', { profit: 10 });
        viewer.sortColumn = '_profit';
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['negative', 'zero', 'missing', 'cached']);
        expect(compute).toHaveBeenCalledTimes(3);
        viewer.applyFilters();
        expect(compute).toHaveBeenCalledTimes(3);
    });

    test('missing numeric values remain zero and equal values keep their input order', () => {
        viewer.sessions = [
            session('first', '/items/a', day(9)),
            session('second', '/items/b', day(9), { totalAttempts: 0 }),
            session('third', '/items/c', day(9), { totalAttempts: 3 }),
        ];
        viewer.sortColumn = 'totalAttempts';
        viewer.sortDirection = 'desc';
        viewer.applyFilters();
        expect(ids(viewer.filteredSessions)).toEqual(['third', 'first', 'second']);
    });
});
