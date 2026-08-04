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

vi.mock('../../core/storage.js', () => ({ default: { get: async () => [], set: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char-1' } }));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => true } }));

const { default: networthHistory } = await import('./networth-history.js');

const HOUR = 3_600_000;

/** A snapshot `hoursAgo` hours before "now", with the given total */
const point = (hoursAgo, total) => ({ t: Date.now() - hoursAgo * HOUR, total });

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T00:00:00Z'));
    networthHistory.history = [];
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
