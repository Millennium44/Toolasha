/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, Z_FLOATING_PANEL: 1100 },
}));
const tick = vi.hoisted(() => ({
    status: { capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null },
    calls: [],
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    default: {
        captureStatus: () => ({ ...tick.status }),
        isCapturing: () => tick.status.capturing,
        heldTickCount: () => tick.status.ticks,
        startCapture: (...args) => tick.calls.push(['start', ...args]),
        stopCapture: () => tick.calls.push(['stop']),
        forgetForCharacterSwitch: () => tick.calls.push(['forget']),
        loadAutosave: async () => {
            tick.calls.push(['loadAutosave']);
            return false;
        },
        downloadCapture: () => {
            tick.calls.push(['download']);
            tick.status.savedAt = 123;
            return true;
        },
        clearCapture: () => {
            tick.calls.push(['clear']);
            tick.status = { capturing: false, ticks: 0, seconds: 0, duplicatesDiscarded: 0, savedAt: null };
        },
        captureFile: () => ({ ticks: [] }),
    },
}));
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
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        getJSON: async () => null,
        setJSON: async () => {},
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => null,
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

const { labyrinthRoomLogs, mergeRoomLogs } = await import('./labyrinth-room-logs.js');

// The shape labyrinth_room_progress carries for a skilling room
const msg = (counter, work, over = {}) => ({
    targetLevel: null,
    successRate: 0.8,
    doubleProgressChance: 0.1,
    actionTimeMs: 10000,
    actionCounter: counter,
    currentWorkValue: work,
    targetWorkValue: 100,
    progressPerAction: 10,
    ...over,
});

describe('skilling attempts are logged one per retry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        labyrinthRoomLogs.sessions = [];
        labyrinthRoomLogs.activeSession = null;
        labyrinthRoomLogs.labContext = { runKey: 'run|3', roomKey: '1,2', room: {}, floor: 3 };
        labyrinthRoomLogs.persist = () => Promise.resolve(true);
        labyrinthRoomLogs.renderIfOpen = () => {};
    });
    afterEach(() => {
        labyrinthRoomLogs.activeSession = null;
        labyrinthRoomLogs.labContext = null;
        vi.useRealTimers();
    });

    const play = (steps) => {
        for (const [counter, work] of steps) {
            vi.advanceTimersByTime(10_000);
            labyrinthRoomLogs.onRoomProgress(msg(counter, work));
        }
    };

    test('a counter reset starts a second attempt and scores its first action', () => {
        play([
            [0, 0],
            [1, 10],
            [2, 10],
            [3, 20],
            // retry: the counter falls back to 1 and work restarts
            [1, 10],
            [2, 20],
        ]);
        const attempts = labyrinthRoomLogs.activeSession.attempts;
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toMatchObject({ actions: 3, successes: 2, endWorkValue: 20, cleared: false });
        expect(attempts[0].endedAt).toBeGreaterThan(0);
        expect(attempts[1]).toMatchObject({ actions: 2, successes: 2, endWorkValue: 20, endedAt: 0 });
        expect(attempts[1].actionTimeMs).toBe(10000);
        expect(attempts[1].targetWorkValue).toBe(100);
    });

    test('finishing the room closes the last attempt as cleared', () => {
        play([
            [0, 0],
            [1, 50],
            [2, 100],
        ]);
        labyrinthRoomLogs.finalizeActiveSession('room_complete');
        const attempts = labyrinthRoomLogs.sessions[0].attempts;
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ actions: 2, cleared: true });
        expect(attempts[0].endedAt).toBeGreaterThan(0);
    });

    test('attempts are capped per session', () => {
        for (let i = 0; i < 130; i++)
            play([
                [2, 20],
                [1, 10],
            ]);
        expect(labyrinthRoomLogs.activeSession.attempts).toHaveLength(100);
    });

    test('joining an attempt already under way counts the actions it missed and marks it partial', () => {
        play([
            [5, 50],
            [6, 60],
        ]);
        const [attempt] = labyrinthRoomLogs.activeSession.attempts;
        expect(attempt).toMatchObject({ actions: 6, successes: 1, partial: true });
    });

    test('a skipped batch of actions is counted but not scored, and marks the attempt partial', () => {
        play([
            [0, 0],
            [1, 10],
            [3, 30],
        ]);
        const [attempt] = labyrinthRoomLogs.activeSession.attempts;
        expect(attempt).toMatchObject({ actions: 3, successes: 1, doubles: 0, partial: true });
    });

    test('a retry first seen past its first action is marked partial', () => {
        play([
            [0, 0],
            [1, 10],
            [5, 50],
            // retry, but the first message kept is already at counter 2
            [2, 20],
        ]);
        const attempts = labyrinthRoomLogs.activeSession.attempts;
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toMatchObject({ actions: 2, successes: 0, partial: true });
    });

    test('an attempt seen from its start is not partial', () => {
        play([
            [0, 0],
            [1, 10],
        ]);
        expect(labyrinthRoomLogs.activeSession.attempts[0].partial).toBeUndefined();
    });

    test('a missing actionTimeMs is recorded as null, not guessed', () => {
        labyrinthRoomLogs.onRoomProgress(msg(0, 0, { actionTimeMs: undefined }));
        expect(labyrinthRoomLogs.activeSession.attempts[0].actionTimeMs).toBeNull();
    });
});

describe('the attempt list draws on a card', () => {
    test('two or more attempts draw rows; none, or an old session, draw nothing', () => {
        const base = { mode: 'skilling', startedAt: 1 };
        expect(labyrinthRoomLogs.renderAttemptList(base)).toBeNull();
        const card = labyrinthRoomLogs.renderAttemptList({
            ...base,
            attempts: [
                { startedAt: 1, endedAt: 2, actions: 7, endWorkValue: 80, targetWorkValue: 100, cleared: false },
                { startedAt: 3, endedAt: 4, actions: 9, endWorkValue: 100, targetWorkValue: 100, cleared: true },
            ],
        });
        expect(card.textContent).toContain('#1: 7 actions, 80/100');
        expect(card.textContent).toContain('#2: 9 actions, 100/100 cleared');
    });
});

describe('the room log merge keeps attempts', () => {
    const attempt = (startedAt) => ({ startedAt, endedAt: startedAt + 1, actions: 1 });
    test('the same room on both sides unions its attempts by start time', () => {
        const stored = { sessions: [{ runKey: 'r', startedAt: 5, attempts: [attempt(10), attempt(20)] }] };
        const fresh = { sessions: [{ runKey: 'r', startedAt: 5, attempts: [attempt(20), attempt(30)] }] };
        const merged = mergeRoomLogs(stored, fresh, 10).sessions;
        expect(merged).toHaveLength(1);
        expect(merged[0].attempts.map((a) => a.startedAt)).toEqual([10, 20, 30]);
    });

    test('sessions stored before attempts existed still merge', () => {
        const stored = { sessions: [{ runKey: 'r', startedAt: 5 }] };
        const fresh = { sessions: [{ runKey: 'r', startedAt: 5, attempts: [attempt(10)] }] };
        expect(mergeRoomLogs(stored, fresh, 10).sessions[0].attempts).toHaveLength(1);
        expect(mergeRoomLogs(fresh, stored, 10).sessions[0].attempts).toHaveLength(1);
        expect(mergeRoomLogs(stored, stored, 10).sessions[0].attempts).toBeUndefined();
    });
});
