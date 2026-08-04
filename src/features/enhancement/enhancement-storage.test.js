/**
 * Enhancement sessions used to be written as one immediate blob — every session
 * ever kept, rewritten into the settings store on every attempt of a run.
 *
 * These cover what changed: the write is debounced and not awaited, the
 * in-memory mirror means a load during the lag still sees the last save rather
 * than the last flush, and — since the sessions belong to whichever character
 * ran them — every key carries that character's id.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const dataManagerMock = vi.hoisted(() => ({
    currentCharacterId: 'market123',
    currentGameMode: 'standard',
    getCurrentCharacterId: vi.fn(() => dataManagerMock.currentCharacterId),
    getCurrentCharacterGameMode: vi.fn(() => dataManagerMock.currentGameMode),
    on: vi.fn(),
    off: vi.fn(),
}));

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const read = async (key, store = 'settings', fallback = null) => {
        const held = storeFor(store).get(key);
        return held === undefined || held === null ? fallback : held;
    };
    const write = async (key, value, store = 'settings') => {
        storeFor(store).set(key, value);
        return true;
    };
    const mock = {
        stores,
        storeFor,
        get: vi.fn(read),
        getJSON: vi.fn(read),
        set: vi.fn(write),
        setJSON: vi.fn(write),
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
    /** Undo any per-test stub and start from an empty database. */
    mock.reset = () => {
        stores.clear();
        mock.get.mockReset().mockImplementation(read);
        mock.getJSON.mockReset().mockImplementation(read);
        mock.set.mockReset().mockImplementation(write);
        mock.setJSON.mockReset().mockImplementation(write);
        mock.delete.mockReset().mockImplementation(async (key, store = 'settings') => storeFor(store).delete(key));
        mock.getAllKeys
            .mockReset()
            .mockImplementation(async (store = 'settings') => Array.from(storeFor(store).keys()));
    };
    return mock;
});

vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
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

const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const settings = () => storageMock.storeFor('settings');

beforeEach(() => {
    storageMock.reset();
    dataManagerMock.currentCharacterId = 'market123';
    dataManagerMock.currentGameMode = 'standard';
    _resetAdoptionCache();
    resetPendingSessionCache();
});

describe('session writes', () => {
    test('sessions are queued for a debounced write, not written immediately', async () => {
        await saveSessions({ s1: { id: 's1', startTime: 1 } });

        expect(storageMock.set).toHaveBeenCalledTimes(1);
        const [key, value, store, immediate] = storageMock.set.mock.calls[0];
        expect(key).toBe('enhancementTracker_sessions_market123');
        expect(value).toEqual({ s1: { id: 's1', startTime: 1 } });
        expect(store).toBe('settings');
        expect(immediate).toBe(false);
    });

    test('the current session id is queued the same way', async () => {
        await saveCurrentSessionId('s1');

        const [key, value, store, immediate] = storageMock.set.mock.calls[0];
        expect(key).toBe('enhancementTracker_currentSession_market123');
        expect(value).toBe('s1');
        expect(store).toBe('settings');
        expect(immediate).toBe(false);
    });

    test('saving does not wait for the debounce timer', async () => {
        // A `set` that never resolves stands in for the debounced promise, which
        // resolves only when its timer fires — awaiting it would stall the run
        storageMock.set.mockImplementation(() => new Promise(() => {}));

        await expect(saveSessions({ s1: {} })).resolves.toBeUndefined();
    });
});

describe('reads during the debounce lag', () => {
    test('a load returns what was last saved, not what was last flushed', async () => {
        settings().set('enhancementTracker_sessions_market123', { stale: true });

        await saveSessions({ s1: { id: 's1' } });
        storageMock.get.mockClear();

        expect(await loadSessions()).toEqual({ s1: { id: 's1' } });
        expect(storageMock.get).not.toHaveBeenCalled();
    });

    test('with nothing saved yet, a load goes to storage', async () => {
        settings().set('enhancementTracker_sessions_market123', { fromStorage: true });

        expect(await loadSessions()).toEqual({ fromStorage: true });
    });

    test('a current session id of null is remembered as null, not as "nothing saved"', async () => {
        settings().set('enhancementTracker_currentSession_market123', 'stale-id');

        await saveCurrentSessionId(null);
        storageMock.get.mockClear();

        expect(await loadCurrentSessionId()).toBeNull();
        expect(storageMock.get).not.toHaveBeenCalled();
    });

    test('clearing empties both, immediately and in memory', async () => {
        await saveSessions({ s1: {} });

        await clearAllSessions();

        expect(await loadSessions()).toEqual({});
        expect(await loadCurrentSessionId()).toBeNull();
        // A clear is awaited by its caller, so it does not go through the debounce
        const immediateCalls = storageMock.set.mock.calls.filter(([, , , immediate]) => immediate === true);
        expect(immediateCalls.map(([key]) => key)).toEqual([
            'enhancementTracker_sessions_market123',
            'enhancementTracker_currentSession_market123',
        ]);
    });
});

describe('the callers that write through these', () => {
    test('deleting a session writes the remainder', async () => {
        const sessions = { s1: { id: 's1' }, s2: { id: 's2' } };

        await deleteSession(sessions, 's1');

        expect(storageMock.set.mock.calls.at(-1)[1]).toEqual({ s2: { id: 's2' } });
    });

    test('archiving keeps the newest sessions and writes only those', async () => {
        const sessions = Object.fromEntries(
            Array.from({ length: 5 }, (_, i) => [`s${i}`, { id: `s${i}`, startTime: i }])
        );

        await archiveOldSessions(sessions, 3);

        expect(Object.keys(storageMock.set.mock.calls.at(-1)[1])).toEqual(['s2', 's3', 's4']);
    });

    test('archiving under the limit writes nothing at all', async () => {
        await archiveOldSessions({ s1: { startTime: 1 } }, 3);
        expect(storageMock.set).not.toHaveBeenCalled();
    });
});

describe('one character cannot read another character’s sessions', () => {
    test('a load reads this character’s key, not the bare one', async () => {
        settings().set('enhancementTracker_sessions_market123', { mine: {} });
        settings().set('enhancementTracker_sessions_iron456', { theirs: {} });

        expect(await loadSessions()).toEqual({ mine: {} });

        dataManagerMock.currentCharacterId = 'iron456';
        resetPendingSessionCache();
        expect(await loadSessions()).toEqual({ theirs: {} });
    });

    test('the key follows a switch made without a reload', async () => {
        await saveSessions({ s1: {} });
        expect(settings().has('enhancementTracker_sessions_market123')).toBe(true);

        dataManagerMock.currentCharacterId = 'iron456';
        resetPendingSessionCache();
        await saveSessions({ s2: {} });

        expect(settings().get('enhancementTracker_sessions_market123')).toEqual({ s1: {} });
        expect(settings().get('enhancementTracker_sessions_iron456')).toEqual({ s2: {} });
    });

    test('the legacy global sessions are adopted by the main character once', async () => {
        settings().set('enhancementTracker_sessions', { legacy: {} });

        expect(await loadSessions()).toEqual({ legacy: {} });
        expect(settings().get('enhancementTracker_sessions_market123')).toEqual({ legacy: {} });
        expect(settings().has('enhancementTracker_sessions')).toBe(false);
    });

    test('an iron cow starts clean and leaves the legacy sessions for the main', async () => {
        dataManagerMock.currentCharacterId = 'iron456';
        dataManagerMock.currentGameMode = 'ironcow';
        settings().set('enhancementTracker_sessions', { legacy: {} });

        expect(await loadSessions()).toEqual({});
        expect(settings().get('enhancementTracker_sessions')).toEqual({ legacy: {} });
        expect(settings().has('enhancementTracker_sessions_iron456')).toBe(false);
    });

    test('the current session id is scoped and adopted the same way', async () => {
        settings().set('enhancementTracker_currentSession', 's-legacy');

        expect(await loadCurrentSessionId()).toBe('s-legacy');
        expect(settings().get('enhancementTracker_currentSession_market123')).toBe('s-legacy');
        expect(settings().has('enhancementTracker_currentSession')).toBe(false);
    });

    test('the in-memory mirror is dropped when the character changes', async () => {
        await saveSessions({ s1: {} });
        settings().set('enhancementTracker_sessions_iron456', { theirs: {} });

        // The listener the module registers on character_switching
        const [event, handler] = dataManagerMock.on.mock.calls.at(-1);
        expect(event).toBe('character_switching');

        dataManagerMock.currentCharacterId = 'iron456';
        handler();

        expect(await loadSessions()).toEqual({ theirs: {} });
    });
});
