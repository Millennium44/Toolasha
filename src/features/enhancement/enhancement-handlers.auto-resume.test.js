/**
 * Auto-resume, end to end through the real tracker and session code: a run that stopped short of
 * its target, followed by a new run of the same item, target and protection that starts at exactly
 * the level the last one ended at, continues the old session instead of opening a new one.
 *
 * The messages are shaped as the game sends them: the queue row (actions_updated) carries the
 * item hash with the level the run starts from, and each action_completed carries the level the
 * attempt ended at.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    handlers: {},
    actions: [],
    settings: { enhancementTracker: true, enhancementTracker_autoResume: true },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => state.settings[key] } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/holy_spatula': {
                    name: 'Holy Spatula',
                    enhancementCosts: [
                        { itemHrid: '/items/holy_cheese', count: 6 },
                        { itemHrid: '/items/coin', count: 1500 },
                    ],
                },
                '/items/mirror_of_protection': { name: 'Mirror of Protection', sellPrice: 1250 },
            },
        }),
        getCurrentActions: () => state.actions,
        getCurrentCharacterId: () => 'c1',
        characterData: { character: { id: 'c1' } },
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: () => {},
    },
}));
vi.mock('./enhancement-storage.js', () => ({
    loadSessions: async () => ({}),
    loadCurrentSessionId: async () => null,
    sessionsLoaded: () => true,
    saveSessions: async () => {},
    saveCurrentSessionId: async () => {},
}));
vi.mock('../insights/enhancement-calibration.js', () => ({ default: { recordCompletion: async () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('../../utils/ironcow-valuation.js', () => ({ ironCowBook: () => null }));
vi.mock('./enhancement-xp.js', () => ({
    calculateSuccessXP: () => 10,
    calculateFailureXP: () => 1,
    calculateAdjustedAttemptCount: () => 1,
    calculateEnhancementPredictions: () => null,
}));
vi.mock('./tooltip-enhancement.js', () => ({ getEnhancementMaterialPrice: () => 0 }));
vi.mock('./enhancement-ui.js', () => ({ default: { switchToSession: () => {}, scheduleUpdate: () => {} } }));

const { setupEnhancementHandlers, cleanupEnhancementHandlers } = await import('./enhancement-handlers.js');
const { default: tracker } = await import('./enhancement-tracker.js');
const { getSessionDuration, SessionState } = await import('./enhancement-session.js');

const SPATULA = '/items/holy_spatula';
const hash = (level) => `30404::/item_locations/inventory::${SPATULA}::${level}`;

/** The enhance row as the queue holds it */
const row = (id, level, currentCount, extra = {}) => ({
    id,
    actionHrid: '/actions/enhancing/enhance',
    isDone: false,
    ordinal: 1,
    currentCount,
    primaryItemHash: hash(level),
    secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
    enhancingMaxLevel: 8,
    enhancingProtectionMinLevel: 5,
    ...extra,
});

/** A new run comes to the front of the queue */
async function queueRun(action) {
    state.actions = [action];
    await state.handlers.actions_updated({ endCharacterActions: [action] });
}

/** The running row is gone: stopped, or out of materials */
async function stopRun(action) {
    state.actions = [];
    await state.handlers.actions_updated({ endCharacterActions: [{ ...action, isDone: true }] });
}

/** One attempt on the running action, ending at `level` */
async function attempt(action, level, currentCount) {
    const done = { ...action, currentCount, primaryItemHash: hash(level) };
    state.actions = [done];
    await state.handlers.action_completed({ endCharacterAction: done });
}

let now;
const advance = (ms) => {
    now += ms;
    vi.setSystemTime(now);
};

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = Date.UTC(2026, 9, 6, 12, 0, 0);
    vi.setSystemTime(now);
    state.handlers = {};
    state.actions = [];
    state.settings = { enhancementTracker: true, enhancementTracker_autoResume: true };
    tracker.isInitialized = false;
    tracker.sessions = {};
    tracker.currentSessionId = null;
    tracker.pendingSessionStart = false;
    await tracker.initialize();
    setupEnhancementHandlers();
});

afterEach(() => {
    cleanupEnhancementHandlers();
    vi.useRealTimers();
});

/** Session #7: +0 → +4 → +3 (protected failure), then the run stops. Ends at +3. */
async function firstRunEndingAtThree() {
    const a1 = row('a1', 0, 0);
    await queueRun(a1);
    let level = 0;
    for (let count = 1; count <= 4; count++) {
        advance(10_000);
        level += 1;
        await attempt(a1, level, count);
    }
    advance(10_000);
    await attempt(a1, 3, 5);
    advance(60_000);
    await stopRun(a1);
    const [session] = Object.values(tracker.sessions);
    return session;
}

describe('auto-resume', () => {
    test('a new run starting exactly where the last one ended continues it', async () => {
        const first = await firstRunEndingAtThree();
        expect(first.state).toBe(SessionState.COMPLETED);
        expect(first.currentLevel).toBe(3);
        expect(first.totalAttempts).toBe(5);
        const activeBefore = getSessionDuration(first);

        // Ten minutes away, then a new queue action for the same spatula at +3
        advance(600_000);
        const a2 = row('a2', 3, 0);
        await queueRun(a2);
        advance(10_000);
        await attempt(a2, 4, 1);

        const sessions = Object.values(tracker.sessions);
        expect(sessions).toHaveLength(1);
        const resumed = sessions[0];
        expect(resumed.id).toBe(first.id);
        expect(tracker.currentSessionId).toBe(first.id);
        expect(resumed.state).toBe(SessionState.TRACKING);
        expect(resumed.endTime).toBeNull();
        expect(resumed.totalAttempts).toBe(6);
        // Scored from the queue row's level, the one the session ended at (+3 had one success before)
        expect(resumed.attemptsPerLevel[3].success).toBe(2);
        expect(resumed.attemptsPerLevel[4].fail).toBe(1);
        expect(resumed.currentLevel).toBe(4);
        // The ten minutes away are not enhancing time
        expect(getSessionDuration(resumed)).toBe(activeBefore);
        advance(10_000);
        await attempt(a2, 5, 2);
        expect(getSessionDuration(resumed)).toBe(activeBefore + 10);
    });

    test('a run starting at a different level starts a new session', async () => {
        const first = await firstRunEndingAtThree();
        advance(600_000);
        const a2 = row('a2', 0, 0);
        await queueRun(a2);
        advance(10_000);
        await attempt(a2, 1, 1);

        expect(Object.keys(tracker.sessions)).toHaveLength(2);
        expect(first.state).toBe(SessionState.COMPLETED);
        expect(tracker.currentSessionId).not.toBe(first.id);
    });

    test('a different target or protection starts a new session', async () => {
        await firstRunEndingAtThree();
        advance(600_000);
        const a2 = row('a2', 3, 0, { enhancingMaxLevel: 10 });
        await queueRun(a2);
        advance(10_000);
        await attempt(a2, 4, 1);
        expect(Object.keys(tracker.sessions)).toHaveLength(2);

        advance(60_000);
        await stopRun(a2);
        advance(600_000);
        const a3 = row('a3', 4, 0, { enhancingMaxLevel: 10, enhancingProtectionMinLevel: 6 });
        await queueRun(a3);
        advance(10_000);
        await attempt(a3, 5, 1);
        expect(Object.keys(tracker.sessions)).toHaveLength(3);
    });

    test('with the setting off (the default), every new run is its own session', async () => {
        state.settings.enhancementTracker_autoResume = false;
        await firstRunEndingAtThree();
        advance(600_000);
        const a2 = row('a2', 3, 0);
        await queueRun(a2);
        advance(10_000);
        await attempt(a2, 4, 1);
        expect(Object.keys(tracker.sessions)).toHaveLength(2);
    });
});
