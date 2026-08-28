/**
 * Tests for enhancement session bookkeeping.
 */

import { describe, test, expect } from 'vitest';
import {
    createSession,
    extendSession,
    finalizeSession,
    getCurrentLegCounters,
    getSessionDuration,
    mergeSessions,
    normalizeSession,
    recordFailure,
    recordSuccess,
} from './enhancement-session.js';

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
