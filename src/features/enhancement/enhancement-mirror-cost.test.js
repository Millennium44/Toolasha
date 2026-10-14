/**
 * Philosopher's Mirror attempts are a consumable cost of their own, never a protection.
 * Sessions recorded before that hold the mirror inside the protection fields and breakdown;
 * they must read the same way without their stored data being rewritten.
 */
import { describe, test, expect } from 'vitest';
import {
    PHILOSOPHERS_MIRROR_HRID,
    SessionState,
    addMirrorCost,
    addProtectionCost,
    createSession,
    foldSessions,
    getCurrentLegCounters,
    getMirrorUsage,
    getProtectionUsage,
    mergeSessions,
} from './enhancement-session.js';
import { costVsExpected } from './enhancement-profit.js';
import { enhancementSessionText } from './enhancement-ui.js';

const BOOK = '/items/mirror_of_protection';

/** A session recorded before mirrors had their own fields: 2 real protections and 3 mirrors in the protection fields. */
function legacySession(overrides = {}) {
    const session = createSession('/items/foo', 'Foo', 0, 10, 2);
    session.id = 'legacy';
    session.protectionItemHrid = BOOK;
    session.protectionCount = 5;
    session.protectionCost = 2 * 1000 + 3 * 90000;
    session.protectionBreakdown = {
        [BOOK]: { count: 2, totalCost: 2000 },
        [PHILOSOPHERS_MIRROR_HRID]: { count: 3, totalCost: 270000 },
    };
    session.totalCost = session.protectionCost;
    return Object.assign(session, overrides);
}

describe('addMirrorCost', () => {
    test('adds to the total cost but not to the protection count, cost or breakdown', () => {
        const session = createSession('/items/foo', 'Foo', 0, 10, 2);
        addProtectionCost(session, BOOK, 1000);
        addMirrorCost(session, 90000);
        addMirrorCost(session, 90000);

        expect(session.mirrorCount).toBe(2);
        expect(session.mirrorCost).toBe(180000);
        expect(session.protectionCount).toBe(1);
        expect(session.protectionCost).toBe(1000);
        expect(session.protectionItemHrid).toBe(BOOK);
        expect(session.protectionBreakdown).toBeUndefined();
        expect(session.totalCost).toBe(181000);
        expect(getProtectionUsage(session).count).toBe(1);
    });

    test('a mirror attempt before any protection does not claim the protection item slot', () => {
        const session = createSession('/items/foo', 'Foo', 0, 10, 2);
        addMirrorCost(session, 90000);
        expect(session.protectionItemHrid).toBeNull();
        expect(getProtectionUsage(session)).toEqual({ count: 0, cost: 0, breakdown: {} });
    });

    test('an unpriced mirror flags the session', () => {
        const session = createSession('/items/foo', 'Foo', 0, 10, 2);
        addMirrorCost(session, 0);
        expect(session.hasUnpricedInput).toBe(true);
    });
});

describe('a session recorded with the mirror inside the protection fields', () => {
    test('reads the mirror as its own line and leaves it out of protections', () => {
        const session = legacySession();

        expect(getMirrorUsage(session)).toMatchObject({ count: 3, cost: 270000 });
        const usage = getProtectionUsage(session);
        expect(usage.count).toBe(2);
        expect(usage.cost).toBe(2000);
        expect(Object.keys(usage.breakdown)).toEqual([BOOK]);
        // Stored data is untouched
        expect(session.protectionCount).toBe(5);
        expect(session.protectionBreakdown[PHILOSOPHERS_MIRROR_HRID].count).toBe(3);
    });

    test('a mirror-only session with no breakdown reads the same way', () => {
        const session = legacySession({ protectionItemHrid: PHILOSOPHERS_MIRROR_HRID, protectionBreakdown: undefined });
        session.protectionCount = 3;
        session.protectionCost = 270000;

        expect(getMirrorUsage(session).count).toBe(3);
        expect(getProtectionUsage(session)).toEqual({ count: 0, cost: 0, breakdown: {} });
    });

    test('the Prot Factor leg counter does not count the mirrors', () => {
        expect(getCurrentLegCounters(legacySession()).protections).toBe(2);
    });
});

describe('readers of mirror state', () => {
    test('mergeSessions sums mirrors apart from protections, old and new alike', () => {
        const fresh = createSession('/items/foo', 'Foo', 0, 10, 2);
        addProtectionCost(fresh, BOOK, 1000);
        addMirrorCost(fresh, 90000);

        const merged = mergeSessions([legacySession(), fresh]);

        expect(merged.protectionCount).toBe(3);
        expect(merged.protectionCost).toBe(3000);
        expect(merged.mirrorCount).toBe(4);
        expect(merged.mirrorCost).toBe(360000);
        expect(merged.totalCost).toBe(272000 + 91000);
    });

    test('foldSessions keeps new-format mirrors out of the protection count and in the total', () => {
        const a = createSession('/items/foo', 'Foo', 0, 10, 2);
        a.id = 'a';
        a.state = SessionState.COMPLETED;
        a.lastUpdateTime = 10;
        addMirrorCost(a, 90000);
        const b = createSession('/items/foo', 'Foo', 0, 10, 2);
        b.id = 'b';
        b.lastUpdateTime = 20;
        addProtectionCost(b, BOOK, 1000);
        addMirrorCost(b, 90000);

        const folded = foldSessions([a, b]);

        expect(getProtectionUsage(folded).count).toBe(1);
        expect(getMirrorUsage(folded)).toMatchObject({ count: 2, cost: 180000 });
        expect(folded.totalCost).toBe(181000);
    });

    test('foldSessions of a recorded session into a new one keeps its mirrors out of protections', () => {
        const old = legacySession();
        old.lastUpdateTime = 10;
        const fresh = createSession('/items/foo', 'Foo', 0, 10, 2);
        fresh.id = 'fresh';
        fresh.lastUpdateTime = 20;
        addMirrorCost(fresh, 90000);

        const folded = foldSessions([old, fresh]);

        expect(getProtectionUsage(folded).count).toBe(2);
        expect(getMirrorUsage(folded).count).toBe(4);
    });

    test('costVsExpected keeps mirrors out of the protection side and in the actual cost', () => {
        const session = {
            ...createSession('/items/foo', 'Foo', 0, 10, 2),
            totalAttempts: 10,
            materialCosts: { '/items/x': { count: 10, totalCost: 1000 } },
            predictions: { expectedAttempts: 10, expectedProtections: 1 },
        };
        addProtectionCost(session, BOOK, 500);
        addMirrorCost(session, 4000);

        const result = costVsExpected(session);

        expect(result.protActual).toBe(500);
        expect(result.protExpected).toBe(500);
        expect(result.materialActual).toBe(5000);
        expect(result.actualCost).toBe(session.totalCost);
    });

    test('the clipboard export lists protections without the mirrors and the mirrors apart', () => {
        const text = enhancementSessionText(legacySession());
        expect(text).toContain('Protections used: 2');
        expect(text).toContain("Philosopher's Mirrors used: 3");
        expect(enhancementSessionText(createSession('/items/foo', 'Foo', 0, 10, 2))).not.toContain('Mirrors used');
    });
});
