/** @vitest-environment happy-dom */

/**
 * The live-session writer and its read-side checks.
 *
 * The trackers decide which run a saved session is; what is worth asserting
 * here is everything that must hold whichever tracker is using it: a write is
 * throttled rather than per tick, a page going away writes at once, a key that
 * moved between the change and the write drops it, and a saved session is only
 * ever handed to the same character inside twenty minutes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ data: new Map(), sets: [], deletes: [], settings: {} }));

vi.mock('../core/storage.js', () => ({
    default: {
        get: async (key, storeName, fallback) => {
            const id = `${storeName}:${key}`;
            return disk.data.has(id) ? structuredClone(disk.data.get(id)) : fallback;
        },
        set: (key, value, storeName, immediate) => {
            disk.sets.push({ key, value: structuredClone(value), storeName, immediate });
            disk.data.set(`${storeName}:${key}`, structuredClone(value));
            return Promise.resolve(true);
        },
        delete: async (key, storeName) => {
            disk.deletes.push({ key, storeName });
            disk.data.delete(`${storeName}:${key}`);
            return true;
        },
    },
}));
vi.mock('../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in disk.settings ? disk.settings[key] : fallback) },
}));

const {
    createLiveSessionPersister,
    isRestorable,
    liveSessionKey,
    loadLiveSession,
    mergeCounts,
    LIVE_SESSION_MAX_AGE_MS,
    LIVE_SESSION_PERSIST_MS,
    LIVE_SESSION_VERSION,
} = await import('./live-session-persist.js');

const T0 = Date.parse('2026-09-12T12:00:00Z');

beforeEach(() => {
    disk.data.clear();
    disk.sets.length = 0;
    disk.deletes.length = 0;
    disk.settings = {};
    vi.useFakeTimers();
    vi.setSystemTime(T0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('keys', () => {
    test('one per character, and device-local', () => {
        expect(liveSessionKey('Damage', 42)).toBe('toolasha_local_liveDamage_42');
        // The prefix the backup and the sync strip in every store
        expect(liveSessionKey('Damage', 42).startsWith('toolasha_local_')).toBe(true);
        expect(liveSessionKey('Damage', 42)).not.toBe(liveSessionKey('Damage', 43));
    });

    test('no character, no key', () => {
        expect(liveSessionKey('Damage', null)).toBeNull();
        expect(liveSessionKey('Damage', undefined)).toBeNull();
        expect(liveSessionKey('Damage', '')).toBeNull();
    });
});

describe('isRestorable', () => {
    const saved = (overrides = {}) => ({
        v: LIVE_SESSION_VERSION,
        kind: 'damage',
        characterId: 42,
        savedAt: T0,
        ...overrides,
    });

    test('the same character, the same kind, inside twenty minutes', () => {
        expect(isRestorable(saved(), { kind: 'damage', characterId: 42, now: T0 + 60_000 })).toBe(true);
        expect(isRestorable(saved(), { kind: 'damage', characterId: '42', now: T0 })).toBe(true);
    });

    test('twenty minutes is the edge', () => {
        const at = (now) => isRestorable(saved(), { kind: 'damage', characterId: 42, now });
        expect(at(T0 + LIVE_SESSION_MAX_AGE_MS)).toBe(true);
        expect(at(T0 + LIVE_SESSION_MAX_AGE_MS + 1)).toBe(false);
    });

    test('another character’s session is never restorable', () => {
        expect(isRestorable(saved(), { kind: 'damage', characterId: 43, now: T0 })).toBe(false);
        expect(isRestorable(saved(), { kind: 'damage', characterId: null, now: T0 })).toBe(false);
    });

    test('another kind, another version, or a stamp from the future is not', () => {
        expect(isRestorable(saved(), { kind: 'taken', characterId: 42, now: T0 })).toBe(false);
        expect(isRestorable(saved({ v: 0 }), { kind: 'damage', characterId: 42, now: T0 })).toBe(false);
        expect(isRestorable(saved({ savedAt: T0 + 5 * 60_000 }), { kind: 'damage', characterId: 42, now: T0 })).toBe(
            false
        );
        expect(isRestorable(null, { kind: 'damage', characterId: 42, now: T0 })).toBe(false);
    });
});

describe('mergeCounts', () => {
    test('numbers add all the way down', () => {
        const target = { 0: { damage: 10, hits: 1, byAbility: { auto: { damage: 10, hits: 1 } } } };
        mergeCounts(target, { 0: { damage: 5, hits: 2, byAbility: { auto: { damage: 5 }, fireball: { damage: 3 } } } });
        expect(target).toEqual({
            0: { damage: 15, hits: 3, byAbility: { auto: { damage: 15, hits: 1 }, fireball: { damage: 3 } } },
        });
    });

    test('a range keeps its extremes, and an empty range takes the other side’s', () => {
        const target = { Eye: { damage: 10, min: 4, max: 6 }, Veyes: { damage: 0, min: null, max: null } };
        mergeCounts(target, { Eye: { damage: 9, min: 2, max: 7 }, Veyes: { damage: 3, min: 3, max: 3 } });
        expect(target.Eye).toEqual({ damage: 19, min: 2, max: 7 });
        expect(target.Veyes).toEqual({ damage: 3, min: 3, max: 3 });
    });

    test('the source is left as it was', () => {
        const source = { 0: { damage: 5, byAbility: { auto: { damage: 5 } } } };
        const copy = structuredClone(source);
        mergeCounts({}, source);
        mergeCounts({ 0: { damage: 1, byAbility: {} } }, source);
        expect(source).toEqual(copy);
    });
});

describe('the writer', () => {
    /** Every writer a test made, so none is left listening to the next test's window */
    const made = [];

    afterEach(() => {
        for (const persister of made.splice(0)) persister.stop({ flush: false });
    });

    /** A tracker whose session is a counter, and whose key is a character */
    const tracker = () => {
        const held = { characterId: 42, count: 0 };
        const persister = createLiveSessionPersister({
            storeName: 'combatStats',
            kind: 'damage',
            keyFor: () => liveSessionKey('Damage', held.characterId),
            serialize: () => (held.count ? { characterId: held.characterId, count: held.count } : null),
        });
        made.push(persister);
        return { held, persister };
    };

    test('a run of changes is one write per interval, not one per change', () => {
        const { held, persister } = tracker();
        persister.start();

        for (let i = 0; i < 30; i++) {
            held.count += 1;
            persister.note();
            vi.advanceTimersByTime(100);
        }
        // Three seconds of ticks: nothing written yet
        expect(disk.sets).toHaveLength(0);

        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(1);
        expect(disk.sets[0]).toMatchObject({ key: 'toolasha_local_liveDamage_42', storeName: 'combatStats' });
        // Immediate, because the throttle already is the batching
        expect(disk.sets[0].immediate).toBe(true);
        expect(disk.sets[0].value).toMatchObject({
            count: 30,
            kind: 'damage',
            v: LIVE_SESSION_VERSION,
            // One interval after the first change, carrying every change since
            savedAt: T0 + LIVE_SESSION_PERSIST_MS,
        });
        persister.stop();
    });

    test('no change waits longer than one interval to be written', () => {
        const { held, persister } = tracker();
        persister.start();
        held.count = 1;
        persister.note();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(1);

        vi.advanceTimersByTime(1000);
        held.count = 2;
        persister.note();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS - 1);
        expect(disk.sets).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(disk.sets).toHaveLength(2);
        persister.stop();
    });

    test('the page going away writes at once', () => {
        const { held, persister } = tracker();
        persister.start();
        held.count = 7;
        persister.note();

        window.dispatchEvent(new Event('beforeunload'));
        expect(disk.sets).toHaveLength(1);
        expect(disk.sets[0].value.count).toBe(7);

        // …once: nothing changed since, so `pagehide` has nothing to add
        window.dispatchEvent(new Event('pagehide'));
        expect(disk.sets).toHaveLength(1);

        held.count = 8;
        persister.note();
        window.dispatchEvent(new Event('pagehide'));
        expect(disk.sets).toHaveLength(2);
        persister.stop();
    });

    test('a key that moved between the change and the write drops the write', () => {
        // A character switch: what is in memory by the time the timer fires is
        // not the session the change belonged to, and filing it under either
        // character would be wrong
        const { held, persister } = tracker();
        persister.start();
        held.count = 5;
        persister.note();
        held.characterId = 43;
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(0);
        persister.stop();
    });

    test('nothing is written with the setting off, and nothing read', async () => {
        disk.settings.combatSessionRestore = false;
        const { held, persister } = tracker();
        persister.start();
        held.count = 3;
        persister.note();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(0);

        disk.data.set('combatStats:toolasha_local_liveDamage_42', { count: 1 });
        expect(await loadLiveSession('toolasha_local_liveDamage_42', 'combatStats')).toBeNull();
        persister.stop();
    });

    test('an empty session is not written', () => {
        const { persister } = tracker();
        persister.start();
        persister.note();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(0);
        persister.stop();
    });

    test('stopping writes what is pending, then stops listening', () => {
        const { held, persister } = tracker();
        persister.start();
        held.count = 4;
        persister.note();
        persister.stop();
        expect(disk.sets).toHaveLength(1);

        held.count = 9;
        persister.note();
        window.dispatchEvent(new Event('beforeunload'));
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.sets).toHaveLength(1);
    });

    test('discard deletes the saved session and whatever was pending', () => {
        const { held, persister } = tracker();
        persister.start();
        held.count = 2;
        persister.note();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        held.count = 3;
        persister.note();

        persister.discard();
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(disk.deletes).toEqual([{ key: 'toolasha_local_liveDamage_42', storeName: 'combatStats' }]);
        expect(disk.sets).toHaveLength(1);
        persister.stop();
    });
});
