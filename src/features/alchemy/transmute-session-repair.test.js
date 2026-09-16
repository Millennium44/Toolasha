/**
 * Repairing sessions recorded through the self-return batching bug.
 *
 * The bug read one batched message's repeated snapshots of the input stack as
 * separate self-returns, so a run of 75 attempts and 64 successes was recorded
 * as handing back 103 capes — which `computeSessionProfit` then clamped to a
 * net consumption of zero, erasing the session's whole input cost.
 *
 * Three things are being protected here:
 *   - the repaired number is DERIVED (successes × bulk − other outputs), not
 *     clamped to successes × bulk, which would still be wrong
 *   - a session whose arithmetic does not close is flagged, never written
 *   - a repaired session can never be mistaken for an observed one, and a
 *     repair whose write was refused is retried rather than marked done
 */

import { describe, test, expect, beforeEach } from 'vitest';

import {
    REPAIR_ID,
    planSessionRepair,
    repairTransmuteSessions,
    ensureSessionsRepaired,
    resetRepairState,
} from './transmute-session-repair.js';

const CAPE = '/items/gatherer_cape_refined';
const STONE = '/items/philosophers_stone';

/**
 * The maintainer's actual corrupt session, as stored.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} A session
 */
function brokenSession(overrides = {}) {
    return {
        id: 'transmute_1789532567707',
        startTime: 1789532567707,
        inputItemHrid: CAPE,
        totalAttempts: 75,
        totalSuccesses: 64,
        bulkMultiplier: 1,
        results: {
            [CAPE]: { count: 103, totalValue: 0, priceEach: 0, isSelfReturn: true },
            [STONE]: { count: 2, totalValue: 2000, priceEach: 1000, isSelfReturn: false },
        },
        ...overrides,
    };
}

beforeEach(() => {
    resetRepairState();
});

describe('deriving the self-return count', () => {
    test('the 75/64/103 session lands on 62, not the 64 a clamp would write', () => {
        const { sessions, repaired, flagged } = repairTransmuteSessions([brokenSession()], 1_000);

        expect(repaired).toBe(1);
        expect(flagged).toBe(0);
        expect(sessions[0].results[CAPE].count).toBe(62);
        expect(sessions[0].results[CAPE].count).not.toBe(64);
    });

    test('net consumption comes back to 13 rather than clamping to zero', () => {
        const [session] = repairTransmuteSessions([brokenSession()], 1_000).sessions;

        const selfReturned = session.results[CAPE].count;
        const netConsumed = Math.max(0, session.totalAttempts * session.bulkMultiplier - selfReturned);

        expect(netConsumed).toBe(13);
    });

    test('bulk multipliers scale the derivation', () => {
        const session = brokenSession({
            bulkMultiplier: 5,
            totalAttempts: 20,
            totalSuccesses: 10,
            results: {
                [CAPE]: { count: 90, isSelfReturn: true },
                [STONE]: { count: 10, isSelfReturn: false },
            },
        });

        // 10 successes x 5 = 50 items produced, 10 of them stones
        expect(repairTransmuteSessions([session], 1_000).sessions[0].results[CAPE].count).toBe(40);
    });

    test('a session whose self-returns already fit is left exactly as recorded', () => {
        const clean = brokenSession({ results: { [CAPE]: { count: 62, isSelfReturn: true } } });
        const { sessions, changed } = repairTransmuteSessions([clean], 1_000);

        expect(changed).toBe(false);
        expect(sessions[0]).toBe(clean);
        expect(sessions[0].repair).toBeUndefined();
    });
});

describe('where the arithmetic does not close, nothing is written', () => {
    test('a derivation that goes negative flags the session instead of writing a number', () => {
        // More stones recorded than the successes could have produced
        const session = brokenSession({
            results: { [CAPE]: { count: 103, isSelfReturn: true }, [STONE]: { count: 80 } },
        });
        const { sessions, repaired, flagged } = repairTransmuteSessions([session], 1_000);

        expect(repaired).toBe(0);
        expect(flagged).toBe(1);
        expect(sessions[0].results[CAPE].count).toBe(103);
        expect(sessions[0].repair.outcome).toBe('unreliable');
    });

    test('more successes than attempts is flagged, not repaired', () => {
        const session = brokenSession({ totalAttempts: 20, totalSuccesses: 64 });

        expect(planSessionRepair(session)).toEqual({ action: 'flag', reason: 'more successes than attempts' });
    });

    test('self-returns recorded against no successes are flagged', () => {
        const session = brokenSession({ totalSuccesses: 0, results: { [CAPE]: { count: 8, isSelfReturn: true } } });
        const { sessions, flagged } = repairTransmuteSessions([session], 1_000);

        expect(flagged).toBe(1);
        expect(sessions[0].results[CAPE].count).toBe(8);
    });

    test('several self-return outputs cannot be apportioned, so none is touched', () => {
        const session = brokenSession({
            results: {
                [CAPE]: { count: 90, isSelfReturn: true },
                '/items/other_cape': { count: 20, isSelfReturn: true },
            },
        });

        expect(planSessionRepair(session).action).toBe('flag');
    });
});

describe('a repaired session never looks like an observed one', () => {
    test('the stamp records the original value and that the new one was derived', () => {
        const [session] = repairTransmuteSessions([brokenSession()], 12_345).sessions;

        expect(session.repair).toEqual({
            id: REPAIR_ID,
            at: 12_345,
            outcome: 'repaired',
            basis: 'derived',
            itemHrid: CAPE,
            from: 103,
            to: 62,
        });
        expect(session.results[CAPE].recordedCount).toBe(103);
        expect(session.results[CAPE].countBasis).toBe('derived');
    });

    test('the stored session object is copied, not mutated', () => {
        const original = brokenSession();
        repairTransmuteSessions([original], 1_000);

        expect(original.results[CAPE].count).toBe(103);
        expect(original.repair).toBeUndefined();
    });
});

describe('idempotence', () => {
    test('a repaired session is never repaired again', () => {
        const once = repairTransmuteSessions([brokenSession()], 1_000).sessions;
        const twice = repairTransmuteSessions(once, 2_000);

        expect(twice.changed).toBe(false);
        expect(twice.sessions[0].results[CAPE].count).toBe(62);
        expect(twice.sessions[0].repair.at).toBe(1_000);
    });

    test('a flagged session is never revisited either', () => {
        const flagged = repairTransmuteSessions([brokenSession({ totalAttempts: 20 })], 1_000).sessions;

        expect(repairTransmuteSessions(flagged, 2_000).changed).toBe(false);
    });
});

describe('the migration only marks itself done when the write lands', () => {
    test('a successful write repairs once and never scans again', async () => {
        const writes = [];
        const save = async (sessions) => {
            writes.push(sessions);
            return true;
        };

        const first = await ensureSessionsRepaired('char-1', [brokenSession()], save);
        expect(first[0].results[CAPE].count).toBe(62);
        expect(writes).toHaveLength(1);

        // The stored history is still the broken one from this caller's point
        // of view; a second load must not write again
        await ensureSessionsRepaired('char-1', [brokenSession()], save);
        expect(writes).toHaveLength(1);
    });

    test('a refused write is not marked done and is retried on the next load', async () => {
        const writes = [];
        let refuse = true;
        const save = async (sessions) => {
            writes.push(sessions);
            return !refuse;
        };

        const first = await ensureSessionsRepaired('char-1', [brokenSession()], save);
        // The honest numbers are still handed back, just not recorded
        expect(first[0].results[CAPE].count).toBe(62);
        expect(writes).toHaveLength(1);

        refuse = false;
        const second = await ensureSessionsRepaired('char-1', [brokenSession()], save);
        expect(writes).toHaveLength(2);
        expect(second[0].results[CAPE].count).toBe(62);

        await ensureSessionsRepaired('char-1', [brokenSession()], save);
        expect(writes).toHaveLength(2);
    });

    test('a throwing write leaves the history alone and stays un-marked', async () => {
        let calls = 0;
        const save = async () => {
            calls += 1;
            throw new Error('storage is gone');
        };

        const sessions = [brokenSession()];
        expect(await ensureSessionsRepaired('char-1', sessions, save)).toBe(sessions);
        await ensureSessionsRepaired('char-1', sessions, save);
        expect(calls).toBe(2);
    });

    test('a history with nothing to repair costs one scan and no write', async () => {
        const writes = [];
        const clean = [brokenSession({ results: { [CAPE]: { count: 62, isSelfReturn: true } } })];
        const save = async (sessions) => {
            writes.push(sessions);
            return true;
        };

        expect(await ensureSessionsRepaired('char-1', clean, save)).toBe(clean);
        expect(writes).toHaveLength(0);
    });

    test('each character scope is judged on its own', async () => {
        const writes = [];
        const save = async (sessions) => {
            writes.push(sessions);
            return true;
        };

        await ensureSessionsRepaired('char-1', [brokenSession()], save);
        await ensureSessionsRepaired('char-2', [brokenSession()], save);
        expect(writes).toHaveLength(2);
    });
});
