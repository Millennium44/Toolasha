/**
 * Rejoining the sessions a page reload split.
 *
 * The danger runs one way: a split is visible and a bad merge is not, so the
 * gap test has to rule out a merge across any interval in which a completed
 * action could have hidden. These tests pin both directions — a reload-sized
 * gap merges, a real absence does not — and the arithmetic the readers depend
 * on afterwards.
 */

import { describe, test, expect } from 'vitest';

import { mergeReloadSplitSessions, expandKeptSessions, isReloadSplit, sessionPaceMs } from './alchemy-session-merge.js';

const CAPE = '/items/cape';
const SHARD = '/items/shard';
const PRIME = '/items/prime_catalyst';

const MINUTE = 60_000;

/**
 * A transmute-shaped session. Ten attempts over a hundred seconds is a measured
 * pace of ten seconds per attempt, which is the merge threshold.
 *
 * @param {Object} [overrides] - Session fields
 * @returns {Object} A stored session
 */
function session(overrides = {}) {
    const startTime = overrides.startTime ?? 0;
    return {
        id: `transmute_${startTime}`,
        startTime,
        lastActivityTime: startTime + 100_000,
        inputItemHrid: CAPE,
        bulkMultiplier: 1,
        totalAttempts: 10,
        totalSuccesses: 8,
        predictedRate: 0.5,
        predictedAt: startTime,
        predictedCatalystHrid: PRIME,
        catalystsUsed: { [PRIME]: 8 },
        results: { [SHARD]: { count: 8, totalValue: 800, priceEach: 100 } },
        ...overrides,
    };
}

describe('the gap test', () => {
    test('a session measures its own pace', () => {
        expect(sessionPaceMs(session())).toBe(10_000);
        expect(sessionPaceMs(session({ totalAttempts: 0 }))).toBeNull();
        expect(sessionPaceMs(session({ lastActivityTime: undefined }))).toBeNull();
    });

    test('a gap shorter than one measured attempt is a reload', () => {
        expect(isReloadSplit(session(), session({ startTime: 105_000 }))).toBe(true);
    });

    test('a gap long enough to have hidden an action is not', () => {
        expect(isReloadSplit(session(), session({ startTime: 110_000 }))).toBe(false);
        expect(isReloadSplit(session(), session({ startTime: 100_000 + 30 * MINUTE }))).toBe(false);
    });

    test('a session with no recorded activity time is never merged', () => {
        // Everything stored before `lastActivityTime` existed
        expect(isReloadSplit(session({ lastActivityTime: undefined }), session({ startTime: 105_000 }))).toBe(false);
        expect(isReloadSplit(session(), session({ startTime: 105_000, lastActivityTime: undefined }))).toBe(false);
    });
});

describe('what merges and what does not', () => {
    test('two sessions split by a sub-action gap become one, and the numbers add up', () => {
        const merged = mergeReloadSplitSessions([session(), session({ startTime: 105_000 })]);

        expect(merged).toHaveLength(1);
        const run = merged[0];
        expect(run.startTime).toBe(0);
        expect(run.lastActivityTime).toBe(205_000);
        expect(run.totalAttempts).toBe(20);
        expect(run.totalSuccesses).toBe(16);
        expect(run.results[SHARD].count).toBe(16);
        expect(run.results[SHARD].totalValue).toBe(1600);
        expect(run.catalystsUsed).toEqual({ [PRIME]: 16 });
        expect(run.mergedFrom).toEqual(['transmute_0', 'transmute_105000']);

        // The invariant every reader leans on
        const outputs = Object.values(run.results).reduce((sum, r) => sum + r.count, 0);
        expect(outputs).toBeLessThanOrEqual(run.totalSuccesses * run.bulkMultiplier);
        expect(run.totalSuccesses).toBeLessThanOrEqual(run.totalAttempts);
    });

    test('a genuinely long gap stays two sessions', () => {
        const sessions = [session(), session({ startTime: 100_000 + 30 * MINUTE })];
        expect(mergeReloadSplitSessions(sessions)).toBe(sessions);
    });

    test('a different input item never merges, however close', () => {
        const sessions = [session(), session({ startTime: 101_000, inputItemHrid: '/items/other' })];
        expect(mergeReloadSplitSessions(sessions)).toHaveLength(2);
    });

    test('a different enhancement level never merges', () => {
        const sessions = [session({ enhancementLevel: 0 }), session({ startTime: 101_000, enhancementLevel: 1 })];
        expect(mergeReloadSplitSessions(sessions)).toHaveLength(2);
    });

    test('a bulk multiplier the game has since changed never merges', () => {
        const sessions = [session(), session({ startTime: 101_000, bulkMultiplier: 5 })];
        expect(mergeReloadSplitSessions(sessions)).toHaveLength(2);
    });

    test('three reload-split parts become one run', () => {
        const merged = mergeReloadSplitSessions([
            session(),
            session({ startTime: 105_000 }),
            session({ startTime: 210_000 }),
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0].totalAttempts).toBe(30);
        expect(merged[0].mergedFrom).toEqual(['transmute_0', 'transmute_105000', 'transmute_210000']);
    });

    test('the chain does not loosen its own threshold — the test is against the last real part', () => {
        // The merged whole's span/attempts would be a little longer than either
        // part's, which must not buy the next gap any slack
        const merged = mergeReloadSplitSessions([
            session(),
            session({ startTime: 105_000 }),
            // 10.5 s after the second part's last activity: too long
            session({ startTime: 215_500 }),
        ]);

        expect(merged).toHaveLength(2);
        expect(merged[0].mergedFrom).toEqual(['transmute_0', 'transmute_105000']);
    });

    test('sessions arrive merged in start order whatever order they were stored in', () => {
        const merged = mergeReloadSplitSessions([session({ startTime: 105_000 }), session()]);
        expect(merged).toHaveLength(1);
        expect(merged[0].startTime).toBe(0);
    });

    test('nothing is mutated — the stored records stay split', () => {
        const first = session();
        const second = session({ startTime: 105_000 });
        mergeReloadSplitSessions([first, second]);

        expect(first.totalAttempts).toBe(10);
        expect(first.lastActivityTime).toBe(100_000);
        expect(first.mergedFrom).toBeUndefined();
        expect(second.totalAttempts).toBe(10);
    });
});

describe('a merge cannot launder an untrustworthy part', () => {
    test('a repair stamp survives', () => {
        const stamp = { id: 'transmute-self-return-batching', at: 5, outcome: 'repaired', basis: 'derived' };
        const merged = mergeReloadSplitSessions([session({ repair: stamp }), session({ startTime: 105_000 })]);

        expect(merged[0].repair).toEqual(stamp);
    });

    test('an unreliable stamp on either part wins', () => {
        const repaired = { id: 'r', outcome: 'repaired' };
        const unreliable = { id: 'r', outcome: 'unreliable', reason: 'more successes than attempts' };
        const merged = mergeReloadSplitSessions([
            session({ repair: repaired }),
            session({ startTime: 105_000, repair: unreliable }),
        ]);

        expect(merged[0].repair).toEqual(unreliable);
    });

    test('an unreliable mark survives', () => {
        const merged = mergeReloadSplitSessions([session(), session({ startTime: 105_000, unreliable: true })]);
        expect(merged[0].unreliable).toBe(true);
    });

    test('a derived output count stays derived, with what was originally recorded', () => {
        const merged = mergeReloadSplitSessions([
            session({ results: { [SHARD]: { count: 8, totalValue: 800, recordedCount: 20, countBasis: 'derived' } } }),
            session({ startTime: 105_000 }),
        ]);

        expect(merged[0].results[SHARD].countBasis).toBe('derived');
        expect(merged[0].results[SHARD].recordedCount).toBe(28);
    });

    test('parts predicted against different models leave the merged run unstamped', () => {
        // Judging the whole against one part's prediction would invent a
        // calibration point nothing observed
        const merged = mergeReloadSplitSessions([
            session({ predictedRate: 0.5 }),
            session({ startTime: 105_000, predictedRate: 0.62 }),
        ]);

        expect(merged[0].predictedRate).toBeNull();
        expect(merged[0].predictedCatalystHrid).toBeNull();
    });

    test('parts predicted alike keep the stamp', () => {
        const merged = mergeReloadSplitSessions([session(), session({ startTime: 105_000 })]);
        expect(merged[0].predictedRate).toBe(0.5);
    });
});

describe('mapping a reader’s kept rows back onto storage', () => {
    test('keeping a merged row keeps every part behind it', () => {
        const stored = [session(), session({ startTime: 105_000 }), session({ startTime: 10 * MINUTE })];
        const view = mergeReloadSplitSessions(stored);

        expect(expandKeptSessions(view, stored)).toEqual(stored);
    });

    test('deleting a merged row deletes every part behind it', () => {
        const stored = [session(), session({ startTime: 105_000 }), session({ startTime: 10 * MINUTE })];
        const view = mergeReloadSplitSessions(stored);
        const kept = view.filter((s) => s.startTime !== 0);

        expect(expandKeptSessions(kept, stored)).toEqual([stored[2]]);
    });
});
