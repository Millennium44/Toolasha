/**
 * One-time repair of transmute sessions recorded through the self-return
 * batching bug.
 *
 * ## What went wrong
 *
 * Until `foldStackRows` landed (see `alchemy-item-deltas.js`), a single
 * `action_completed` covering a batch of efficiency procs carried the input
 * stack several times — successive snapshots of one stack, not several gains —
 * and the transmute tracker read each of them as a separate self-return. A run
 * of 75 attempts and 64 successes was recorded as handing back 103 capes.
 *
 * That number is not merely too big; it is load-bearing.
 * `computeSessionProfit` takes `netConsumed = max(0, attempts × bulk −
 * selfReturned)`, so 103 against 75 clamps to zero and the session's entire
 * input cost disappears. The session then reads as pure profit.
 *
 * ## Deriving, not clamping
 *
 * Every successful transmute produces exactly one output of `bulkMultiplier`
 * items — a self-return is one of the drop table's entries, not an extra. So
 * the self-returned count is not a thing to be guessed at:
 *
 *     selfReturnCount = totalSuccesses × bulkMultiplier − (every other output)
 *
 * For the example above: 64 − 2 = 62, and `netConsumed` comes back to 13.
 * Clamping to `successes × bulk` would have written 64 — still wrong, and
 * wrong in the direction that understates the cost.
 *
 * ## Where the derivation is unsound, nothing is written
 *
 * `totalSuccesses` is itself capped per message by the tracker and can be an
 * undercount. Where it is, the subtraction above goes negative or produces an
 * answer the rest of the record contradicts, and a repaired session would be a
 * confident wrong number wearing the same clothes as an observed one. Those
 * sessions are marked unreliable instead, and the totals table declines to
 * average them in.
 *
 * ## Every touched session says so
 *
 * A repaired count is derived, not observed, and must never be mistaken for
 * something the wire reported. So the session carries a `repair` stamp naming
 * the original value, and the repaired result entry keeps `recordedCount`
 * alongside `countBasis: 'derived'`. The stamp is also what makes the repair
 * idempotent: a session that carries it is never examined again.
 *
 * ## Completion is recorded per session, in the write that makes the change
 *
 * `settings-storage.js` learned this the hard way — a rewrite that marked
 * itself done over a save the storage layer had refused stopped for good, and
 * the next load found the old value back. Here the "done" marker IS the stamp,
 * and it reaches disk in the same record as the repaired count, so the two
 * cannot diverge. The per-scope short-circuit below is only set once the save
 * has actually landed; a refused save leaves it unset and the next load tries
 * again.
 */

/** Identifies this repair wherever it is recorded. */
export const REPAIR_ID = 'transmute-self-return-batching';

/** Scopes whose sessions have been repaired and successfully written this session. */
const repairedScopes = new Set();

/**
 * Forget which scopes have been repaired — for tests, and for a character
 * switch, where the next scope has to be examined on its own terms.
 * @returns {void}
 */
export function resetRepairState() {
    repairedScopes.clear();
}

/**
 * Whether a session already carries this repair's stamp.
 * @param {Object} session - A stored transmute session
 * @returns {boolean} True when it has been examined before
 */
function alreadyStamped(session) {
    return session?.repair?.id === REPAIR_ID;
}

/**
 * Read a session's outputs into the two numbers the derivation needs.
 * @param {Object} session - A stored transmute session
 * @returns {{selfHrids: Array<string>, selfReturned: number, otherCount: number}} The split
 */
function splitResults(session) {
    const selfHrids = [];
    let selfReturned = 0;
    let otherCount = 0;

    for (const [itemHrid, result] of Object.entries(session?.results || {})) {
        const count = Number(result?.count) || 0;
        if (result?.isSelfReturn) {
            selfHrids.push(itemHrid);
            selfReturned += count;
        } else {
            otherCount += count;
        }
    }

    return { selfHrids, selfReturned, otherCount };
}

/**
 * Decide what, if anything, this session needs.
 *
 * Deliberately narrow: a session is only considered at all when its recorded
 * self-returns EXCEED what the successes could have produced. Everything else
 * — including a session that merely looks odd — is left exactly as recorded.
 *
 * @param {Object} session - A stored transmute session
 * @returns {{action: 'none'|'repair'|'flag', itemHrid?: string, from?: number,
 *   to?: number, reason?: string}} What to do with it
 */
export function planSessionRepair(session) {
    if (!session || alreadyStamped(session)) return { action: 'none' };

    const bulkMultiplier = Number(session.bulkMultiplier) || 1;
    const attempts = Number(session.totalAttempts) || 0;
    const successes = Number(session.totalSuccesses) || 0;
    const { selfHrids, selfReturned, otherCount } = splitResults(session);

    if (selfHrids.length === 0 || selfReturned <= 0) return { action: 'none' };

    const derived = successes * bulkMultiplier - otherCount;

    // Recorded self-returns that fit inside what the successes produced are
    // consistent with the wire, whatever else is true of the session
    if (selfReturned <= derived) return { action: 'none' };

    if (successes <= 0) {
        return { action: 'flag', reason: 'self-returns recorded against no successes' };
    }
    if (successes > attempts) {
        return { action: 'flag', reason: 'more successes than attempts' };
    }
    if (derived < 0) {
        return { action: 'flag', reason: 'other outputs already exceed what the successes could produce' };
    }
    if (selfHrids.length > 1) {
        return { action: 'flag', reason: 'several self-return outputs — the derived total cannot be apportioned' };
    }

    return { action: 'repair', itemHrid: selfHrids[0], from: selfReturned, to: derived };
}

/**
 * Apply the plan to a COPY of the session — the stored object is never mutated,
 * so a save that does not land leaves the in-memory history exactly as the disk
 * still has it and the next load repairs afresh.
 *
 * @param {Object} session - A stored transmute session
 * @param {Object} plan - What {@link planSessionRepair} decided
 * @param {number} at - Timestamp for the stamp
 * @returns {Object} The repaired or flagged copy
 */
function applyPlan(session, plan, at) {
    if (plan.action === 'flag') {
        return {
            ...session,
            repair: {
                id: REPAIR_ID,
                at,
                outcome: 'unreliable',
                reason: plan.reason,
            },
        };
    }

    const result = session.results[plan.itemHrid];
    return {
        ...session,
        results: {
            ...session.results,
            [plan.itemHrid]: {
                ...result,
                count: plan.to,
                // The number the buggy tracker actually wrote, kept so the
                // repair can be seen rather than merely trusted
                recordedCount: plan.from,
                countBasis: 'derived',
            },
        },
        repair: {
            id: REPAIR_ID,
            at,
            outcome: 'repaired',
            basis: 'derived',
            itemHrid: plan.itemHrid,
            from: plan.from,
            to: plan.to,
        },
    };
}

/**
 * Repair a whole history, returning a new array when anything changed.
 *
 * @param {Array<Object>} sessions - Stored transmute sessions
 * @param {number} [at] - Timestamp for the stamps, for tests
 * @returns {{sessions: Array<Object>, repaired: number, flagged: number, changed: boolean}} The outcome
 */
export function repairTransmuteSessions(sessions, at = Date.now()) {
    const list = Array.isArray(sessions) ? sessions : [];
    let repaired = 0;
    let flagged = 0;

    const next = list.map((session) => {
        const plan = planSessionRepair(session);
        if (plan.action === 'none') return session;
        if (plan.action === 'repair') repaired += 1;
        else flagged += 1;
        return applyPlan(session, plan, at);
    });

    const changed = repaired + flagged > 0;
    return { sessions: changed ? next : list, repaired, flagged, changed };
}

/**
 * Run the repair over one character's history, once, persisting what it changed.
 *
 * The repaired array is handed back whether or not the write landed — showing
 * the honest numbers costs nothing — but the scope is only marked done on a
 * write that actually succeeded, so a refused save is retried on the next load.
 *
 * @param {string} scope - Character scope the sessions belong to
 * @param {Array<Object>} sessions - The history as loaded
 * @param {Function} save - `(sessions) => Promise<boolean>`; false means nothing was written
 * @returns {Promise<Array<Object>>} The sessions to use
 */
export async function ensureSessionsRepaired(scope, sessions, save) {
    if (!scope || repairedScopes.has(scope)) return sessions;

    try {
        const { sessions: next, repaired, flagged, changed } = repairTransmuteSessions(sessions);
        if (!changed) {
            repairedScopes.add(scope);
            return sessions;
        }

        const written = await save(next);
        if (written === false) {
            console.warn(
                '[TransmuteSessionRepair] The repaired sessions could not be written; will try again on the next load'
            );
            return next;
        }

        repairedScopes.add(scope);
        console.info(
            `[TransmuteSessionRepair] Repaired ${repaired} session(s) and flagged ${flagged} as unreliable ` +
                'after the self-return batching bug'
        );
        return next;
    } catch (error) {
        // A failed repair must not cost the user their history, and an
        // unmarked scope tries again next load
        console.error('[TransmuteSessionRepair] Repair failed:', error);
        return sessions;
    }
}

export default { REPAIR_ID, repairTransmuteSessions, planSessionRepair, ensureSessionsRepaired, resetRepairState };
