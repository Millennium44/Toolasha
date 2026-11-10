import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ owner: 'alice', enabled: true, disk: new Map(), listeners: [], gate: null }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => state.enabled } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.owner,
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, fn) => state.listeners.push([event, fn]),
        off: () => {},
    },
}));
vi.mock('../../core/storage.js', () => {
    async function pause(method, key) {
        const gate = state.gate;
        if (!gate || gate.used || gate.method !== method || gate.key !== key) return;
        gate.used = true;
        gate.entered.resolve();
        await gate.released.promise;
    }
    return {
        default: {
            get: async (key, _store, fallback = null) => {
                const value = state.disk.has(key) ? structuredClone(state.disk.get(key)) : fallback;
                await pause('get', key);
                return value;
            },
            tryGet: async (key) => {
                const value = state.disk.has(key)
                    ? { found: true, value: structuredClone(state.disk.get(key)) }
                    : { found: false, value: null };
                await pause('tryGet', key);
                return value;
            },
            set: async (key, value) => {
                const copy = structuredClone(value);
                await pause('set', key);
                state.disk.set(key, copy);
                const gate = state.gate;
                if (gate?.used && gate.method === 'set' && gate.key === key) gate.completed.resolve();
                return true;
            },
            update: async (key, mutate) => {
                const found = state.disk.has(key);
                const next = mutate(found ? structuredClone(state.disk.get(key)) : undefined, found);
                if (next === undefined) return { written: false, value: state.disk.get(key) };
                state.disk.set(key, structuredClone(next));
                return { written: true, value: next };
            },
            onBeforeTeardown: () => () => {},
        },
    };
});
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: async () => null,
}));
vi.mock('../insights/enhancement-calibration.js', () => ({ default: { recordCompletion: async () => {} } }));
vi.mock('./enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

import { createSession } from './enhancement-session.js';
import { resetPendingSessionCache, flushSessionWrites } from './enhancement-storage.js';
import tracker from './enhancement-tracker.js';

const sessionsKey = (owner) => `enhancementTracker_sessions_${owner}`;
const currentKey = (owner) => `enhancementTracker_currentSession_${owner}`;
function deferred() {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
}
function block(method, key) {
    state.gate = { method, key, used: false, entered: deferred(), released: deferred(), completed: deferred() };
    return state.gate;
}
function seed(owner, id = `${owner}-run`) {
    const session = createSession('/items/cheese_sword', 'Cheese Sword', 10, 15, 12);
    session.id = id;
    state.disk.set(sessionsKey(owner), { [id]: session });
    state.disk.set(currentKey(owner), id);
    return session;
}
function switchTo(owner) {
    tracker.disable();
    for (const [event, fn] of state.listeners) if (event === 'character_switching') fn();
    state.owner = owner;
}

beforeEach(() => {
    tracker.disable();
    resetPendingSessionCache();
    state.owner = 'alice';
    state.enabled = true;
    state.disk.clear();
    state.gate = null;
});
afterEach(() => {
    tracker.disable();
    resetPendingSessionCache();
});

describe('enhancement startup owns its reads and current-session repair', () => {
    test('an old current-ID read cannot clear the arriving character’s saved active session', async () => {
        seed('alice');
        seed('bob');
        const gate = block('get', currentKey('alice'));
        const oldStart = tracker.initialize();
        await gate.entered.promise;
        switchTo('bob');
        await tracker.initialize();
        expect(tracker.currentSessionId).toBe('bob-run');
        gate.released.resolve();
        await oldStart;
        expect(state.disk.get(currentKey('bob'))).toBe('bob-run');
        expect(tracker.currentSessionId).toBe('bob-run');
        expect(tracker.getCurrentSession().id).toBe('bob-run');
    });

    test('a disabled startup does not publish a late session-map read', async () => {
        seed('alice');
        const gate = block('tryGet', sessionsKey('alice'));
        const starting = tracker.initialize();
        await gate.entered.promise;
        tracker.disable();
        gate.released.resolve();
        await starting;
        expect(tracker.isInitialized).toBe(false);
        expect(tracker.sessions).toEqual({});
        expect(tracker.currentSessionId).toBeNull();
    });

    test('a retired same-character read cannot replace the newer active session', async () => {
        seed('alice', 'old-run');
        const gate = block('get', currentKey('alice'));
        const oldStart = tracker.initialize();
        await gate.entered.promise;
        switchTo('alice');
        seed('alice', 'new-run');
        await tracker.initialize();
        gate.released.resolve();
        await oldStart;
        expect(tracker.currentSessionId).toBe('new-run');
        expect(state.disk.get(currentKey('alice'))).toBe('new-run');
    });

    test.each(['tryGet', 'get'])('a changed owner before teardown rejects the pending %s read', async (method) => {
        seed('alice');
        seed('bob');
        const gate = block(method, method === 'tryGet' ? sessionsKey('alice') : currentKey('alice'));
        const starting = tracker.initialize();
        await gate.entered.promise;
        state.owner = 'bob';
        gate.released.resolve();
        await starting;
        expect(tracker.isInitialized).toBe(false);
        expect(tracker.sessions).toEqual({});
        expect(tracker.currentSessionId).toBeNull();
        expect(state.disk.get(currentKey('bob'))).toBe('bob-run');
    });

    test('turning the setting off during a read does not publish loaded data', async () => {
        seed('alice');
        const gate = block('tryGet', sessionsKey('alice'));
        const starting = tracker.initialize();
        await gate.entered.promise;
        state.enabled = false;
        gate.released.resolve();
        await starting;
        expect(tracker.isInitialized).toBe(false);
        expect(tracker.sessions).toEqual({});
    });

    test('a repair queued before disable can finish for its owner without reviving the tracker', async () => {
        seed('alice');
        state.disk.set(currentKey('alice'), 'missing');
        const gate = block('set', currentKey('alice'));
        const starting = tracker.initialize();
        await gate.entered.promise;
        tracker.disable();
        gate.released.resolve();
        await starting;
        await gate.completed.promise;
        expect(state.disk.get(currentKey('alice'))).toBeNull();
        expect(tracker.isInitialized).toBe(false);
        expect(tracker.sessions).toEqual({});
    });

    test('a queued old repair still writes only the old owner after a switch', async () => {
        seed('alice');
        seed('bob');
        state.disk.set(currentKey('alice'), 'missing');
        const gate = block('set', currentKey('alice'));
        const oldStart = tracker.initialize();
        await gate.entered.promise;
        switchTo('bob');
        await tracker.initialize();
        gate.released.resolve();
        await oldStart;
        await gate.completed.promise;
        expect(state.disk.get(currentKey('alice'))).toBeNull();
        expect(state.disk.get(currentKey('bob'))).toBe('bob-run');
        expect(tracker.getCurrentSession().id).toBe('bob-run');
    });

    test('unchanged startup loads the saved session and normalizes it', async () => {
        seed('alice');
        await tracker.initialize();
        expect(tracker.isInitialized).toBe(true);
        expect(tracker.getCurrentSession().id).toBe('alice-run');
        expect(state.disk.get(currentKey('alice'))).toBe('alice-run');
    });

    test('same-character disable and re-enable keep a session update that has not flushed yet', async () => {
        seed('alice');
        await tracker.initialize();
        await tracker.trackCoinCost(123);
        expect(state.disk.get(sessionsKey('alice'))['alice-run'].coinCost).toBe(0);

        tracker.disable();
        await tracker.initialize();
        expect(tracker.getCurrentSession().id).toBe('alice-run');
        expect(tracker.getCurrentSession().coinCost).toBe(123);
        await flushSessionWrites();
        expect(state.disk.get(sessionsKey('alice'))['alice-run'].coinCost).toBe(123);
    });

    test('a genuinely orphaned current-session ID is still cleared', async () => {
        seed('alice');
        state.disk.set(currentKey('alice'), 'missing');
        await tracker.initialize();
        expect(tracker.isInitialized).toBe(true);
        expect(tracker.currentSessionId).toBeNull();
        expect(state.disk.get(currentKey('alice'))).toBeNull();
        expect(Object.keys(tracker.sessions)).toEqual(['alice-run']);
    });
});
