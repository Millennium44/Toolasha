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
                0: { success: 4, fail: 1, successRate: 0.8 },
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
        expect(merged.attemptsPerLevel[0]).toEqual({ success: 8, fail: 2, successRate: 0.8 });
        expect(merged.attemptsPerLevel[1]).toEqual({ success: 4, fail: 6, successRate: 0.4 });
        expect(merged.successRate).toBeCloseTo(12 / 20, 6);
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
