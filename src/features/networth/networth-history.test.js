/**
 * Networth History — `recentSeries`, the read the equipment savings ETA falls
 * back to when combat has nothing to say.
 *
 * The snapshot pipeline itself (hourly capture, compaction, IndexedDB writes)
 * is not exercised here; `recentSeries` is a pure filter over `history`, so
 * it is tested against that array directly rather than through a full
 * `initialize`/`takeSnapshot` cycle.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (key, store, fallback) => fallback),
    set: vi.fn(),
    delete: vi.fn(async () => true),
    getAllKeys: vi.fn(async () => []),
    putAll: vi.fn(async () => 0),
    isQuotaExceeded: vi.fn(() => false),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char-1' } }));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));

const { default: networthHistory, pruneHistory } = await import('./networth-history.js');

const HOUR = 3_600_000;

/** A snapshot `hoursAgo` hours before "now", with the given total */
const point = (hoursAgo, total) => ({ t: Date.now() - hoursAgo * HOUR, total });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    networthHistory.history = [];
    networthHistory.detailHistory = [];
    networthHistory.characterId = 'char-1';
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    storageMock.get.mockImplementation(async (key, store, fallback) => fallback);
    storageMock.getAllKeys.mockImplementation(async () => []);
    storageMock.isQuotaExceeded.mockImplementation(() => false);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('recentSeries', () => {
    test('keeps only points inside the window, oldest first', () => {
        networthHistory.history = [point(72, 100), point(40, 200), point(10, 300), point(1, 400)];
        expect(networthHistory.recentSeries(48).map((p) => p.total)).toEqual([200, 300, 400]);
    });

    test('an empty history is an empty window', () => {
        expect(networthHistory.recentSeries(48)).toEqual([]);
    });

    test('everything outside the window leaves nothing, not the whole history', () => {
        // Reading `.history` directly here would return two points; the window
        // is what a caller outside this module actually asked for
        networthHistory.history = [point(100, 100), point(72, 200)];
        expect(networthHistory.recentSeries(48)).toEqual([]);
    });

    test('a non-positive window is nothing rather than everything', () => {
        networthHistory.history = [point(1, 100)];
        expect(networthHistory.recentSeries(0)).toEqual([]);
        expect(networthHistory.recentSeries(-5)).toEqual([]);
    });

    test('a point exactly at the edge of the window is kept', () => {
        networthHistory.history = [point(48, 100)];
        expect(networthHistory.recentSeries(48)).toHaveLength(1);
    });
});

const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

describe('pruneHistory', () => {
    test('leaves the recent year exactly as it is', () => {
        const now = Date.now();
        const history = Array.from({ length: 200 }, (_, i) => ({ t: now - (200 - i) * HOUR, total: i }));

        expect(pruneHistory(history, now)).toEqual(history);
    });

    test('thins anything past a year to one point a day', () => {
        const now = Date.now();
        // Two days of hourly points, all older than a year
        const old = Array.from({ length: 48 }, (_, i) => ({ t: now - YEAR - DAY * 2 + i * HOUR, total: i }));
        const recent = [{ t: now - HOUR, total: 999 }];

        const pruned = pruneHistory([...old, ...recent], now);

        // One per day-bucket for the old span, and the recent point untouched
        expect(pruned.length).toBeLessThanOrEqual(4);
        expect(pruned.at(-1)).toEqual(recent[0]);
        // The tail is still a trend, not a single point
        expect(pruned.length).toBeGreaterThan(1);
        for (let i = 1; i < pruned.length - 1; i++) {
            expect(pruned[i].t - pruned[i - 1].t).toBeGreaterThanOrEqual(DAY - HOUR);
        }
    });

    test('keeps the oldest point of the record rather than losing the start of the trend', () => {
        const now = Date.now();
        const oldest = { t: now - YEAR - DAY * 5, total: 1 };
        const pruned = pruneHistory([oldest, { t: now - YEAR - DAY * 5 + HOUR, total: 2 }, { t: now, total: 3 }], now);

        expect(pruned[0]).toEqual(oldest);
    });

    test('an empty or absent history prunes to nothing rather than throwing', () => {
        expect(pruneHistory([], Date.now())).toEqual([]);
        expect(pruneHistory(null, Date.now())).toEqual([]);
        expect(pruneHistory(undefined, Date.now())).toEqual([]);
    });

    test('points without a timestamp are dropped rather than kept forever', () => {
        const now = Date.now();
        expect(pruneHistory([{ total: 5 }, { t: now, total: 6 }], now)).toEqual([{ t: now, total: 6 }]);
    });
});

/**
 * The smallest networth payload `takeDetailSnapshot` will accept.
 * @returns {Object} Fake currentData
 */
function fakeNetworthData() {
    return {
        coins: 1000,
        currentAssets: {
            inventory: { value: 10, breakdown: [{ itemHrid: '/items/milk', count: 3, value: 30 }] },
            equipped: { value: 20, breakdown: [] },
            listings: { value: 0, breakdown: [] },
        },
        fixedAssets: {
            houses: { totalCost: 0, breakdown: [] },
            abilities: { totalCost: 0, breakdown: [] },
            abilityBooks: { totalCost: 0, breakdown: [] },
        },
    };
}

describe('detail snapshots are stored one key each', () => {
    test('a new snapshot writes only itself, not the whole window', () => {
        networthHistory.detailHistory = Array.from({ length: 5 }, (_, i) => ({ t: i, items: {} }));

        networthHistory.takeDetailSnapshot(fakeNetworthData());

        const detailWrites = storageMock.set.mock.calls.filter(([key]) => String(key).startsWith('networthDetail_'));
        expect(detailWrites).toHaveLength(1);
        expect(detailWrites[0][0]).toBe(`networthDetail_char-1_${Date.now()}`);
        // What is written is one snapshot, not an array of them
        expect(Array.isArray(detailWrites[0][1])).toBe(false);
        expect(detailWrites[0][1].t).toBe(Date.now());
    });

    test('a snapshot that falls out of the window takes its key with it', () => {
        // 25 is the cap, so pushing a 26th drops the oldest
        networthHistory.detailHistory = Array.from({ length: 25 }, (_, i) => ({ t: 1000 + i, items: {} }));

        networthHistory.takeDetailSnapshot(fakeNetworthData());

        expect(storageMock.delete).toHaveBeenCalledWith('networthDetail_char-1_1000', 'networthHistory');
        expect(networthHistory.detailHistory).toHaveLength(25);
    });

    test('the old single-array key is migrated into per-snapshot keys and removed', async () => {
        const legacy = [
            { t: 1, items: { a: 1 } },
            { t: 2, items: { b: 2 } },
        ];
        storageMock.get.mockImplementation(async (key, store, fallback) =>
            key === 'networthDetail_char-1' ? legacy : fallback
        );

        const loaded = await networthHistory._loadDetailHistory();

        expect(loaded).toEqual(legacy);
        expect(storageMock.putAll).toHaveBeenCalledWith('networthHistory', {
            'networthDetail_char-1_1': legacy[0],
            'networthDetail_char-1_2': legacy[1],
        });
        expect(storageMock.delete).toHaveBeenCalledWith('networthDetail_char-1', 'networthHistory');
    });

    test('already-split snapshots are gathered back into timestamp order', async () => {
        const stored = {
            'networthDetail_char-1_300': { t: 300, items: {} },
            'networthDetail_char-1_100': { t: 100, items: {} },
            'networthDetail_char-1_200': { t: 200, items: {} },
            networth_char1: [], // a key of a different shape in the same store
        };
        storageMock.getAllKeys.mockImplementation(async () => Object.keys(stored));
        storageMock.get.mockImplementation(async (key, store, fallback) => stored[key] ?? fallback);

        const loaded = await networthHistory._loadDetailHistory();

        expect(loaded.map((s) => s.t)).toEqual([100, 200, 300]);
        expect(storageMock.putAll).not.toHaveBeenCalled();
    });
});

describe('standing down when storage is full', () => {
    test('no snapshot is built or written once the quota has been hit', async () => {
        storageMock.isQuotaExceeded.mockImplementation(() => true);
        networthHistory.networthFeature = { currentData: fakeNetworthData() };

        await networthHistory.takeSnapshot();

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(networthHistory.history).toEqual([]);
        expect(networthHistory.detailHistory).toEqual([]);
    });
});
