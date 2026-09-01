/**
 * The enhancement observation recorder, with storage faked around it.
 *
 * The load-bearing rules are what gets declined: a session stopped by hand is
 * censored rather than finished, a session predicted without its distribution
 * has nothing to be a percentile of, and an extended session must be measured
 * on its current leg — the earlier legs were draws against earlier predictions.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char-1',
    calibrationOn: true,
    stored: {},
    unavailable: false,
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => game.calibrationOn } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => game.stored[`${store}:${key}`] ?? fallback,
        tryGet: async (key, store) => {
            if (game.unavailable) return null;
            const value = game.stored[`${store}:${key}`];
            return value == null ? { found: false, value: null } : { found: true, value: structuredClone(value) };
        },
        set: async (key, value, store) => {
            if (game.unavailable) return false;
            game.stored[`${store}:${key}`] = structuredClone(value);
            return true;
        },
        delete: async (key, store) => {
            delete game.stored[`${store}:${key}`];
            return true;
        },
        getAllKeys: async (store) =>
            Object.keys(game.stored)
                .filter((k) => k.startsWith(`${store}:`))
                .map((k) => k.slice(store.length + 1)),
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char-1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.characterId },
}));

const { EnhancementCalibration } = await import('./enhancement-calibration.js');

/**
 * A completed session whose prediction carries its distribution.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object}
 */
function completedSession(overrides = {}) {
    return {
        id: 'session_1',
        state: 'completed',
        itemHrid: '/items/cheese_sword',
        itemName: 'Cheese Sword',
        startLevel: 0,
        currentLevel: 5,
        targetLevel: 5,
        protectFrom: 0,
        totalAttempts: 12,
        protectionCount: 0,
        extensionBaseline: null,
        endTime: Date.parse('2026-08-04T12:00:00Z'),
        predictions: { expectedAttemptsExact: 10, expectedAttempts: 10, attemptsVariance: 30, minAttempts: 5 },
        ...overrides,
    };
}

let calibration;

// `game` is one fixture object shared by every test in the file, so each field a
// test moves — the storage outage, the active character — has to come back here
// rather than at the end of the test that moved it: an outage left switched on
// silently turns every later `storage.set` into a no-op.
beforeEach(() => {
    game.stored = {};
    game.calibrationOn = true;
    game.unavailable = false;
    game.characterId = 'char-1';
    calibration = new EnhancementCalibration();
});

describe('recording a completed session', () => {
    test('writes the observation as a tail probability, not a difference', async () => {
        expect(await calibration.recordCompletion(completedSession())).toBe(true);

        const [record] = await calibration.getRecords();
        expect(record).toMatchObject({
            id: 'session_1:5',
            itemHrid: '/items/cheese_sword',
            targetLevel: 5,
            expectedAttempts: 10,
            observedAttempts: 12,
        });
        expect(record.tailProbability).toBeGreaterThan(0);
        expect(record.tailProbability).toBeLessThan(1);
        // Persisted under this character's own key
        expect(game.stored['lootLogHistory:calibrationEnhancing_char-1']).toHaveLength(1);
    });

    test('declines a session still tracking, or stopped short of its target', async () => {
        expect(await calibration.recordCompletion(completedSession({ state: 'tracking' }))).toBe(false);
        // Finalized by hand at +3 of 5: censored, not a draw from the distribution
        expect(await calibration.recordCompletion(completedSession({ currentLevel: 3 }))).toBe(false);
        expect(await calibration.getRecords()).toHaveLength(0);
    });

    test('declines a prediction that carries no distribution', async () => {
        const old = completedSession({ predictions: { expectedAttempts: 10 } });
        expect(await calibration.recordCompletion(old)).toBe(false);

        expect(await calibration.recordCompletion(completedSession({ predictions: null }))).toBe(false);
    });

    test('measures an extended session on its current leg only', async () => {
        // 40 attempts over the whole session, 25 of them before the extension —
        // the prediction was recomputed at extend time, so the draw is the 15
        const extended = completedSession({
            totalAttempts: 40,
            extensionBaseline: { totalAttempts: 25, protectionCount: 0 },
            targetLevel: 7,
            currentLevel: 7,
        });
        await calibration.recordCompletion(extended);

        expect((await calibration.getRecords())[0].observedAttempts).toBe(15);
    });

    test('does not write the same completion twice', async () => {
        await calibration.recordCompletion(completedSession());
        expect(await calibration.recordCompletion(completedSession())).toBe(false);
        expect(await calibration.getRecords()).toHaveLength(1);
    });

    test('an extension of the same session is its own observation', async () => {
        await calibration.recordCompletion(completedSession());
        await calibration.recordCompletion(
            completedSession({
                targetLevel: 7,
                currentLevel: 7,
                totalAttempts: 30,
                extensionBaseline: { totalAttempts: 12, protectionCount: 0 },
            })
        );

        expect(await calibration.getRecords()).toHaveLength(2);
    });

    test('writes nothing when the feature is off', async () => {
        game.calibrationOn = false;
        expect(await calibration.recordCompletion(completedSession())).toBe(false);
    });

    test('drops the oldest observations rather than growing without end', async () => {
        calibration.records = Array.from({ length: 200 }, (_, i) => ({ id: `old-${i}`, t: i }));
        await calibration.recordCompletion(completedSession());

        const records = await calibration.getRecords();
        expect(records).toHaveLength(200);
        expect(records[0].id).toBe('old-1');
        expect(records[records.length - 1].id).toBe('session_1:5');
    });
});

describe('the observations survive a failed read and a second tab', () => {
    const KEY = 'lootLogHistory:calibrationEnhancing_char-1';
    const ids = (list) => list.map((r) => r.id);

    test('a load that cannot read storage keeps the observations in memory', async () => {
        await calibration.recordCompletion(completedSession());
        game.unavailable = true;
        calibration.store.reset();

        await calibration._load();

        expect(ids(await calibration.getRecords())).toEqual(['session_1:5']);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        await calibration.recordCompletion(completedSession());
        game.unavailable = true;

        await calibration.recordCompletion(completedSession({ id: 'session_2' }));

        game.unavailable = false;
        expect(ids(game.stored[KEY])).toEqual(['session_1:5']);
        expect(ids(await calibration.getRecords())).toEqual(['session_1:5', 'session_2:5']);
    });

    test('a save folds in observations another tab wrote meanwhile', async () => {
        await calibration.recordCompletion(completedSession({ endTime: 1 }));
        game.stored[KEY] = [...game.stored[KEY], { id: 'theirs', t: 3 }];

        await calibration.recordCompletion(completedSession({ id: 'session_2', endTime: 2 }));

        expect(ids(game.stored[KEY])).toEqual(['session_1:5', 'session_2:5', 'theirs']);
        expect(ids(await calibration.getRecords())).toEqual(['session_1:5', 'session_2:5', 'theirs']);
    });

    test('once storage reads again the next save lands everything', async () => {
        game.unavailable = true;
        await calibration.recordCompletion(completedSession({ endTime: 1 }));
        await calibration.recordCompletion(completedSession({ id: 'session_2', endTime: 2 }));
        expect(game.stored[KEY]).toBeUndefined();

        game.unavailable = false;
        await calibration.recordCompletion(completedSession({ id: 'session_3', endTime: 3 }));

        expect(ids(game.stored[KEY])).toEqual(['session_1:5', 'session_2:5', 'session_3:5']);
    });

    test('a character switch forgets the departing character’s observations', async () => {
        await calibration.recordCompletion(completedSession());
        game.characterId = 'char-2';

        await calibration.recordCompletion(completedSession({ id: 'session_9' }));

        expect(ids(game.stored['lootLogHistory:calibrationEnhancing_char-2'])).toEqual(['session_9:5']);
        expect(ids(game.stored[KEY])).toEqual(['session_1:5']);
    });

    test('disable() clears getCachedRecords() immediately, before any new session completes', async () => {
        // getCachedRecords() (unlike getRecords()/recordCompletion()) reads
        // `this.records` straight from memory without going through the
        // owner check in _store(). insights/index.js calls disable() on
        // character_switching so a panel reading the cache right after a
        // switch — before the arriving character has completed any
        // enhancement session of their own — never shows the departing
        // character's observations under the new character's name.
        await calibration.recordCompletion(completedSession());
        expect(ids(calibration.getCachedRecords())).toEqual(['session_1:5']);

        game.characterId = 'char-2';
        calibration.disable();

        expect(calibration.getCachedRecords()).toBeNull();
    });
});
