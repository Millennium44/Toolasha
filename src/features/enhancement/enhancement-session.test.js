/**
 * Tests for enhancement session bookkeeping.
 */

import { describe, test, expect } from 'vitest';
import {
    createSession,
    extendSession,
    finalizeSession,
    getCurrentLegCounters,
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
