/**
 * The loot log's history, which used to rewrite all 500 entries immediately on
 * every `loot_log_updated` — several full-array writes a second while a fast
 * action runs, for a list that changes by one entry.
 *
 * What is worth testing is therefore not the merge arithmetic but the write
 * shape: debounced rather than immediate, one merge landing on top of the last
 * even while the write is still pending, and nothing built at all once the
 * database has said it is full.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (key, store, fallback) => fallback),
    set: vi.fn(async () => true),
    delete: vi.fn(async () => true),
    isQuotaExceeded: vi.fn(() => false),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char-1' } }));

const { default: lootLogHistory } = await import('./loot-log-history.js');

/**
 * A loot log entry as the game sends it.
 * @param {number} id - characterActionId
 * @param {string} startTime - ISO start time
 * @returns {Object} Entry
 */
const entry = (id, startTime) => ({ characterActionId: id, startTime, endTime: startTime, actionCount: 1 });

beforeEach(() => {
    storageMock.get.mockClear();
    storageMock.set.mockClear();
    storageMock.delete.mockClear();
    storageMock.get.mockImplementation(async (key, store, fallback) => fallback);
    storageMock.isQuotaExceeded.mockImplementation(() => false);
    lootLogHistory._cacheKey = null;
    lootLogHistory._cache = null;
});

describe('writes', () => {
    test('the write is debounced, not immediate', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        expect(storageMock.set).toHaveBeenCalledTimes(1);
        const [key, value, storeName, immediate] = storageMock.set.mock.calls[0];
        expect(key).toBe('lootLog_char-1');
        expect(value).toHaveLength(1);
        expect(storeName).toBe('lootLogHistory');
        // The whole point: no `immediate` flag, so the debounce coalesces bursts
        expect(immediate).toBeUndefined();
    });

    test('a merge that changes nothing writes nothing', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        storageMock.set.mockClear();

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('an empty loot log is not a write', async () => {
        await lootLogHistory.mergeAndSave([]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });
});

describe('merging while a write is still pending', () => {
    test('successive merges accumulate rather than each landing on stale storage', async () => {
        // Storage stays empty throughout: with a debounced write, nothing has
        // been flushed yet, so a read-through would lose the earlier merges
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        await lootLogHistory.mergeAndSave([entry(2, '2026-08-02T00:00:00Z')]);
        await lootLogHistory.mergeAndSave([entry(3, '2026-08-03T00:00:00Z')]);

        const lastWrite = storageMock.set.mock.calls.at(-1)[1];
        expect(lastWrite.map((e) => e.characterActionId)).toEqual([3, 2, 1]);
    });

    test('storage is read once, not once per loot message', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);
        await lootLogHistory.mergeAndSave([entry(2, '2026-08-02T00:00:00Z')]);

        expect(storageMock.get).toHaveBeenCalledTimes(1);
    });

    test('the historical read sees entries that have not been flushed yet', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z'), entry(2, '2026-08-02T00:00:00Z')]);

        const historical = await lootLogHistory.getHistoricalEntries(new Set([2]));

        expect(historical.map((e) => e.characterActionId)).toEqual([1]);
    });

    test('clearing drops the in-memory copy too, not just the stored one', async () => {
        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        await lootLogHistory.clearHistory();

        expect(storageMock.delete).toHaveBeenCalledWith('lootLog_char-1', 'lootLogHistory');
        expect(await lootLogHistory.getHistoricalEntries(new Set())).toEqual([]);
    });
});

describe('standing down when storage is full', () => {
    test('nothing is merged or written once the quota has been hit', async () => {
        storageMock.isQuotaExceeded.mockImplementation(() => true);

        await lootLogHistory.mergeAndSave([entry(1, '2026-08-01T00:00:00Z')]);

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(storageMock.get).not.toHaveBeenCalled();
    });
});
