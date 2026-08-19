/** @vitest-environment happy-dom */

/**
 * The skill XP history is one record per character, written whole on every
 * action. These cover the ways that used to lose it: a read that could not be
 * made coming back as an empty map and being written over the stored one, and
 * a second tab overwriting the first's samples.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const game = vi.hoisted(() => ({ characterId: 'char1', handlers: {} }));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: null,
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Main',
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: () => {},
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { xpTracker } = await import('./xp-tracker.js');

const KEY = 'xpHistory_char1';
const stored = () => storageMock.storeFor('xpHistory').get(KEY);
const HOUR = 60 * 60 * 1000;

/** An init_character_data payload with one milking sample. */
const init = (charId, t, xp) => ({
    character: { id: charId },
    currentTimestamp: new Date(t).toISOString(),
    characterSkills: [{ skillHrid: '/skills/milking', experience: xp }],
});

/** An action_completed payload with one milking sample. */
const action = (t, xp) => ({
    endCharacterSkills: [{ skillHrid: '/skills/milking', experience: xp, updatedAt: new Date(t).toISOString() }],
});

beforeEach(() => {
    storageMock.reset();
    game.characterId = 'char1';
    xpTracker.history.reset();
    xpTracker.characterId = null;
});

describe('the XP history survives', () => {
    test('a load that cannot read storage keeps what is in memory instead of blanking it', async () => {
        storageMock.storeFor('xpHistory').set(KEY, { milking: [{ t: 1000, xp: 10 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);

        storageMock.unavailable = true;
        // The re-initialise a reconnect does, with storage gone in between
        await xpTracker._onCharacterInit(init('char1', 3 * HOUR, 30));
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([10, 20, 30]);
        // And nothing was written over the stored record while it could not be read
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);
    });

    test('a sample taken while storage is unreadable lands with the next save once it is back', async () => {
        storageMock.storeFor('xpHistory').set(KEY, { milking: [{ t: 1000, xp: 10 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        storageMock.unavailable = true;
        xpTracker._onActionCompleted(action(3 * HOUR, 30));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20]);

        storageMock.unavailable = false;
        xpTracker._onActionCompleted(action(4 * HOUR, 40));
        await xpTracker.history.flushed();
        expect(stored().milking.map((s) => s.xp)).toEqual([10, 20, 30, 40]);
    });

    test('a save folds in samples another tab stored meanwhile', async () => {
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        // The other tab recorded a later sample and a skill this tab never saw
        storageMock.storeFor('xpHistory').set(KEY, {
            milking: [
                { t: 2 * HOUR, xp: 20 },
                { t: 3 * HOUR, xp: 30 },
            ],
            foraging: [{ t: 3 * HOUR, xp: 5 }],
        });

        xpTracker._onActionCompleted(action(4 * HOUR, 40));
        await xpTracker.history.flushed();

        expect(stored().milking.map((s) => s.xp)).toEqual([20, 30, 40]);
        expect(stored().foraging.map((s) => s.xp)).toEqual([5]);
    });

    test('a character switch starts from the new character’s record, not a fold of both', async () => {
        storageMock.storeFor('xpHistory').set('xpHistory_char2', { foraging: [{ t: 1000, xp: 7 }] });
        await xpTracker._onCharacterInit(init('char1', 2 * HOUR, 20));
        await xpTracker.history.flushed();

        game.characterId = 'char2';
        await xpTracker._onCharacterInit(init('char2', 3 * HOUR, 9));
        await xpTracker.history.flushed();

        expect(xpTracker.xpHistory.foraging.map((s) => s.xp)).toEqual([7]);
        expect(xpTracker.xpHistory.milking.map((s) => s.xp)).toEqual([9]);
        const theirs = storageMock.storeFor('xpHistory').get('xpHistory_char2');
        expect(theirs.foraging.map((s) => s.xp)).toEqual([7]);
        expect(theirs.milking.map((s) => s.xp)).toEqual([9]);
        expect(stored().milking.map((s) => s.xp)).toEqual([20]);
    });
});
