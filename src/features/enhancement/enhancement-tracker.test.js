/**
 * Tests for the enhancement tracker's session bookkeeping around Blessed successes.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    loadSessions: vi.fn(),
    loadCurrentSessionId: vi.fn(),
    saveSessions: vi.fn(async () => true),
    saveCurrentSessionId: vi.fn(async () => true),
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true) },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
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

import { createSession } from './enhancement-session.js';
import enhancementTracker from './enhancement-tracker.js';

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
