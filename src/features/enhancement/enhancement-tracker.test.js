/**
 * Tests for the enhancement tracker's session bookkeeping around Blessed successes.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loadSessions: vi.fn(),
    loadCurrentSessionId: vi.fn(),
    saveSessions: vi.fn(async () => true),
    saveCurrentSessionId: vi.fn(async () => true),
    characterId: 'c1',
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true) },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => mocks.characterId,
        getInitClientData: vi.fn(() => ({
            itemDetailMap: {
                '/items/sword': { name: 'Sword' },
            },
        })),
    },
}));

vi.mock('./enhancement-storage.js', () => ({
    loadSessions: mocks.loadSessions,
    loadCurrentSessionId: mocks.loadCurrentSessionId,
    sessionsLoaded: vi.fn(() => true),
    saveSessions: mocks.saveSessions,
    saveCurrentSessionId: mocks.saveCurrentSessionId,
}));

vi.mock('../insights/enhancement-calibration.js', () => ({
    default: { recordCompletion: vi.fn(async () => {}) },
}));

vi.mock('./enhancement-xp.js', () => ({
    calculateEnhancementPredictions: vi.fn(() => null),
}));

vi.mock('./tooltip-enhancement.js', () => ({
    getEnhancementMaterialPrice: vi.fn(() => 0),
}));

import { createSession, SessionState } from './enhancement-session.js';
import enhancementTracker from './enhancement-tracker.js';
import enhancementCalibration from '../insights/enhancement-calibration.js';
import { calculateEnhancementPredictions } from './enhancement-xp.js';

/** Load the singleton fresh with the given session as the current one. */
async function loadWith(session) {
    mocks.loadSessions.mockResolvedValue({ [session.id]: session });
    mocks.loadCurrentSessionId.mockResolvedValue(session.id);
    enhancementTracker.isInitialized = false;
    enhancementTracker.sessions = {};
    enhancementTracker.currentSessionId = null;
    await enhancementTracker.initialize();
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.characterId = 'c1';
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('EnhancementTracker completion ownership', () => {
    test('keeps a new session active while recording the previous completed run', async () => {
        const finished = createSession('/items/sword', 'Sword', 0, 1, 0);
        finished.id = 'finished';
        await loadWith(finished);
        const saving = deferred();
        mocks.saveSessions.mockReturnValueOnce(saving.promise);

        const completion = enhancementTracker.recordSuccess(0, 1);
        const nextId = await enhancementTracker.startSession('/items/sword', 1, 3);
        mocks.saveCurrentSessionId.mockClear();
        saving.resolve();
        await completion;

        expect(enhancementTracker.currentSessionId).toBe(nextId);
        expect(mocks.saveCurrentSessionId).not.toHaveBeenCalledWith(null);
        expect(enhancementCalibration.recordCompletion).toHaveBeenCalledWith(finished);
    });

    test.each(['saveSessions', 'saveCurrentSessionId'])(
        'does not finish the departing character after waiting for %s',
        async (saveMethod) => {
            const finished = createSession('/items/sword', 'Sword', 0, 1, 0);
            await loadWith(finished);
            const saving = deferred();
            const entered = deferred();
            mocks[saveMethod].mockImplementationOnce(() => {
                entered.resolve();
                return saving.promise;
            });

            const completion = enhancementTracker.recordSuccess(0, 1);
            await entered.promise;
            enhancementTracker.disable();
            mocks.characterId = 'c2';
            const arriving = createSession('/items/sword', 'Sword', 3, 5, 0);
            await loadWith(arriving);
            mocks.saveCurrentSessionId.mockClear();
            saving.resolve();
            await completion;

            expect(enhancementTracker.getCurrentSession()).toBe(arriving);
            expect(mocks.saveCurrentSessionId).not.toHaveBeenCalled();
            expect(enhancementCalibration.recordCompletion).not.toHaveBeenCalled();
            expect(finished.state).toBe(SessionState.COMPLETED);
        }
    );

    test('finalizing an old session does not clear a session started during its save', async () => {
        const previous = createSession('/items/sword', 'Sword', 0, 5, 0);
        previous.id = 'previous';
        await loadWith(previous);
        const saving = deferred();
        mocks.saveSessions.mockReturnValueOnce(saving.promise);
        const finalizing = enhancementTracker.finalizeCurrentSession();
        const nextId = await enhancementTracker.startSession('/items/sword', 1, 3);
        mocks.saveCurrentSessionId.mockClear();

        saving.resolve();
        await finalizing;

        expect(enhancementTracker.currentSessionId).toBe(nextId);
        expect(mocks.saveCurrentSessionId).not.toHaveBeenCalled();
    });

    test('keeps an extended session active and calibrates the leg that actually finished', async () => {
        const session = createSession('/items/sword', 'Sword', 0, 1, 0);
        await loadWith(session);
        const saving = deferred();
        mocks.saveSessions.mockReturnValueOnce(saving.promise);
        const completion = enhancementTracker.recordSuccess(0, 1);
        await enhancementTracker.extendSessionTarget(session.id, 3);
        mocks.saveCurrentSessionId.mockClear();

        saving.resolve();
        await completion;

        expect(enhancementTracker.getCurrentSession()).toBe(session);
        expect(mocks.saveCurrentSessionId).not.toHaveBeenCalled();
        expect(enhancementCalibration.recordCompletion).toHaveBeenCalledWith(
            expect.objectContaining({ id: session.id, targetLevel: 1, currentLevel: 1, state: SessionState.COMPLETED })
        );
    });
});

describe('EnhancementTracker Blessed tracking', () => {
    test('passes wasBlessed through to the session so a +2 success is tracked as Blessed', async () => {
        await loadWith(createSession('/items/sword', 'Sword', 0, 10, 0));

        await enhancementTracker.recordSuccess(0, 2, true);

        const session = enhancementTracker.getCurrentSession();
        expect(session.totalBlessed).toBe(1);
        expect(session.totalSuccesses).toBe(1);
        expect(session.totalAttempts).toBe(1);
        expect(session.attemptsPerLevel[0].blessed).toBe(1);
    });

    test('a plain +1 success is not tracked as Blessed', async () => {
        await loadWith(createSession('/items/sword', 'Sword', 0, 10, 0));

        await enhancementTracker.recordSuccess(0, 1);

        expect(enhancementTracker.getCurrentSession().totalBlessed).toBe(0);
    });

    test('normalizes an older session loaded without a Blessed field to zero, not undefined', async () => {
        const legacySession = createSession('/items/sword', 'Sword', 0, 5, 0);
        delete legacySession.totalBlessed;
        legacySession.attemptsPerLevel[0] = { success: 3, fail: 1, successRate: 0.75 };

        await loadWith(legacySession);

        const session = enhancementTracker.getCurrentSession();
        expect(session.totalBlessed).toBe(0);
        expect(session.attemptsPerLevel[0].blessed).toBe(0);
    });
});

describe('EnhancementTracker.disable() — character switch teardown', () => {
    test('clears sessions, the current session id, and a pending-start flag left over from the departing character', async () => {
        // Reproduces: actions_updated flags a pending start for character A's
        // still-running queue, then the user switches characters before the
        // action_completed that would have consumed the flag arrives. Without
        // resetting it here, character B inherits a stale "always start a new
        // session" flag: their first attempt with no active session takes the
        // shouldStartNew path (which always creates a fresh session) instead of
        // the normal path that tries to extend a matching completed session
        // first — fragmenting what should have been one continued run.
        await loadWith(createSession('/items/sword', 'Sword', 0, 10, 0));
        enhancementTracker.setPendingStart();
        expect(enhancementTracker.pendingSessionStart).toBe(true);

        enhancementTracker.disable();

        expect(enhancementTracker.pendingSessionStart).toBe(false);
        expect(enhancementTracker.getCurrentSession()).toBeNull();
        expect(enhancementTracker.getAllSessions()).toEqual({});
        expect(enhancementTracker.isInitialized).toBe(false);
    });
});

describe('EnhancementTracker material costs', () => {
    test('a unit cost handed in is used as given; otherwise the material price rules apply', async () => {
        const session = createSession('/items/sword', 'Sword', 8, 10, 0);
        await loadWith(session);

        // A mirror attempt's +7 copy is not priced by the +0 material rules
        await enhancementTracker.trackMaterialCost('/items/sword', 1, 5000);
        await enhancementTracker.trackMaterialCost('/items/sword', 2);

        const tracked = enhancementTracker.getCurrentSession().materialCosts['/items/sword'];
        expect(tracked).toEqual({ count: 3, totalCost: 5000 });
    });
});

describe('merging sessions into one', () => {
    /** #7 ended at +3, #8 running from +3; stored as the tracker holds them */
    async function loadSpatulaRuns() {
        const seven = createSession('/items/sword', 'Sword', 0, 8, 5);
        Object.assign(seven, {
            id: 'session_7',
            state: SessionState.COMPLETED,
            startTime: 1_000_000,
            endTime: 1_600_000,
            lastAttempt: { attemptNumber: 466, level: 3, timestamp: 1_600_000, actionId: 'a7', currentCount: 466 },
            lastUpdateTime: 1_600_000,
            currentLevel: 3,
            totalAttempts: 466,
            totalXP: 9000,
            predictions: { expectedAttempts: 400 },
        });
        const eight = createSession('/items/sword', 'Sword', 3, 8, 5);
        Object.assign(eight, {
            id: 'session_8',
            startTime: 5_000_000,
            lastUpdateTime: 5_100_000,
            lastAttempt: { attemptNumber: 10, level: 4, timestamp: 5_100_000, actionId: 'a8', currentCount: 10 },
            currentLevel: 4,
            totalAttempts: 10,
            totalXP: 200,
        });
        mocks.loadSessions.mockResolvedValue({ session_7: seven, session_8: eight });
        mocks.loadCurrentSessionId.mockResolvedValue('session_8');
        enhancementTracker.isInitialized = false;
        enhancementTracker.sessions = {};
        enhancementTracker.currentSessionId = null;
        await enhancementTracker.initialize();
        return { seven, eight };
    }

    test('the originals are removed and the live session stays current, keeping its object', async () => {
        const { eight } = await loadSpatulaRuns();
        const result = await enhancementTracker.mergeSessionsIntoOne(['session_7', 'session_8']);

        expect(result).toEqual({ ok: true, id: 'session_8' });
        expect(Object.keys(enhancementTracker.sessions)).toEqual(['session_8']);
        expect(enhancementTracker.currentSessionId).toBe('session_8');
        expect(enhancementTracker.getCurrentSession()).toBe(eight);
        expect(eight.totalAttempts).toBe(476);
        expect(eight.totalXP).toBe(9200);
        expect(eight.startLevel).toBe(0);
        expect(mocks.saveSessions).toHaveBeenLastCalledWith({ session_8: eight });

        // Later attempts land on the merged session
        await enhancementTracker.recordFailure(4, 3);
        expect(eight.totalAttempts).toBe(477);
    });

    test('the prediction is recomputed from the merged start state', async () => {
        await loadSpatulaRuns();
        calculateEnhancementPredictions.mockReturnValueOnce({ expectedAttempts: 520 });
        await enhancementTracker.mergeSessionsIntoOne(['session_7', 'session_8']);
        expect(calculateEnhancementPredictions).toHaveBeenCalledWith('/items/sword', 0, 8, 5);
        expect(enhancementTracker.getSession('session_8').predictions).toEqual({ expectedAttempts: 520 });
    });

    test('with no prediction to compute, the earliest session prediction is kept', async () => {
        await loadSpatulaRuns();
        await enhancementTracker.mergeSessionsIntoOne(['session_7', 'session_8']);
        expect(enhancementTracker.getSession('session_8').predictions).toEqual({ expectedAttempts: 400 });
    });

    test('an older session still in progress is refused and nothing changes', async () => {
        const { seven } = await loadSpatulaRuns();
        seven.state = SessionState.TRACKING;
        const result = await enhancementTracker.mergeSessionsIntoOne(['session_7', 'session_8']);
        expect(result.ok).toBe(false);
        expect(Object.keys(enhancementTracker.sessions)).toEqual(['session_7', 'session_8']);
        expect(mocks.saveSessions).not.toHaveBeenCalled();
    });
});

describe('calibration after a merge', () => {
    /**
     * One chain of runs on one sword. #7 climbed +0 toward +8: it reached it (recorded then under
     * #7's own id) or stopped at +6. After a completed #7, #7b aimed for +10 from +8 and stopped
     * back at +6. #8 runs on from +6.
     */
    async function loadMergedChain({ sevenReachedTarget, eightTarget = 8, eightPredictions = null }) {
        const seven = createSession('/items/sword', 'Sword', 0, 8, 5);
        Object.assign(seven, {
            id: 'session_7',
            state: SessionState.COMPLETED,
            startTime: 1_000_000,
            endTime: 1_600_000,
            lastUpdateTime: 1_600_000,
            lastAttempt: { attemptNumber: 466, level: 8, timestamp: 1_600_000, actionId: 'a7', currentCount: 466 },
            currentLevel: sevenReachedTarget ? 8 : 6,
            totalAttempts: 466,
        });
        const stored = { session_7: seven };
        if (sevenReachedTarget) {
            const between = createSession('/items/sword', 'Sword', 8, 10, 5);
            Object.assign(between, {
                id: 'session_7b',
                state: SessionState.COMPLETED,
                startTime: 2_000_000,
                endTime: 2_600_000,
                lastUpdateTime: 2_600_000,
                lastAttempt: { attemptNumber: 40, level: 6, timestamp: 2_600_000, actionId: 'a7b', currentCount: 40 },
                currentLevel: 6,
                totalAttempts: 40,
            });
            stored.session_7b = between;
        }
        const eight = createSession('/items/sword', 'Sword', 6, eightTarget, 5);
        Object.assign(eight, {
            id: 'session_8',
            startTime: 5_000_000,
            lastUpdateTime: 5_100_000,
            lastAttempt: { attemptNumber: 10, level: 7, timestamp: 5_100_000, actionId: 'a8', currentCount: 10 },
            currentLevel: 7,
            totalAttempts: 10,
            predictions: eightPredictions,
        });
        stored.session_8 = eight;
        mocks.loadSessions.mockResolvedValue(stored);
        mocks.loadCurrentSessionId.mockResolvedValue('session_8');
        enhancementTracker.isInitialized = false;
        enhancementTracker.sessions = {};
        enhancementTracker.currentSessionId = null;
        await enhancementTracker.initialize();
        const result = await enhancementTracker.mergeSessionsIntoOne(Object.keys(stored));
        expect(result.ok).toBe(true);
    }

    test("reaching an already-recorded target again records #8's own leg alone", async () => {
        await loadMergedChain({ sevenReachedTarget: true, eightPredictions: { expectedAttempts: 12 } });
        await enhancementTracker.recordSuccess(7, 8);
        expect(enhancementCalibration.recordCompletion).toHaveBeenCalledTimes(1);
        const observation = enhancementCalibration.recordCompletion.mock.calls[0][0];
        expect(observation.targetLevel).toBe(8);
        expect(observation.predictions).toEqual({ expectedAttempts: 12 });
        // #8's ten attempts and the one that finished it — not #7's 466 or #7b's 40
        expect(observation.totalAttempts - observation.extensionBaseline.totalAttempts).toBe(11);
    });

    test('with no prediction of its own, that leg is not recorded rather than counted twice', async () => {
        await loadMergedChain({ sevenReachedTarget: true });
        await enhancementTracker.recordSuccess(7, 8);
        expect(enhancementCalibration.recordCompletion).not.toHaveBeenCalled();
    });

    test('a completed +8 in the chain still leaves a distinct +10 observation', async () => {
        await loadMergedChain({ sevenReachedTarget: true, eightTarget: 10 });
        await enhancementTracker.recordSuccess(7, 8);
        await enhancementTracker.recordSuccess(8, 9);
        await enhancementTracker.recordSuccess(9, 10);
        expect(enhancementCalibration.recordCompletion).toHaveBeenCalledTimes(1);
        expect(enhancementCalibration.recordCompletion.mock.calls[0][0].targetLevel).toBe(10);
    });

    test('a merge of runs that never reached their target is recorded as one observation', async () => {
        await loadMergedChain({ sevenReachedTarget: false });
        await enhancementTracker.recordSuccess(7, 8);
        expect(enhancementCalibration.recordCompletion).toHaveBeenCalledTimes(1);
    });
});

describe('merging only runs that continue each other', () => {
    test('two independent climbs are refused with the panel numbers, and nothing changes', async () => {
        const seven = createSession('/items/sword', 'Sword', 0, 5, 0);
        Object.assign(seven, {
            id: 'session_7',
            state: SessionState.COMPLETED,
            startTime: 1_000_000,
            endTime: 1_600_000,
            lastUpdateTime: 1_600_000,
            lastAttempt: { attemptNumber: 50, level: 5, timestamp: 1_600_000, actionId: 'a7', currentCount: 50 },
            currentLevel: 5,
            totalAttempts: 50,
        });
        const eight = createSession('/items/sword', 'Sword', 0, 5, 0);
        Object.assign(eight, {
            id: 'session_8',
            state: SessionState.COMPLETED,
            startTime: 5_000_000,
            endTime: 5_600_000,
            lastUpdateTime: 5_600_000,
            lastAttempt: { attemptNumber: 60, level: 5, timestamp: 5_600_000, actionId: 'a8', currentCount: 60 },
            currentLevel: 5,
            totalAttempts: 60,
        });
        mocks.loadSessions.mockResolvedValue({ session_7: seven, session_8: eight });
        mocks.loadCurrentSessionId.mockResolvedValue(null);
        enhancementTracker.isInitialized = false;
        enhancementTracker.sessions = {};
        enhancementTracker.currentSessionId = null;
        await enhancementTracker.initialize();

        const result = await enhancementTracker.mergeSessionsIntoOne(['session_7', 'session_8']);
        expect(result).toEqual({
            ok: false,
            reason: '#1 ended at +5 but #2 started at +0 — only runs that continue each other can merge.',
        });
        expect(Object.keys(enhancementTracker.sessions)).toEqual(['session_7', 'session_8']);
        expect(seven.totalAttempts).toBe(50);
        expect(eight.totalAttempts).toBe(60);
    });
});
