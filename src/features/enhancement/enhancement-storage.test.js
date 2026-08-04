/**
 * Enhancement sessions used to be written as one immediate blob — every session
 * ever kept, rewritten into the settings store on every attempt of a run.
 *
 * These cover what changed: the write is debounced and not awaited, and the
 * in-memory mirror means a load during the lag still sees the last save rather
 * than the last flush.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    get: vi.fn(async (key, store, fallback) => fallback),
    getJSON: vi.fn(async (key, store, fallback) => fallback),
    set: vi.fn(async () => true),
    setJSON: vi.fn(async () => true),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));

const {
    saveSessions,
    loadSessions,
    saveCurrentSessionId,
    loadCurrentSessionId,
    deleteSession,
    archiveOldSessions,
    clearAllSessions,
    resetPendingSessionCache,
} = await import('./enhancement-storage.js');

beforeEach(() => {
    for (const fn of Object.values(storageMock)) fn.mockClear();
    storageMock.get.mockImplementation(async (key, store, fallback) => fallback);
    storageMock.getJSON.mockImplementation(async (key, store, fallback) => fallback);
    storageMock.set.mockImplementation(async () => true);
    storageMock.setJSON.mockImplementation(async () => true);
    resetPendingSessionCache();
});

describe('session writes', () => {
    test('sessions are queued for a debounced write, not written immediately', async () => {
        await saveSessions({ s1: { id: 's1', startTime: 1 } });

        expect(storageMock.setJSON).toHaveBeenCalledTimes(1);
        const [key, value, store, immediate] = storageMock.setJSON.mock.calls[0];
        expect(key).toBe('enhancementTracker_sessions');
        expect(value).toEqual({ s1: { id: 's1', startTime: 1 } });
        expect(store).toBe('settings');
        expect(immediate).toBeUndefined();
    });

    test('the current session id is queued the same way', async () => {
        await saveCurrentSessionId('s1');

        const [key, value, store, immediate] = storageMock.set.mock.calls[0];
        expect(key).toBe('enhancementTracker_currentSession');
        expect(value).toBe('s1');
        expect(store).toBe('settings');
        expect(immediate).toBeUndefined();
    });

    test('saving does not wait for the debounce timer', async () => {
        // A `set` that never resolves stands in for the debounced promise, which
        // resolves only when its timer fires — awaiting it would stall the run
        storageMock.setJSON.mockImplementation(() => new Promise(() => {}));

        await expect(saveSessions({ s1: {} })).resolves.toBeUndefined();
    });
});

describe('reads during the debounce lag', () => {
    test('a load returns what was last saved, not what was last flushed', async () => {
        storageMock.getJSON.mockImplementation(async () => ({ stale: true }));

        await saveSessions({ s1: { id: 's1' } });

        expect(await loadSessions()).toEqual({ s1: { id: 's1' } });
        expect(storageMock.getJSON).not.toHaveBeenCalled();
    });

    test('with nothing saved yet, a load goes to storage', async () => {
        storageMock.getJSON.mockImplementation(async () => ({ fromStorage: true }));

        expect(await loadSessions()).toEqual({ fromStorage: true });
    });

    test('a current session id of null is remembered as null, not as "nothing saved"', async () => {
        storageMock.get.mockImplementation(async () => 'stale-id');

        await saveCurrentSessionId(null);

        expect(await loadCurrentSessionId()).toBeNull();
        expect(storageMock.get).not.toHaveBeenCalled();
    });

    test('clearing empties both, immediately and in memory', async () => {
        await saveSessions({ s1: {} });

        await clearAllSessions();

        expect(await loadSessions()).toEqual({});
        expect(await loadCurrentSessionId()).toBeNull();
        // A clear is awaited by its caller, so it does not go through the debounce
        expect(storageMock.setJSON.mock.calls.at(-1)[3]).toBe(true);
        expect(storageMock.set.mock.calls.at(-1)[3]).toBe(true);
    });
});

describe('the callers that write through these', () => {
    test('deleting a session writes the remainder', async () => {
        const sessions = { s1: { id: 's1' }, s2: { id: 's2' } };

        await deleteSession(sessions, 's1');

        expect(storageMock.setJSON.mock.calls.at(-1)[1]).toEqual({ s2: { id: 's2' } });
    });

    test('archiving keeps the newest sessions and writes only those', async () => {
        const sessions = Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`s${i}`, { id: `s${i}`, startTime: i }])
        );

        await archiveOldSessions(sessions, 3);

        expect(Object.keys(storageMock.setJSON.mock.calls.at(-1)[1])).toEqual(['s2', 's3', 's4']);
    });

    test('archiving under the limit writes nothing at all', async () => {
        await archiveOldSessions({ s1: { startTime: 1 } }, 3);
        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });
});
