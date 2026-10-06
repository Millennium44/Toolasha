/**
 * Enhancement Session Data Structure
 * Represents a single enhancement tracking session for one item
 */

/**
 * Session states
 */
export const SessionState = {
    IDLE: 'idle', // No active session
    TRACKING: 'tracking', // Currently tracking enhancements
    COMPLETED: 'completed', // Target reached or manually stopped
    ARCHIVED: 'archived', // Historical session (read-only)
};

/**
 * Create a new enhancement session
 * @param {string} itemHrid - Item HRID being enhanced
 * @param {string} itemName - Display name of item
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level (1-20)
 * @param {number} protectFrom - Level to start using protection items (0 = never)
 * @returns {Object} New session object
 */
export function createSession(itemHrid, itemName, startLevel, targetLevel, protectFrom = 0) {
    const now = Date.now();

    return {
        // Session metadata
        id: `session_${now}`,
        state: SessionState.TRACKING,
        itemHrid,
        itemName,
        startLevel,
        targetLevel,
        currentLevel: startLevel,
        protectFrom,

        // Timestamps
        startTime: now,
        lastUpdateTime: now,
        endTime: null,

        // Last attempt tracking (for detecting success/failure)
        lastAttempt: {
            attemptNumber: 0,
            level: startLevel,
            timestamp: now,
        },

        // Attempt tracking (per level)
        // Format: { 1: { success: 5, fail: 3, blessed: 1, successRate: 0.625 }, ... }
        attemptsPerLevel: {},

        // Cost tracking
        materialCosts: {}, // Format: { itemHrid: { count: 10, totalCost: 50000 } }
        hasUnpricedInput: false,
        coinCost: 0,
        coinCount: 0, // Track number of times coins were spent
        protectionCost: 0,
        protectionCount: 0,
        protectionItemHrid: null, // Track which protection item is being used
        totalCost: 0,

        // Statistics
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalBlessed: 0, // Successes that jumped +2 or more levels (Blessed Tea)
        totalXP: 0, // Total XP gained from enhancements
        longestSuccessStreak: 0,
        longestFailureStreak: 0,
        currentStreak: { type: null, count: 0 }, // 'success' or 'fail'

        // Milestones reached
        milestonesReached: [], // [5, 10, 15, 20]

        // Enhancement predictions (optional - calculated at session start)
        predictions: null, // { expectedAttempts, expectedProtections, ... }

        // Counter values when the session was last extended, so validation factors compare the
        // current leg against the prediction made for it. { totalAttempts, protectionCount }
        extensionBaseline: null,
    };
}

/**
 * Initialize attempts tracking for a level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 */
export function initializeLevelTracking(session, level) {
    if (!session.attemptsPerLevel[level]) {
        session.attemptsPerLevel[level] = {
            success: 0,
            fail: 0,
            blessed: 0,
            successRate: 0,
        };
    }
}

/**
 * Update success rate for a level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 */
export function updateSuccessRate(session, level) {
    const levelData = session.attemptsPerLevel[level];
    if (!levelData) return;

    const total = levelData.success + levelData.fail;
    levelData.successRate = total > 0 ? levelData.success / total : 0;
}

/**
 * Record a successful enhancement attempt
 * @param {Object} session - Session object
 * @param {number} previousLevel - Level before enhancement (level that succeeded)
 * @param {number} newLevel - New level after success
 * @param {boolean} wasBlessed - Whether this success jumped +2 or more levels (Blessed Tea).
 *   A subtype of success, not counted as an additional attempt/success on top of it.
 */
export function recordSuccess(session, previousLevel, newLevel, wasBlessed = false) {
    // Initialize tracking if needed for the level that succeeded
    initializeLevelTracking(session, previousLevel);

    // Record success at the level we enhanced FROM
    session.attemptsPerLevel[previousLevel].success++;
    session.totalAttempts++;
    session.totalSuccesses++;

    if (wasBlessed) {
        session.attemptsPerLevel[previousLevel].blessed++;
        session.totalBlessed++;
    }

    // Update success rate for this level
    updateSuccessRate(session, previousLevel);

    // Update current level
    session.currentLevel = newLevel;

    // Update streaks
    if (session.currentStreak.type === 'success') {
        session.currentStreak.count++;
    } else {
        session.currentStreak = { type: 'success', count: 1 };
    }

    if (session.currentStreak.count > session.longestSuccessStreak) {
        session.longestSuccessStreak = session.currentStreak.count;
    }

    // Check for milestones. A Blessed success can jump +2 or more levels in one
    // attempt (e.g. +4 -> +6), passing straight over a milestone (+5) without
    // ever landing on it — checking only newLevel missed those crossed-but-not-
    // landed-on milestones entirely. Scan every level from previousLevel+1
    // through newLevel so a skipped milestone still counts as reached.
    for (let level = previousLevel + 1; level <= newLevel; level++) {
        if ([5, 10, 15, 20].includes(level) && !session.milestonesReached.includes(level)) {
            session.milestonesReached.push(level);
        }
    }

    // Update timestamp
    session.lastUpdateTime = Date.now();

    // Check if target reached
    if (newLevel >= session.targetLevel) {
        session.state = SessionState.COMPLETED;
        session.endTime = Date.now();
    }
}

/**
 * Record a failed enhancement attempt
 * @param {Object} session - Session object
 * @param {number} previousLevel - Level that failed (level we tried to enhance from)
 */
export function recordFailure(session, previousLevel, newLevel) {
    // Initialize tracking if needed for the level that failed
    initializeLevelTracking(session, previousLevel);

    // Record failure at the level we enhanced FROM
    session.attemptsPerLevel[previousLevel].fail++;
    session.totalAttempts++;
    session.totalFailures++;

    // Update success rate for this level
    updateSuccessRate(session, previousLevel);

    // Update current level to actual level after failure
    session.currentLevel = newLevel;

    // Update streaks
    if (session.currentStreak.type === 'fail') {
        session.currentStreak.count++;
    } else {
        session.currentStreak = { type: 'fail', count: 1 };
    }

    if (session.currentStreak.count > session.longestFailureStreak) {
        session.longestFailureStreak = session.currentStreak.count;
    }

    // Update timestamp
    session.lastUpdateTime = Date.now();
}

/**
 * Add material cost to session
 * @param {Object} session - Session object
 * @param {string} itemHrid - Material item HRID
 * @param {number} count - Quantity used
 * @param {number} unitCost - Cost per item (from market)
 */
export function addMaterialCost(session, itemHrid, count, unitCost) {
    if (count > 0 && !(unitCost > 0)) session.hasUnpricedInput = true;
    if (!session.materialCosts[itemHrid]) {
        session.materialCosts[itemHrid] = {
            count: 0,
            totalCost: 0,
        };
    }

    session.materialCosts[itemHrid].count += count;
    session.materialCosts[itemHrid].totalCost += count * unitCost;

    // Update total cost
    recalculateTotalCost(session);
}

/**
 * Add coin cost to session
 * @param {Object} session - Session object
 * @param {number} amount - Coin amount spent
 */
export function addCoinCost(session, amount) {
    session.coinCost += amount;
    session.coinCount += 1;
    recalculateTotalCost(session);
}

/**
 * Add protection item cost to session
 * @param {Object} session - Session object
 * @param {string} protectionItemHrid - Protection item HRID
 * @param {number} cost - Protection item cost
 */
export function addProtectionCost(session, protectionItemHrid, cost) {
    if (!(cost > 0)) session.hasUnpricedInput = true;

    // A second protection item starts a per-item breakdown, splitting off what the first one
    // already consumed, rather than booking the new item under the old one's name
    if (
        !session.protectionBreakdown &&
        protectionItemHrid &&
        session.protectionItemHrid &&
        session.protectionItemHrid !== protectionItemHrid
    ) {
        session.protectionBreakdown = { ...getProtectionBreakdown(session) };
    }

    session.protectionCost += cost;
    session.protectionCount += 1;

    // Store the protection item HRID if not already set
    if (!session.protectionItemHrid) {
        session.protectionItemHrid = protectionItemHrid;
    }

    // A session merged from runs that used different protection items keeps them apart
    if (session.protectionBreakdown && protectionItemHrid) {
        const entry = (session.protectionBreakdown[protectionItemHrid] ||= { count: 0, totalCost: 0 });
        entry.count += 1;
        entry.totalCost += cost;
    }

    recalculateTotalCost(session);
}

/**
 * The protection a session consumed, per protection item. A session that never mixed items has
 * no stored breakdown; its one item carries the whole count and cost.
 * @param {Object} session - Session object
 * @returns {Object<string, {count: number, totalCost: number}>} Keyed by item hrid ('' when the
 *   item was never recorded)
 */
export function getProtectionBreakdown(session) {
    if (session?.protectionBreakdown) return session.protectionBreakdown;
    if (!(session?.protectionCount > 0) && !(session?.protectionCost > 0)) return {};
    return {
        [session.protectionItemHrid || '']: {
            count: session.protectionCount || 0,
            totalCost: session.protectionCost || 0,
        },
    };
}

/**
 * Recalculate total cost from all sources
 * @param {Object} session - Session object
 */
function recalculateTotalCost(session) {
    const materialTotal = Object.values(session.materialCosts).reduce((sum, m) => sum + m.totalCost, 0);

    session.totalCost = materialTotal + session.coinCost + session.protectionCost;
}

/**
 * Get session duration in seconds
 * @param {Object} session - Session object
 * @returns {number} Duration in seconds
 */
export function getSessionDuration(session) {
    // A live session's clock runs to its last recorded attempt, not to the
    // wall clock. lastUpdateTime advances only when an attempt lands, so once
    // enhancing stops — the user walked away, or the run was abandoned short of
    // its target — the duration freezes instead of counting time nobody spent
    // enhancing. Before this, only a completed run (which sets endTime) ever
    // stopped, so an idle In-Progress session ticked up forever.
    //
    // A resumed or merged session counts only active time: the stretches it was
    // ended for (between one run stopping and the next picking it up) are not
    // enhancing. See getActiveSpans.
    const ms = getActiveSpans(session).reduce((sum, span) => sum + (span.end - span.start), 0);
    return Math.floor(ms / 1000);
}

/**
 * The stretches of time a session was actually enhancing, oldest first.
 *
 * A session that was never resumed or merged has one: its start to its end (or, while running,
 * its last recorded attempt). A resumed or merged one keeps its closed stretches in
 * `pastActiveSpans` and runs its current one from `segmentStartTime`, so the gaps between runs
 * are neither counted as duration nor spread over by anything that shares a session's figures
 * out across the days it ran.
 * @param {Object} session - Session object
 * @returns {Array<{start: number, end: number}>} Epoch ms, `end >= start`
 */
export function getActiveSpans(session) {
    if (!session) return [];
    const past = Array.isArray(session.pastActiveSpans) ? session.pastActiveSpans : [];
    const start = session.segmentStartTime || session.startTime;
    const end = session.endTime || session.lastUpdateTime || start;
    const spans = past.map((span) => ({ start: span.start, end: Math.max(span.start, span.end) }));
    if (Number.isFinite(start)) spans.push({ start, end: Math.max(start, end) });
    return spans;
}

/**
 * When a session last did anything: its last attempt, else its last update, else its end, else
 * its start. Resume and extend keep a session's original start time while it runs on long
 * after, so ordering sessions by start says nothing about which one is the latest.
 * @param {Object} session - Session object
 * @returns {number} Epoch ms
 */
export function lastActivityTime(session) {
    return (
        Math.max(session?.lastAttempt?.timestamp || 0, session?.lastUpdateTime || 0, session?.endTime || 0) ||
        session?.startTime ||
        0
    );
}

/**
 * Whether an ended session is the one a new run should continue rather than start afresh: the
 * same item, the same target and protection setup, ended short of its target, and the new run
 * starting at exactly the level the session ended at.
 *
 * Every input is the game's own data (item hrid, levels from the queue row's item hash, the
 * action's target and protect-from fields), never displayed text.
 *
 * @param {Object} session - Candidate session (the most recent one)
 * @param {Object} run - The run about to start
 * @param {string} run.itemHrid - Item being enhanced
 * @param {number|null} run.startLevel - Level the run's first attempt started from (null: unknown)
 * @param {number} run.targetLevel - The action's enhancingMaxLevel
 * @param {number} run.protectFrom - The action's enhancingProtectionMinLevel (0: none)
 * @param {string|null} [run.protectionItemHrid] - Protection item loaded, when known
 * @returns {boolean}
 */
export function canResumeSession(session, run) {
    if (!session || !run) return false;
    if (session.state !== SessionState.COMPLETED) return false;
    if (session.itemHrid !== run.itemHrid) return false;
    if (!Number.isFinite(run.startLevel)) return false;
    if (session.targetLevel !== run.targetLevel) return false;
    if ((session.protectFrom || 0) !== (run.protectFrom || 0)) return false;
    // A different protection item is a different setup; an unknown one on either side (no
    // protection consumed yet, or none loaded) is not evidence against it. The session's own
    // setup is the item loaded on its last attempt; the item it first consumed stands in for
    // sessions recorded before attempts carried it.
    const configured = session.lastAttempt?.protectionItemHrid ?? session.protectionItemHrid;
    if (configured && run.protectionItemHrid && configured !== run.protectionItemHrid) {
        return false;
    }
    // A run that reached its target is extended, not resumed
    if (!(session.currentLevel < session.targetLevel)) return false;
    return session.currentLevel === run.startLevel;
}

/**
 * Reopen an ended session so a new run's attempts are recorded against it. The time it spent
 * ended is not counted: its duration so far is banked and the clock restarts now.
 * @param {Object} session - Session to reopen (mutated)
 * @param {number} [now] - Epoch ms
 */
export function resumeSession(session, now = Date.now()) {
    session.pastActiveSpans = getActiveSpans(session);
    session.segmentStartTime = now;
    session.state = SessionState.TRACKING;
    session.endTime = null;
    session.lastUpdateTime = now;
}

/**
 * Check whether a set of sessions can be merged into one, and order them by last activity.
 *
 * Every session must be the same item, and every one but the latest — the one active most
 * recently ({@link lastActivityTime}), not the one started last: a resumed or extended session
 * keeps its early start while it runs on — must have ended. The latest may still be running, in
 * which case the merged session stays the live one. Differing targets or protection are
 * allowed: the merged session keeps the latest one's (`settingsDiffer` says when that happened,
 * and `protectionItemsDiffer` when the runs consumed different protection items, so the
 * confirmation can say so).
 *
 * Every run must also continue the one before it, in that order: start at the level it ended at.
 *
 * @param {Array<Object>} sessions - Sessions picked for the merge
 * @param {Object} [options]
 * @param {function(Object): string} [options.labelOf] - How to name a session in a refusal
 * @returns {{ok: boolean, reason?: string, ordered?: Array<Object>, settingsDiffer?: boolean,
 *   protectionItemsDiffer?: boolean}} `ordered` runs from least to most recently active
 */
export function planSessionMerge(sessions, { labelOf = (session) => session.id } = {}) {
    const list = (Array.isArray(sessions) ? sessions : []).filter(Boolean);
    if (list.length < 2) return { ok: false, reason: 'Pick at least two sessions to merge.' };
    const itemHrid = list[0].itemHrid;
    if (list.some((session) => session.itemHrid !== itemHrid)) {
        return { ok: false, reason: 'Only sessions for the same item can be merged.' };
    }
    const ordered = [...list].sort((a, b) => lastActivityTime(a) - lastActivityTime(b));
    const older = ordered.slice(0, -1);
    if (older.some((session) => session.state === SessionState.TRACKING)) {
        return {
            ok: false,
            reason: 'Only the most recently active of the picked sessions may still be in progress; the others must have ended.',
        };
    }
    // One chain only: each run picks the item up at the level the run before it left it. Two
    // independent climbs (two +0 → +5 runs on different copies) cannot become one session — it
    // would hold one start and one end level against both runs' costs, and everything valuing
    // the climb (worth-it, gold sources) would see one level gain paid for twice.
    for (let i = 1; i < ordered.length; i++) {
        const before = ordered[i - 1];
        const after = ordered[i];
        if (after.startLevel !== before.currentLevel) {
            return {
                ok: false,
                reason:
                    `${labelOf(before)} ended at +${before.currentLevel} but ${labelOf(after)} started at ` +
                    `+${after.startLevel} — only runs that continue each other can merge.`,
            };
        }
    }
    const newest = ordered[ordered.length - 1];
    const settingsDiffer = older.some(
        (session) =>
            session.targetLevel !== newest.targetLevel || (session.protectFrom || 0) !== (newest.protectFrom || 0)
    );
    const protectionItems = new Set(
        ordered.flatMap((session) => Object.keys(getProtectionBreakdown(session)).filter(Boolean))
    );
    return { ok: true, ordered, settingsDiffer, protectionItemsDiffer: protectionItems.size > 1 };
}

/**
 * Fold the other sessions into the most recently active one, in place, making one persisted
 * session.
 *
 * The latest session's object is kept (and so its id, its place in the list, the tracker's
 * current-session pointer, and any attempt handler still holding it). It takes the sum of every
 * counter, cost, per-level tally and XP; the start level and start time of the session that
 * started first; and every session's active stretches (not the wall-clock span between them).
 * Its own target, protection, state, current level and last attempt are kept. Protection is kept
 * per item when the runs used different ones. The caller recomputes the prediction for the
 * merged start state; the extension baseline is cleared since the merged session is one leg
 * from the earliest start.
 *
 * When a folded-in session had already reached its own target, its completion has been recorded
 * for calibration under its own id; the merged session lists those targets
 * (`calibrationRecordedTargets`) so reaching one of them does not record those attempts a second
 * time. A different target is a distinct observation and is still recorded.
 *
 * @param {Array<Object>} ordered - Sessions by last activity, from {@link planSessionMerge}
 * @returns {Object} The latest session, now the merged one
 */
export function foldSessions(ordered) {
    const newest = ordered[ordered.length - 1];
    const older = ordered.slice(0, -1);
    // The chain starts where its first run (by activity) started; the start time is the earliest
    // any of them started, for anything asking how far back the session reaches
    const chainStart = ordered[0];
    const firstStartTime = Math.min(...ordered.map((session) => session.startTime || Infinity));

    // The survivor's own leg, before the others are folded in: its prediction, and how many
    // attempts and protections the merged counters will hold before that leg's own began
    // (a survivor merged before already carries its leg; the runs folded in now come before it)
    const foldedAttempts = older.reduce((sum, s) => sum + (s.totalAttempts || 0), 0);
    const foldedProtections = older.reduce((sum, s) => sum + (s.protectionCount || 0), 0);
    const ownBaseline = newest.calibrationOwnLeg || {
        targetLevel: newest.targetLevel,
        predictions: newest.predictions || null,
        totalAttempts: newest.extensionBaseline?.totalAttempts || 0,
        protectionCount: newest.extensionBaseline?.protectionCount || 0,
    };
    const ownLeg = {
        ...ownBaseline,
        totalAttempts: ownBaseline.totalAttempts + foldedAttempts,
        protectionCount: ownBaseline.protectionCount + foldedProtections,
    };

    const spans = [];
    const breakdowns = ordered.map((session) => getProtectionBreakdown(session));
    const segmentStartTime = newest.segmentStartTime || newest.startTime;
    const ownPast = Array.isArray(newest.pastActiveSpans) ? newest.pastActiveSpans : [];
    // Targets whose completion calibration has already recorded under a folded-in session's id
    const recordedTargets = new Set();
    for (const session of ordered) {
        for (const target of session.calibrationRecordedTargets || []) recordedTargets.add(target);
    }
    for (const session of older) {
        if (session.state === SessionState.COMPLETED && session.currentLevel >= session.targetLevel) {
            recordedTargets.add(session.targetLevel);
        }
    }
    for (const session of older) {
        spans.push(...getActiveSpans(session));

        newest.totalAttempts = (newest.totalAttempts || 0) + (session.totalAttempts || 0);
        newest.totalSuccesses = (newest.totalSuccesses || 0) + (session.totalSuccesses || 0);
        newest.totalFailures = (newest.totalFailures || 0) + (session.totalFailures || 0);
        newest.totalBlessed = (newest.totalBlessed || 0) + (session.totalBlessed || 0);
        newest.totalXP = (newest.totalXP || 0) + (session.totalXP || 0);
        newest.coinCost = (newest.coinCost || 0) + (session.coinCost || 0);
        newest.coinCount = (newest.coinCount || 0) + (session.coinCount || 0);
        newest.protectionCost = (newest.protectionCost || 0) + (session.protectionCost || 0);
        newest.protectionCount = (newest.protectionCount || 0) + (session.protectionCount || 0);
        newest.hasUnpricedInput = newest.hasUnpricedInput === true || session.hasUnpricedInput === true;
        newest.longestSuccessStreak = Math.max(newest.longestSuccessStreak || 0, session.longestSuccessStreak || 0);
        newest.longestFailureStreak = Math.max(newest.longestFailureStreak || 0, session.longestFailureStreak || 0);

        newest.attemptsPerLevel ||= {};
        for (const [level, tally] of Object.entries(session.attemptsPerLevel || {})) {
            initializeLevelTracking(newest, level);
            const into = newest.attemptsPerLevel[level];
            into.success += tally.success || 0;
            into.fail += tally.fail || 0;
            into.blessed = (into.blessed || 0) + (tally.blessed || 0);
            updateSuccessRate(newest, level);
        }

        newest.materialCosts ||= {};
        for (const [hrid, material] of Object.entries(session.materialCosts || {})) {
            if (!newest.materialCosts[hrid]) newest.materialCosts[hrid] = { count: 0, totalCost: 0 };
            newest.materialCosts[hrid].count += material.count || 0;
            newest.materialCosts[hrid].totalCost += material.totalCost || 0;
        }

        for (const milestone of session.milestonesReached || []) {
            newest.milestonesReached ||= [];
            if (!newest.milestonesReached.includes(milestone)) newest.milestonesReached.push(milestone);
        }
    }
    newest.milestonesReached?.sort((a, b) => a - b);
    recalculateTotalCost(newest);

    // Per-item protection. The survivor's protectionItemHrid stays its own (the item its own setup
    // consumes, null until it consumes one), never one inherited from another run; that history
    // is kept per item whenever it is not all that one item, so a later protection is booked
    // under its real name.
    const combined = {};
    for (const breakdown of breakdowns) {
        for (const [hrid, entry] of Object.entries(breakdown)) {
            const into = (combined[hrid] ||= { count: 0, totalCost: 0 });
            into.count += entry.count || 0;
            into.totalCost += entry.totalCost || 0;
        }
    }
    const items = Object.keys(combined);
    if (items.length > 1 || (items.length === 1 && items[0] !== (newest.protectionItemHrid || ''))) {
        newest.protectionBreakdown = combined;
    }

    newest.startLevel = chainStart.startLevel;
    if (Number.isFinite(firstStartTime)) newest.startTime = firstStartTime;
    newest.pastActiveSpans = [...spans, ...ownPast].sort((a, b) => a.start - b.start);
    newest.segmentStartTime = segmentStartTime;
    newest.extensionBaseline = null;
    if (recordedTargets.size > 0) {
        newest.calibrationRecordedTargets = [...recordedTargets].sort((a, b) => a - b);
        // Reaching one of those targets again is the survivor's own leg finishing: calibration
        // then measures that leg alone, against its own prediction (see calibrationObservation)
        newest.calibrationOwnLeg = ownLeg;
    }
    newest.mergedFrom = [
        ...(newest.mergedFrom || []),
        ...older.flatMap((session) => [...(session.mergedFrom || []), session.id]),
    ];
    return newest;
}

/**
 * What a completed session hands calibration, or null when it must not be recorded.
 *
 * A merged session holding a run that already reached its own target T had that run recorded
 * under the run's own id. Reaching T again is the survivor's own leg finishing — a separate
 * draw — so it is measured alone: its own attempts, against the prediction it was started with.
 * Without that leg on record (nothing to measure it against) it is not recorded at all, so the
 * folded-in run is never counted twice. Any other target is the whole chain's observation.
 * @param {Object} session - A completed session (a snapshot; not mutated)
 * @returns {Object|null} The session as calibration should read it
 */
export function calibrationObservation(session) {
    if (!session) return null;
    if (!session.calibrationRecordedTargets?.includes(session.targetLevel)) return session;
    const leg = session.calibrationOwnLeg;
    if (!leg || leg.targetLevel !== session.targetLevel || !leg.predictions) return null;
    return {
        ...session,
        predictions: leg.predictions,
        extensionBaseline: { totalAttempts: leg.totalAttempts, protectionCount: leg.protectionCount },
    };
}

/**
 * Calculate success rate for a specific level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 * @returns {number} Success rate percentage (0-100)
 */
export function getLevelSuccessRate(session, level) {
    const attempts = session.attemptsPerLevel[level];
    if (!attempts) return 0;

    const total = attempts.success + attempts.fail;
    if (total === 0) return 0;

    return (attempts.success / total) * 100;
}

/**
 * Calculate overall success rate
 * @param {Object} session - Session object
 * @returns {number} Success rate percentage (0-100)
 */
export function getOverallSuccessRate(session) {
    if (session.totalAttempts === 0) return 0;
    return (session.totalSuccesses / session.totalAttempts) * 100;
}

/**
 * Get total attempts for a specific level
 * @param {Object} session - Session object
 * @param {number} level - Enhancement level
 * @returns {number} Total attempts
 */
export function getLevelAttempts(session, level) {
    const attempts = session.attemptsPerLevel[level];
    if (!attempts) return 0;
    return attempts.success + attempts.fail;
}

/**
 * Finalize session (mark as completed)
 * @param {Object} session - Session object
 * @param {number} [endTime] - When the run ended, when that was not now
 */
export function finalizeSession(session, endTime = Date.now()) {
    session.state = SessionState.COMPLETED;
    session.endTime = endTime;
}

/**
 * Archive session (mark as read-only historical data)
 * @param {Object} session - Session object
 */
export function archiveSession(session) {
    session.state = SessionState.ARCHIVED;
    if (!session.endTime) {
        session.endTime = Date.now();
    }
}

/**
 * Check if session matches given item and level criteria (for resume logic)
 * @param {Object} session - Session object
 * @param {string} itemHrid - Item HRID
 * @param {number} currentLevel - Current enhancement level
 * @param {number} targetLevel - Target level
 * @param {number} protectFrom - Protection level
 * @returns {boolean} True if session matches
 */
export function sessionMatches(session, itemHrid, currentLevel, targetLevel, protectFrom = 0) {
    // Must be same item
    if (session.itemHrid !== itemHrid) return false;

    // Can only resume tracking sessions (not completed/archived)
    if (session.state !== SessionState.TRACKING) return false;

    // Must match protection settings exactly (Ultimate Tracker requirement)
    if (session.protectFrom !== protectFrom) return false;

    // Must match target level exactly (Ultimate Tracker requirement)
    if (session.targetLevel !== targetLevel) return false;

    // Must match current level (with small tolerance for out-of-order events)
    const levelDiff = Math.abs(session.currentLevel - currentLevel);
    if (levelDiff <= 1) {
        return true;
    }

    return false;
}

/**
 * Check if a completed session can be extended
 * @param {Object} session - Session object
 * @param {string} itemHrid - Item HRID
 * @param {number} currentLevel - Current enhancement level
 * @param {Object|null} [action] - Queue action now running, when known
 * @returns {boolean} True if session can be extended
 */
export function canExtendSession(session, itemHrid, currentLevel, action = null) {
    // Must be same item
    if (session.itemHrid !== itemHrid) return false;

    // Must be completed
    if (session.state !== SessionState.COMPLETED) return false;

    if (action) {
        const lastActionId = session.lastAttempt?.actionId;
        const sameAction = lastActionId != null && action.id != null && lastActionId === action.id;
        if (!sameAction) {
            // A different queue action can extend a completed climb only when
            // the old target was reached and the new target is higher. A run
            // canceled below target is its own attempt, even at the same level.
            if (!(session.currentLevel >= session.targetLevel && action.enhancingMaxLevel > session.targetLevel)) {
                return false;
            }
        }
    }

    // Current level should match where session ended (or close)
    const levelDiff = Math.abs(session.currentLevel - currentLevel);
    if (levelDiff <= 1) {
        return true;
    }

    return false;
}

/**
 * Extend a completed session to a new target level
 *
 * The predictions are recomputed for the new leg (+10 → +12, say), but the attempt and
 * protection counters keep running from the whole session. Comparing one against the other
 * makes the run look wildly over budget, so snapshot the counters here and let the display
 * diff against them.
 *
 * @param {Object} session - Session object
 * @param {number} newTargetLevel - New target level
 */
export function extendSession(session, newTargetLevel) {
    session.state = SessionState.TRACKING;
    session.targetLevel = newTargetLevel;
    session.endTime = null;
    session.lastUpdateTime = Date.now();
    session.extensionBaseline = {
        totalAttempts: session.totalAttempts || 0,
        protectionCount: session.protectionCount || 0,
    };
}

/**
 * Get attempts and protections accrued since the session was last extended.
 * A session that was never extended reports its full totals.
 * @param {Object} session - Session object
 * @returns {{attempts: number, protections: number}} Counters for the current leg
 */
export function getCurrentLegCounters(session) {
    const baseline = session?.extensionBaseline;
    const attempts = (session?.totalAttempts || 0) - (baseline?.totalAttempts || 0);
    const protections = (session?.protectionCount || 0) - (baseline?.protectionCount || 0);

    return {
        attempts: Math.max(0, attempts),
        protections: Math.max(0, protections),
    };
}

/**
 * Combine several sessions into one aggregate reading.
 *
 * Sums the counters, costs, XP and duration and re-derives the per-level tally
 * and overall rate, so runs of the same item split across sessions — or a mix of
 * items — read as one. The result is shaped like a session in the fields the
 * per-level and cost renderers touch (`id`, `attemptsPerLevel`, `materialCosts`,
 * the cost fields, `currentLevel`, `predictions`) so those views can be reused
 * as they are.
 *
 * Predictions are not merged: each describes a single leg's distribution and
 * they do not add, so the aggregate carries expected attempts/protections only
 * as plain sums for a rough factor, and `predictions` is left null so the
 * per-level table shows no misleading "Pred %" against a combined run.
 *
 * @param {Array<Object>} sessions - Sessions to combine
 * @returns {Object|null} Aggregate, or null for an empty list
 */
export function mergeSessions(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return null;

    const agg = {
        id: 'merged',
        merged: true,
        count: 0,
        itemHrids: [],
        itemNames: [],
        totalAttempts: 0,
        totalSuccesses: 0,
        totalFailures: 0,
        totalBlessed: 0,
        totalXP: 0,
        protectionCount: 0,
        protectionItemHrid: null,
        coinCost: 0,
        coinCount: 0,
        protectionCost: 0,
        totalCost: 0,
        durationSeconds: 0,
        currentLevel: 0,
        predictions: null,
        attemptsPerLevel: {},
        materialCosts: {},
        hasUnpricedInput: false,
        expectedAttempts: 0,
        expectedProtections: 0,
    };
    const seenItems = new Set();
    const protection = {};

    for (const session of sessions) {
        if (!session) continue;
        agg.count += 1;

        if (!seenItems.has(session.itemHrid)) {
            seenItems.add(session.itemHrid);
            agg.itemHrids.push(session.itemHrid);
            agg.itemNames.push(session.itemName);
        }

        agg.totalAttempts += session.totalAttempts || 0;
        agg.totalSuccesses += session.totalSuccesses || 0;
        agg.totalFailures += session.totalFailures || 0;
        agg.totalBlessed += session.totalBlessed || 0;
        agg.totalXP += session.totalXP || 0;
        agg.protectionCount += session.protectionCount || 0;
        agg.coinCost += session.coinCost || 0;
        agg.coinCount += session.coinCount || 0;
        agg.protectionCost += session.protectionCost || 0;
        agg.totalCost += session.totalCost || 0;
        agg.hasUnpricedInput ||= session.hasUnpricedInput === true;
        agg.durationSeconds += getSessionDuration(session);
        if (!agg.protectionItemHrid && session.protectionItemHrid) {
            agg.protectionItemHrid = session.protectionItemHrid;
        }
        for (const [hrid, entry] of Object.entries(getProtectionBreakdown(session))) {
            const into = (protection[hrid] ||= { count: 0, totalCost: 0 });
            into.count += entry.count || 0;
            into.totalCost += entry.totalCost || 0;
        }

        for (const [level, tally] of Object.entries(session.attemptsPerLevel || {})) {
            if (!agg.attemptsPerLevel[level]) {
                agg.attemptsPerLevel[level] = { success: 0, fail: 0, blessed: 0, successRate: 0 };
            }
            agg.attemptsPerLevel[level].success += tally.success || 0;
            agg.attemptsPerLevel[level].fail += tally.fail || 0;
            agg.attemptsPerLevel[level].blessed += tally.blessed || 0;
        }

        for (const [hrid, material] of Object.entries(session.materialCosts || {})) {
            if (!agg.materialCosts[hrid]) {
                agg.materialCosts[hrid] = { count: 0, totalCost: 0 };
            }
            agg.materialCosts[hrid].count += material.count || 0;
            agg.materialCosts[hrid].totalCost += material.totalCost || 0;
        }

        if (session.predictions) {
            agg.expectedAttempts += session.predictions.expectedAttempts || 0;
            agg.expectedProtections += session.predictions.expectedProtections || 0;
        }
    }

    for (const tally of Object.values(agg.attemptsPerLevel)) {
        const total = tally.success + tally.fail;
        tally.successRate = total > 0 ? tally.success / total : 0;
    }
    agg.successRate = agg.totalAttempts > 0 ? agg.totalSuccesses / agg.totalAttempts : 0;

    // Where the item stands now: the level of the most recently active session, so the
    // per-level table marks the row being worked on, the way the single-session view does.
    // Several items have no one level to mark.
    const present = sessions.filter(Boolean);
    agg.live = present.some((session) => session.state === SessionState.TRACKING);
    if (Object.keys(protection).length > 1) agg.protectionBreakdown = protection;
    if (agg.itemHrids.length === 1) {
        const activity = (s) =>
            Math.max(s.endTime || 0, s.lastAttempt?.timestamp || 0, s.lastUpdateTime || 0, s.startTime || 0);
        const running = present.filter((session) => session.state === SessionState.TRACKING);
        const latest = (running.length > 0 ? running : present).reduce((a, b) => (activity(b) >= activity(a) ? b : a));
        agg.currentLevel = Number.isFinite(latest.currentLevel) ? latest.currentLevel : 0;
    }

    return agg;
}

/**
 * Validate session data integrity
 * @param {Object} session - Session object
 * @returns {boolean} True if valid
 */
export function validateSession(session) {
    if (!session || typeof session !== 'object') return false;

    // Required fields
    if (!session.id || !session.itemHrid || !session.itemName) return false;
    if (typeof session.startLevel !== 'number' || typeof session.targetLevel !== 'number') return false;
    if (typeof session.currentLevel !== 'number') return false;

    // Validate level ranges
    if (session.startLevel < 0 || session.startLevel > 20) return false;
    if (session.targetLevel < 1 || session.targetLevel > 20) return false;
    if (session.currentLevel < 0 || session.currentLevel > 20) return false;

    // Validate costs are non-negative
    if (session.totalCost < 0 || session.coinCost < 0 || session.protectionCost < 0) return false;

    return true;
}

/**
 * Normalize a session loaded from storage so older sessions (persisted before Blessed
 * tracking existed) read with an explicit 0 instead of undefined. Mutates in place.
 * @param {Object} session - Session object
 * @returns {Object} The same session, normalized
 */
export function normalizeSession(session) {
    if (typeof session.totalBlessed !== 'number') {
        session.totalBlessed = 0;
    }

    for (const levelData of Object.values(session.attemptsPerLevel || {})) {
        if (typeof levelData.blessed !== 'number') {
            levelData.blessed = 0;
        }
    }

    return session;
}
