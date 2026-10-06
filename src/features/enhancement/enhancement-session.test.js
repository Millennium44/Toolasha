/**
 * Tests for enhancement session bookkeeping.
 */

import { describe, test, expect } from 'vitest';
import {
    createSession,
    canExtendSession,
    canResumeSession,
    foldSessions,
    planSessionMerge,
    resumeSession,
    extendSession,
    finalizeSession,
    getCurrentLegCounters,
    getSessionDuration,
    mergeSessions,
    normalizeSession,
    recordFailure,
    recordSuccess,
    SessionState,
} from './enhancement-session.js';

describe('completed session extension across queue actions', () => {
    test('a canceled a1 below its target cannot be folded into a2 at the same level', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 15, 2);
        session.currentLevel = 5;
        session.lastAttempt = { actionId: 'a1', level: 5, currentCount: 10 };
        finalizeSession(session);
        expect(canExtendSession(session, '/items/test_sword', 5, { id: 'a2', enhancingMaxLevel: 15 })).toBe(false);
    });

    test('a completed target may be intentionally extended to a higher target on a2', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 5, 2);
        session.currentLevel = 5;
        session.lastAttempt = { actionId: 'a1', level: 5, currentCount: 10 };
        finalizeSession(session);
        expect(canExtendSession(session, '/items/test_sword', 5, { id: 'a2', enhancingMaxLevel: 8 })).toBe(true);
    });
});

/** Run `count` failures at `level`, each landing back on the same level. */
function fail(session, level, count) {
    for (let i = 0; i < count; i++) {
        recordFailure(session, level, level);
    }
}

describe('getCurrentLegCounters', () => {
    test('a session that was never extended reports its full totals', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 2, 0);
        fail(session, 0, 7);
        session.protectionCount = 3;

        expect(getCurrentLegCounters(session)).toEqual({ attempts: 7, protections: 3 });
    });

    test('an extension resets the comparison so the new leg is measured on its own', () => {
        // The predictions are recomputed for +2 → +4, so the factors must not be handed the
        // attempts spent climbing to +2 in the first place.
        const session = createSession('/items/test_sword', 'Test Sword', 0, 2, 2);
        fail(session, 0, 20);
        session.protectionCount = 6;
        recordSuccess(session, 1, 2);
        finalizeSession(session);

        extendSession(session, 4);
        expect(getCurrentLegCounters(session)).toEqual({ attempts: 0, protections: 0 });

        fail(session, 2, 4);
        session.protectionCount += 2;

        expect(getCurrentLegCounters(session)).toEqual({ attempts: 4, protections: 2 });
    });

    test('counters that somehow run behind the snapshot never report negative work', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 2, 0);
        fail(session, 0, 5);
        finalizeSession(session);
        extendSession(session, 4);

        session.totalAttempts = 1; // e.g. a session edited or reloaded out of order

        expect(getCurrentLegCounters(session)).toEqual({ attempts: 0, protections: 0 });
    });
});

describe('getSessionDuration', () => {
    test('a live session stops at its last attempt, not the wall clock', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 5, 0);
        session.startTime = 1_000_000;
        // Last attempt landed 30s in; the run has since sat idle
        session.lastUpdateTime = 1_030_000;
        session.endTime = null;

        // Duration is the 30s of enhancing, regardless of how long ago that was
        expect(getSessionDuration(session)).toBe(30);
    });

    test('a completed session measures to its end', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 5, 0);
        session.startTime = 1_000_000;
        session.lastUpdateTime = 1_090_000;
        session.endTime = 1_045_000;

        expect(getSessionDuration(session)).toBe(45);
    });

    test('a brand-new session with no attempts is zero, not the epoch', () => {
        const session = createSession('/items/test_sword', 'Test Sword', 0, 5, 0);
        session.startTime = 1_000_000;
        session.lastUpdateTime = 1_000_000;

        expect(getSessionDuration(session)).toBe(0);
    });
});

describe('mergeSessions', () => {
    /** A session with the fields merge reads, timestamps set for a 20s duration. */
    const make = (over = {}) => {
        const session = createSession(over.itemHrid || '/items/sword', over.itemName || 'Sword', 0, 5, 0);
        session.startTime = 1_000_000;
        session.lastUpdateTime = 1_020_000;
        session.endTime = null;
        return Object.assign(session, {
            totalAttempts: 10,
            totalSuccesses: 6,
            totalFailures: 4,
            totalXP: 300,
            protectionCount: 1,
            coinCost: 0,
            coinCount: 0,
            protectionCost: 500,
            totalCost: 1500,
            attemptsPerLevel: {
                0: { success: 4, fail: 1, blessed: 1, successRate: 0.8 },
                1: { success: 2, fail: 3, successRate: 0.4 },
            },
            materialCosts: { '/items/stone': { count: 10, totalCost: 1000 } },
            predictions: { expectedAttempts: 8, expectedProtections: 1 },
            ...over,
        });
    };

    test('sums counters, costs, XP and duration across sessions', () => {
        const merged = mergeSessions([make(), make()]);
        expect(merged.count).toBe(2);
        expect(merged.totalAttempts).toBe(20);
        expect(merged.totalSuccesses).toBe(12);
        expect(merged.totalXP).toBe(600);
        expect(merged.protectionCount).toBe(2);
        expect(merged.totalCost).toBe(3000);
        expect(merged.durationSeconds).toBe(40); // 20s each
        expect(merged.expectedAttempts).toBe(16);
    });

    test('folds per-level tallies together and re-derives the rate', () => {
        const merged = mergeSessions([make(), make()]);
        expect(merged.attemptsPerLevel[0]).toEqual({ success: 8, fail: 2, blessed: 2, successRate: 0.8 });
        expect(merged.attemptsPerLevel[1]).toEqual({ success: 4, fail: 6, blessed: 0, successRate: 0.4 });
        expect(merged.successRate).toBeCloseTo(12 / 20, 6);
    });

    test('sums Blessed successes across sessions', () => {
        const merged = mergeSessions([make({ totalBlessed: 1 }), make({ totalBlessed: 2 })]);
        expect(merged.totalBlessed).toBe(3);
    });

    test('sums material costs by item', () => {
        const merged = mergeSessions([make(), make()]);
        expect(merged.materialCosts['/items/stone']).toEqual({ count: 20, totalCost: 2000 });
    });

    test('lists each distinct item once', () => {
        const merged = mergeSessions([
            make({ itemHrid: '/items/sword', itemName: 'Sword' }),
            make({ itemHrid: '/items/sword', itemName: 'Sword' }),
            make({ itemHrid: '/items/shield', itemName: 'Shield' }),
        ]);
        expect(merged.itemHrids).toEqual(['/items/sword', '/items/shield']);
        expect(merged.itemNames).toEqual(['Sword', 'Shield']);
    });

    test('an empty or missing list is null', () => {
        expect(mergeSessions([])).toBeNull();
        expect(mergeSessions(null)).toBeNull();
    });
});

describe('recordSuccess - Blessed tea tracking', () => {
    test('a normal +1 success increments success, not Blessed', () => {
        const session = createSession('/items/sword', 'Sword', 0, 5, 0);

        recordSuccess(session, 0, 1, false);

        expect(session.totalSuccesses).toBe(1);
        expect(session.totalBlessed).toBe(0);
        expect(session.attemptsPerLevel[0].success).toBe(1);
        expect(session.attemptsPerLevel[0].blessed).toBe(0);
    });

    test('a +2 success increments both success and Blessed, exactly once', () => {
        const session = createSession('/items/sword', 'Sword', 0, 5, 0);

        recordSuccess(session, 0, 2, true);

        expect(session.totalSuccesses).toBe(1);
        expect(session.totalBlessed).toBe(1);
        expect(session.attemptsPerLevel[0].success).toBe(1);
        expect(session.attemptsPerLevel[0].blessed).toBe(1);
    });

    test('Blessed is never counted as an additional success or attempt on top of the success', () => {
        const session = createSession('/items/sword', 'Sword', 0, 5, 0);

        recordSuccess(session, 0, 2, true);

        // totalAttempts/totalSuccesses must match a plain success exactly - Blessed only
        // annotates it via a separate counter, never adds a second attempt/success.
        expect(session.totalAttempts).toBe(1);
        expect(session.totalSuccesses).toBe(1);
    });

    test('a failure increments neither Blessed nor success', () => {
        const session = createSession('/items/sword', 'Sword', 1, 5, 0);

        recordFailure(session, 1, 0);

        expect(session.totalSuccesses).toBe(0);
        expect(session.totalBlessed).toBe(0);
        expect(session.totalFailures).toBe(1);
    });

    test('protected failure behavior remains unchanged (level stays same, still counted as a failure)', () => {
        const session = createSession('/items/sword', 'Sword', 3, 5, 1);

        recordFailure(session, 3, 3);

        expect(session.totalFailures).toBe(1);
        expect(session.totalSuccesses).toBe(0);
        expect(session.totalBlessed).toBe(0);
        expect(session.currentLevel).toBe(3);
    });

    test('per-level and total Blessed aggregates stay consistent across multiple levels', () => {
        const session = createSession('/items/sword', 'Sword', 0, 10, 0);

        recordSuccess(session, 0, 1, false);
        recordSuccess(session, 1, 3, true);
        recordSuccess(session, 3, 4, false);
        recordSuccess(session, 4, 6, true);

        expect(session.totalBlessed).toBe(2);
        expect(session.attemptsPerLevel[1].blessed).toBe(1);
        expect(session.attemptsPerLevel[4].blessed).toBe(1);
        expect(session.attemptsPerLevel[0].blessed).toBe(0);
        expect(session.attemptsPerLevel[3].blessed).toBe(0);

        const totalBlessedAcrossLevels = Object.values(session.attemptsPerLevel).reduce(
            (sum, level) => sum + level.blessed,
            0
        );
        expect(totalBlessedAcrossLevels).toBe(session.totalBlessed);
    });

    test('a Blessed success that jumps over a milestone still records it as reached', () => {
        // Blessed Tea can jump +2 or more levels in one attempt. +4 -> +6 never
        // lands on +5, so checking only the landing level silently dropped it.
        const session = createSession('/items/sword', 'Sword', 4, 10, 0);

        recordSuccess(session, 4, 6, true);

        expect(session.milestonesReached).toEqual([5]);
    });

    test('a Blessed success that jumps over two milestones records both', () => {
        const session = createSession('/items/sword', 'Sword', 9, 20, 0);

        recordSuccess(session, 9, 11, true);

        expect(session.milestonesReached).toEqual([10]);
    });

    test('landing exactly on a milestone still records it once, not twice on a later re-pass', () => {
        const session = createSession('/items/sword', 'Sword', 0, 20, 0);

        recordSuccess(session, 4, 5, false);
        // A later Blessed success that starts at the milestone and jumps past it
        // must not push a duplicate entry for the milestone already reached.
        recordSuccess(session, 5, 7, true);

        expect(session.milestonesReached).toEqual([5]);
    });
});

describe('normalizeSession - backward compatibility', () => {
    test('an older session with no Blessed field at all loads as zero', () => {
        const legacySession = createSession('/items/sword', 'Sword', 0, 5, 0);
        delete legacySession.totalBlessed;
        legacySession.attemptsPerLevel[0] = { success: 3, fail: 1, successRate: 0.75 };

        normalizeSession(legacySession);

        expect(legacySession.totalBlessed).toBe(0);
        expect(legacySession.attemptsPerLevel[0].blessed).toBe(0);
    });

    test('an existing session with real Blessed data is left untouched', () => {
        const session = createSession('/items/sword', 'Sword', 0, 5, 0);
        recordSuccess(session, 0, 2, true);

        normalizeSession(session);

        expect(session.totalBlessed).toBe(1);
        expect(session.attemptsPerLevel[0].blessed).toBe(1);
    });

    test('does not destructively reset any other session field', () => {
        const legacySession = createSession('/items/sword', 'Sword', 0, 5, 0);
        delete legacySession.totalBlessed;
        legacySession.totalSuccesses = 12;
        legacySession.totalXP = 4500;

        normalizeSession(legacySession);

        expect(legacySession.totalSuccesses).toBe(12);
        expect(legacySession.totalXP).toBe(4500);
    });
});

describe('finalizeSession end time', () => {
    test('ends now by default, or at the moment it is handed', () => {
        const session = createSession('/items/sword', 'Sword', 0, 5, 0);
        finalizeSession(session, 12_345);
        expect(session.state).toBe(SessionState.COMPLETED);
        expect(session.endTime).toBe(12_345);

        const now = createSession('/items/sword', 'Sword', 0, 5, 0);
        finalizeSession(now);
        expect(now.endTime).toBeGreaterThan(12_345);
    });
});

/**
 * Two runs of one Holy Spatula toward +8, protect from +5: #7 ended at +3 after a climb to +6,
 * #8 picked up right after. Shaped as the store holds them.
 */
function spatulaRuns() {
    const seven = createSession('/items/holy_spatula', 'Holy Spatula', 0, 8, 5);
    Object.assign(seven, {
        id: 'session_7',
        state: SessionState.COMPLETED,
        startTime: 1_000_000,
        lastUpdateTime: 1_600_000,
        endTime: 1_600_000, // 600s active
        currentLevel: 3,
        totalAttempts: 466,
        totalSuccesses: 200,
        totalFailures: 266,
        totalBlessed: 4,
        totalXP: 9000,
        protectionCount: 12,
        protectionCost: 12_000,
        protectionItemHrid: '/items/mirror_of_protection',
        coinCost: 466 * 1500,
        coinCount: 466,
        materialCosts: { '/items/holy_cheese': { count: 2796, totalCost: 2_796_000 } },
        totalCost: 2_796_000 + 466 * 1500 + 12_000,
        longestSuccessStreak: 4,
        longestFailureStreak: 9,
        milestonesReached: [5],
        attemptsPerLevel: {
            0: { success: 150, fail: 200, blessed: 3, successRate: 150 / 350 },
            5: { success: 2, fail: 6, blessed: 0, successRate: 0.25 },
        },
        predictions: { expectedAttempts: 400 },
    });
    const eight = createSession('/items/holy_spatula', 'Holy Spatula', 3, 8, 5);
    Object.assign(eight, {
        id: 'session_8',
        state: SessionState.TRACKING,
        startTime: 5_000_000, // an hour after #7 ended
        lastUpdateTime: 5_100_000, // 100s active so far
        endTime: null,
        currentLevel: 4,
        totalAttempts: 10,
        totalSuccesses: 4,
        totalFailures: 6,
        totalXP: 200,
        coinCost: 10 * 1500,
        coinCount: 10,
        materialCosts: { '/items/holy_cheese': { count: 60, totalCost: 60_000 } },
        totalCost: 60_000 + 10 * 1500,
        longestSuccessStreak: 2,
        longestFailureStreak: 3,
        attemptsPerLevel: {
            0: { success: 3, fail: 6, blessed: 0, successRate: 1 / 3 },
            3: { success: 1, fail: 0, blessed: 0, successRate: 1 },
        },
        lastAttempt: { attemptNumber: 10, level: 4, timestamp: 5_100_000, actionId: 'a8', currentCount: 10 },
    });
    return { seven, eight };
}

describe('planSessionMerge', () => {
    test('orders oldest first and lets the newest still be running', () => {
        const { seven, eight } = spatulaRuns();
        const plan = planSessionMerge([eight, seven]);
        expect(plan.ok).toBe(true);
        expect(plan.ordered.map((s) => s.id)).toEqual(['session_7', 'session_8']);
        expect(plan.settingsDiffer).toBe(false);
    });

    test('refuses an older session still in progress, a different item, or a single session', () => {
        const { seven, eight } = spatulaRuns();
        seven.state = SessionState.TRACKING;
        expect(planSessionMerge([seven, eight]).ok).toBe(false);

        const other = spatulaRuns();
        other.seven.itemHrid = '/items/holy_brush';
        expect(planSessionMerge([other.seven, other.eight]).reason).toMatch(/same item/);

        expect(planSessionMerge([eight]).ok).toBe(false);
    });

    test('says when targets or protection differ (the newest one is kept)', () => {
        const { seven, eight } = spatulaRuns();
        seven.protectFrom = 4;
        expect(planSessionMerge([seven, eight]).settingsDiffer).toBe(true);
    });
});

describe('foldSessions', () => {
    test('combines every counter, cost and tally into the newest session', () => {
        const { seven, eight } = spatulaRuns();
        const merged = foldSessions([seven, eight]);

        expect(merged).toBe(eight);
        expect(merged.id).toBe('session_8');
        expect(merged.state).toBe(SessionState.TRACKING);
        expect(merged.totalAttempts).toBe(476);
        expect(merged.totalSuccesses).toBe(204);
        expect(merged.totalFailures).toBe(272);
        expect(merged.totalBlessed).toBe(4);
        expect(merged.totalXP).toBe(9200);
        expect(merged.protectionCount).toBe(12);
        expect(merged.protectionCost).toBe(12_000);
        expect(merged.protectionItemHrid).toBe('/items/mirror_of_protection');
        expect(merged.coinCost).toBe(476 * 1500);
        expect(merged.coinCount).toBe(476);
        expect(merged.materialCosts['/items/holy_cheese']).toEqual({ count: 2856, totalCost: 2_856_000 });
        expect(merged.totalCost).toBe(2_856_000 + 476 * 1500 + 12_000);
        expect(merged.attemptsPerLevel[0]).toEqual({ success: 153, fail: 206, blessed: 3, successRate: 153 / 359 });
        expect(merged.attemptsPerLevel[3].success).toBe(1);
        expect(merged.attemptsPerLevel[5]).toEqual({ success: 2, fail: 6, blessed: 0, successRate: 0.25 });
        expect(merged.longestFailureStreak).toBe(9);
        expect(merged.milestonesReached).toEqual([5]);
        expect(merged.mergedFrom).toEqual(['session_7']);
    });

    test('starts where the earliest started, stands where the newest stands', () => {
        const { seven, eight } = spatulaRuns();
        const merged = foldSessions([seven, eight]);
        expect(merged.startLevel).toBe(0);
        expect(merged.startTime).toBe(1_000_000);
        expect(merged.currentLevel).toBe(4);
        expect(merged.targetLevel).toBe(8);
        expect(merged.protectFrom).toBe(5);
        expect(merged.lastAttempt.actionId).toBe('a8');
        expect(merged.extensionBaseline).toBeNull();
    });

    test('duration is the sum of active time, not the span from the first start', () => {
        const { seven, eight } = spatulaRuns();
        const merged = foldSessions([seven, eight]);
        expect(getSessionDuration(merged)).toBe(600 + 100);
        // and keeps running with the live session
        merged.lastUpdateTime += 30_000;
        expect(getSessionDuration(merged)).toBe(730);
    });
});

describe('canResumeSession and resumeSession', () => {
    const run = (over = {}) => ({
        itemHrid: '/items/holy_spatula',
        startLevel: 3,
        targetLevel: 8,
        protectFrom: 5,
        protectionItemHrid: '/items/mirror_of_protection',
        ...over,
    });

    test('resumes only an ended run of the same setup, starting exactly where it ended', () => {
        const { seven } = spatulaRuns();
        expect(canResumeSession(seven, run())).toBe(true);
        expect(canResumeSession(seven, run({ startLevel: 2 }))).toBe(false);
        expect(canResumeSession(seven, run({ startLevel: null }))).toBe(false);
        expect(canResumeSession(seven, run({ targetLevel: 10 }))).toBe(false);
        expect(canResumeSession(seven, run({ protectFrom: 6 }))).toBe(false);
        expect(canResumeSession(seven, run({ protectionItemHrid: '/items/holy_spatula' }))).toBe(false);
        expect(canResumeSession(seven, run({ itemHrid: '/items/holy_brush' }))).toBe(false);
    });

    test('a running session or one that reached its target is not resumed', () => {
        const { seven, eight } = spatulaRuns();
        expect(canResumeSession(eight, run({ startLevel: 4 }))).toBe(false);
        seven.currentLevel = 8;
        expect(canResumeSession(seven, run({ startLevel: 8 }))).toBe(false);
    });

    test('reopening banks the active time and does not count the time it was ended', () => {
        const { seven } = spatulaRuns();
        resumeSession(seven, 9_000_000);
        expect(seven.state).toBe(SessionState.TRACKING);
        expect(seven.endTime).toBeNull();
        expect(getSessionDuration(seven)).toBe(600);
        seven.lastUpdateTime = 9_020_000;
        expect(getSessionDuration(seven)).toBe(620);
    });
});

describe('mergeSessions view marks where the item stands', () => {
    test('the live session sets the current level, so its row is highlighted', () => {
        const { seven, eight } = spatulaRuns();
        const merged = mergeSessions([seven, eight]);
        expect(merged.currentLevel).toBe(4);
        expect(merged.live).toBe(true);
        eight.currentLevel = 5;
        expect(mergeSessions([seven, eight]).currentLevel).toBe(5);
    });
});
