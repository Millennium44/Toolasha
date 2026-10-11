/**
 * An older copy of this device's own checkpoints must fold to exactly what is
 * held, and a row only the other side has must still come in.
 *
 * Real chunked-history underneath, storage faked: the property lives in what the
 * recorder writes and what the registered pull fold makes of it, and a mocked
 * store would test neither.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    const mock = {
        store,
        FOLD_DELETE: Symbol('fold-delete'),
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => store.delete(key)),
        getMany: vi.fn(async (keys) => new Map(keys.map((key) => [key, store.has(key) ? store.get(key) : null]))),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
    mock.tryGetAllKeys = vi.fn(async () => [...store.keys()]);
    return mock;
});

vi.mock('../core/storage.js', () => ({ default: storageMock }));

const { mergeForKey } = await import('./sync-merge-registry.js');
const { createDailyCheckpoints } = await import('./daily-checkpoints.js');

const noon = (month, day) => new Date(2026, month - 1, day, 12).getTime();
const KEY = 'sumCheckpointRec_30404_2026-10';

// The game lists skills in its own order, which is not alphabetical
const samples = (xp) => [
    { k: '/skills/woodcutting', xp, level: 10 },
    { k: '/skills/milking', xp: xp + 1, level: 10 },
    { k: '/skills/foraging', xp: xp + 2, level: 10 },
];

let checkpoints;

beforeEach(() => {
    storageMock.store.clear();
    checkpoints = createDailyCheckpoints({
        storeName: 'xpHistory',
        prefix: 'sumCheckpointRec',
        legacyKey: (charId) => `sumCheckpoints_${charId}`,
        label: 'SumCheckpoints',
    });
});

describe('folding an older copy of the same device’s checkpoints', () => {
    test('equals what is held, however many days the recorder has appended since', async () => {
        await checkpoints.recordToday('30404', samples(100), noon(10, 1));
        const older = structuredClone(storageMock.store.get(KEY));

        await checkpoints.recordToday('30404', samples(200), noon(10, 2));
        await checkpoints.recordToday('30404', samples(300), noon(10, 3));
        const local = storageMock.store.get(KEY);
        expect(local).toHaveLength(9);

        const folded = mergeForKey('xpHistory', KEY).mergeForPull(local, older);
        expect(folded).toEqual(local);
    });

    test('the very same copy folds to itself, whatever order it was written in', () => {
        const local = [
            { d: '2026-10-02', k: '/skills/woodcutting', xp: 5, level: 1 },
            { d: '2026-10-02', k: '/skills/milking', xp: 6, level: 1 },
        ];
        createDailyCheckpoints({
            storeName: 'xpHistory',
            prefix: 'sumCheckpointRec',
            legacyKey: (charId) => `sumCheckpoints_${charId}`,
            label: 'SumCheckpoints',
        });
        const folded = mergeForKey('xpHistory', KEY).mergeForPull(local, structuredClone(local));
        expect(folded).toEqual(local);
    });

    test('a row only the other side has still comes in', async () => {
        await checkpoints.recordToday('30404', samples(100), noon(10, 1));
        const local = storageMock.store.get(KEY);
        const other = [...local, { d: '2026-10-05', k: '/skills/milking', xp: 500, level: 11 }];

        const folded = mergeForKey('xpHistory', KEY).mergeForPull(local, other);
        expect(folded).toHaveLength(local.length + 1);
        expect(folded.some((entry) => entry.d === '2026-10-05')).toBe(true);
    });
});
