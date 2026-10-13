/**
 * The maintainer's real case: one climb run as four sessions, protected first by spare capes of
 * different types and enhancement levels, then by Mirror of Protection.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import {
    addCoinCost,
    addMaterialCost,
    addProtectionCost,
    createSession,
    finalizeSession,
    foldSessions,
    getProtectionBreakdown,
    getSessionDuration,
    mergeSessions,
    planSessionMerge,
    recordFailure,
    recordSuccess,
    summedLegPredictions,
    calibrationObservation,
} from './enhancement-session.js';

const CAPE = '/items/sinister_cape';
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 10, 8, 0, 0);

/** Run one session: steps are [from, to, protection hrid or null, protection cost]. */
function run(id, at, startLevel, protectFrom, steps, { finalize = true } = {}) {
    vi.setSystemTime(at);
    const session = createSession(CAPE, 'Sinister Cape', startLevel, 7, protectFrom);
    session.id = id;
    session.predictions = {
        expectedAttempts: 40,
        expectedProtections: 5,
        levelExpectations: { 4: [20, 2], 5: [30, 3] },
    };
    addMaterialCost(session, '/items/holy_cheese', 10, 1000);
    addCoinCost(session, 500);
    let now = at;
    for (const [from, to, prot, cost] of steps) {
        now += MIN;
        vi.setSystemTime(now);
        session.lastAttempt = { level: to, timestamp: now };
        if (prot) addProtectionCost(session, prot, cost);
        if (to > from) recordSuccess(session, from, to, false);
        else recordFailure(session, from, to);
    }
    if (finalize && session.state !== 'completed') {
        vi.setSystemTime(now + 1000);
        finalizeSession(session);
    }
    return session;
}

function fourSessions() {
    // 12 climbs 0 -> 5 and falls back to +4 (a protected fail), with two spare capes of different types
    const s12 = run('session_12', T0, 0, 4, [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 3, '/items/radiant_cape', 3_000_000],
        [3, 4],
        [4, 5],
        [5, 4, '/items/radiant_cape', 3_000_000],
    ]);
    const s13 = run('session_13', T0 + 60 * MIN, 4, 4, [
        [4, 5],
        [5, 4, '/items/mirror_of_protection', 9_000_000],
    ]);
    const s14 = run('session_14', T0 + 120 * MIN, 4, 4, [
        [4, 5],
        [5, 6],
        [6, 5, '/items/mirror_of_protection', 9_000_000],
        [5, 4, '/items/mirror_of_protection', 9_000_000],
    ]);
    const s15 = run('session_15', T0 + 180 * MIN, 4, 4, [
        [4, 5],
        [5, 6],
        [6, 7],
    ]);
    return [s12, s13, s14, s15];
}

afterEach(() => vi.useRealTimers());

describe('merging one climb run as four sessions with mixed protection', () => {
    test('is allowed, and every figure is the sum of the parts', () => {
        vi.useFakeTimers();
        const parts = fourSessions();
        const totals = {};
        for (const key of ['totalAttempts', 'totalSuccesses', 'totalFailures', 'protectionCount', 'protectionCost']) {
            totals[key] = parts.reduce((s, p) => s + p[key], 0);
        }
        const level4 = parts.reduce((s, p) => s + p.attemptsPerLevel[4].success + p.attemptsPerLevel[4].fail, 0);
        const expectedCost = parts.reduce((s, p) => s + p.totalCost, 0);
        const expectedSeconds = parts.reduce((s, p) => s + getSessionDuration(p), 0);
        const plan = planSessionMerge(parts);
        expect(plan.ok).toBe(true);
        expect(plan.protectionItemsDiffer).toBe(true);

        const merged = foldSessions(plan.ordered);
        for (const key of ['totalAttempts', 'totalSuccesses', 'totalFailures', 'protectionCount', 'protectionCost']) {
            expect(merged[key]).toBe(totals[key]);
        }
        expect(merged.totalCost).toBe(expectedCost);
        expect(getSessionDuration(merged)).toBe(expectedSeconds);
        expect(merged.startLevel).toBe(0);
        expect(merged.currentLevel).toBe(7);
        expect(getProtectionBreakdown(merged)).toEqual({
            '/items/radiant_cape': { count: 2, totalCost: 6_000_000 },
            '/items/mirror_of_protection': { count: 3, totalCost: 27_000_000 },
        });
        expect(merged.totalCost).toBe(
            Object.values(merged.materialCosts).reduce((s, m) => s + m.totalCost, 0) +
                merged.coinCost +
                merged.protectionCost
        );
        // level 4 appears in all four
        const l4 = merged.attemptsPerLevel[4];
        expect(l4.success + l4.fail).toBe(level4);
        expect(merged.predictions).toBeNull();
        expect(calibrationObservation(merged)).toBeNull();
        expect(summedLegPredictions(merged)?.legs).toBe(4);
        const agg = mergeSessions([merged]);
        expect(Number.isNaN(agg.expectedAttempts)).toBe(false);
        expect(agg.protectionCost).toBe(merged.protectionCost);
    });
});
